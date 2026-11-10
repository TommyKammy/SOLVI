import type pg from 'pg';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CatalogValues } from '@solvi/shared/catalog';
import { Problems, type ObjectStorage } from '@solvi/shared';
import { hasRole, requireRole } from '../../common/authz/authz.js';
import { uuidv7, recordAuditEvent } from '../../common/audit/audit.js';
import { TicketService } from '../ticket/ticket.service.js';
import { CollaborationService } from '../ticket/collaboration.service.js';
import type { AuthenticatedRequest } from '../auth/auth.routes.js';
import {
  definitionSchema,
  validateValues,
  validateRequestInputs,
  type Definition,
} from './catalog-definition.js';

const uuid = z.string().uuid();
const inputSchema = z
  .object({
    reason: z.string().trim().max(2000).optional(),
    durationDays: z.number().finite().optional(),
    approverId: uuid,
    values: z
      .record(
        z.union([
          z.string().max(2000),
          z.boolean(),
          z.number().finite(),
          z.array(z.string().max(100)).max(10),
        ]),
      )
      .default({}),
  })
  .strict();
const createSchema = inputSchema.extend({
  itemId: uuid,
  itemVersion: z.number().int().positive(),
  idempotencyKey: uuid,
});
const editSchema = inputSchema.extend({ expectedVersion: z.number().int().positive() });
const decisionSchema = z.object({
  decision: z.enum(['approve', 'reject', 'revoke']),
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().max(2000).default(''),
});
type Snapshot = {
  item: { id: string; version: number; title: string; definition: Definition };
  inputs: { reason?: string; durationDays?: number; values?: CatalogValues };
  requesterId: string;
};
type RequestRow = {
  id: string;
  organization_id: string;
  requester_id: string;
  ticket_id: string;
  version: number;
  revision: number;
  state: string;
  snapshot: Snapshot;
  snapshot_hash: string;
  current_approval_id: string;
};
type ApprovalRow = {
  id: string;
  approver_id: string;
  state: string;
  snapshot_hash: string;
  revision: number;
  expires_at: Date;
  reason: string | null;
};
const approverSql = `SELECT DISTINCT u.id,u.display_name AS name FROM app_user u JOIN role_binding rb ON rb.user_id=u.id JOIN role r ON r.id=rb.role_id
 WHERE rb.organization_id=$1 AND r.code='approver' AND rb.valid_from<=clock_timestamp()
 AND (rb.valid_until IS NULL OR rb.valid_until>clock_timestamp()) AND u.status='active' AND u.id<>$2`;
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const r = schema.safeParse(value);
  if (!r.success)
    throw Problems.validation(
      r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    );
  return r.data;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

export class CatalogController {
  constructor(
    private readonly pool: pg.Pool,
    private readonly storage: ObjectStorage,
    private readonly enabled: boolean,
  ) {}
  private async run<T>(
    auth: AuthenticatedRequest,
    fn: (c: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    if (!this.enabled) throw Problems.notFound('ローカル検証機能');
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.current_org',$1,true)", [auth.authz.organizationId]);
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
  private staff(auth: AuthenticatedRequest) {
    return hasRole(auth.authz, 'agent', 'org_admin', 'platform_admin');
  }
  private async event(
    c: pg.PoolClient,
    auth: AuthenticatedRequest,
    id: string,
    action: 'submitted' | 'changed' | 'approved' | 'rejected' | 'revoked' | 'simulated',
    revision: number,
  ) {
    await recordAuditEvent(c, {
      eventType: `request.${action}`,
      organizationId: auth.authz.organizationId,
      actorType: 'user',
      actorId: auth.userId,
      targetType: 'service_request',
      targetId: id,
      action: `request.${action}`,
      outcome: 'success',
      afterState: { revision, simulation: true },
    });
  }
  private async validateApprover(
    c: pg.PoolClient,
    organizationId: string,
    requesterId: string,
    approverId: string,
  ) {
    if (requesterId === approverId)
      throw Problems.forbidden('自分の申請を承認することはできません');
    if (
      !(await c.query(`${approverSql} AND u.id=$3`, [organizationId, requesterId, approverId]))
        .rowCount
    )
      throw Problems.forbidden('現在有効な同組織の承認者を選んでください');
  }
  async catalog(auth: AuthenticatedRequest) {
    return this.run(auth, async (c) => ({
      items: (
        await c.query(
          'SELECT id,version,title,description,definition FROM local_catalog_item WHERE organization_id=$1 AND active ORDER BY code',
          [auth.authz.organizationId],
        )
      ).rows,
      approvers: (await c.query(approverSql, [auth.authz.organizationId, auth.userId])).rows,
      canManage: hasRole(auth.authz, 'org_admin', 'platform_admin', 'catalog_editor'),
      simulation: true,
    }));
  }
  async list(auth: AuthenticatedRequest, query = new URLSearchParams()) {
    const filter = parse(
      z
        .object({
          q: z.string().trim().max(160).default(''),
          state: z
            .enum([
              'all',
              'pending',
              'approved',
              'rejected',
              'invalidated',
              'completed',
              'cancelled',
              'expired',
            ])
            .default('all'),
          view: z.enum(['all', 'mine', 'approvals']).default('all'),
          page: z.coerce.number().int().min(1).max(10000).default(1),
        })
        .strict(),
      Object.fromEntries(query),
    );
    return this.run(auth, async (c) => {
      const now = (await c.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
      const pageSize = 25;
      const values: unknown[] = [auth.authz.organizationId, this.staff(auth), auth.userId, now];
      const expired = "(q.state IN ('pending','approved') AND a.expires_at <= $4::timestamptz)";
      const conditions = [
        'q.organization_id=$1',
        '($2::boolean OR q.requester_id=$3 OR a.approver_id=$3)',
      ];
      if (filter.q) {
        values.push('%' + filter.q.replace(/([%_\\])/g, '\\$1') + '%');
        conditions.push(
          `(q.snapshot->'item'->>'title' ILIKE $${values.length} OR t.number ILIKE $${values.length} OR u.display_name ILIKE $${values.length})`,
        );
      }
      if (filter.view === 'mine') conditions.push('q.requester_id=$3');
      if (filter.view === 'approvals')
        conditions.push(
          hasRole(auth.authz, 'approver')
            ? `a.approver_id=$3 AND q.requester_id<>$3 AND q.state='pending' AND a.state='pending' AND NOT ${expired}`
            : 'false',
        );
      if (filter.state === 'expired') conditions.push(expired);
      else if (filter.state !== 'all') {
        values.push(filter.state);
        conditions.push(`q.state=$${values.length}`);
        if (['pending', 'approved'].includes(filter.state)) conditions.push(`NOT ${expired}`);
      }
      const from = `FROM local_service_request q
        JOIN local_request_approval a ON a.id=q.current_approval_id AND a.organization_id=q.organization_id
        JOIN ticket t ON t.id=q.ticket_id AND t.organization_id=q.organization_id
        JOIN app_user u ON u.id=q.requester_id JOIN app_user ap ON ap.id=a.approver_id
        WHERE ${conditions.join(' AND ')}`;
      const total = (
        await c.query<{ total: number }>(
          `SELECT count(*)::int AS total, $4::timestamptz AS as_of ${from}`,
          values,
        )
      ).rows[0]!.total;
      const items = (
        await c.query(
          `SELECT q.id,q.state,q.version,q.snapshot->'item'->>'title' AS title,
          q.created_at AS "createdAt",q.updated_at AS "updatedAt",a.state AS "approvalState",q.ticket_id AS "ticketId",t.number,
          u.display_name AS "requesterName",ap.display_name AS "approverName",a.expires_at AS "expiresAt",
          a.reason AS "decisionReason",q.requester_id=$3 AS own,a.approver_id=$3 AS assigned,${expired} AS expired
         ${from} ORDER BY q.updated_at DESC,q.id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
          [...values, pageSize, (filter.page - 1) * pageSize],
        )
      ).rows.map((row) => {
        const nextAction =
          row.state === 'completed'
            ? '結果を確認する'
            : row.state === 'cancelled'
              ? '取消内容を確認する'
              : row.expired
                ? row.own
                  ? '期限切れの内容を修正して再承認を依頼する'
                  : '申請者の再承認を待っています'
                : ['rejected', 'invalidated'].includes(row.state)
                  ? row.own
                    ? '理由を確認して修正・再申請する'
                    : '申請者の修正を待っています'
                  : row.state === 'pending'
                    ? row.assigned && !row.own && hasRole(auth.authz, 'approver')
                      ? '内容を確認して承認・却下を判断する'
                      : '承認者の判断を待っています'
                    : row.state === 'approved'
                      ? this.staff(auth)
                        ? '承認内容を確認して模擬実行へ進む'
                        : '担当者の模擬実行を待っています'
                      : '内容を確認する';
        return { ...row, nextAction };
      });
      return { items, total, page: filter.page, pageSize, appliedFilter: filter };
    });
  }
  private async lock(
    c: pg.PoolClient,
    auth: AuthenticatedRequest,
    id: string,
  ): Promise<RequestRow> {
    parse(uuid, id);
    const r = await c.query<RequestRow>(
      'SELECT * FROM local_service_request WHERE id=$1 AND organization_id=$2 FOR UPDATE',
      [id, auth.authz.organizationId],
    );
    if (!r.rows[0]) throw Problems.notFound('申請');
    return r.rows[0];
  }
  private async approval(c: pg.PoolClient, q: RequestRow): Promise<ApprovalRow> {
    const r = await c.query<ApprovalRow>(
      'SELECT * FROM local_request_approval WHERE id=$1 AND organization_id=$2 AND request_id=$3',
      [q.current_approval_id, q.organization_id, q.id],
    );
    if (!r.rows[0]) throw Problems.conflict('承認記録を確認できません');
    return r.rows[0];
  }
  private visible(auth: AuthenticatedRequest, q: RequestRow, a: ApprovalRow) {
    if (q.requester_id !== auth.userId && a.approver_id !== auth.userId && !this.staff(auth))
      throw Problems.notFound('申請');
  }
  private async checklistProgress(c: pg.PoolClient, q: RequestRow) {
    return (
      (
        await c.query<{
          version: number;
          completion: Record<
            string,
            { completed: boolean; completedBy: string; completedAt: string }
          >;
        }>(
          'SELECT version,completion FROM local_request_checklist_progress WHERE request_id=$1 AND organization_id=$2 AND request_revision=$3',
          [q.id, q.organization_id, q.revision],
        )
      ).rows[0] ?? { version: 1, completion: {} }
    );
  }
  private approvalMatches(q: RequestRow, approval: ApprovalRow) {
    return (
      approval.snapshot_hash === q.snapshot_hash &&
      hash(q.snapshot) === q.snapshot_hash &&
      approval.revision === q.revision &&
      (!q.snapshot.item.definition.approval ||
        q.snapshot.item.definition.approval.approverId === approval.approver_id)
    );
  }
  private async fulfillment(
    c: pg.PoolClient,
    auth: AuthenticatedRequest,
    q: RequestRow,
    approval: ApprovalRow,
  ) {
    const definition = q.snapshot.item.definition,
      progress = await this.checklistProgress(c, q);
    const owner = definition.ownerId
      ? (
          await c.query('SELECT display_name AS name FROM app_user WHERE id=$1', [
            definition.ownerId,
          ])
        ).rows[0]
      : undefined;
    const group = definition.fulfillmentGroupId
      ? (
          await c.query('SELECT name FROM assignment_group WHERE id=$1 AND organization_id=$2', [
            definition.fulfillmentGroupId,
            q.organization_id,
          ])
        ).rows[0]
      : undefined;
    return {
      ownerName: owner?.name ?? null,
      groupName: group?.name ?? null,
      checklistVersion: progress.version,
      checks: (definition.checklist ?? []).map((item) => ({
        ...item,
        completed: progress.completion[item.key]?.completed === true,
      })),
      canUpdate:
        this.staff(auth) &&
        q.state === 'approved' &&
        approval.state === 'approved' &&
        approval.expires_at.getTime() > Date.now() &&
        this.approvalMatches(q, approval),
    };
  }
  async detail(auth: AuthenticatedRequest, id: string) {
    return this.run(auth, async (c) => {
      const q = await this.lock(c, auth, id),
        a = await this.approval(c, q);
      this.visible(auth, q, a);
      const names = (
        await c.query<{ id: string; display_name: string }>(
          'SELECT id,display_name FROM app_user WHERE id=ANY($1::uuid[])',
          [[q.requester_id, a.approver_id]],
        )
      ).rows;
      return {
        requesterName: names.find((u) => u.id === q.requester_id)?.display_name ?? '申請者',
        approverName: names.find((u) => u.id === a.approver_id)?.display_name ?? '承認者',
        request: {
          id: q.id,
          state: q.state,
          version: q.version,
          revision: q.revision,
          snapshot: q.snapshot,
          snapshotHash: q.snapshot_hash,
          requesterId: q.requester_id,
          ticketId: q.ticket_id,
        },
        approval: a,
        history: (
          await c.query(
            `SELECT a.id,a.state,a.revision,a.approver_id AS "approverId",u.display_name AS "approverName",a.reason,a.decided_at AS "decidedAt",a.expires_at AS "expiresAt",r.snapshot->'inputs' AS inputs,r.snapshot->'item' AS item
             FROM local_request_approval a JOIN local_request_revision r ON r.request_id=a.request_id AND r.organization_id=a.organization_id AND r.revision=a.revision JOIN app_user u ON u.id=a.approver_id
             WHERE a.request_id=$1 AND a.organization_id=$2 ORDER BY a.revision`,
            [id, q.organization_id],
          )
        ).rows,
        receipt:
          (
            await c.query(
              'SELECT id,result,simulation,started_at AS "startedAt",finished_at AS "finishedAt",idempotency_key AS "idempotencyKey",snapshot_hash AS "snapshotHash" FROM local_simulation_receipt WHERE request_id=$1 AND organization_id=$2',
              [id, q.organization_id],
            )
          ).rows[0] ?? null,
        approvers: (await c.query(approverSql, [q.organization_id, q.requester_id])).rows,
        fulfillment: await this.fulfillment(c, auth, q, a),
        simulation: true,
      };
    });
  }
  private async addApproval(
    c: pg.PoolClient,
    auth: AuthenticatedRequest,
    q: RequestRow,
    approverId: string,
  ) {
    await c.query(
      'INSERT INTO local_request_revision(request_id,organization_id,revision,snapshot,snapshot_hash,changed_by) VALUES($1,$2,$3,$4,$5,$6)',
      [q.id, q.organization_id, q.revision, q.snapshot, q.snapshot_hash, auth.userId],
    );
    await c.query(
      "INSERT INTO local_request_approval(id,organization_id,request_id,revision,snapshot_hash,approver_id,state,expires_at) VALUES($1,$2,$3,$4,$5,$6,'pending',clock_timestamp()+interval '72 hours')",
      [q.current_approval_id, q.organization_id, q.id, q.revision, q.snapshot_hash, approverId],
    );
  }
  async create(auth: AuthenticatedRequest, value: unknown) {
    const input = parse(createSchema, value);
    return this.run(auth, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `${auth.authz.organizationId}:${auth.userId}:${input.idempotencyKey}`,
      ]);
      const previous = (
        await c.query<RequestRow>(
          'SELECT * FROM local_service_request WHERE organization_id=$1 AND requester_id=$2 AND idempotency_key=$3',
          [auth.authz.organizationId, auth.userId, input.idempotencyKey],
        )
      ).rows[0];
      if (previous) {
        const original = (
          await c.query<{ snapshot: Snapshot }>(
            'SELECT snapshot FROM local_request_revision WHERE request_id=$1 AND organization_id=$2 AND revision=1',
            [previous.id, previous.organization_id],
          )
        ).rows[0]!.snapshot;
        const originalApprover = (
          await c.query<{ approver_id: string }>(
            'SELECT approver_id FROM local_request_approval WHERE request_id=$1 AND revision=1',
            [previous.id],
          )
        ).rows[0]!.approver_id;
        const normalized = validateRequestInputs(original.item.definition, input);
        if (
          original.item.id !== input.itemId ||
          original.item.version !== input.itemVersion ||
          original.inputs.reason !== normalized.reason ||
          original.inputs.durationDays !== normalized.durationDays ||
          originalApprover !== input.approverId ||
          canonical(original.inputs.values ?? {}) !==
            canonical(validateValues(original.item.definition, input.values))
        )
          throw Problems.conflict('同じ送信キーで異なる申請内容は送信できません');
        return { id: previous.id, ticketId: previous.ticket_id, replayed: true };
      }
      const item = (
        await c.query<{ id: string; version: number; title: string; definition: unknown }>(
          'SELECT * FROM local_catalog_item WHERE id=$1 AND organization_id=$2 AND active FOR SHARE',
          [input.itemId, auth.authz.organizationId],
        )
      ).rows[0];
      if (!item) throw Problems.notFound('カタログ');
      if (item.version !== input.itemVersion)
        throw Problems.conflict('カタログが更新されました。画面を更新してください');
      const definition = parse(definitionSchema, item.definition);
      if (
        definition.fulfillmentGroupId &&
        !(
          await c.query(
            'SELECT id FROM assignment_group WHERE id=$1 AND organization_id=$2 AND active FOR SHARE',
            [definition.fulfillmentGroupId, auth.authz.organizationId],
          )
        ).rowCount
      )
        throw Problems.validation([
          {
            field: 'fulfillmentGroupId',
            message: '処理グループが現在有効ではありません。担当者へ確認してください',
          },
        ]);
      const inputs = validateRequestInputs(definition, input);
      const values = validateValues(definition, input.values);
      if (definition.approval && definition.approval.approverId !== input.approverId)
        throw Problems.forbidden('設定された固定承認者を変更できません');
      await this.validateApprover(c, auth.authz.organizationId, auth.userId, input.approverId);
      const snapshot: Snapshot = {
        item: { id: item.id, version: item.version, title: item.title, definition },
        inputs: {
          ...inputs,
          ...(definition.fields ? { values } : {}),
        },
        requesterId: auth.userId,
      };
      const ticket = await new TicketService(c).create(
        auth.authz,
        {
          kind: 'request',
          subject: item.title,
          body: [
            'ローカル模擬申請（外部変更なし）',
            ...(inputs.durationDays === undefined ? [] : [`利用日数: ${inputs.durationDays}`]),
            ...(inputs.reason === undefined ? [] : [`理由: ${inputs.reason}`]),
          ].join('\n'),
          impact: 'low',
          urgency: 'low',
        },
        definition.fulfillmentGroupId
          ? { groupId: definition.fulfillmentGroupId, itemId: item.id, revision: item.version }
          : undefined,
      );
      const q: RequestRow = {
        id: uuidv7(),
        organization_id: auth.authz.organizationId,
        requester_id: auth.userId,
        ticket_id: ticket.id,
        version: 1,
        revision: 1,
        state: 'pending',
        snapshot,
        snapshot_hash: hash(snapshot),
        current_approval_id: uuidv7(),
      };
      await c.query(
        'INSERT INTO local_service_request(id,organization_id,item_id,requester_id,ticket_id,idempotency_key,version,revision,state,snapshot,snapshot_hash,current_approval_id) VALUES($1,$2,$3,$4,$5,$6,1,1,$7,$8,$9,$10)',
        [
          q.id,
          q.organization_id,
          item.id,
          q.requester_id,
          ticket.id,
          input.idempotencyKey,
          q.state,
          snapshot,
          q.snapshot_hash,
          q.current_approval_id,
        ],
      );
      await this.addApproval(c, auth, q, input.approverId);
      await this.event(c, auth, q.id, 'submitted', 1);
      return { id: q.id, ticketId: ticket.id, replayed: false };
    });
  }
  async edit(auth: AuthenticatedRequest, id: string, value: unknown) {
    const input = parse(editSchema, value);
    return this.run(auth, async (c) => {
      const q = await this.lock(c, auth, id);
      if (q.requester_id !== auth.userId) throw Problems.notFound('申請');
      if (q.version !== input.expectedVersion) throw Problems.stale('申請');
      if (['completed', 'cancelled'].includes(q.state))
        throw Problems.conflict('完了・取消済みの申請は変更できません');
      const definition = parse(definitionSchema, q.snapshot.item.definition);
      const inputs = validateRequestInputs(definition, input);
      const values = validateValues(definition, input.values);
      if (definition.approval && definition.approval.approverId !== input.approverId)
        throw Problems.forbidden('この申請版の固定承認者を変更できません');
      await this.validateApprover(c, q.organization_id, q.requester_id, input.approverId);
      await c.query(
        "UPDATE local_request_approval SET state='invalidated',reason='申請内容の変更による再承認',decided_at=clock_timestamp() WHERE id=$1 AND state IN ('pending','approved')",
        [q.current_approval_id],
      );
      q.snapshot = {
        ...q.snapshot,
        inputs: {
          ...inputs,
          ...(definition.fields ? { values } : {}),
        },
      };
      q.snapshot_hash = hash(q.snapshot);
      q.revision += 1;
      q.version += 1;
      q.current_approval_id = uuidv7();
      q.state = 'pending';
      await this.addApproval(c, auth, q, input.approverId);
      await c.query(
        "UPDATE local_service_request SET snapshot=$2,snapshot_hash=$3,revision=$4,version=$5,current_approval_id=$6,state='pending',updated_at=clock_timestamp() WHERE id=$1",
        [id, q.snapshot, q.snapshot_hash, q.revision, q.version, q.current_approval_id],
      );
      await this.event(c, auth, id, 'changed', q.revision);
      return { id, version: q.version };
    });
  }
  async decide(auth: AuthenticatedRequest, id: string, value: unknown) {
    const input = parse(decisionSchema, value);
    return this.run(auth, async (c) => {
      const q = await this.lock(c, auth, id),
        a = await this.approval(c, q);
      this.visible(auth, q, a);
      if (input.decision === 'revoke') {
        if (a.approver_id !== auth.userId && !hasRole(auth.authz, 'org_admin', 'platform_admin'))
          throw Problems.forbidden();
      } else {
        requireRole(auth.authz, 'approver');
        if (a.approver_id !== auth.userId)
          throw Problems.forbidden('指定された承認者だけが決定できます');
      }
      if (q.requester_id === auth.userId)
        throw Problems.forbidden('自己承認・自己決定はできません');
      if (q.version !== input.expectedVersion) throw Problems.stale('申請');
      if (input.decision === 'revoke') {
        if (q.state !== 'approved' || a.state !== 'approved')
          throw Problems.conflict('承認済みの申請だけ取り消せます');
        if (!input.reason)
          throw Problems.validation([{ field: 'reason', message: '取消理由を入力してください' }]);
        await c.query(
          "UPDATE local_request_approval SET state='invalidated',reason=$2,decided_at=clock_timestamp() WHERE id=$1",
          [a.id, input.reason],
        );
        await c.query(
          "UPDATE local_service_request SET state='invalidated',version=version+1,updated_at=clock_timestamp() WHERE id=$1",
          [id],
        );
        await this.event(c, auth, id, 'revoked', q.revision);
        return { id };
      }
      if (q.state !== 'pending' || a.state !== 'pending' || a.expires_at.getTime() <= Date.now())
        throw Problems.conflict('承認待ちではないか、承認期限が過ぎています');
      await this.validateApprover(c, q.organization_id, q.requester_id, a.approver_id);
      if (
        q.snapshot.item.definition.approval &&
        q.snapshot.item.definition.approval.approverId !== a.approver_id
      )
        throw Problems.conflict('固定承認者が申請版と一致しません');
      if (
        a.snapshot_hash !== q.snapshot_hash ||
        hash(q.snapshot) !== q.snapshot_hash ||
        a.revision !== q.revision
      )
        throw Problems.conflict('申請内容のハッシュが承認対象と一致しません');
      if (input.decision === 'reject' && !input.reason)
        throw Problems.validation([{ field: 'reason', message: '却下理由を入力してください' }]);
      const state = input.decision === 'approve' ? 'approved' : 'rejected';
      await c.query(
        'UPDATE local_request_approval SET state=$2,reason=$3,decided_at=clock_timestamp() WHERE id=$1',
        [a.id, state, input.reason || null],
      );
      await c.query(
        'UPDATE local_service_request SET state=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1',
        [id, state],
      );
      await this.event(c, auth, id, state, q.revision);
      return { id, state };
    });
  }
  async updateChecklist(auth: AuthenticatedRequest, id: string, value: unknown) {
    requireRole(auth.authz, 'agent', 'org_admin', 'platform_admin');
    const input = parse(
      z
        .object({
          requestRevision: z.number().int().positive(),
          expectedVersion: z.number().int().positive(),
          key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
          completed: z.boolean(),
        })
        .strict(),
      value,
    );
    return this.run(auth, async (c) => {
      const q = await this.lock(c, auth, id),
        approval = await this.approval(c, q);
      if (q.revision !== input.requestRevision) throw Problems.stale('申請の作業チェック');
      if (
        q.state !== 'approved' ||
        approval.state !== 'approved' ||
        approval.expires_at.getTime() <= Date.now()
      )
        throw Problems.conflict('有効な承認済み申請だけ作業チェックを更新できます');
      if (!this.approvalMatches(q, approval))
        throw Problems.conflict('承認対象の定義・内容・版が申請と一致しません');
      await this.validateApprover(c, q.organization_id, q.requester_id, approval.approver_id);
      if (!(q.snapshot.item.definition.checklist ?? []).some((item) => item.key === input.key))
        throw Problems.validation([
          { field: 'key', message: '申請時の定義にある作業項目を選んでください' },
        ]);
      const progress = await this.checklistProgress(c, q);
      if (progress.version !== input.expectedVersion) throw Problems.stale('作業チェック');
      const nextVersion = progress.version + 1;
      const completion = {
        ...progress.completion,
        [input.key]: {
          completed: input.completed,
          completedBy: auth.userId,
          completedAt: new Date().toISOString(),
        },
      };
      await c.query(
        'INSERT INTO local_request_checklist_progress(request_id,organization_id,request_revision,version,completion,updated_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(request_id,organization_id,request_revision) DO UPDATE SET version=EXCLUDED.version,completion=EXCLUDED.completion,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()',
        [q.id, q.organization_id, q.revision, nextVersion, completion, auth.userId],
      );
      await recordAuditEvent(c, {
        eventType: 'request.checklist.updated',
        organizationId: q.organization_id,
        actorType: 'user',
        actorId: auth.userId,
        targetType: 'service_request',
        targetId: q.id,
        action: 'request.checklist.updated',
        outcome: 'success',
        beforeState: {
          requestRevision: q.revision,
          checklistVersion: progress.version,
          key: input.key,
          completed: progress.completion[input.key]?.completed === true,
        },
        afterState: {
          requestRevision: q.revision,
          checklistVersion: nextVersion,
          key: input.key,
          completed: input.completed,
        },
      });
      return { id, checklistVersion: nextVersion };
    });
  }
  async simulate(auth: AuthenticatedRequest, id: string, value: unknown) {
    requireRole(auth.authz, 'agent', 'org_admin', 'platform_admin');
    const input = parse(z.object({ expectedVersion: z.number().int().positive() }), value);
    return this.run(auth, async (c) => {
      const q = await this.lock(c, auth, id);
      const existing = (
        await c.query(
          'SELECT id,result FROM local_simulation_receipt WHERE request_id=$1 AND organization_id=$2',
          [id, q.organization_id],
        )
      ).rows[0];
      if (existing) return { receipt: existing, replayed: true };
      if (q.version !== input.expectedVersion) throw Problems.stale('申請');
      const a = await this.approval(c, q);
      if (q.state !== 'approved' || a.state !== 'approved' || a.expires_at.getTime() <= Date.now())
        throw Problems.conflict('有効な承認がありません');
      await this.validateApprover(c, q.organization_id, q.requester_id, a.approver_id);
      if (
        a.snapshot_hash !== q.snapshot_hash ||
        hash(q.snapshot) !== q.snapshot_hash ||
        a.revision !== q.revision
      )
        throw Problems.conflict('承認後に申請内容が変わっています');
      const definition = parse(definitionSchema, q.snapshot.item.definition);
      validateRequestInputs(definition, q.snapshot.inputs);
      validateValues(definition, q.snapshot.inputs.values ?? {});
      if (definition.approval && definition.approval.approverId !== a.approver_id)
        throw Problems.conflict('固定承認者が申請版と一致しません');
      const progress = await this.checklistProgress(c, q);
      if (
        (definition.checklist ?? []).some(
          (item) => item.required && progress.completion[item.key]?.completed !== true,
        )
      )
        throw Problems.conflict('必須の作業チェックを完了してから模擬実行してください');
      const key = hash({
        requestId: id,
        revision: q.revision,
        step: 'local-simulation',
        action: definition.action,
        target: definition.targetLabel,
        subject: q.requester_id,
      });
      const receiptId = uuidv7();
      const result = {
        mode: 'local_simulation',
        status: 'succeeded',
        action: definition.action,
        targetLabel: definition.targetLabel,
        subjectId: q.requester_id,
        ...(q.snapshot.inputs.durationDays === undefined
          ? {}
          : { durationDays: q.snapshot.inputs.durationDays }),
        externalChanges: 0,
        summary:
          '承認済みの入力を検証し模擬結果を保存しました。外部のアカウント・権限は変更していません。',
      };
      await c.query(
        'INSERT INTO local_simulation_receipt(id,organization_id,request_id,approval_id,snapshot_hash,idempotency_key,simulation,result) VALUES($1,$2,$3,$4,$5,$6,true,$7)',
        [receiptId, q.organization_id, id, a.id, q.snapshot_hash, key, result],
      );
      const tickets = new TicketService(c);
      let ticket = await tickets.findById(auth.authz, q.ticket_id);
      if (['closed', 'cancelled', 'merged'].includes(ticket.state))
        throw Problems.conflict('関連チケットが完了・取消・統合済みです');
      if (ticket.state === 'new') {
        await tickets.assign(auth.authz, ticket.id, auth.userId, ticket.version);
        ticket = await tickets.transition(auth.authz, {
          ticketId: ticket.id,
          to: 'assigned',
          reason: 'assign',
        });
      }
      if (ticket.state === 'assigned')
        ticket = await tickets.transition(auth.authz, {
          ticketId: ticket.id,
          to: 'in_progress',
          reason: 'start',
        });
      if (ticket.state === 'pending')
        ticket = await tickets.transition(auth.authz, {
          ticketId: ticket.id,
          to: 'in_progress',
          reason: 'resume',
        });
      if (ticket.state === 'in_progress')
        await tickets.transition(auth.authz, {
          ticketId: ticket.id,
          to: 'resolved',
          reason: 'resolve',
        });
      await new CollaborationService(c, this.storage).addComment(auth.authz, {
        ticketId: ticket.id,
        visibility: 'public',
        body: [
          'ローカル模擬実行が完了しました。外部変更は0件です。',
          `対象: ${definition.targetLabel}`,
          ...(q.snapshot.inputs.durationDays === undefined
            ? []
            : [`利用日数: ${q.snapshot.inputs.durationDays}`]),
          `結果証跡: ${receiptId}`,
        ].join('\n'),
      });
      await c.query(
        "UPDATE local_service_request SET state='completed',version=version+1,updated_at=clock_timestamp() WHERE id=$1",
        [id],
      );
      await this.event(c, auth, id, 'simulated', q.revision);
      return { receipt: { id: receiptId, result }, replayed: false };
    });
  }
}
