import type pg from 'pg';
import { Problems } from '@solvi/shared';
import { requireRole, type AuthzContext } from '../../common/authz/authz.js';

/**
 * 上長・主部署・部署長の変更履歴 (WP-P4-APR-015 §6.1 / ADR-0023 §3)。
 *
 * ## 監査イベントを読むだけ
 *
 * 上長・主部署・部署長の設定は承認権限の付与と同格の特権操作である(脅威 T-26)。
 * その変更を人が見直せるようにするため、既存の監査イベントを期間指定で返す。
 * **新しい履歴テーブルは作らない。** 監査は append-only の正本であり、
 * 二つ目の履歴を持つと片方だけ直したときに食い違う。
 *
 * ## 返さないもの
 *
 * 監査イベントの `before_state` / `after_state` には役職・勤務地が含まれることがある。
 * 応答には上長・主部署・部署・部署長だけを写し、**社員番号・役職・勤務地は返さない**
 * (03.16 §3.6 / ADR-0023 §12)。値そのものを読み出さないのではなく、
 * 明示的に組み立てた項目だけを返す。
 *
 * ## 読める人
 *
 * `org_admin` と `auditor` だけ。監査テーブルのRLS(organization_id = app_current_org())に
 * 加えて、ここでも組織IDで絞る(RLSを認可の代わりにしない / ADR-0015)。
 */

/** 1回に返す上限。**無制限にしない** — 履歴は増え続ける。 */
export const RELATIONSHIP_CHANGE_PAGE_SIZE = 50;
/** 指定できる期間の上限(日)。長すぎる走査を防ぐ。 */
const MAX_PERIOD_DAYS = 366;

export type RelationshipChangeType =
  | 'manager'
  | 'primary_department'
  | 'manager_and_primary_department'
  | 'department_head_assigned'
  | 'department_head_removed';

export interface RelationshipChangePerson {
  userId: string | null;
  displayName: string | null;
}

export interface RelationshipChangeDepartment {
  departmentId: string | null;
  departmentCode: string | null;
  departmentName: string | null;
}

export interface RelationshipChangeItem {
  eventId: string;
  occurredAt: string;
  changeType: RelationshipChangeType;
  actor: RelationshipChangePerson;
  subject: RelationshipChangePerson;
  before: unknown;
  after: unknown;
}

export interface RelationshipChangeInput {
  /** YYYY-MM-DD(UTC)。 */
  from: string;
  /** YYYY-MM-DD(UTC、この日を含む)。 */
  to: string;
  page: number;
}

export interface RelationshipChangeResult {
  items: RelationshipChangeItem[];
  page: number;
  pageSize: number;
  hasMore: boolean;
  from: string;
  to: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function readDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw Problems.validation([
      { field, message: '日付は YYYY-MM-DD で指定してください' },
    ]);
  }
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(time)) {
    throw Problems.validation([{ field, message: '日付が正しくありません' }]);
  }
  // 2026-02-30 のような繰り上がりを拒否する。
  if (new Date(time).toISOString().slice(0, 10) !== value) {
    throw Problems.validation([{ field, message: '日付が正しくありません' }]);
  }
  return value;
}

/** 期間・ページを検証する。未知の項目は値を見る前に拒否する(TL-03 / 脅威 T-03)。 */
export function parseRelationshipChangeQuery(value: unknown): RelationshipChangeInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw Problems.validation([{ field: 'query', message: '要求の形式が正しくありません' }]);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!['from', 'to', 'page'].includes(key)) {
      throw Problems.validation([{ field: key, message: 'この項目は指定できません' }]);
    }
  }
  const from = readDate(record.from, 'from');
  const to = readDate(record.to, 'to');
  const fromTime = Date.parse(`${from}T00:00:00.000Z`);
  const toTime = Date.parse(`${to}T00:00:00.000Z`);
  if (fromTime > toTime) {
    throw Problems.validation([{ field: 'from', message: '開始日は終了日以前にしてください' }]);
  }
  const days = Math.floor((toTime - fromTime) / 86_400_000) + 1;
  if (days > MAX_PERIOD_DAYS) {
    throw Problems.validation([
      { field: 'to', message: `期間は${MAX_PERIOD_DAYS}日以内にしてください` },
    ]);
  }
  const rawPage = record.page ?? '1';
  const page =
    typeof rawPage === 'string' || typeof rawPage === 'number'
      ? Number(rawPage)
      : Number.NaN;
  if (!Number.isInteger(page) || page < 1 || page > 10_000) {
    throw Problems.validation([{ field: 'page', message: 'ページは1以上で指定してください' }]);
  }
  return { from, to, page };
}

type AuditRow = {
  event_id: string;
  occurred_at: Date;
  event_type: string;
  actor_id: string | null;
  actor_display: string | null;
  subject_user_id: string | null;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
};

type PersonRow = { id: string; display_name: string };
type DepartmentRow = { id: string; code: string; name: string };

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function changed(before: unknown, after: unknown): boolean {
  return (before ?? null) !== (after ?? null);
}

function profileState(
  state: Record<string, unknown> | null,
  names: ReadonlyMap<string, string>,
  departments: ReadonlyMap<string, DepartmentRow>,
) {
  const managerUserId = stringValue(state?.managerUserId);
  const primaryDepartmentId = stringValue(state?.primaryDepartmentId);
  const department = primaryDepartmentId ? departments.get(primaryDepartmentId) : undefined;
  return {
    managerUserId,
    managerDisplayName: managerUserId ? (names.get(managerUserId) ?? null) : null,
    primaryDepartmentId,
    primaryDepartmentName: department?.name ?? null,
  };
}

function headState(
  state: Record<string, unknown> | null,
  department: DepartmentRow | null,
  names: ReadonlyMap<string, string>,
) {
  const userId = stringValue(state?.userId);
  if (!userId) return null;
  return {
    departmentId: department?.id ?? null,
    departmentName: department?.name ?? null,
    headUserId: userId,
    headDisplayName: names.get(userId) ?? null,
    validFrom: stringValue(state?.validFrom),
    validUntil: stringValue(state?.validUntil),
  };
}

export class RelationshipChangeService {
  constructor(private readonly client: pg.PoolClient | pg.Client) {}

  private requireViewer(ctx: AuthzContext): void {
    // 監査の閲覧は auditor、変更の管理は org_admin。どちらも組織内の履歴だけを見る。
    requireRole(ctx, 'org_admin', 'auditor');
  }

  async list(
    ctx: AuthzContext,
    input: RelationshipChangeInput,
  ): Promise<RelationshipChangeResult> {
    this.requireViewer(ctx);
    const fromTime = new Date(`${input.from}T00:00:00.000Z`);
    const toExclusive = new Date(Date.parse(`${input.to}T00:00:00.000Z`) + 86_400_000);
    const offset = (input.page - 1) * RELATIONSHIP_CHANGE_PAGE_SIZE;

    const { rows } = await this.client.query<AuditRow>(
      `SELECT event_id, occurred_at, event_type, actor_id, actor_display, subject_user_id,
              before_state, after_state
         FROM audit_event
        WHERE organization_id = $1
          AND occurred_at >= $2::timestamptz
          AND occurred_at < $3::timestamptz
          AND (
            (event_type = 'org.member.profile.updated' AND (
              (before_state->>'managerUserId') IS DISTINCT FROM (after_state->>'managerUserId')
              OR (before_state->>'primaryDepartmentId')
                 IS DISTINCT FROM (after_state->>'primaryDepartmentId')
            ))
            OR event_type IN ('org.department.head.assigned', 'org.department.head.removed')
          )
        ORDER BY occurred_at DESC, event_id DESC
        LIMIT ${RELATIONSHIP_CHANGE_PAGE_SIZE + 1} OFFSET $4`,
      [ctx.organizationId, fromTime.toISOString(), toExclusive.toISOString(), offset],
    );
    const hasMore = rows.length > RELATIONSHIP_CHANGE_PAGE_SIZE;
    const kept = hasMore ? rows.slice(0, RELATIONSHIP_CHANGE_PAGE_SIZE) : rows;

    // 表示名と部署名をまとめて引く。RLS により他組織の利用者・部署は見えない。
    const userIds = new Set<string>();
    const departmentIds = new Set<string>();
    const departmentCodes = new Set<string>();
    for (const row of kept) {
      if (row.actor_id) userIds.add(row.actor_id);
      if (row.subject_user_id) userIds.add(row.subject_user_id);
      const before = row.before_state ?? {};
      const after = row.after_state ?? {};
      for (const state of [before, after]) {
        for (const key of ['managerUserId', 'userId']) {
          const id = stringValue(state[key]);
          if (id) userIds.add(id);
        }
        const departmentId = stringValue(state.primaryDepartmentId);
        if (departmentId) departmentIds.add(departmentId);
        const departmentCode = stringValue(state.departmentCode);
        if (departmentCode) departmentCodes.add(departmentCode);
      }
    }

    const names = new Map<string, string>();
    if (userIds.size > 0) {
      const { rows: people } = await this.client.query<PersonRow>(
        'SELECT id, display_name FROM app_user WHERE id = ANY($1::uuid[])',
        [[...userIds]],
      );
      for (const person of people) names.set(person.id, person.display_name);
    }
    const departmentsById = new Map<string, DepartmentRow>();
    const departmentsByCode = new Map<string, DepartmentRow>();
    if (departmentIds.size > 0 || departmentCodes.size > 0) {
      const { rows: departments } = await this.client.query<DepartmentRow>(
        `SELECT id, code, name
           FROM department
          WHERE organization_id = $1
            AND (id = ANY($2::uuid[]) OR code = ANY($3::text[]))`,
        [ctx.organizationId, [...departmentIds], [...departmentCodes]],
      );
      for (const department of departments) {
        departmentsById.set(department.id, department);
        departmentsByCode.set(department.code, department);
      }
    }

    const items: RelationshipChangeItem[] = [];
    for (const row of kept) {
      const actor = {
        userId: row.actor_id,
        displayName: row.actor_id
          ? (names.get(row.actor_id) ?? row.actor_display ?? null)
          : (row.actor_display ?? null),
      };
      if (row.event_type === 'org.member.profile.updated') {
        const before = row.before_state ?? {};
        const after = row.after_state ?? {};
        const managerChanged = changed(before.managerUserId, after.managerUserId);
        const departmentChanged = changed(
          before.primaryDepartmentId,
          after.primaryDepartmentId,
        );
        if (!managerChanged && !departmentChanged) continue;
        items.push({
          eventId: row.event_id,
          occurredAt: row.occurred_at.toISOString(),
          changeType:
            managerChanged && departmentChanged
              ? 'manager_and_primary_department'
              : managerChanged
                ? 'manager'
                : 'primary_department',
          actor,
          subject: {
            userId: row.subject_user_id,
            displayName: row.subject_user_id
              ? (names.get(row.subject_user_id) ?? null)
              : null,
          },
          before: profileState(row.before_state, names, departmentsById),
          after: profileState(row.after_state, names, departmentsById),
        });
        continue;
      }

      // 部署長の設定・終了。departmentCode は設定時 after / 終了時 before にある。
      const before = row.before_state ?? {};
      const after = row.after_state ?? {};
      const departmentCode =
        stringValue(after.departmentCode) ?? stringValue(before.departmentCode);
      const department = departmentCode ? (departmentsByCode.get(departmentCode) ?? null) : null;
      const headUserId = stringValue(after.userId) ?? stringValue(before.userId);
      items.push({
        eventId: row.event_id,
        occurredAt: row.occurred_at.toISOString(),
        changeType:
          row.event_type === 'org.department.head.assigned'
            ? 'department_head_assigned'
            : 'department_head_removed',
        actor,
        subject: {
          userId: headUserId ?? row.subject_user_id,
          displayName: headUserId
            ? (names.get(headUserId) ?? null)
            : row.subject_user_id
              ? (names.get(row.subject_user_id) ?? null)
              : null,
        },
        before: headState(row.before_state, department, names),
        after: headState(row.after_state, department, names),
      });
    }

    return {
      items,
      page: input.page,
      pageSize: RELATIONSHIP_CHANGE_PAGE_SIZE,
      hasMore,
      from: input.from,
      to: input.to,
    };
  }
}
