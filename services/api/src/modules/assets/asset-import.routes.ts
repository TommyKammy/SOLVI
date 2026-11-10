import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { ProblemError, Problems } from '@solvi/shared';
import { requireRole, hasRole } from '../../common/authz/authz.js';
import { recordAuditEvent, uuidv7 } from '../../common/audit/audit.js';
import type { AuthenticatedRequest } from '../auth/auth.routes.js';
import {
  AssetsController,
  assetInputSchema,
  type AssetInput,
  type AssetRow,
} from './assets.routes.js';
import { parseAssetCsv } from './asset-csv.js';

export const importFields = [
  { key: 'externalId', label: '外部ID', required: true },
  { key: 'assetTag', label: '資産タグ', required: true },
  { key: 'name', label: '資産名', required: true },
  { key: 'kind', label: '種別', required: true },
  { key: 'state', label: '状態', required: false },
  { key: 'model', label: 'モデル・サービス名', required: false },
  { key: 'serialNumber', label: 'シリアル番号', required: false },
  { key: 'hostname', label: 'ホスト名', required: false },
  { key: 'vendor', label: 'メーカー・提供元', required: false },
  { key: 'assignedUserEmail', label: '利用者メール', required: false },
  { key: 'location', label: '保管場所', required: false },
  { key: 'internalNotes', label: '内部メモ', required: false },
];
const requestSchema = z
  .object({
    sourceKey: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    csv: z.string().min(1).max(24576),
    mapping: z.record(z.string(), z.string().max(120)),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
type PreviewRow = {
  row: number;
  externalId: string;
  assetTag: string;
  rawSerialNumber: string;
  operation: 'add' | 'update' | 'unchanged' | 'error';
  assetId: string | null;
  expectedVersion: number | null;
  identityExists: boolean;
  input: AssetInput | null;
  assignedEmail: string | null;
  issues: string[];
  match: 'external_id' | 'asset_tag' | 'new';
  changes: Array<{ field: string; label: string; before: string | null; after: string | null }>;
};
type ImportPlan = {
  headers: string[];
  mapping: Record<string, string>;
  reason: string;
  rows: PreviewRow[];
  counts: Record<PreviewRow['operation'], number>;
};
type PlanRecord = {
  id: string;
  organization_id: string;
  source_key: string;
  content_hash: string;
  plan_hash: string;
  plan: ImportPlan;
  created_at: Date;
  creatorName: string;
};
type ApplyResult = {
  added: number;
  updated: number;
  unchanged: number;
  skipped: number;
  assets: Array<{ row: number; id: string; version: number }>;
};
function checked<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const r = schema.safeParse(value);
  if (!r.success)
    throw Problems.validation(
      r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    );
  return r.data;
}
function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
function current(a: AssetRow): AssetInput {
  return {
    assetTag: a.asset_tag,
    name: a.name,
    kind: a.kind,
    state: a.state,
    model: a.model,
    serialNumber: a.serial_number,
    hostname: a.hostname,
    vendor: a.vendor,
    assignedUserId: a.assigned_user_id,
    location: a.location,
    internalNotes: a.internal_notes,
  };
}
const eligibleMembers = `SELECT DISTINCT u.id,u.display_name,u.primary_email FROM app_user u JOIN role_binding rb ON rb.user_id=u.id
 WHERE rb.organization_id=$1 AND rb.valid_from<=clock_timestamp() AND (rb.valid_until IS NULL OR rb.valid_until>clock_timestamp()) AND u.status='active' AND u.primary_email=$2`;

export class AssetImportsController {
  private readonly assets: AssetsController;
  constructor(private readonly pool: pg.Pool) {
    this.assets = new AssetsController(pool);
  }
  private write(auth: AuthenticatedRequest) {
    requireRole(auth.authz, 'agent', 'org_admin', 'platform_admin');
  }
  private read(auth: AuthenticatedRequest) {
    requireRole(auth.authz, 'agent', 'org_admin', 'platform_admin', 'auditor');
  }
  private async run<T>(
    auth: AuthenticatedRequest,
    fn: (c: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
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
        throw Problems.conflict(
          '取込対象が変わりました。CSVを再プレビューしてください。資産は一括で保存されませんでした',
        );
      throw e;
    } finally {
      c.release();
    }
  }
  inspect(auth: AuthenticatedRequest, value: unknown) {
    this.write(auth);
    const { csv } = checked(z.object({ csv: z.string().min(1).max(24576) }).strict(), value);
    const parsed = parseAssetCsv(csv);
    return { headers: parsed.headers, sample: parsed.rows.slice(0, 3), fields: importFields };
  }
  private async asset(c: pg.PoolClient, org: string, id: string) {
    return (
      await c.query<AssetRow>('SELECT * FROM asset WHERE organization_id=$1 AND id=$2', [org, id])
    ).rows[0];
  }
  private async identity(c: pg.PoolClient, org: string, source: string, externalId: string) {
    return (
      await c.query<{ asset_id: string }>(
        'SELECT asset_id FROM asset_source_identity WHERE organization_id=$1 AND source_key=$2 AND external_id=$3',
        [org, source, externalId],
      )
    ).rows[0];
  }
  private async emailUser(c: pg.PoolClient, org: string, email: string) {
    const users = (
      await c.query<{ id: string; display_name: string }>(eligibleMembers, [org, email])
    ).rows;
    if (users.length !== 1)
      throw Problems.validation([
        { field: 'assignedUserEmail', message: '利用者メールが同じ組織の有効な1名に一致しません' },
      ]);
    return users[0]!;
  }
  async preview(auth: AuthenticatedRequest, value: unknown) {
    this.write(auth);
    const input = checked(requestSchema, value),
      csv = parseAssetCsv(input.csv);
    for (const [key, column] of Object.entries(input.mapping))
      if (!importFields.some((f) => f.key === key) || (column && !csv.headers.includes(column)))
        throw Problems.validation([
          { field: 'mapping', message: 'CSVの見出しから対応列を選んでください' },
        ]);
    for (const f of importFields.filter((f) => f.required))
      if (!input.mapping[f.key])
        throw Problems.validation([{ field: f.key, message: `${f.label}の対応列が必須です` }]);
    const mapped = Object.values(input.mapping).filter(Boolean);
    if (new Set(mapped).size !== mapped.length)
      throw Problems.validation([
        { field: 'mapping', message: '1つの列を複数の属性に対応付けることはできません' },
      ]);
    return this.run(auth, async (c) => {
      const org = auth.authz.organizationId,
        rows: PreviewRow[] = [];
      for (let index = 0; index < csv.rows.length; index++) {
        const cells = csv.rows[index]!;
        const get = (key: string) =>
          input.mapping[key]
            ? (cells[csv.headers.indexOf(input.mapping[key]!)] ?? '').trim()
            : undefined;
        const externalId = get('externalId') ?? '',
          assetTag = get('assetTag') ?? '';
        const row: PreviewRow = {
          row: index + 2,
          externalId,
          assetTag,
          rawSerialNumber: get('serialNumber') ?? '',
          operation: 'error',
          assetId: null,
          expectedVersion: null,
          identityExists: false,
          input: null,
          assignedEmail: null,
          issues: [],
          match: 'new',
          changes: [],
        };
        rows.push(row);
        try {
          if (cells.length !== csv.headers.length)
            throw Problems.validation([{ field: 'csv', message: '列数が見出しと一致しません' }]);
          checked(z.string().min(1).max(120), externalId);
          const identity = await this.identity(c, org, input.sourceKey, externalId);
          const existing = identity
            ? await this.asset(c, org, identity.asset_id)
            : (
                await c.query<AssetRow>(
                  'SELECT * FROM asset WHERE organization_id=$1 AND lower(asset_tag)=lower($2)',
                  [org, assetTag],
                )
              ).rows[0];
          if (identity && !existing) throw Problems.conflict('外部IDの資産が見つかりません');
          row.identityExists = !!identity;
          row.match = identity ? 'external_id' : existing ? 'asset_tag' : 'new';
          row.assetId = existing?.id ?? null;
          row.expectedVersion = existing?.version ?? null;
          if (
            existing &&
            !identity &&
            (
              await c.query(
                'SELECT 1 FROM asset_source_identity WHERE organization_id=$1 AND source_key=$2 AND asset_id=$3',
                [org, input.sourceKey, existing.id],
              )
            ).rowCount
          )
            throw Problems.conflict(
              '資産タグの一致先は、この取込元の別の外部IDとすでに対応しています',
            );
          const raw: Record<string, unknown> = existing ? current(existing) : { state: 'stocked' };
          for (const field of importFields.filter(
            (f) => !['externalId', 'assignedUserEmail'].includes(f.key),
          ))
            if (input.mapping[field.key]) raw[field.key] = get(field.key);
          let ownerName: string | null = null;
          if (input.mapping.assignedUserEmail) {
            row.assignedEmail = get('assignedUserEmail') ?? '';
            const owner = row.assignedEmail
              ? await this.emailUser(c, org, row.assignedEmail)
              : null;
            raw.assignedUserId = owner?.id ?? null;
            ownerName = owner?.display_name ?? null;
          }
          const normalized = checked(assetInputSchema, raw);
          row.input = normalized;
          await this.assets.validateInput(c, auth, normalized);
          if (existing?.kind && existing.kind !== normalized.kind)
            throw Problems.conflict('登録後の種別は変更できません');
          if (existing?.state === 'retired' && normalized.state !== 'retired')
            throw Problems.conflict('廃止した資産は再稼働できません');
          const clashes = (
            await c.query<{ id: string }>(
              `SELECT id FROM asset WHERE organization_id=$1 AND id IS DISTINCT FROM $2::uuid
            AND (lower(asset_tag)=lower($3) OR ($4<>'' AND lower(serial_number)=lower($4)))`,
              [org, existing?.id ?? null, normalized.assetTag, normalized.serialNumber],
            )
          ).rows;
          if (clashes.length)
            throw Problems.conflict('資産タグまたはシリアル番号が別の資産と競合します');
          const before = existing ? current(existing) : null;
          for (const [key, val] of Object.entries(normalized)) {
            const old = before?.[key as keyof AssetInput] ?? null;
            if (!before || old !== val) {
              let oldDisplay = old === null ? null : String(old),
                newDisplay = val === null ? null : String(val);
              if (key === 'assignedUserId') {
                oldDisplay = existing?.assigned_user_id
                  ? ((
                      await c.query<{ display_name: string }>(
                        'SELECT display_name FROM app_user WHERE id=$1',
                        [existing.assigned_user_id],
                      )
                    ).rows[0]?.display_name ?? null)
                  : null;
                newDisplay = ownerName ?? oldDisplay;
                if (!val) newDisplay = null;
              }
              row.changes.push({
                field: key,
                label:
                  key === 'assignedUserId'
                    ? '利用者'
                    : (importFields.find((f) => f.key === key)?.label ?? key),
                before: oldDisplay,
                after: newDisplay,
              });
            }
          }
          row.operation = existing ? (row.changes.length ? 'update' : 'unchanged') : 'add';
        } catch (e) {
          if (!(e instanceof ProblemError)) throw e;
          row.issues.push(...(e.errors?.map((i) => `${i.field}: ${i.message}`) ?? [e.message]));
        }
      }
      for (const key of ['externalId', 'assetTag', 'serialNumber'] as const) {
        const groups = new Map<string, PreviewRow[]>();
        for (const row of rows) {
          const val = key === 'serialNumber' ? row.rawSerialNumber : row[key];
          const match = key === 'externalId' ? val : val.toLowerCase();
          if (match) groups.set(match, [...(groups.get(match) ?? []), row]);
        }
        for (const group of groups.values())
          if (group.length > 1)
            for (const row of group) {
              row.operation = 'error';
              row.issues.push(`${key}: CSV内で重複しています（該当する全行を隔離）`);
            }
      }
      // Different identifiers must not select the same asset, including tag renames.
      const targets = new Map<string, PreviewRow[]>();
      for (const row of rows)
        if (row.assetId) targets.set(row.assetId, [...(targets.get(row.assetId) ?? []), row]);
      for (const group of targets.values())
        if (group.length > 1)
          for (const row of group) {
            row.operation = 'error';
            row.issues.push('複数の行が同じ既存資産を指しています');
          }
      const counts = { add: 0, update: 0, unchanged: 0, error: 0 };
      for (const row of rows) counts[row.operation]++;
      const plan: ImportPlan = {
        headers: csv.headers,
        mapping: input.mapping,
        reason: input.reason,
        rows,
        counts,
      };
      const id = uuidv7(),
        planHash = hash(JSON.stringify(plan)),
        contentHash = hash(input.csv);
      await c.query(
        'INSERT INTO asset_import_plan(id,organization_id,source_key,content_hash,plan_hash,plan,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [id, org, input.sourceKey, contentHash, planHash, plan, auth.userId],
      );
      await recordAuditEvent(c, {
        eventType: 'asset.import.previewed',
        organizationId: org,
        actorType: 'user',
        actorId: auth.userId,
        targetType: 'asset_import',
        targetId: id,
        action: 'asset.import.previewed',
        outcome: 'success',
        afterState: { ...counts, contentHash, planHash },
      });
      return { id, planHash, counts };
    });
  }
  async list(auth: AuthenticatedRequest) {
    this.read(auth);
    return this.run(auth, async (c) => ({
      canManage: hasRole(auth.authz, 'agent', 'org_admin', 'platform_admin'),
      items: (
        await c.query(
          `SELECT p.id,p.source_key AS "sourceKey",p.created_at AS "createdAt",p.plan->'counts' AS counts,r.applied_at AS "appliedAt"
        FROM asset_import_plan p LEFT JOIN asset_import_receipt r ON r.import_id=p.id AND r.organization_id=p.organization_id
        WHERE p.organization_id=$1 ORDER BY p.created_at DESC,p.id DESC LIMIT 50`,
          [auth.authz.organizationId],
        )
      ).rows,
    }));
  }
  async detail(auth: AuthenticatedRequest, id: string) {
    this.read(auth);
    checked(z.string().uuid(), id);
    return this.run(auth, async (c) => {
      const p = (
        await c.query<PlanRecord>(
          `SELECT p.*,u.display_name AS "creatorName" FROM asset_import_plan p JOIN app_user u ON u.id=p.created_by WHERE p.id=$1 AND p.organization_id=$2`,
          [id, auth.authz.organizationId],
        )
      ).rows[0];
      if (!p) throw Problems.notFound('取込プレビュー');
      const receipt =
        (
          await c.query(
            'SELECT result,applied_at AS "appliedAt",u.display_name AS "actorName" FROM asset_import_receipt r JOIN app_user u ON u.id=r.applied_by WHERE import_id=$1 AND organization_id=$2',
            [id, auth.authz.organizationId],
          )
        ).rows[0] ?? null;
      return {
        id: p.id,
        sourceKey: p.source_key,
        contentHash: p.content_hash,
        planHash: p.plan_hash,
        plan: p.plan,
        createdAt: p.created_at,
        creatorName: p.creatorName,
        receipt,
        canManage: hasRole(auth.authz, 'agent', 'org_admin', 'platform_admin'),
      };
    });
  }
  async apply(auth: AuthenticatedRequest, id: string, value: unknown) {
    this.write(auth);
    checked(z.string().uuid(), id);
    const input = checked(
      z.object({ planHash: z.string().length(64), confirmed: z.literal(true) }).strict(),
      value,
    );
    return this.run(auth, async (c) => {
      const org = auth.authz.organizationId;
      // Serialize imports in this organization; manual edits are guarded by row versions and DB constraints.
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'asset-import:' + org,
      ]);
      const p = (
        await c.query<PlanRecord>(
          'SELECT * FROM asset_import_plan WHERE id=$1 AND organization_id=$2',
          [id, org],
        )
      ).rows[0];
      if (!p) throw Problems.notFound('取込プレビュー');
      if (p.plan_hash !== input.planHash)
        throw Problems.conflict('確認したプレビューが一致しません');
      const previous = (
        await c.query<{ result: ApplyResult }>(
          'SELECT result FROM asset_import_receipt WHERE import_id=$1 AND organization_id=$2',
          [id, org],
        )
      ).rows[0];
      if (previous) return { ...previous.result, replayed: true };
      const valid = p.plan.rows.filter((r) => r.operation !== 'error');
      if (!valid.length)
        throw Problems.conflict('正常行がありません。CSVを修正し再プレビューしてください');
      const ids = valid
        .map((r) => r.assetId)
        .filter((a): a is string => !!a)
        .sort();
      if (ids.length)
        await c.query(
          'SELECT id FROM asset WHERE organization_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',
          [org, ids],
        );
      const result: ApplyResult = {
        added: 0,
        updated: 0,
        unchanged: 0,
        skipped: p.plan.counts.error,
        assets: [],
      };
      for (const row of valid) {
        const identity = await this.identity(c, org, p.source_key, row.externalId);
        if (
          (row.identityExists && identity?.asset_id !== row.assetId) ||
          (!row.identityExists && identity)
        )
          throw Problems.conflict('外部IDの対応が変わりました。CSVを再プレビューしてください');
        const a = row.assetId ? await this.asset(c, org, row.assetId) : undefined;
        if (row.assetId && (!a || a.version !== row.expectedVersion))
          throw Problems.conflict(
            '資産がプレビュー後に変更されました。CSVを再プレビューしてください。全行の保存を取り消しました',
          );
        try {
          if (row.assignedEmail) {
            const user = await this.emailUser(c, org, row.assignedEmail);
            if (user.id !== row.input!.assignedUserId)
              throw Problems.conflict('利用者の対応が変わりました。再プレビューしてください');
          }
          await this.assets.validateInput(c, auth, row.input!);
        } catch (e) {
          if (e instanceof ProblemError && e.status === 400)
            throw Problems.conflict(
              '資産の利用者・条件が変わりました。CSVを再プレビューしてください',
            );
          throw e;
        }
        const reason = `CSV取込 ${id}: ${p.plan.reason}`.slice(0, 1000);
        let saved = { id: row.assetId!, version: row.expectedVersion! };
        if (row.operation === 'add') {
          saved = await this.assets.createInTransaction(c, auth, { ...row.input!, reason }, 'csv');
          result.added++;
        } else if (row.operation === 'update') {
          saved = await this.assets.editInTransaction(c, auth, row.assetId!, {
            ...row.input!,
            reason,
            expectedVersion: row.expectedVersion,
          });
          result.updated++;
        } else result.unchanged++;
        if (!row.identityExists) {
          await c.query(
            'INSERT INTO asset_source_identity(organization_id,source_key,external_id,asset_id,import_id) VALUES($1,$2,$3,$4,$5)',
            [org, p.source_key, row.externalId, saved.id, id],
          );
          await recordAuditEvent(c, {
            eventType: 'asset.source.bound',
            organizationId: org,
            actorType: 'user',
            actorId: auth.userId,
            targetType: 'asset',
            targetId: saved.id,
            action: 'asset.source.bound',
            outcome: 'success',
            afterState: { importId: id },
          });
        }
        result.assets.push({ row: row.row, ...saved });
      }
      await c.query(
        'INSERT INTO asset_import_receipt(import_id,organization_id,result,applied_by) VALUES($1,$2,$3,$4)',
        [id, org, result, auth.userId],
      );
      await recordAuditEvent(c, {
        eventType: 'asset.import.applied',
        organizationId: org,
        actorType: 'user',
        actorId: auth.userId,
        targetType: 'asset_import',
        targetId: id,
        action: 'asset.import.applied',
        outcome: 'success',
        afterState: {
          added: result.added,
          updated: result.updated,
          unchanged: result.unchanged,
          skipped: result.skipped,
          planHash: p.plan_hash,
        },
      });
      return { ...result, replayed: false };
    });
  }
}
