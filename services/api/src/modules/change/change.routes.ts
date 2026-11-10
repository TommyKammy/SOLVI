import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { Problems } from '@solvi/shared';
import { hasRole, requireRole } from '../../common/authz/authz.js';
import { recordAuditEvent, uuidv7, type AuditEventType } from '../../common/audit/audit.js';
import { TicketService } from '../ticket/ticket.service.js';
import type { AuthenticatedRequest } from '../auth/auth.routes.js';

const uuid = z.string().uuid();
const date = z.string().datetime({ offset: true }).nullable().default(null);
const text = z.string().trim().max(4000).default('');
const planSchema = z.object({
  type: z.literal('normal').default('normal'),
  title: z.string().trim().min(1).max(160),
  ticketId: uuid,
  assetIds: z.array(uuid).min(1).max(10),
  ownerId: uuid,
  approverId: uuid.nullable().default(null),
  purpose: text,
  impact: text,
  risk: z.enum(['low', 'medium', 'high']).default('low'),
  implementationPlan: text,
  testPlan: text,
  backoutPlan: text,
  plannedStart: date,
  plannedEnd: date,
});
const baseSchema = z.object({
  expectedVersion: z.number().int().positive(),
  commandKey: uuid,
  reason: z.string().trim().max(1000).default(''),
});
const reviewed = { approvalId: uuid, snapshotHash: z.string().length(64) };
const schemas = {
  edit: planSchema
    .merge(baseSchema)
    .extend({ reason: z.string().trim().min(1).max(1000) })
    .strict(),
  submit: baseSchema.strict(),
  approve: baseSchema.extend({ ...reviewed, reason: z.string().trim().min(1).max(1000) }).strict(),
  reject: baseSchema.extend({ ...reviewed, reason: z.string().trim().min(1).max(1000) }).strict(),
  schedule: baseSchema
    .extend({
      ...reviewed,
      confirmed: z.literal(true),
      conflictIds: z.array(uuid).max(100).default([]),
      reason: z.string().trim().min(1).max(1000),
    })
    .strict(),
  start: baseSchema.extend({ ...reviewed, confirmed: z.literal(true) }).strict(),
  result: baseSchema
    .extend({
      outcome: z.enum(['completed', 'failed']),
      summary: z.string().trim().min(1).max(4000),
      testResults: z.string().trim().min(1).max(4000),
      backoutPerformed: z.boolean(),
      backoutReason: z.string().trim().min(1).max(4000),
    })
    .strict(),
  pir: baseSchema
    .extend({
      rootCause: z.string().trim().min(1).max(4000),
      lessons: z.string().trim().min(1).max(4000),
      prevention: z.string().trim().min(1).max(4000),
    })
    .strict(),
  cancel: baseSchema.extend({ reason: z.string().trim().min(1).max(1000) }).strict(),
};
export type ChangeCommand = keyof typeof schemas;
type Input = z.infer<typeof planSchema>;
type State =
  | 'draft'
  | 'review'
  | 'approved'
  | 'rejected'
  | 'scheduled'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled';
type Target = {
  id: string;
  assetTag: string;
  name: string;
  kind: string;
  state: string;
  version: number;
};
type Person = { id: string; name: string };
type Snapshot = Pick<
  Input,
  | 'type'
  | 'title'
  | 'purpose'
  | 'impact'
  | 'risk'
  | 'implementationPlan'
  | 'testPlan'
  | 'backoutPlan'
  | 'plannedStart'
  | 'plannedEnd'
> & {
  ticket: { id: string; number: string; subject: string };
  assets: Target[];
  owner: Person;
  approver: Person | null;
};
type Row = {
  id: string;
  organization_id: string;
  sequence_no: number;
  ticket_id: string;
  owner_id: string;
  created_by: string;
  creation_hash: string;
  state: State;
  version: number;
  revision: number;
  snapshot: Snapshot;
  snapshot_hash: string;
  current_approval_id: string | null;
  started_at: Date | null;
  created_at: Date;
  updated_at: Date;
};
type Approval = {
  id: string;
  change_id: string;
  revision: number;
  snapshot_hash: string;
  approver_id: string;
  expires_at: Date;
  decision: 'approved' | 'rejected' | null;
};
const labels = {
  purpose: '目的',
  impact: '影響',
  implementationPlan: '実施計画',
  testPlan: 'テスト計画',
  backoutPlan: '切戻し計画',
};
const states: State[] = [
  'draft',
  'review',
  'approved',
  'rejected',
  'scheduled',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
];
const eventTypes: Record<ChangeCommand, AuditEventType> = {
  edit: 'change.edited',
  submit: 'change.submitted',
  approve: 'change.approved',
  reject: 'change.rejected',
  schedule: 'change.scheduled',
  start: 'change.started',
  result: 'change.result.recorded',
  pir: 'change.pir.recorded',
  cancel: 'change.cancelled',
};
const memberSql = `SELECT DISTINCT u.id,u.display_name AS name FROM app_user u JOIN role_binding rb ON rb.user_id=u.id JOIN role r ON r.id=rb.role_id
 WHERE rb.organization_id=$1 AND r.code=ANY($2::text[]) AND rb.valid_from<=clock_timestamp() AND (rb.valid_until IS NULL OR rb.valid_until>clock_timestamp()) AND u.status='active'`;
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const p = schema.safeParse(value);
  if (!p.success)
    throw Problems.validation(
      p.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    );
  return p.data;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
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
function hash(value: unknown) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function number(r: Row) {
  return 'CHG-' + String(r.sequence_no).padStart(6, '0');
}
function summary(r: Row) {
  return {
    id: r.id,
    number: number(r),
    title: r.snapshot.title,
    type: 'normal',
    state: r.state,
    version: r.version,
    revision: r.revision,
    plannedStart: r.snapshot.plannedStart,
    plannedEnd: r.snapshot.plannedEnd,
    ownerName: r.snapshot.owner.name,
    ticket: r.snapshot.ticket,
    assets: r.snapshot.assets,
    updatedAt: r.updated_at,
  };
}

export class ChangeController {
  constructor(
    private readonly pool: pg.Pool,
    private readonly enabled: boolean,
  ) {}
  private all(auth: AuthenticatedRequest) {
    return hasRole(auth.authz, 'agent', 'org_admin', 'platform_admin', 'auditor');
  }
  private staff(auth: AuthenticatedRequest) {
    return hasRole(auth.authz, 'agent', 'org_admin', 'platform_admin');
  }
  private manages(auth: AuthenticatedRequest, r: Row) {
    return (
      this.staff(auth) &&
      (hasRole(auth.authz, 'org_admin', 'platform_admin') ||
        [r.created_by, r.owner_id].includes(auth.userId))
    );
  }
  private canRead(auth: AuthenticatedRequest, r: Row) {
    return (
      this.all(auth) ||
      (hasRole(auth.authz, 'approver') &&
        !!r.current_approval_id &&
        r.snapshot.approver?.id === auth.userId)
    );
  }
  private async run<T>(
    auth: AuthenticatedRequest,
    fn: (c: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    if (!this.enabled) throw Problems.notFound('ローカル変更管理');
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.current_org',$1,true)", [auth.authz.organizationId]);
      const result = await fn(c);
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      if (['23505', '40001', '40P01'].includes((e as { code?: string }).code ?? ''))
        throw Problems.conflict('変更が競合しました。最新の内容を読み直してください');
      throw e;
    } finally {
      c.release();
    }
  }
  private async row(c: pg.PoolClient, auth: AuthenticatedRequest, id: string, lock = false) {
    parse(uuid, id);
    const r = (
      await c.query<Row>(
        'SELECT * FROM local_change WHERE id=$1 AND organization_id=$2' +
          (lock ? ' FOR UPDATE' : ''),
        [id, auth.authz.organizationId],
      )
    ).rows[0];
    if (!r || !this.canRead(auth, r)) throw Problems.notFound('変更');
    return r;
  }
  private async person(c: pg.PoolClient, org: string, id: string, codes: string[]) {
    return (await c.query<Person>(memberSql + ' AND u.id=$3', [org, codes, id])).rows[0];
  }
  private async snapshot(
    c: pg.PoolClient,
    auth: AuthenticatedRequest,
    input: Input,
  ): Promise<Snapshot> {
    if (new Set(input.assetIds).size !== input.assetIds.length)
      throw Problems.validation([{ field: 'assetIds', message: '同じ資産を複数選べません' }]);
    const ticket = await new TicketService(c).findById(auth.authz, input.ticketId);
    const assets = (
      await c.query<Target>(
        'SELECT id,asset_tag AS "assetTag",name,kind,state,version FROM asset WHERE organization_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE',
        [auth.authz.organizationId, input.assetIds],
      )
    ).rows;
    if (assets.length !== input.assetIds.length) throw Problems.notFound('対象資産');
    if (assets.some((a) => a.state === 'retired'))
      throw Problems.conflict('廃止した資産は新しい変更の対象にできません');
    const owner = await this.person(c, auth.authz.organizationId, input.ownerId, [
      'agent',
      'org_admin',
      'platform_admin',
    ]);
    if (!owner)
      throw Problems.validation([
        { field: 'ownerId', message: '同じ組織の有効な担当者を選んでください' },
      ]);
    let approver: Person | null = null;
    if (input.approverId) {
      if ([auth.userId, input.ownerId].includes(input.approverId))
        throw Problems.forbidden('作成者・実施担当者は自分の変更を承認できません');
      approver =
        (await this.person(c, auth.authz.organizationId, input.approverId, ['approver'])) ?? null;
      if (!approver)
        throw Problems.validation([
          { field: 'approverId', message: '同じ組織の有効な承認者を選んでください' },
        ]);
    }
    return {
      type: 'normal',
      title: input.title,
      purpose: input.purpose,
      impact: input.impact,
      risk: input.risk,
      implementationPlan: input.implementationPlan,
      testPlan: input.testPlan,
      backoutPlan: input.backoutPlan,
      plannedStart: input.plannedStart ? new Date(input.plannedStart).toISOString() : null,
      plannedEnd: input.plannedEnd ? new Date(input.plannedEnd).toISOString() : null,
      ticket: { id: ticket.id, number: ticket.number, subject: ticket.subject },
      assets,
      owner,
      approver,
    };
  }
  private planIssues(s: Snapshot, now: Date) {
    const issues: string[] = [];
    for (const [key, label] of Object.entries(labels))
      if (!s[key as keyof typeof labels].trim()) issues.push(`${label}を記入してください`);
    if (!s.approver) issues.push('承認者を選んでください');
    if (!s.plannedStart || !s.plannedEnd || new Date(s.plannedStart) >= new Date(s.plannedEnd))
      issues.push('予定開始と終了を正しい順序で指定してください');
    else if (new Date(s.plannedEnd) <= now)
      issues.push('予定終了を過ぎています。予定を見直して再申請してください');
    return issues;
  }
  private async readiness(c: pg.PoolClient, auth: AuthenticatedRequest, r: Row, lock = false) {
    const now = (await c.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
    const issues = this.planIssues(r.snapshot, now);
    const revision = (
      await c.query<{ snapshot: Snapshot; snapshot_hash: string }>(
        'SELECT snapshot,snapshot_hash FROM local_change_revision WHERE change_id=$1 AND organization_id=$2 AND revision=$3',
        [r.id, r.organization_id, r.revision],
      )
    ).rows[0];
    if (
      !revision ||
      hash(r.snapshot) !== r.snapshot_hash ||
      revision.snapshot_hash !== r.snapshot_hash ||
      hash(revision.snapshot) !== r.snapshot_hash
    )
      issues.push('計画と不変履歴が一致しません');
    const linked = (
      await c.query<{ asset_id: string }>(
        'SELECT asset_id FROM local_change_asset WHERE change_id=$1 AND organization_id=$2 AND active',
        [r.id, r.organization_id],
      )
    ).rows
      .map((a) => a.asset_id)
      .sort();
    if (
      canonical(linked) !== canonical(r.snapshot.assets.map((a) => a.id).sort()) ||
      r.ticket_id !== r.snapshot.ticket.id ||
      r.owner_id !== r.snapshot.owner.id
    )
      issues.push('対象の関連と承認計画が一致しません');
    const targets = (
      await c.query<Target>(
        'SELECT id,asset_tag AS "assetTag",name,kind,state,version FROM asset WHERE organization_id=$1 AND id=ANY($2::uuid[]) ORDER BY id' +
          (lock ? ' FOR SHARE' : ''),
        [r.organization_id, r.snapshot.assets.map((a) => a.id)],
      )
    ).rows;
    if (
      targets.length !== r.snapshot.assets.length ||
      r.snapshot.assets.some(
        (a) =>
          !targets.some((t) => t.id === a.id && t.version === a.version && t.state !== 'retired'),
      )
    )
      issues.push(
        '対象資産が計画作成後に変わりました。計画を編集し、対象を再確認して再申請してください',
      );
    if (
      !(await this.person(c, r.organization_id, r.owner_id, [
        'agent',
        'org_admin',
        'platform_admin',
      ]))
    )
      issues.push('実施担当者が現在有効ではありません');
    if (
      r.snapshot.approver &&
      !(await this.person(c, r.organization_id, r.snapshot.approver.id, ['approver']))
    )
      issues.push('承認者が現在有効ではありません');
    if (r.snapshot.approver && [r.created_by, r.owner_id].includes(r.snapshot.approver.id))
      issues.push('作成者・実施担当者は自己承認できません');
    return {
      issues,
      now,
      withinWindow:
        !!r.snapshot.plannedStart &&
        !!r.snapshot.plannedEnd &&
        new Date(r.snapshot.plannedStart) <= now &&
        now < new Date(r.snapshot.plannedEnd),
    };
  }
  private async assertReady(c: pg.PoolClient, auth: AuthenticatedRequest, r: Row) {
    const ready = await this.readiness(c, auth, r, true);
    if (ready.issues.length) throw Problems.conflict(ready.issues.join(' / '));
    return ready;
  }
  private async approval(c: pg.PoolClient, r: Row) {
    if (!r.current_approval_id) throw Problems.conflict('現在の承認依頼がありません');
    const a = (
      await c.query<Approval>(
        'SELECT a.*,d.decision FROM local_change_approval a LEFT JOIN local_change_decision d ON d.approval_id=a.id AND d.organization_id=a.organization_id WHERE a.id=$1 AND a.organization_id=$2',
        [r.current_approval_id, r.organization_id],
      )
    ).rows[0];
    if (
      !a ||
      a.change_id !== r.id ||
      a.revision !== r.revision ||
      a.snapshot_hash !== r.snapshot_hash ||
      a.approver_id !== r.snapshot.approver?.id
    )
      throw Problems.conflict('承認内容と現在の計画が一致しません。再申請してください');
    return a;
  }
  private matchReviewed(r: Row, input: { approvalId: string; snapshotHash: string }) {
    if (input.approvalId !== r.current_approval_id || input.snapshotHash !== r.snapshot_hash)
      throw Problems.conflict('確認した承認・計画が現在の内容と一致しません');
  }
  private async links(c: pg.PoolClient, r: Row) {
    await c.query(
      'UPDATE local_change_asset SET active=false WHERE change_id=$1 AND organization_id=$2',
      [r.id, r.organization_id],
    );
    for (const a of r.snapshot.assets)
      await c.query(
        'INSERT INTO local_change_asset(change_id,asset_id,organization_id,active) VALUES($1,$2,$3,true) ON CONFLICT(change_id,asset_id,organization_id) DO UPDATE SET active=true',
        [r.id, a.id, r.organization_id],
      );
  }
  private async revision(c: pg.PoolClient, auth: AuthenticatedRequest, r: Row, reason: string) {
    await c.query(
      'INSERT INTO local_change_revision(change_id,organization_id,revision,snapshot,snapshot_hash,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [r.id, r.organization_id, r.revision, r.snapshot, r.snapshot_hash, reason, auth.userId],
    );
  }
  private async event(
    c: pg.PoolClient,
    auth: AuthenticatedRequest,
    r: Row,
    action: ChangeCommand | 'create',
    before: State | null,
    key: string,
    inputHash: string,
    reason: string,
    extra: Record<string, unknown> = {},
  ) {
    const response = {
      id: r.id,
      number: number(r),
      state: r.state,
      version: r.version,
      revision: r.revision,
      ...extra,
    };
    await c.query(
      'INSERT INTO local_change_event(id,change_id,organization_id,version,revision,action,before_state,after_state,reason,command_key,input_hash,response,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
      [
        uuidv7(),
        r.id,
        r.organization_id,
        r.version,
        r.revision,
        action,
        before,
        r.state,
        reason,
        key,
        inputHash,
        response,
        auth.userId,
      ],
    );
    const eventType = action === 'create' ? 'change.created' : eventTypes[action];
    await recordAuditEvent(c, {
      eventType,
      organizationId: r.organization_id,
      actorType: 'user',
      actorId: auth.userId,
      targetType: 'change',
      targetId: r.id,
      action: eventType,
      outcome: 'success',
      afterState: {
        state: r.state,
        version: r.version,
        revision: r.revision,
        snapshotHash: r.snapshot_hash,
        approvalId: r.current_approval_id,
        simulation: true,
      },
    });
    return { ...response, replayed: false };
  }
  async options(auth: AuthenticatedRequest, query: unknown) {
    requireRole(auth.authz, 'agent', 'org_admin', 'platform_admin');
    const input = parse(
      z.object({
        q: z.string().trim().max(200).default(''),
        ticketId: uuid.optional(),
        assetIds: z
          .string()
          .max(400)
          .optional()
          .transform((v) => (v ? v.split(',') : []))
          .pipe(z.array(uuid).max(10)),
      }),
      query,
    );
    return this.run(auth, async (c) => {
      if (input.ticketId) await new TicketService(c).findById(auth.authz, input.ticketId);
      const pattern = '%' + input.q.replace(/[\\%_]/g, '\\$&') + '%';
      return {
        owners: (
          await c.query<Person>(memberSql + ' ORDER BY name,u.id', [
            auth.authz.organizationId,
            ['agent', 'org_admin', 'platform_admin'],
          ])
        ).rows,
        approvers: (
          await c.query<Person>(memberSql + ' AND u.id<>$3 ORDER BY name,u.id', [
            auth.authz.organizationId,
            ['approver'],
            auth.userId,
          ])
        ).rows,
        assets: (
          await c.query<Target>(
            `SELECT id,asset_tag AS "assetTag",name,kind,state,version FROM asset WHERE organization_id=$1 AND (id=ANY($3::uuid[]) OR (state<>'retired' AND concat_ws(' ',asset_tag,name) ILIKE $2)) ORDER BY (id=ANY($3::uuid[])) DESC,updated_at DESC,id DESC LIMIT (50+cardinality($3::uuid[]))`,
            [auth.authz.organizationId, pattern, input.assetIds],
          )
        ).rows,
        tickets: (
          await c.query(
            `SELECT id,number,subject FROM ticket WHERE organization_id=$1 AND ($2::uuid IS NULL OR id=$2) ORDER BY created_at DESC,id DESC LIMIT 50`,
            [auth.authz.organizationId, input.ticketId ?? null],
          )
        ).rows,
      };
    });
  }
  async create(auth: AuthenticatedRequest, value: unknown) {
    requireRole(auth.authz, 'agent', 'org_admin', 'platform_admin');
    const input = parse(
        planSchema
          .extend({
            creationKey: uuid,
            reason: z.string().trim().min(1).max(1000).default('初回計画'),
          })
          .strict(),
        value,
      ),
      inputHash = hash(input);
    return this.run(auth, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'change-create:' + auth.authz.organizationId,
      ]);
      const old = (
        await c.query<Row>(
          'SELECT * FROM local_change WHERE organization_id=$1 AND created_by=$2 AND creation_key=$3',
          [auth.authz.organizationId, auth.userId, input.creationKey],
        )
      ).rows[0];
      if (old) {
        if (old.creation_hash !== inputHash)
          throw Problems.conflict('同じ作成キーで異なる計画は登録できません');
        return { ...summary(old), replayed: true };
      }
      const snapshot = await this.snapshot(c, auth, input);
      const seq = (
        await c.query<{ n: number }>(
          'SELECT coalesce(max(sequence_no),0)+1 AS n FROM local_change WHERE organization_id=$1',
          [auth.authz.organizationId],
        )
      ).rows[0]!.n;
      const id = uuidv7();
      const r = (
        await c.query<Row>(
          `INSERT INTO local_change(id,organization_id,sequence_no,ticket_id,owner_id,created_by,creation_key,creation_hash,version,revision,state,snapshot,snapshot_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,1,'draft',$9,$10) RETURNING *`,
          [
            id,
            auth.authz.organizationId,
            seq,
            input.ticketId,
            input.ownerId,
            auth.userId,
            input.creationKey,
            inputHash,
            snapshot,
            hash(snapshot),
          ],
        )
      ).rows[0]!;
      await this.revision(c, auth, r, input.reason);
      await this.links(c, r);
      return this.event(c, auth, r, 'create', null, input.creationKey, inputHash, input.reason);
    });
  }
  private async conflicts(c: pg.PoolClient, r: Row) {
    if (!r.snapshot.plannedStart || !r.snapshot.plannedEnd) return [];
    return (
      await c.query<{
        id: string;
        number: string;
        title: string;
        plannedStart: string;
        plannedEnd: string;
      }>(
        `SELECT DISTINCT ch.id,'CHG-'||lpad(ch.sequence_no::text,6,'0') AS number,ch.snapshot->>'title' AS title,ch.snapshot->>'plannedStart' AS "plannedStart",ch.snapshot->>'plannedEnd' AS "plannedEnd"
      FROM local_change ch JOIN local_change_asset a ON a.change_id=ch.id AND a.organization_id=ch.organization_id
      WHERE ch.organization_id=$1 AND ch.id<>$2 AND ch.state IN ('scheduled','in_progress') AND a.active AND a.asset_id=ANY($3::uuid[])
      AND (ch.snapshot->>'plannedStart')::timestamptz<$5::timestamptz AND (ch.snapshot->>'plannedEnd')::timestamptz>$4::timestamptz ORDER BY ch.id`,
        [
          r.organization_id,
          r.id,
          r.snapshot.assets.map((a) => a.id),
          r.snapshot.plannedStart,
          r.snapshot.plannedEnd,
        ],
      )
    ).rows;
  }
  async command(auth: AuthenticatedRequest, id: string, action: ChangeCommand, value: unknown) {
    const input = parse(schemas[action], value),
      inputHash = hash({ action, input });
    return this.run(auth, async (c) => {
      const r = await this.row(c, auth, id, true);
      const old = (
        await c.query<{
          input_hash: string;
          actor_id: string;
          action: string;
          response: Record<string, unknown>;
        }>(
          'SELECT input_hash,actor_id,action,response FROM local_change_event WHERE change_id=$1 AND organization_id=$2 AND command_key=$3',
          [id, r.organization_id, input.commandKey],
        )
      ).rows[0];
      if (old) {
        if (old.input_hash !== inputHash || old.actor_id !== auth.userId || old.action !== action)
          throw Problems.conflict('同じ操作キーで異なる操作はできません');
        return { ...old.response, replayed: true };
      }
      if (['approve', 'reject'].includes(action)) {
        if ([r.created_by, r.owner_id].includes(auth.userId))
          throw Problems.forbidden('作成者・実施担当者は自己承認できません');
        requireRole(auth.authz, 'approver');
        if (r.snapshot.approver?.id !== auth.userId)
          throw Problems.forbidden('指名された承認者だけが判断できます');
      } else if (!this.manages(auth, r))
        throw Problems.forbidden('作成者・実施担当者または管理者が操作してください');
      if (r.version !== input.expectedVersion) throw Problems.stale('変更');
      const before = r.state;
      let reason = input.reason,
        extra: Record<string, unknown> = {};
      const requireState = (...allowed: State[]) => {
        if (!allowed.includes(r.state)) throw Problems.invalidTransition(r.state, action);
      };
      switch (action) {
        case 'edit': {
          requireState('draft', 'review', 'approved', 'rejected', 'scheduled');
          const p = parse(schemas.edit, input);
          if (p.approverId && [r.created_by, p.ownerId].includes(p.approverId))
            throw Problems.forbidden('作成者・実施担当者は自己承認できません');
          r.snapshot = await this.snapshot(c, auth, p);
          r.snapshot_hash = hash(r.snapshot);
          r.revision++;
          r.ticket_id = p.ticketId;
          r.owner_id = p.ownerId;
          r.current_approval_id = null;
          r.state = 'draft';
          await this.revision(c, auth, r, reason);
          await this.links(c, r);
          break;
        }
        case 'submit': {
          requireState('draft');
          const ready = await this.readiness(c, auth, r, true);
          if (ready.issues.length)
            throw Problems.validation(ready.issues.map((message) => ({ field: 'plan', message })));
          r.current_approval_id = uuidv7();
          await c.query(
            'INSERT INTO local_change_approval(id,change_id,organization_id,revision,snapshot_hash,approver_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
            [
              r.current_approval_id,
              id,
              r.organization_id,
              r.revision,
              r.snapshot_hash,
              r.snapshot.approver!.id,
              r.snapshot.plannedEnd,
            ],
          );
          r.state = 'review';
          reason = reason || '計画を確認して承認を依頼';
          break;
        }
        case 'approve':
        case 'reject': {
          requireState('review');
          const p = parse(schemas.approve, input);
          this.matchReviewed(r, p);
          const a = await this.approval(c, r);
          if (a.decision) throw Problems.conflict('この承認依頼は判断済みです');
          if (action === 'approve') {
            const ready = await this.assertReady(c, auth, r);
            if (a.expires_at <= ready.now) throw Problems.conflict('承認期限を過ぎています');
          }
          r.state = action === 'approve' ? 'approved' : 'rejected';
          await c.query(
            'INSERT INTO local_change_decision(approval_id,organization_id,decision,reason,actor_id) VALUES($1,$2,$3,$4,$5)',
            [a.id, r.organization_id, r.state, reason, auth.userId],
          );
          break;
        }
        case 'schedule':
        case 'start': {
          requireState(action === 'schedule' ? 'approved' : 'scheduled');
          const p = parse(action === 'schedule' ? schemas.schedule : schemas.start, input);
          this.matchReviewed(r, p);
          const ready = await this.assertReady(c, auth, r),
            a = await this.approval(c, r);
          if (a.decision !== 'approved' || a.expires_at <= ready.now)
            throw Problems.conflict('有効な承認が必要です。再申請してください');
          if (action === 'schedule') {
            await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
              'change-schedule:' + r.organization_id,
            ]);
            const overlaps = await this.conflicts(c, r);
            const expected = parse(schemas.schedule, input).conflictIds;
            if (canonical([...expected].sort()) !== canonical(overlaps.map((o) => o.id).sort()))
              throw Problems.conflict(
                '予定の重複が変わりました。最新の予定を確認してから確定してください',
              );
            extra = { conflictIds: overlaps.map((o) => o.id) };
            r.state = 'scheduled';
          } else {
            if (!ready.withinWindow)
              throw Problems.conflict(
                '開始は予定期間内だけ記録できます。日時を見直す場合は再承認が必要です',
              );
            r.state = 'in_progress';
            r.started_at = (
              await c.query<{ now: Date }>('SELECT clock_timestamp() AS now')
            ).rows[0]!.now;
            reason = reason || '合成例の実施開始を記録';
          }
          break;
        }
        case 'result': {
          requireState('in_progress');
          const p = parse(schemas.result, input),
            a = await this.approval(c, r);
          if (hash(r.snapshot) !== r.snapshot_hash || a.decision !== 'approved')
            throw Problems.conflict('開始時の承認計画が一致しません');
          const resultId = uuidv7();
          await c.query(
            `INSERT INTO local_change_result(id,change_id,organization_id,revision,approval_id,snapshot_hash,outcome,summary,test_results,backout_performed,backout_reason,simulation,external_changes,started_at,finished_at,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,0,$12,clock_timestamp(),$13)`,
            [
              resultId,
              id,
              r.organization_id,
              r.revision,
              a.id,
              r.snapshot_hash,
              p.outcome,
              p.summary,
              p.testResults,
              p.backoutPerformed,
              p.backoutReason,
              r.started_at,
              auth.userId,
            ],
          );
          r.state = p.outcome;
          reason = reason || p.summary.slice(0, 1000);
          extra = { resultId, simulation: true, externalChanges: 0 };
          break;
        }
        case 'pir': {
          requireState('completed', 'failed');
          const p = parse(schemas.pir, input),
            pirId = uuidv7();
          await c.query(
            'INSERT INTO local_change_pir(id,change_id,organization_id,root_cause,lessons,prevention,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
            [pirId, id, r.organization_id, p.rootCause, p.lessons, p.prevention, auth.userId],
          );
          reason = reason || '実施後レビューを記録';
          extra = { pirId };
          break;
        }
        case 'cancel':
          requireState('draft', 'review', 'approved', 'rejected', 'scheduled');
          r.state = 'cancelled';
          break;
      }
      r.version++;
      await c.query(
        'UPDATE local_change SET ticket_id=$3,owner_id=$4,version=$5,revision=$6,state=$7,snapshot=$8,snapshot_hash=$9,current_approval_id=$10,started_at=$11,updated_at=clock_timestamp() WHERE id=$1 AND organization_id=$2',
        [
          id,
          r.organization_id,
          r.ticket_id,
          r.owner_id,
          r.version,
          r.revision,
          r.state,
          r.snapshot,
          r.snapshot_hash,
          r.current_approval_id,
          r.started_at,
        ],
      );
      return this.event(c, auth, r, action, before, input.commandKey, inputHash, reason, extra);
    });
  }
  async detail(auth: AuthenticatedRequest, id: string) {
    return this.run(auth, async (c) => {
      const r = await this.row(c, auth, id),
        readiness = await this.readiness(c, auth, r),
        canManage = this.manages(auth, r),
        _currentApproval = r.current_approval_id ? await this.approval(c, r) : null;
      const result =
        (
          await c.query(
            'SELECT x.id,x.revision,x.approval_id AS "approvalId",x.snapshot_hash AS "snapshotHash",x.outcome,x.summary,x.test_results AS "testResults",x.backout_performed AS "backoutPerformed",x.backout_reason AS "backoutReason",x.simulation,x.external_changes AS "externalChanges",x.started_at AS "startedAt",x.finished_at AS "finishedAt",u.display_name AS "actorName" FROM local_change_result x JOIN app_user u ON u.id=x.actor_id WHERE x.change_id=$1 AND x.organization_id=$2',
            [id, r.organization_id],
          )
        ).rows[0] ?? null;
      const pir =
        (
          await c.query(
            'SELECT p.id,p.root_cause AS "rootCause",p.lessons,p.prevention,p.created_at AS "createdAt",u.display_name AS "actorName" FROM local_change_pir p JOIN app_user u ON u.id=p.actor_id WHERE p.change_id=$1 AND p.organization_id=$2',
            [id, r.organization_id],
          )
        ).rows[0] ?? null;
      const actions: ChangeCommand[] = [];
      if (canManage) {
        if (['draft', 'review', 'approved', 'rejected', 'scheduled'].includes(r.state))
          actions.push('edit', 'cancel');
        if (r.state === 'draft' && !readiness.issues.length) actions.push('submit');
        if (r.state === 'approved' && !readiness.issues.length) actions.push('schedule');
        if (r.state === 'scheduled' && !readiness.issues.length && readiness.withinWindow)
          actions.push('start');
        if (r.state === 'in_progress') actions.push('result');
        if (['completed', 'failed'].includes(r.state) && !pir) actions.push('pir');
      }
      if (
        r.state === 'review' &&
        r.snapshot.approver?.id === auth.userId &&
        ![r.created_by, r.owner_id].includes(auth.userId) &&
        hasRole(auth.authz, 'approver')
      ) {
        if (!readiness.issues.length) actions.push('approve');
        actions.push('reject');
      }
      const assetOwnership = (
        await c.query<{ id: string; assigned_user_id: string | null }>(
          'SELECT id,assigned_user_id FROM asset WHERE organization_id=$1 AND id=ANY($2::uuid[])',
          [r.organization_id, r.snapshot.assets.map((a) => a.id)],
        )
      ).rows;
      const ticketOwner = (
        await c.query<{ requester_id: string }>(
          'SELECT requester_id FROM ticket WHERE organization_id=$1 AND id=$2',
          [r.organization_id, r.ticket_id],
        )
      ).rows[0]?.requester_id;
      return {
        change: {
          ...summary(r),
          snapshot: r.snapshot,
          snapshotHash: r.snapshot_hash,
          currentApprovalId: r.current_approval_id,
          createdBy: r.created_by,
          startedAt: r.started_at,
        },
        canManage,
        availableActions: actions,
        readiness: {
          issues: readiness.issues,
          withinWindow: readiness.withinWindow,
          now: readiness.now,
        },
        ticketCanOpen: this.all(auth) || ticketOwner === auth.userId,
        assetAccess: r.snapshot.assets.map((a) => ({
          id: a.id,
          canOpen:
            this.all(auth) ||
            assetOwnership.some((o) => o.id === a.id && o.assigned_user_id === auth.userId),
        })),
        result,
        pir,
        conflicts: this.all(auth) ? await this.conflicts(c, r) : [],
        approvals: (
          await c.query(
            `SELECT a.id,a.revision,a.snapshot_hash AS "snapshotHash",a.approver_id AS "approverId",u.display_name AS "approverName",a.expires_at AS "expiresAt",a.created_at AS "createdAt",d.decision,d.reason,d.created_at AS "decidedAt",(a.id=$3) AS "isCurrent" FROM local_change_approval a JOIN app_user u ON u.id=a.approver_id LEFT JOIN local_change_decision d ON d.approval_id=a.id AND d.organization_id=a.organization_id WHERE a.change_id=$1 AND a.organization_id=$2 ORDER BY a.created_at DESC,a.id DESC`,
            [id, r.organization_id, r.current_approval_id],
          )
        ).rows,
        revisions: (
          await c.query(
            'SELECT v.revision,v.snapshot,v.snapshot_hash AS "snapshotHash",v.reason,v.created_at AS "createdAt",u.display_name AS "actorName" FROM local_change_revision v JOIN app_user u ON u.id=v.actor_id WHERE v.change_id=$1 AND v.organization_id=$2 ORDER BY v.revision DESC',
            [id, r.organization_id],
          )
        ).rows,
        history: (
          await c.query(
            'SELECT e.version,e.revision,e.action,e.before_state AS "beforeState",e.after_state AS "afterState",e.reason,e.created_at AS "createdAt",u.display_name AS "actorName" FROM local_change_event e JOIN app_user u ON u.id=e.actor_id WHERE e.change_id=$1 AND e.organization_id=$2 ORDER BY e.version DESC',
            [id, r.organization_id],
          )
        ).rows,
      };
    });
  }
  async list(auth: AuthenticatedRequest, query: unknown) {
    requireRole(auth.authz, 'agent', 'org_admin', 'platform_admin', 'auditor', 'approver');
    const input = parse(
      z.object({
        q: z.string().trim().max(200).default(''),
        state: z.enum(states as [State, ...State[]]).optional(),
        assetId: uuid.optional(),
        ticketId: uuid.optional(),
        needsPir: z.enum(['1', '0']).default('0'),
        page: z.coerce.number().int().min(1).max(100000).default(1),
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
      }),
      query,
    );
    return this.run(auth, async (c) => {
      const where = `WHERE ch.organization_id=$1 AND ($2::boolean OR (ch.current_approval_id IS NOT NULL AND ch.snapshot->'approver'->>'id'=$3))
       AND ($4::text IS NULL OR ch.state=$4) AND ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM local_change_asset a WHERE a.change_id=ch.id AND a.organization_id=ch.organization_id AND a.asset_id=$5 AND a.active))
       AND ($6::uuid IS NULL OR ch.ticket_id=$6) AND ($7='0' OR (ch.state='failed' AND NOT EXISTS(SELECT 1 FROM local_change_pir p WHERE p.change_id=ch.id AND p.organization_id=ch.organization_id)))
       AND (concat_ws(' ',ch.snapshot->>'title',ch.snapshot->'ticket'->>'number','CHG-'||lpad(ch.sequence_no::text,6,'0')) ILIKE $8)
       AND ($9::timestamptz IS NULL OR (ch.snapshot->>'plannedEnd')::timestamptz>$9) AND ($10::timestamptz IS NULL OR (ch.snapshot->>'plannedStart')::timestamptz<$10)`;
      const args = [
        auth.authz.organizationId,
        this.all(auth),
        auth.userId,
        input.state ?? null,
        input.assetId ?? null,
        input.ticketId ?? null,
        input.needsPir,
        '%' + input.q.replace(/[\\%_]/g, '\\$&') + '%',
        input.from ?? null,
        input.to ?? null,
      ];
      const items = (
        await c.query<Row>(
          `SELECT ch.* FROM local_change ch ${where} ORDER BY ch.updated_at DESC,ch.id DESC LIMIT 25 OFFSET $11`,
          [...args, (input.page - 1) * 25],
        )
      ).rows;
      const total = Number(
        (await c.query(`SELECT count(*) AS total FROM local_change ch ${where}`, args)).rows[0]
          .total,
      );
      return {
        items: items.map(summary),
        total,
        page: input.page,
        pageSize: 25,
        canCreate: this.staff(auth),
      };
    });
  }
  async related(auth: AuthenticatedRequest, resource: 'ticket' | 'asset', id: string) {
    parse(uuid, id);
    return this.run(auth, async (c) => {
      if (resource === 'ticket') await new TicketService(c).findById(auth.authz, id);
      else {
        const asset = (
          await c.query<{ assigned_user_id: string | null }>(
            'SELECT assigned_user_id FROM asset WHERE id=$1 AND organization_id=$2',
            [id, auth.authz.organizationId],
          )
        ).rows[0];
        if (!asset || (!this.all(auth) && asset.assigned_user_id !== auth.userId))
          throw Problems.notFound('資産');
      }
      if (!this.all(auth)) return { items: [], canCreate: false };
      const condition =
        resource === 'ticket'
          ? 'ch.ticket_id=$2'
          : 'EXISTS(SELECT 1 FROM local_change_asset a WHERE a.change_id=ch.id AND a.organization_id=ch.organization_id AND a.asset_id=$2 AND a.active)';
      return {
        items: (
          await c.query<Row>(
            `SELECT ch.* FROM local_change ch WHERE ch.organization_id=$1 AND ${condition} ORDER BY ch.updated_at DESC,ch.id DESC LIMIT 50`,
            [auth.authz.organizationId, id],
          )
        ).rows.map(summary),
        canCreate: this.staff(auth),
      };
    });
  }
}
