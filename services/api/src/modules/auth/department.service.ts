import type pg from 'pg';
import { Problems } from '@solvi/shared';
import { recordAuditEvent, uuidv7 } from '../../common/audit/audit.js';
import { requireRole, type AuthzContext } from '../../common/authz/authz.js';

/**
 * 部署・部署長の管理 (FR-IDM-010 / FR-IDM-012 / FR-IDM-013 / WP-P4-IDM-013)。
 *
 * ## 変更できるのは組織管理者だけ
 *
 * 上長・主部署・部署長の設定は承認権限の付与と同格の特権操作である
 * (ADR-0023 §3 / 脅威 T-26)。`platform_admin` の扱いは ADR で `要確認` のため、
 * ここでは `org_admin` だけを許す(fail closed)。
 *
 * ## 入力の再検証
 *
 * 親部署・部署長候補は、画面から送られたIDをそのまま使わない。
 * **同一組織に実在し、有効であることを毎回サーバーで引き直す**。
 * RLS は組織単位までしか守らないため、認可と再検証はAPI層の責務である(ADR-0015)。
 *
 * ## DBの拒否を利用者向けの応答へ変換する
 *
 * 循環・深さ・無効な部署・使用中の無効化は Migration 0037 のトリガが拒否する。
 * 内部のSQLSTATEや例外文をそのまま返すと、スキーマの内部情報が漏れる。
 * ここで日本語の 409/400 に変換する。
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_MAX = 64;
const NAME_MAX = 200;
const MAX_DEPTH = 10;

export interface DepartmentTreeRow {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  active: boolean;
}

export interface DepartmentNode extends DepartmentTreeRow {
  depth: number;
  children: DepartmentNode[];
}

export interface DepartmentRecord extends DepartmentTreeRow {
  createdAt: string;
  updatedAt: string;
}

export interface DepartmentMember {
  userId: string;
  displayName: string;
  status: 'active' | 'deactivated';
  jobTitle: string | null;
  managerUserId: string | null;
  managerDisplayName: string | null;
  activeMembership: boolean;
}

export interface DepartmentHeadRecord {
  id: string;
  departmentId: string;
  userId: string;
  displayName: string;
  validFrom: string;
  validUntil: string | null;
}

/**
 * 部署の一覧を木へ組み立てる。
 *
 * 画面の都合(親→子の順)と、深さの表示に使う。DBは循環を拒否するが、
 * ここでも訪問済みを確認して**壊れたデータで無限ループしない**ようにする。
 */
export function buildDepartmentTree(rows: readonly DepartmentTreeRow[]): DepartmentNode[] {
  const byId = new Map<string, DepartmentNode>();
  for (const row of rows) {
    byId.set(row.id, { ...row, depth: 1, children: [] });
  }
  const roots: DepartmentNode[] = [];
  for (const row of rows) {
    const node = byId.get(row.id)!;
    const parent = row.parentId ? byId.get(row.parentId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }

  const visited = new Set<string>();
  const assignDepth = (node: DepartmentNode, depth: number): void => {
    if (visited.has(node.id)) return;
    // 循環したデータでは子が祖先を指す。訪問済みの子を外して木に戻す。
    node.children = node.children.filter((child) => !visited.has(child.id));
    visited.add(node.id);
    node.depth = depth;
    node.children.sort((a, b) => a.code.localeCompare(b.code) || a.id.localeCompare(b.id));
    for (const child of node.children) assignDepth(child, depth + 1);
  };
  roots.sort((a, b) => a.code.localeCompare(b.code) || a.id.localeCompare(b.id));
  for (const root of roots) assignDepth(root, 1);
  // 循環したデータ(DBが拒否するので通常は存在しない)でも全件を返す。
  for (const row of rows) {
    const node = byId.get(row.id)!;
    if (!visited.has(node.id)) {
      roots.push(node);
      assignDepth(node, 1);
    }
  }
  return roots;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : '';
}

/**
 * トリガの拒否を利用者向けの応答へ変換する。
 * 一致しないものは握りつぶさず、呼び出し元で 500 として扱う(原因を隠さない)。
 */
function translateDepartmentError(error: unknown): never {
  const code = errorCode(error);
  const message = errorMessage(error);
  if (code === '23505') {
    throw Problems.conflict('同じ部署コードが既に使われています');
  }
  if (code === '23503') {
    throw Problems.notFound('親部署');
  }
  if (code === '23001') {
    if (message.includes('child departments')) {
      throw Problems.conflict(
        '子部署が残っているため無効化できません。先に子部署を無効化するか、親から外してください。',
      );
    }
    if (message.includes('active members')) {
      throw Problems.conflict(
        '有効な所属メンバーが残っているため無効化できません。先に主部署を変更してください。',
      );
    }
    if (message.includes('department head')) {
      throw Problems.conflict(
        '有効な部署長が残っているため無効化できません。先に部署長の終了日を設定してください。',
      );
    }
    throw Problems.conflict('この部署はまだ使用されているため無効化できません');
  }
  if (code === '23P01') {
    throw Problems.conflict(
      'この部署には既に有効な部署長がいます。先に現在の部署長の終了日を設定してください。',
    );
  }
  if (code === '23514') {
    if (message.includes('department_cycle')) {
      throw Problems.conflict('部署の親子関係が循環します。別の親部署を選んでください。');
    }
    if (message.includes('department_depth')) {
      throw Problems.conflict('部署の階層が深すぎます(上限10階層)。');
    }
    if (message.includes('department_inactive')) {
      throw Problems.conflict('無効化された部署は指定できません。');
    }
    if (message.includes('department_head_immutable')) {
      throw Problems.conflict(
        '部署長の任期は変更できません。終了日は短縮だけが可能です。延長する場合は新しい任期として登録してください。',
      );
    }
    if (message.includes('department_immutable')) {
      throw Problems.conflict('部署の識別子は変更できません。');
    }
    throw Problems.validation([{ field: 'department', message: '部署の内容を確認してください' }]);
  }
  throw error;
}

function requireUuid(value: string, field: string): string {
  if (!UUID_RE.test(value)) {
    throw Problems.validation([{ field, message: 'IDの形式が正しくありません' }]);
  }
  return value.toLowerCase();
}

function readCode(value: string): string {
  const code = value.trim();
  if (code.length < 1 || code.length > CODE_MAX) {
    throw Problems.validation([
      { field: 'code', message: `部署コードは1〜${CODE_MAX}文字で入力してください` },
    ]);
  }
  return code;
}

function readName(value: string): string {
  const name = value.trim();
  if (name.length < 1 || name.length > NAME_MAX) {
    throw Problems.validation([
      { field: 'name', message: `部署名は1〜${NAME_MAX}文字で入力してください` },
    ]);
  }
  return name;
}

export class DepartmentService {
  constructor(private readonly client: pg.PoolClient | pg.Client) {}

  /** 部署の管理は組織管理者だけが行う(ADR-0023 §3)。 */
  private requireAdmin(ctx: AuthzContext): void {
    requireRole(ctx, 'org_admin');
  }

  private async requireDepartment(
    ctx: AuthzContext,
    departmentId: string,
  ): Promise<DepartmentRecord> {
    const id = requireUuid(departmentId, 'departmentId');
    const { rows } = await this.client.query(
      `SELECT id, code, name, parent_id, active, created_at, updated_at
         FROM department
        WHERE id = $1 AND organization_id = $2`,
      [id, ctx.organizationId],
    );
    if (rows.length === 0) throw Problems.notFound('部署');
    return {
      id: rows[0]!.id as string,
      code: rows[0]!.code as string,
      name: rows[0]!.name as string,
      parentId: (rows[0]!.parent_id as string | null) ?? null,
      active: rows[0]!.active as boolean,
      createdAt: (rows[0]!.created_at as Date).toISOString(),
      updatedAt: (rows[0]!.updated_at as Date).toISOString(),
    };
  }

  /** 有効な親部署であることを確かめる。他組織のIDは RLS でも見えないため 404。 */
  private async requireActiveParent(ctx: AuthzContext, parentId: string): Promise<void> {
    const { rows } = await this.client.query(
      'SELECT active FROM department WHERE id = $1 AND organization_id = $2',
      [requireUuid(parentId, 'parentId'), ctx.organizationId],
    );
    if (rows.length === 0) throw Problems.notFound('親部署');
    if (!(rows[0]!.active as boolean)) {
      throw Problems.conflict('無効化された部署を親に指定できません');
    }
  }

  /**
   * 部署の深さ(根を1とする)。ADR-0023 §3 は深さ上限10をDBとAPIの両方で
   * 検証することを求める。ここでは**利用者へ早く理由を返す**ために数える。
   * 最終的な保証はトリガ(同時更新を含む)である。
   */
  private async hierarchyDepth(ctx: AuthzContext, departmentId: string): Promise<number> {
    const { rows } = await this.client.query(
      `WITH RECURSIVE up(id, parent_id, depth) AS (
         SELECT d.id, d.parent_id, 1
           FROM department d
          WHERE d.id = $1 AND d.organization_id = $2
         UNION ALL
         SELECT p.id, p.parent_id, up.depth + 1
           FROM department p
           JOIN up ON p.id = up.parent_id AND p.organization_id = $2
          WHERE up.depth < $3
       )
       SELECT coalesce(max(depth), 0)::int AS depth FROM up`,
      [departmentId, ctx.organizationId, MAX_DEPTH + 2],
    );
    return Number(rows[0]?.depth ?? 0);
  }

  /** 配下の最大の深さ(子を1とする)。自分自身は含めない。 */
  private async descendantDepth(ctx: AuthzContext, departmentId: string): Promise<number> {
    const { rows } = await this.client.query(
      `WITH RECURSIVE down(id, depth) AS (
         SELECT c.id, 1
           FROM department c
          WHERE c.parent_id = $1 AND c.organization_id = $2
         UNION ALL
         SELECT c.id, down.depth + 1
           FROM department c
           JOIN down ON c.parent_id = down.id AND c.organization_id = $2
          WHERE down.depth < $3
       )
       SELECT coalesce(max(depth), 0)::int AS depth FROM down`,
      [departmentId, ctx.organizationId, MAX_DEPTH + 2],
    );
    return Number(rows[0]?.depth ?? 0);
  }

  /** 有効な所属(ADR-0023 §1)かつプロフィールを持つことを確かめる。 */
  private async requireActiveMember(
    ctx: AuthzContext,
    userId: string,
    label: string,
  ): Promise<void> {
    const id = requireUuid(userId, 'userId');
    const { rows } = await this.client.query(
      `SELECT 1
         FROM app_user u
         JOIN role_binding rb ON rb.user_id = u.id AND rb.organization_id = $2
        WHERE u.id = $1
          AND u.status = 'active'
          AND rb.valid_from <= clock_timestamp()
          AND (rb.valid_until IS NULL OR rb.valid_until > clock_timestamp())
        LIMIT 1`,
      [id, ctx.organizationId],
    );
    if (rows.length === 0) throw Problems.notFound(label);
    const { rows: profile } = await this.client.query(
      'SELECT 1 FROM org_member_profile WHERE organization_id = $1 AND user_id = $2',
      [ctx.organizationId, id],
    );
    if (profile.length === 0) {
      throw Problems.conflict(
        '組織プロフィールが未設定の利用者です。先にプロフィールを設定してください。',
      );
    }
  }

  async listTree(ctx: AuthzContext): Promise<DepartmentNode[]> {
    this.requireAdmin(ctx);
    const { rows } = await this.client.query(
      `SELECT id, code, name, parent_id, active
         FROM department
        WHERE organization_id = $1
        ORDER BY code, id`,
      [ctx.organizationId],
    );
    return buildDepartmentTree(
      rows.map((row) => ({
        id: row.id as string,
        code: row.code as string,
        name: row.name as string,
        parentId: (row.parent_id as string | null) ?? null,
        active: row.active as boolean,
      })),
    );
  }

  async listMembers(ctx: AuthzContext, departmentId: string): Promise<DepartmentMember[]> {
    this.requireAdmin(ctx);
    const department = await this.requireDepartment(ctx, departmentId);
    const { rows } = await this.client.query(
      `SELECT p.user_id, u.display_name, u.status, p.job_title,
              p.manager_user_id, mu.display_name AS manager_display_name,
              EXISTS (
                SELECT 1 FROM role_binding rb
                 WHERE rb.user_id = p.user_id AND rb.organization_id = p.organization_id
                   AND rb.valid_from <= clock_timestamp()
                   AND (rb.valid_until IS NULL OR rb.valid_until > clock_timestamp())
              ) AS active_membership
         FROM org_member_profile p
         JOIN app_user u ON u.id = p.user_id
         LEFT JOIN app_user mu ON mu.id = p.manager_user_id
        WHERE p.organization_id = $1 AND p.primary_department_id = $2
        ORDER BY u.display_name, p.user_id`,
      [ctx.organizationId, department.id],
    );
    return rows.map((row) => ({
      userId: row.user_id as string,
      displayName: row.display_name as string,
      status: row.status as 'active' | 'deactivated',
      jobTitle: (row.job_title as string | null) ?? null,
      managerUserId: (row.manager_user_id as string | null) ?? null,
      managerDisplayName: (row.manager_display_name as string | null) ?? null,
      activeMembership: row.active_membership as boolean,
    }));
  }

  async create(
    ctx: AuthzContext,
    input: { code: string; name: string; parentId?: string | null },
  ): Promise<DepartmentRecord> {
    this.requireAdmin(ctx);
    const code = readCode(input.code);
    const name = readName(input.name);
    const parentId = input.parentId ?? null;
    if (parentId !== null) {
      await this.requireActiveParent(ctx, parentId);
      if ((await this.hierarchyDepth(ctx, parentId)) + 1 > MAX_DEPTH) {
        throw Problems.conflict('部署の階層が深すぎます(上限10階層)。');
      }
    }

    const id = uuidv7();
    let row: pg.QueryResultRow | undefined;
    try {
      const { rows } = await this.client.query(
        `INSERT INTO department (id, organization_id, code, name, parent_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, code, name, parent_id, active, created_at, updated_at`,
        [id, ctx.organizationId, code, name, parentId],
      );
      row = rows[0];
    } catch (error) {
      translateDepartmentError(error);
    }
    if (!row) throw Problems.internal();

    await recordAuditEvent(this.client, {
      eventType: 'org.department.created',
      organizationId: ctx.organizationId,
      actorType: 'user',
      actorId: ctx.principal.userId,
      targetType: 'department',
      targetId: id,
      action: 'create',
      outcome: 'success',
      afterState: { code, name, parentId, active: true },
    });

    return {
      id: row!.id as string,
      code: row!.code as string,
      name: row!.name as string,
      parentId: (row!.parent_id as string | null) ?? null,
      active: row!.active as boolean,
      createdAt: (row!.created_at as Date).toISOString(),
      updatedAt: (row!.updated_at as Date).toISOString(),
    };
  }

  async edit(
    ctx: AuthzContext,
    departmentId: string,
    input: { code?: string; name?: string; parentId?: string | null },
  ): Promise<DepartmentRecord> {
    this.requireAdmin(ctx);
    const before = await this.requireDepartment(ctx, departmentId);
    if (!before.active) {
      throw Problems.conflict('無効化された部署は編集できません。');
    }

    const code = input.code !== undefined ? readCode(input.code) : before.code;
    const name = input.name !== undefined ? readName(input.name) : before.name;
    const parentProvided = Object.hasOwn(input, 'parentId');
    const parentId = parentProvided ? (input.parentId ?? null) : before.parentId;

    if (code === before.code && name === before.name && parentId === before.parentId) {
      return before;
    }
    if (parentProvided && parentId !== null) {
      if (parentId === before.id) {
        throw Problems.validation([
          { field: 'parentId', message: '自分自身を親部署に指定できません' },
        ]);
      }
      if (parentId !== before.parentId) {
        await this.requireActiveParent(ctx, parentId);
        const parentDepth = await this.hierarchyDepth(ctx, parentId);
        const below = await this.descendantDepth(ctx, before.id);
        if (parentDepth + 1 + below > MAX_DEPTH) {
          throw Problems.conflict('部署の階層が深すぎます(上限10階層)。');
        }
      }
    }

    const sets: string[] = [];
    const values: unknown[] = [before.id, ctx.organizationId];
    if (code !== before.code) {
      values.push(code);
      sets.push(`code = $${values.length}`);
    }
    if (name !== before.name) {
      values.push(name);
      sets.push(`name = $${values.length}`);
    }
    if (parentProvided && parentId !== before.parentId) {
      values.push(parentId);
      sets.push(`parent_id = $${values.length}`);
    }

    let row: pg.QueryResultRow | undefined;
    try {
      const { rows } = await this.client.query(
        `UPDATE department
            SET ${sets.join(', ')}
          WHERE id = $1 AND organization_id = $2
        RETURNING id, code, name, parent_id, active, created_at, updated_at`,
        values,
      );
      row = rows[0];
    } catch (error) {
      translateDepartmentError(error);
    }
    if (!row) throw Problems.notFound('部署');

    await recordAuditEvent(this.client, {
      eventType: 'org.department.updated',
      organizationId: ctx.organizationId,
      actorType: 'user',
      actorId: ctx.principal.userId,
      targetType: 'department',
      targetId: before.id,
      action: 'update',
      outcome: 'success',
      beforeState: {
        code: before.code,
        name: before.name,
        parentId: before.parentId,
        active: before.active,
      },
      afterState: {
        code: row.code as string,
        name: row.name as string,
        parentId: (row.parent_id as string | null) ?? null,
        active: row.active as boolean,
      },
    });

    return {
      id: row.id as string,
      code: row.code as string,
      name: row.name as string,
      parentId: (row.parent_id as string | null) ?? null,
      active: row.active as boolean,
      createdAt: (row.created_at as Date).toISOString(),
      updatedAt: (row.updated_at as Date).toISOString(),
    };
  }

  async deactivate(ctx: AuthzContext, departmentId: string): Promise<DepartmentRecord> {
    this.requireAdmin(ctx);
    const before = await this.requireDepartment(ctx, departmentId);
    if (!before.active) throw Problems.conflict('この部署は既に無効化されています');

    let row: pg.QueryResultRow | undefined;
    try {
      const { rows } = await this.client.query(
        `UPDATE department
            SET active = false
          WHERE id = $1 AND organization_id = $2
        RETURNING id, code, name, parent_id, active, created_at, updated_at`,
        [before.id, ctx.organizationId],
      );
      row = rows[0];
    } catch (error) {
      translateDepartmentError(error);
    }
    if (!row) throw Problems.notFound('部署');

    await recordAuditEvent(this.client, {
      eventType: 'org.department.deactivated',
      organizationId: ctx.organizationId,
      actorType: 'user',
      actorId: ctx.principal.userId,
      targetType: 'department',
      targetId: before.id,
      action: 'deactivate',
      outcome: 'success',
      beforeState: {
        code: before.code,
        name: before.name,
        parentId: before.parentId,
        active: true,
      },
      afterState: {
        code: row.code as string,
        name: row.name as string,
        parentId: (row.parent_id as string | null) ?? null,
        active: false,
      },
    });

    return {
      id: row.id as string,
      code: row.code as string,
      name: row.name as string,
      parentId: (row.parent_id as string | null) ?? null,
      active: row.active as boolean,
      createdAt: (row.created_at as Date).toISOString(),
      updatedAt: (row.updated_at as Date).toISOString(),
    };
  }

  private async currentHead(
    ctx: AuthzContext,
    departmentId: string,
  ): Promise<DepartmentHeadRecord | null> {
    const { rows } = await this.client.query(
      `SELECT h.id, h.department_id, h.user_id, u.display_name, h.valid_from, h.valid_until
         FROM department_head h
         JOIN app_user u ON u.id = h.user_id
        WHERE h.department_id = $1 AND h.organization_id = $2
          AND h.valid_from <= clock_timestamp()
          AND (h.valid_until IS NULL OR h.valid_until > clock_timestamp())
        ORDER BY h.valid_from DESC, h.id
        LIMIT 1`,
      [departmentId, ctx.organizationId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id as string,
      departmentId: row.department_id as string,
      userId: row.user_id as string,
      displayName: row.display_name as string,
      validFrom: (row.valid_from as Date).toISOString(),
      validUntil: (row.valid_until as Date | null)?.toISOString() ?? null,
    };
  }

  async assignHead(
    ctx: AuthzContext,
    departmentId: string,
    input: { userId: string },
  ): Promise<DepartmentHeadRecord> {
    this.requireAdmin(ctx);
    const department = await this.requireDepartment(ctx, departmentId);
    if (!department.active) {
      throw Problems.conflict('無効化された部署に部署長は設定できません');
    }
    await this.requireActiveMember(ctx, input.userId, '部署長候補');
    const before = await this.currentHead(ctx, department.id);

    const id = uuidv7();
    let row: pg.QueryResultRow | undefined;
    try {
      const { rows } = await this.client.query(
        `INSERT INTO department_head
           (id, department_id, organization_id, user_id, valid_from, valid_until, created_by)
         VALUES ($1, $2, $3, $4, clock_timestamp(), NULL, $5)
         RETURNING id, department_id, user_id, valid_from, valid_until`,
        [id, department.id, ctx.organizationId, input.userId, ctx.principal.userId],
      );
      row = rows[0];
    } catch (error) {
      translateDepartmentError(error);
    }
    if (!row) throw Problems.notFound('部署');

    const { rows: names } = await this.client.query(
      'SELECT display_name FROM app_user WHERE id = $1',
      [input.userId],
    );
    const displayName = (names[0]?.display_name as string | null) ?? '';

    await recordAuditEvent(this.client, {
      eventType: 'org.department.head.assigned',
      organizationId: ctx.organizationId,
      actorType: 'user',
      actorId: ctx.principal.userId,
      subjectUserId: input.userId,
      targetType: 'department_head',
      targetId: id,
      action: 'assign',
      outcome: 'success',
      beforeState: before
        ? {
            userId: before.userId,
            validFrom: before.validFrom,
            validUntil: before.validUntil,
          }
        : null,
      afterState: {
        departmentCode: department.code,
        userId: input.userId,
        validFrom: (row.valid_from as Date).toISOString(),
        validUntil: (row.valid_until as Date | null)?.toISOString() ?? null,
      },
    });

    return {
      id: row.id as string,
      departmentId: row.department_id as string,
      userId: row.user_id as string,
      displayName,
      validFrom: (row.valid_from as Date).toISOString(),
      validUntil: (row.valid_until as Date | null)?.toISOString() ?? null,
    };
  }

  /**
   * 部署長の終了日付け。
   *
   * **延長はできない。** DBのトリガが `valid_until` の短縮だけを許す。
   * 延長が必要なら新しい任期として登録する(履歴が残る)。
   */
  async endHead(
    ctx: AuthzContext,
    departmentId: string,
    input: { validUntil?: Date | null },
  ): Promise<DepartmentHeadRecord> {
    this.requireAdmin(ctx);
    const department = await this.requireDepartment(ctx, departmentId);
    const before = await this.currentHead(ctx, department.id);
    if (!before) throw Problems.notFound('有効な部署長');

    if (input.validUntil && input.validUntil.getTime() <= new Date(before.validFrom).getTime()) {
      throw Problems.validation([
        { field: 'validUntil', message: '終了日は就任日より後にしてください' },
      ]);
    }

    let row: pg.QueryResultRow | undefined;
    try {
      const { rows } = await this.client.query(
        `UPDATE department_head
            SET valid_until = COALESCE($3::timestamptz, clock_timestamp())
          WHERE id = $1 AND organization_id = $2
        RETURNING id, department_id, user_id, valid_from, valid_until`,
        [before.id, ctx.organizationId, input.validUntil ?? null],
      );
      row = rows[0];
    } catch (error) {
      translateDepartmentError(error);
    }
    if (!row) throw Problems.notFound('部署長');

    await recordAuditEvent(this.client, {
      eventType: 'org.department.head.removed',
      organizationId: ctx.organizationId,
      actorType: 'user',
      actorId: ctx.principal.userId,
      subjectUserId: before.userId,
      targetType: 'department_head',
      targetId: before.id,
      action: 'remove',
      outcome: 'success',
      beforeState: {
        departmentCode: department.code,
        userId: before.userId,
        validFrom: before.validFrom,
        validUntil: before.validUntil,
      },
      afterState: {
        departmentCode: department.code,
        userId: before.userId,
        validFrom: (row.valid_from as Date).toISOString(),
        validUntil: (row.valid_until as Date | null)?.toISOString() ?? null,
      },
    });

    const { rows: names } = await this.client.query(
      'SELECT display_name FROM app_user WHERE id = $1',
      [before.userId],
    );
    return {
      id: row.id as string,
      departmentId: row.department_id as string,
      userId: row.user_id as string,
      displayName: (names[0]?.display_name as string | null) ?? before.displayName,
      validFrom: (row.valid_from as Date).toISOString(),
      validUntil: (row.valid_until as Date | null)?.toISOString() ?? null,
    };
  }
}
