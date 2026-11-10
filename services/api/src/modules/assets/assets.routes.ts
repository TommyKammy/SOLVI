import type pg from 'pg';
import { z } from 'zod';
import { Problems } from '@solvi/shared';
import { hasRole, requireRole } from '../../common/authz/authz.js';
import { recordAuditEvent, uuidv7 } from '../../common/audit/audit.js';
import { TicketService } from '../ticket/ticket.service.js';
import type { AuthenticatedRequest } from '../auth/auth.routes.js';

const kinds = [
  { code: 'pc', label: 'PC', requiredFields: ['model', 'serialNumber', 'hostname'] },
  { code: 'server', label: 'サーバー', requiredFields: ['model', 'serialNumber', 'hostname'] },
  { code: 'vm', label: '仮想マシン', requiredFields: ['hostname', 'vendor'] },
  {
    code: 'network',
    label: 'ネットワーク機器',
    requiredFields: ['model', 'serialNumber', 'hostname'],
  },
  { code: 'mobile', label: 'モバイル端末', requiredFields: ['model', 'serialNumber'] },
  { code: 'saas', label: 'SaaS', requiredFields: ['model', 'vendor'] },
];
const states = [
  { code: 'stocked', label: '在庫' },
  { code: 'in_use', label: '使用中' },
  { code: 'repair', label: '修理中' },
  { code: 'retired', label: '廃止' },
];
const fields = [
  { key: 'model', label: 'モデル・サービス名' },
  { key: 'serialNumber', label: 'シリアル番号' },
  { key: 'hostname', label: 'ホスト名' },
  { key: 'vendor', label: 'メーカー・提供元' },
];
const uuid = z.string().uuid();
export const assetInputSchema = z.object({
  assetTag: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(160),
  kind: z.enum(['pc', 'server', 'vm', 'network', 'mobile', 'saas']),
  state: z.enum(['stocked', 'in_use', 'repair', 'retired']),
  model: z.string().trim().max(160).default(''),
  serialNumber: z.string().trim().max(160).default(''),
  hostname: z.string().trim().max(160).default(''),
  vendor: z.string().trim().max(160).default(''),
  assignedUserId: uuid.nullable().default(null),
  location: z.string().trim().max(200).default(''),
  internalNotes: z.string().trim().max(4000).default(''),
});
const createSchema = assetInputSchema
  .extend({ reason: z.string().trim().min(1).max(1000).default('初回登録') })
  .strict();
const editSchema = assetInputSchema
  .extend({
    reason: z.string().trim().min(1).max(1000),
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export type AssetInput = z.infer<typeof assetInputSchema>;
export type AssetRow = {
  id: string;
  organization_id: string;
  asset_tag: string;
  name: string;
  kind: AssetInput['kind'];
  state: AssetInput['state'];
  model: string;
  serial_number: string;
  hostname: string;
  vendor: string;
  assigned_user_id: string | null;
  assigned_user_name: string | null;
  location: string;
  internal_notes: string;
  source_kind: 'manual' | 'csv';
  version: number;
  created_at: Date;
  updated_at: Date;
};
const assetSql =
  'SELECT a.*,u.display_name AS assigned_user_name FROM asset a LEFT JOIN app_user u ON u.id=a.assigned_user_id';
const memberSql = `SELECT DISTINCT u.id,u.display_name AS name FROM app_user u JOIN role_binding rb ON rb.user_id=u.id
 WHERE rb.organization_id=$1 AND rb.valid_from<=clock_timestamp() AND (rb.valid_until IS NULL OR rb.valid_until>clock_timestamp()) AND u.status='active'`;
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const r = schema.safeParse(value);
  if (!r.success)
    throw Problems.validation(
      r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    );
  return r.data;
}
function view(a: AssetRow, privateFields: boolean) {
  return {
    id: a.id,
    assetTag: a.asset_tag,
    name: a.name,
    kind: a.kind,
    state: a.state,
    version: a.version,
    model: a.model,
    serialNumber: a.serial_number,
    hostname: a.hostname,
    vendor: a.vendor,
    assignedUserId: a.assigned_user_id,
    assignedUserName: a.assigned_user_name,
    sourceKind: a.source_kind,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
    ...(privateFields ? { location: a.location, internalNotes: a.internal_notes } : {}),
  };
}
export class AssetsController {
  constructor(private readonly pool: pg.Pool) {}
  private manage(auth: AuthenticatedRequest) {
    return hasRole(auth.authz, 'agent', 'org_admin', 'platform_admin');
  }
  private readAll(auth: AuthenticatedRequest) {
    return hasRole(auth.authz, 'agent', 'org_admin', 'auditor', 'platform_admin');
  }
  private async run<T>(
    auth: AuthenticatedRequest,
    fn: (c: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.current_org',$1,true)", [auth.authz.organizationId]);
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      if ((e as { code?: string }).code === '23505')
        throw Problems.conflict('資産タグまたはシリアル番号はすでに登録されています');
      throw e;
    } finally {
      c.release();
    }
  }
  private async row(
    c: pg.PoolClient,
    auth: AuthenticatedRequest,
    id: string,
    lock: 'share' | 'update' = 'share',
  ) {
    parse(uuid, id);
    const r = await c.query<AssetRow>(
      `${assetSql} WHERE a.id=$1 AND a.organization_id=$2 FOR ${lock === 'share' ? 'SHARE' : 'UPDATE'} OF a`,
      [id, auth.authz.organizationId],
    );
    if (!r.rows[0]) throw Problems.notFound('資産');
    return r.rows[0];
  }
  private access(auth: AuthenticatedRequest, a: AssetRow) {
    if (!this.readAll(auth) && a.assigned_user_id !== auth.userId) throw Problems.notFound('資産');
  }
  async options(auth: AuthenticatedRequest) {
    requireRole(auth.authz, 'agent', 'org_admin', 'platform_admin');
    return this.run(auth, async (c) => ({
      kinds,
      states,
      fields,
      members: (await c.query(memberSql + ' ORDER BY name,u.id', [auth.authz.organizationId])).rows,
    }));
  }
  async list(auth: AuthenticatedRequest, query: unknown) {
    const q = parse(
      z.object({
        q: z.string().trim().max(200).default(''),
        page: z.coerce.number().int().min(1).max(100000).default(1),
        kind: assetInputSchema.shape.kind.optional(),
        state: assetInputSchema.shape.state.optional(),
        assignment: z.enum(['all', 'mine', 'unassigned']).default('all'),
      }),
      query,
    );
    return this.run(auth, async (c) => {
      const where = `WHERE a.organization_id=$1 AND ($2::boolean OR a.assigned_user_id=$3) AND ($4::text IS NULL OR a.kind=$4) AND ($5::text IS NULL OR a.state=$5)
        AND ($6='all' OR ($6='mine' AND a.assigned_user_id=$3) OR ($6='unassigned' AND a.assigned_user_id IS NULL))
        AND concat_ws(' ',a.asset_tag,a.name,a.model,a.serial_number,a.hostname,a.vendor,u.display_name) ILIKE $7`;
      const args = [
        auth.authz.organizationId,
        this.readAll(auth),
        auth.userId,
        q.kind ?? null,
        q.state ?? null,
        q.assignment,
        '%' + q.q.replace(/[\\%_]/g, '\\$&') + '%',
      ];
      const rows = (
        await c.query<AssetRow>(
          `${assetSql} ${where} ORDER BY a.updated_at DESC,a.id DESC LIMIT 25 OFFSET $8`,
          [...args, (q.page - 1) * 25],
        )
      ).rows;
      const total = Number(
        (
          await c.query(
            `${assetSql.replace('a.*,u.display_name AS assigned_user_name', 'count(*) AS total')} ${where}`,
            args,
          )
        ).rows[0].total,
      );
      return {
        items: rows.map((a) => view(a, this.readAll(auth))),
        total,
        page: q.page,
        pageSize: 25,
        canManage: this.manage(auth),
        canReadAll: this.readAll(auth),
        kinds,
        states,
      };
    });
  }
  async detail(auth: AuthenticatedRequest, id: string) {
    return this.run(auth, async (c) => {
      const a = await this.row(c, auth, id);
      this.access(auth, a);
      const all = this.readAll(auth),
        args = [id, a.organization_id, all, auth.userId];
      return {
        asset: view(a, all),
        canManage: this.manage(auth),
        revisions: all
          ? (
              await c.query(
                'SELECT r.version,r.snapshot,r.reason,r.created_at AS "createdAt",u.display_name AS "actorName" FROM asset_revision r JOIN app_user u ON u.id=r.changed_by WHERE r.asset_id=$1 AND r.organization_id=$2 ORDER BY r.version DESC',
                [id, a.organization_id],
              )
            ).rows
          : [],
        tickets: (
          await c.query(
            `SELECT t.id,t.number,t.subject,t.state,l.version FROM asset_ticket_link l JOIN ticket t ON t.id=l.ticket_id AND t.organization_id=l.organization_id WHERE l.asset_id=$1 AND l.organization_id=$2 AND l.active AND ($3::boolean OR t.requester_id=$4) ORDER BY t.created_at DESC,t.id DESC LIMIT 100`,
            args,
          )
        ).rows,
        relationHistory: all
          ? (
              await c.query(
                `SELECT e.id,e.operation,e.reason,e.created_at AS "createdAt",u.display_name AS "actorName",t.id AS "ticketId",t.number,t.subject FROM asset_ticket_event e JOIN ticket t ON t.id=e.ticket_id AND t.organization_id=e.organization_id JOIN app_user u ON u.id=e.actor_id WHERE e.asset_id=$1 AND e.organization_id=$2 ORDER BY e.created_at DESC,e.id DESC LIMIT 100`,
                [id, a.organization_id],
              )
            ).rows
          : [],
      };
    });
  }
  async validateInput(c: pg.PoolClient, auth: AuthenticatedRequest, input: AssetInput) {
    const type = kinds.find((t) => t.code === input.kind)!;
    const missing = type.requiredFields.filter((k) => !input[k as keyof AssetInput]);
    if (missing.length)
      throw Problems.validation(
        missing.map((k) => ({
          field: k,
          message: `${fields.find((f) => f.key === k)!.label}はこの種別で必須です`,
        })),
      );
    if (input.state === 'in_use' && !input.assignedUserId)
      throw Problems.validation([
        { field: 'assignedUserId', message: '使用中の資産には利用者を指定してください' },
      ]);
    if (['stocked', 'retired'].includes(input.state) && input.assignedUserId)
      throw Problems.validation([
        { field: 'assignedUserId', message: '在庫・廃止の資産は利用者の割当を外してください' },
      ]);
    if (
      input.assignedUserId &&
      !(
        await c.query(memberSql + ' AND u.id=$2', [auth.authz.organizationId, input.assignedUserId])
      ).rowCount
    )
      throw Problems.validation([
        { field: 'assignedUserId', message: '同じ組織の有効な利用者を選んでください' },
      ]);
  }
  private async revision(
    c: pg.PoolClient,
    auth: AuthenticatedRequest,
    a: AssetRow,
    reason: string,
    eventType: 'asset.created' | 'asset.updated',
  ) {
    await c.query(
      'INSERT INTO asset_revision(asset_id,organization_id,version,snapshot,reason,changed_by) VALUES($1,$2,$3,$4,$5,$6)',
      [a.id, a.organization_id, a.version, view(a, true), reason, auth.userId],
    );
    await recordAuditEvent(c, {
      eventType,
      organizationId: a.organization_id,
      actorType: 'user',
      actorId: auth.userId,
      targetType: 'asset',
      targetId: a.id,
      action: eventType,
      outcome: 'success',
      afterState: {
        version: a.version,
        state: a.state,
        assignedUserId: a.assigned_user_id,
        sourceKind: a.source_kind,
      },
    });
  }
  async create(auth: AuthenticatedRequest, value: unknown) {
    return this.run(auth, (c) => this.createInTransaction(c, auth, value));
  }
  async createInTransaction(
    c: pg.PoolClient,
    auth: AuthenticatedRequest,
    value: unknown,
    sourceKind: 'manual' | 'csv' = 'manual',
  ) {
    requireRole(auth.authz, 'agent', 'org_admin', 'platform_admin');
    const input = parse(createSchema, value);
    await this.validateInput(c, auth, input);
    const id = uuidv7();
    await c.query(
      `INSERT INTO asset(id,organization_id,asset_tag,name,kind,state,model,serial_number,hostname,vendor,assigned_user_id,location,internal_notes,version,created_by,source_kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,$14,$15)`,
      [
        id,
        auth.authz.organizationId,
        input.assetTag,
        input.name,
        input.kind,
        input.state,
        input.model,
        input.serialNumber,
        input.hostname,
        input.vendor,
        input.assignedUserId,
        input.location,
        input.internalNotes,
        auth.userId,
        sourceKind,
      ],
    );
    const a = await this.row(c, auth, id);
    await this.revision(c, auth, a, input.reason, 'asset.created');
    return { id, version: 1 };
  }
  async edit(auth: AuthenticatedRequest, id: string, value: unknown) {
    return this.run(auth, (c) => this.editInTransaction(c, auth, id, value));
  }
  async editInTransaction(
    c: pg.PoolClient,
    auth: AuthenticatedRequest,
    id: string,
    value: unknown,
  ) {
    requireRole(auth.authz, 'agent', 'org_admin', 'platform_admin');
    const input = parse(editSchema, value);
    const a = await this.row(c, auth, id, 'update');
    if (a.version !== input.expectedVersion) throw Problems.stale('資産');
    if (a.kind !== input.kind)
      throw Problems.validation([{ field: 'kind', message: '登録後の種別は変更できません' }]);
    if (a.state === 'retired' && input.state !== 'retired')
      throw Problems.conflict(
        '廃止した資産は再稼働できません。履歴を保ち新しい資産として登録してください',
      );
    await this.validateInput(c, auth, input);
    await c.query(
      `UPDATE asset SET asset_tag=$3,name=$4,state=$5,model=$6,serial_number=$7,hostname=$8,vendor=$9,assigned_user_id=$10,location=$11,internal_notes=$12,version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND organization_id=$2`,
      [
        id,
        a.organization_id,
        input.assetTag,
        input.name,
        input.state,
        input.model,
        input.serialNumber,
        input.hostname,
        input.vendor,
        input.assignedUserId,
        input.location,
        input.internalNotes,
      ],
    );
    const changed = await this.row(c, auth, id);
    await this.revision(c, auth, changed, input.reason, 'asset.updated');
    return { id, version: changed.version };
  }
  async ticketAssets(auth: AuthenticatedRequest, ticketId: string) {
    return this.run(auth, async (c) => {
      parse(uuid, ticketId);
      await new TicketService(c).findById(auth.authz, ticketId);
      const rows = (
        await c.query<AssetRow & { link_version: number }>(
          `${assetSql.replace('a.*,u.display_name AS assigned_user_name', 'a.*,u.display_name AS assigned_user_name,l.version AS link_version')} JOIN asset_ticket_link l ON l.asset_id=a.id AND l.organization_id=a.organization_id WHERE l.ticket_id=$1 AND l.organization_id=$2 AND l.active ORDER BY a.asset_tag,a.id`,
          [ticketId, auth.authz.organizationId],
        )
      ).rows;
      return {
        canManage: this.manage(auth),
        items: rows.map((a) => ({
          id: a.id,
          assetTag: a.asset_tag,
          name: a.name,
          kind: a.kind,
          state: a.state,
          linkVersion: a.link_version,
          canOpen: this.readAll(auth) || a.assigned_user_id === auth.userId,
        })),
        history: this.readAll(auth)
          ? (
              await c.query(
                `SELECT e.id,e.operation,e.reason,e.created_at AS "createdAt",u.display_name AS "actorName",a.id AS "assetId",a.asset_tag AS "assetTag",a.name FROM asset_ticket_event e JOIN asset a ON a.id=e.asset_id AND a.organization_id=e.organization_id JOIN app_user u ON u.id=e.actor_id WHERE e.ticket_id=$1 AND e.organization_id=$2 ORDER BY e.created_at DESC,e.id DESC LIMIT 100`,
                [ticketId, auth.authz.organizationId],
              )
            ).rows
          : [],
      };
    });
  }
  async link(auth: AuthenticatedRequest, ticketId: string, value: unknown, unlinkId?: string) {
    requireRole(auth.authz, 'agent', 'org_admin', 'platform_admin');
    const input = unlinkId
      ? parse(
          z
            .object({
              reason: z.string().trim().min(1).max(1000),
              expectedVersion: z.number().int().positive(),
            })
            .strict(),
          value,
        )
      : parse(
          z.object({ assetId: uuid, reason: z.string().trim().min(1).max(1000) }).strict(),
          value,
        );
    const assetId = unlinkId ?? ('assetId' in input ? input.assetId : '');
    parse(uuid, assetId);
    parse(uuid, ticketId);
    return this.run(auth, async (c) => {
      await new TicketService(c).findById(auth.authz, ticketId);
      const a = await this.row(c, auth, assetId);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `${a.organization_id}:asset-link:${ticketId}:${assetId}`,
      ]);
      const previous = (
        await c.query<{ active: boolean; version: number }>(
          'SELECT active,version FROM asset_ticket_link WHERE asset_id=$1 AND ticket_id=$2 AND organization_id=$3 FOR UPDATE',
          [assetId, ticketId, a.organization_id],
        )
      ).rows[0];
      if (unlinkId) {
        if (!previous) throw Problems.notFound('資産の関連');
        const expected = 'expectedVersion' in input ? input.expectedVersion : 0;
        if (!previous.active && previous.version === expected + 1)
          return { active: false, replayed: true };
        if (previous.version !== expected) throw Problems.stale('資産の関連');
        if (!previous.active) return { active: false, replayed: true };
      } else {
        if (previous?.active) return { active: true, replayed: true };
        if (a.state === 'retired') throw Problems.conflict('廃止資産は新しく関連付けできません');
      }
      const active = !unlinkId,
        version = (previous?.version ?? 0) + 1;
      await c.query(
        `INSERT INTO asset_ticket_link(asset_id,ticket_id,organization_id,active,version) VALUES($1,$2,$3,$4,$5) ON CONFLICT(asset_id,ticket_id,organization_id) DO UPDATE SET active=EXCLUDED.active,version=EXCLUDED.version,updated_at=clock_timestamp()`,
        [assetId, ticketId, a.organization_id, active, version],
      );
      const eventType = active ? 'asset.ticket.linked' : 'asset.ticket.unlinked';
      await c.query(
        'INSERT INTO asset_ticket_event(id,asset_id,ticket_id,organization_id,version,operation,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          uuidv7(),
          assetId,
          ticketId,
          a.organization_id,
          version,
          active ? 'linked' : 'unlinked',
          input.reason,
          auth.userId,
        ],
      );
      await recordAuditEvent(c, {
        eventType,
        organizationId: a.organization_id,
        actorType: 'user',
        actorId: auth.userId,
        targetType: 'asset',
        targetId: assetId,
        action: eventType,
        outcome: 'success',
        afterState: { ticketId, linkVersion: version, active },
      });
      return { active, version, replayed: false };
    });
  }
}
