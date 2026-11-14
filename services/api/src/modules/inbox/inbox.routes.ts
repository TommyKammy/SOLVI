import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { Problems, currentElapsedSeconds } from '@solvi/shared';
import { hasRole } from '../../common/authz/authz.js';
import { recordAuditEvent, uuidv7 } from '../../common/audit/audit.js';
import type { AuthenticatedRequest } from '../auth/auth.routes.js';
import { effectiveGenerationSql } from '../catalog/approval-route-state.js';
const sourceKinds = ['ticket', 'request_approval', 'change'] as const;
type SourceKind = (typeof sourceKinds)[number];
type Deadline = {
  label: string;
  status: 'none' | 'paused' | 'upcoming' | 'within' | 'overdue';
  at: string | null;
  remainingSeconds: number | null;
};
type Item = {
  kind: SourceKind;
  id: string;
  number: string;
  title: string;
  state: string;
  stateLabel: string;
  scopeLabel: string;
  nextAction: string;
  href: string;
  waiting: boolean;
  eventKey: string;
  updatedAt: string;
  deadline: Deadline;
  unread: boolean;
  plannedStart?: string | null;
  plannedEnd?: string | null;
};
const querySchema = z
  .object({
    kind: z.enum(['all', 'ticket', 'approval', 'change']).default('all'),
    q: z.string().trim().max(160).default(''),
    unread: z.enum(['0', '1']).default('0'),
    unassigned: z.enum(['0', '1']).default('0'),
    page: z.coerce.number().int().min(1).max(100000).default(1),
  })
  .strict();
const readSchema = z
  .object({
    kind: z.enum(sourceKinds),
    id: z.string().uuid(),
    eventKey: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const r = schema.safeParse(value);
  if (!r.success)
    throw Problems.validation(
      r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    );
  return r.data;
}
const iso = (date: Date) => date.toISOString();
const digest = (parts: unknown[]) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex');
function timed(label: string, end: Date | null, now: Date, start?: Date | null): Deadline {
  if (!end) return { label, status: 'none', at: null, remainingSeconds: null };
  const remaining = Math.floor((end.getTime() - now.getTime()) / 1000);
  return {
    label,
    status: now >= end ? 'overdue' : start && now >= start ? 'within' : 'upcoming',
    at: iso(end),
    remainingSeconds: remaining,
  };
}
const changeLabels: Record<string, string> = {
  draft: '下書き',
  review: '承認待ち',
  approved: '承認済み・予定未確定',
  rejected: '却下・見直し待ち',
  scheduled: '予定確定',
  in_progress: '実施中（合成記録）',
  failed: '失敗記録済み・PIR待ち',
};
/** A current-state work queue, not another notification dispatcher. ADR-0027. */
export class InboxController {
  constructor(
    private readonly pool: pg.Pool,
    private readonly enabled: boolean,
  ) {}
  private staff(auth: AuthenticatedRequest) {
    return hasRole(auth.authz, 'agent', 'org_admin', 'platform_admin');
  }
  /**
   * 受信箱の利用者を絞る。
   *
   * 従来のロール(担当者・承認者など)に加え、**現在の pending ステップの
   * 承認者である利用者**を許す。上長・部署長は `approver` ロールを持たないため
   * (ADR-0023 §2 / §5)、ロールだけでは自分宛ての承認依頼に到達できない。
   * 承認待ちの抽出と同じ判定をここでも使う。
   */
  private async authorize(c: pg.PoolClient, auth: AuthenticatedRequest): Promise<void> {
    if (hasRole(auth.authz, 'agent', 'org_admin', 'platform_admin', 'approver')) return;
    // 現在の pending ステップの有効な世代は共有の導出式で決める(再割当後も到達できる)。
    const effectiveGeneration = effectiveGenerationSql({
      requestId: 'q.id',
      organizationId: 'q.organization_id',
      revision: 'q.revision',
      stepNo: 'a.step_no',
      baseGeneration: 'r.route_generation',
    });
    const r = await c.query(
      `SELECT 1
         FROM local_service_request q
         JOIN local_request_revision r
           ON r.request_id=q.id AND r.organization_id=q.organization_id AND r.revision=q.revision
         JOIN local_request_approval a
           ON a.id=q.current_approval_id AND a.organization_id=q.organization_id
          AND a.request_id=q.id AND a.revision=q.revision
          AND a.route_generation=${effectiveGeneration}
        WHERE q.organization_id=$1 AND q.state='pending' AND a.state='pending'
          AND a.approver_id=$2 AND q.requester_id<>$2
        LIMIT 1`,
      [auth.authz.organizationId, auth.userId],
    );
    if (!r.rowCount) throw Problems.forbidden('必要な権限がありません');
  }
  private async run<T>(
    auth: AuthenticatedRequest,
    writing: boolean,
    fn: (c: pg.PoolClient) => Promise<T>,
  ) {
    if (!this.enabled) throw Problems.notFound('ローカル業務受信箱');
    const c = await this.pool.connect();
    try {
      await c.query(writing ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await c.query(
        "SELECT set_config('app.current_org',$1,true),set_config('app.inbox_user',$2,true)",
        [auth.authz.organizationId, auth.userId],
      );
      await this.authorize(c, auth);
      const result = await fn(c);
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
  private async items(
    c: pg.PoolClient,
    auth: AuthenticatedRequest,
    unassigned: boolean,
    only?: { kind: SourceKind; id: string },
  ) {
    const now = (await c.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
    const items: Item[] = [];
    const org = auth.authz.organizationId,
      user = auth.userId;
    const add = (item: Omit<Item, 'eventKey' | 'unread'>, version: unknown[]) =>
      items.push({
        ...item,
        eventKey: digest([item.kind, item.id, ...version, item.deadline.status]),
        unread: true,
      });
    if (this.staff(auth) && (!only || only.kind === 'ticket')) {
      const rows = (
        await c.query(
          `SELECT t.id,t.number,t.subject,t.state,t.pending_reason,t.assignee_id,t.updated_at,t.updated_at::text AS version,t.sla_clock_started_at,t.sla_elapsed_seconds,t.first_responded_at,p.response_target_minutes,p.resolution_target_minutes,cm.id AS comment_id,cm.created_at AS comment_at
    FROM ticket t LEFT JOIN sla_policy p ON p.organization_id=t.organization_id AND p.priority=t.priority
    LEFT JOIN LATERAL (SELECT id,created_at FROM ticket_comment WHERE ticket_id=t.id AND organization_id=t.organization_id ORDER BY created_at DESC,id DESC LIMIT 1) cm ON true
    WHERE t.organization_id=$1 AND t.state IN ('new','assigned','in_progress','pending') AND (t.assignee_id=$2 OR ($3::boolean AND t.assignee_id IS NULL)) AND ($4::uuid IS NULL OR t.id=$4)`,
          [org, user, unassigned, only?.id ?? null],
        )
      ).rows;
      for (const r of rows) {
        const label = r.first_responded_at ? '解決SLA' : '初回応答SLA',
          minutes = r.first_responded_at ? r.resolution_target_minutes : r.response_target_minutes;
        const remaining =
          minutes === null
            ? null
            : Number(minutes) * 60 -
              currentElapsedSeconds(
                { startedAt: r.sla_clock_started_at, elapsedSeconds: r.sla_elapsed_seconds },
                now,
              );
        const deadline: Deadline =
          remaining === null
            ? { label, status: 'none', at: null, remainingSeconds: null }
            : !r.sla_clock_started_at
              ? { label, status: 'paused', at: null, remainingSeconds: remaining }
              : {
                  label,
                  status: remaining < 0 ? 'overdue' : 'upcoming',
                  at: iso(new Date(now.getTime() + remaining * 1000)),
                  remainingSeconds: remaining,
                };
        const stateLabels: Record<string, string> = {
          new: '受付済み',
          assigned: '担当割当済み',
          in_progress: '対応中',
          pending:
            r.pending_reason === 'wait_requester'
              ? '利用者の返答待ち・SLA停止'
              : r.pending_reason === 'wait_external'
                ? '外部の対応待ち・SLA停止'
                : '待ち先未記録・SLA停止',
        };
        add(
          {
            kind: 'ticket',
            id: r.id,
            number: r.number,
            title: r.subject,
            state: r.state,
            stateLabel: stateLabels[r.state] ?? r.state,
            scopeLabel: r.assignee_id ? '自分の担当' : '担当未定',
            nextAction: !r.assignee_id
              ? '内容を確認して引き受ける'
              : r.state === 'pending'
                ? '返答を確認する'
                : r.state === 'assigned'
                  ? '対応を始める'
                  : '対応・返信を確認する',
            href: '/ops/' + r.id,
            waiting: r.state === 'pending',
            updatedAt: iso(
              new Date(Math.max(r.updated_at.getTime(), r.comment_at?.getTime() ?? 0)),
            ),
            deadline,
          },
          [r.version, r.comment_id ?? null],
        );
      }
    }
    // 承認待ちはロールではなく「自分が現在の pending ステップの承認者である」で抽出する
    // (ADR-0023 §5 / WP-P4-APR-015 §6-5)。上長・部署長は approver ロールを持たない。
    if (!only || only.kind === 'request_approval') {
      const effectiveGeneration = effectiveGenerationSql({
        requestId: 'q.id',
        organizationId: 'q.organization_id',
        revision: 'q.revision',
        stepNo: 'a.step_no',
        baseGeneration: 'r.route_generation',
      });
      const rows = (
        await c.query(
          `SELECT q.id,q.version,q.updated_at,q.snapshot->'item'->>'title' AS title,t.number,a.id AS approval_id,a.expires_at
    FROM local_service_request q
    JOIN local_request_revision r ON r.request_id=q.id AND r.organization_id=q.organization_id AND r.revision=q.revision
    JOIN local_request_approval a ON a.id=q.current_approval_id AND a.organization_id=q.organization_id AND a.request_id=q.id AND a.revision=q.revision AND a.snapshot_hash=q.snapshot_hash
      AND a.route_generation=${effectiveGeneration}
    JOIN ticket t ON t.id=q.ticket_id AND t.organization_id=q.organization_id
    WHERE q.organization_id=$1 AND q.state='pending' AND a.state='pending' AND a.approver_id=$2 AND q.requester_id<>$2 AND ($3::uuid IS NULL OR q.id=$3)`,
          [org, user, only?.id ?? null],
        )
      ).rows;
      for (const r of rows) {
        const deadline = timed('承認期限', r.expires_at, now);
        add(
          {
            kind: 'request_approval',
            id: r.id,
            number: r.number,
            title: r.title,
            state: 'pending',
            stateLabel:
              deadline.status === 'overdue' ? '承認期限超過・再申請の確認' : '自分への承認依頼',
            scopeLabel: '指名された承認者',
            nextAction:
              deadline.status === 'overdue'
                ? '期限と再申請の必要を確認する'
                : '申請を確認して承認・却下する',
            href: '/requests/' + r.id,
            waiting: false,
            updatedAt: iso(r.updated_at),
            deadline,
          },
          [r.version, r.approval_id],
        );
      }
    }
    if (!only || only.kind === 'change') {
      const rows = (
        await c.query(
          `SELECT ch.*,a.expires_at AS approval_expires,d.decision
    FROM local_change ch LEFT JOIN local_change_approval a ON a.id=ch.current_approval_id AND a.organization_id=ch.organization_id AND a.change_id=ch.id AND a.revision=ch.revision AND a.snapshot_hash=ch.snapshot_hash
    LEFT JOIN local_change_decision d ON d.approval_id=a.id AND d.organization_id=a.organization_id
    WHERE ch.organization_id=$1 AND ($5::uuid IS NULL OR ch.id=$5) AND (
    ($3::boolean AND (ch.owner_id=$2 OR ch.created_by=$2) AND (ch.state IN ('draft','review','approved','rejected','scheduled','in_progress') OR (ch.state='failed' AND NOT EXISTS(SELECT 1 FROM local_change_pir p WHERE p.change_id=ch.id AND p.organization_id=ch.organization_id))))
    OR ($4::boolean AND ch.state='review' AND a.approver_id=$2 AND d.approval_id IS NULL AND ch.owner_id<>$2 AND ch.created_by<>$2))`,
          [org, user, this.staff(auth), hasRole(auth.authz, 'approver'), only?.id ?? null],
        )
      ).rows;
      for (const r of rows) {
        const s = r.snapshot,
          reviewer =
            r.state === 'review' && s.approver?.id === user && hasRole(auth.authz, 'approver');
        const start = s.plannedStart ? new Date(s.plannedStart) : null,
          end = s.plannedEnd ? new Date(s.plannedEnd) : null;
        let deadline: Deadline =
          r.state === 'failed'
            ? timed('PIR期限は未設定', null, now)
            : timed(
                reviewer ? '承認期限' : '予定終了',
                reviewer ? r.approval_expires : end,
                now,
                start,
              );
        if (r.state === 'scheduled' && start && now < start)
          deadline = timed('予定開始', start, now);
        const actions: Record<string, string> = {
          draft: '計画と申請条件を確認する',
          review: '承認状況を確認する',
          approved: '承認した対象と予定を確認する',
          rejected: '却下理由を確認して計画を見直す',
          scheduled:
            deadline.status === 'overdue'
              ? '予定を見直して再承認を依頼する'
              : start && now < start
                ? '開始予定と対象を確認する'
                : '対象を確認して開始を記録する',
          in_progress: '合成の実施結果を記録する',
          failed: '原因・教訓・再発防止をPIRへ記録する',
        };
        add(
          {
            kind: 'change',
            plannedStart: s.plannedStart,
            plannedEnd: s.plannedEnd,
            id: r.id,
            number: 'CHG-' + String(r.sequence_no).padStart(6, '0'),
            title: s.title,
            state: r.state,
            stateLabel: reviewer ? '自分への変更承認依頼' : (changeLabels[r.state] ?? r.state),
            scopeLabel: reviewer
              ? '指名された承認者'
              : r.owner_id === user
                ? '自分の実施担当'
                : '自分が作成した変更',
            nextAction: reviewer ? '計画・対象を確認して判断する' : actions[r.state]!,
            href: '/changes/' + r.id,
            waiting: r.state === 'review' && !reviewer,
            updatedAt: iso(r.updated_at),
            deadline,
          },
          [r.version, r.current_approval_id],
        );
      }
    }
    const receipts = (
      await c.query<{ source_kind: SourceKind; source_id: string; event_key: string }>(
        'SELECT source_kind,source_id,event_key FROM work_inbox_read_receipt WHERE organization_id=$1 AND user_id=$2',
        [org, user],
      )
    ).rows;
    const read = new Set(
      receipts.map((r) => r.source_kind + ':' + r.source_id + ':' + r.event_key),
    );
    for (const item of items)
      item.unread = !read.has(item.kind + ':' + item.id + ':' + item.eventKey);
    return { items, now: iso(now) };
  }
  async list(auth: AuthenticatedRequest, query: unknown) {
    const q = parse(querySchema, query);
    return this.run(auth, false, async (c) => {
      const source = await this.items(c, auth, q.unassigned === '1'),
        term = q.q.toLocaleLowerCase('ja');
      const group = (i: Item) =>
        i.kind === 'request_approval' || (i.kind === 'change' && i.state === 'review' && !i.waiting)
          ? 'approval'
          : i.kind;
      const matching = source.items.filter(
        (i) =>
          (q.kind === 'all' || group(i) === q.kind) &&
          (!term || (i.number + ' ' + i.title).toLocaleLowerCase('ja').includes(term)),
      );
      const unread = matching.filter((i) => i.unread).length;
      const filtered = matching
        .filter((i) => q.unread === '0' || i.unread)
        .sort(
          (a, b) =>
            Number(b.deadline.status === 'overdue') - Number(a.deadline.status === 'overdue') ||
            Number(a.waiting) - Number(b.waiting) ||
            (a.deadline.at ? new Date(a.deadline.at).getTime() : Infinity) -
              (b.deadline.at ? new Date(b.deadline.at).getTime() : Infinity) ||
            b.updatedAt.localeCompare(a.updatedAt) ||
            a.kind.localeCompare(b.kind) ||
            a.id.localeCompare(b.id),
        );
      return {
        items: filtered.slice((q.page - 1) * 25, q.page * 25),
        total: filtered.length,
        unread,
        page: q.page,
        pageSize: 25,
        asOf: source.now,
        canIncludeUnassigned: this.staff(auth),
        counts: {
          ticket: matching.filter((i) => group(i) === 'ticket').length,
          approval: matching.filter((i) => group(i) === 'approval').length,
          change: matching.filter((i) => group(i) === 'change').length,
        },
        appliedFilter: q,
      };
    });
  }
  async markRead(auth: AuthenticatedRequest, body: unknown) {
    const input = parse(readSchema, body);
    return this.run(auth, true, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'inbox-read:' +
          auth.authz.organizationId +
          ':' +
          auth.userId +
          ':' +
          input.kind +
          ':' +
          input.id,
      ]);
      const table =
        input.kind === 'ticket'
          ? 'ticket'
          : input.kind === 'change'
            ? 'local_change'
            : 'local_service_request';
      await c.query(`SELECT id FROM ${table} WHERE id=$1 AND organization_id=$2 FOR SHARE`, [
        input.id,
        auth.authz.organizationId,
      ]);
      const current = (await this.items(c, auth, true, input)).items.find(
        (i) => i.id === input.id && i.kind === input.kind,
      );
      if (!current) throw Problems.notFound('現在の担当・承認業務');
      if (current.eventKey !== input.eventKey)
        throw Problems.conflict('新しい更新があります。受信箱を更新してから開いてください');
      const receiptId = uuidv7();
      const inserted = await c.query<{ id: string }>(
        'INSERT INTO work_inbox_read_receipt(id,organization_id,user_id,source_kind,source_id,event_key) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organization_id,user_id,source_kind,source_id,event_key) DO NOTHING RETURNING id',
        [receiptId, auth.authz.organizationId, auth.userId, input.kind, input.id, input.eventKey],
      );
      if (inserted.rowCount)
        await recordAuditEvent(c, {
          eventType: 'inbox.read',
          organizationId: auth.authz.organizationId,
          actorType: 'user',
          actorId: auth.userId,
          targetType: 'inbox_read_receipt',
          targetId: receiptId,
          action: 'inbox.read',
          outcome: 'success',
          afterState: { kind: input.kind, sourceId: input.id, eventKey: input.eventKey },
        });
      const row =
        inserted.rows[0] ??
        (
          await c.query<{ id: string }>(
            'SELECT id FROM work_inbox_read_receipt WHERE organization_id=$1 AND user_id=$2 AND source_kind=$3 AND source_id=$4 AND event_key=$5',
            [auth.authz.organizationId, auth.userId, input.kind, input.id, input.eventKey],
          )
        ).rows[0]!;
      return { receiptId: row.id, replayed: !inserted.rowCount, href: current.href };
    });
  }
}
