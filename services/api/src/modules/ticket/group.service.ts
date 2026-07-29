import type pg from 'pg';
import { Problems } from '@solvi/shared';
import { recordAuditEvent, uuidv7 } from '../../common/audit/audit.js';
import { NoopDenialRecorder, type DenialRecorder } from '../../common/audit/denial-recorder.js';
import { requireRole, type AuthzContext } from '../../common/authz/authz.js';

/**
 * 担当グループ (FR-TKT-003 / WP-P2-GRP-015)。
 *
 * 要求は「担当 **Group** / Userを設定」だが、実装は個人割当だけだった。
 *
 * **これはITSMの基本動作の欠落である。** 問い合わせはまず担当グループの
 * キューに入り、そこから個人が引き受ける。個人指名しかできないと、
 * 「誰に振ればいいか分かる人」が全件を捌くことになり、
 * その人が休んだ日に問い合わせが止まる。
 *
 * 設計の要点:
 *
 * 1. **グループは経路であって進行状態ではない。** 状態機械に手を入れない。
 *    キューに入っただけで `assigned` にすると「担当者が決まった」ことになるが、
 *    実際には誰も見ていない。SLAの応答時間は人が応答するまでの時間である。
 *
 * 2. **消さずに閉じる。** グループを削除すると、過去のチケットが
 *    「どこへ振られたか」を失う。運用から外すのは無効化で行う。
 *
 * 3. **グループ割当で通知しない。** 購読設定が無い状態で全員へ送ると、
 *    すぐに誰も読まなくなる。Watcher機能は 03.3 の Non-Goals である。
 */

export interface AssignmentGroup {
  id: string;
  code: string;
  name: string;
  description: string | null;
  active: boolean;
  memberCount: number;
}

export interface GroupMember {
  userId: string;
  displayName: string;
  addedAt: Date;
}

/** グループを作る・変えるのは組織の管理者。担当者は振るだけ。 */
const MANAGE_ROLES = ['org_admin', 'platform_admin'] as const;
/** キューを見る・振るのは担当側。 */
const USE_ROLES = ['agent', 'org_admin', 'platform_admin'] as const;

export class GroupService {
  constructor(
    private readonly client: pg.PoolClient | pg.Client,
    private readonly denialRecorder: DenialRecorder = new NoopDenialRecorder(),
  ) {}

  /**
   * グループの一覧。
   *
   * 既定では有効なものだけを返す。無効化したグループを既定で混ぜると、
   * 振り先の選択肢に使われないものが並ぶ。
   */
  async list(ctx: AuthzContext, includeInactive = false): Promise<AssignmentGroup[]> {
    requireRole(ctx, ...USE_ROLES);

    const { rows } = await this.client.query(
      `SELECT g.id, g.code, g.name, g.description, g.active,
              (SELECT count(*)::int FROM assignment_group_member m WHERE m.group_id = g.id)
                AS member_count
         FROM assignment_group g
        WHERE ($1::boolean OR g.active)
        ORDER BY g.active DESC, g.name`,
      [includeInactive],
    );
    return rows.map(toGroup);
  }

  /** 本人が所属するグループ。「自分のキュー」を引くために使う。 */
  async myGroups(ctx: AuthzContext): Promise<AssignmentGroup[]> {
    const { rows } = await this.client.query(
      `SELECT g.id, g.code, g.name, g.description, g.active,
              (SELECT count(*)::int FROM assignment_group_member m2 WHERE m2.group_id = g.id)
                AS member_count
         FROM assignment_group g
         JOIN assignment_group_member m ON m.group_id = g.id
        WHERE m.user_id = $1 AND g.active
        ORDER BY g.name`,
      [ctx.principal.userId],
    );
    return rows.map(toGroup);
  }

  async create(
    ctx: AuthzContext,
    input: { code: string; name: string; description?: string },
  ): Promise<AssignmentGroup> {
    requireRole(ctx, ...MANAGE_ROLES);

    const code = input.code.trim().toLowerCase();
    const name = input.name.trim();
    const errors: Array<{ field: string; message: string }> = [];

    // 形式はDB制約と同じ規則を持つ。**ここで通してDBで落とすと、
    // 利用者には「エラーが起きました」しか見えない。**
    if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(code)) {
      errors.push({
        field: 'code',
        message: '記号は英小文字・数字・ハイフン・下線で2〜32文字にしてください',
      });
    }
    if (name.length === 0 || name.length > 120) {
      errors.push({ field: 'name', message: '名前を120文字以内で入力してください' });
    }
    if (errors.length > 0) throw Problems.validation(errors);

    const id = uuidv7();
    try {
      await this.client.query(
        `INSERT INTO assignment_group (id, organization_id, code, name, description)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, ctx.organizationId, code, name, input.description?.trim() || null],
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw Problems.conflict('その記号のグループは既にあります');
      }
      throw error;
    }

    await recordAuditEvent(this.client, {
      eventType: 'config.changed',
      organizationId: ctx.organizationId,
      actorType: 'user',
      actorId: ctx.principal.userId,
      targetType: 'assignment_group',
      targetId: id,
      action: 'create',
      outcome: 'success',
      afterState: { code, name },
    });

    return {
      id,
      code,
      name,
      description: input.description?.trim() || null,
      active: true,
      memberCount: 0,
    };
  }

  /**
   * 有効・無効の切り替え。
   *
   * **削除は無い。** 無効化してもチケットの振り先としては残り、
   * 過去の経路を辿れる。新しく振ることだけができなくなる。
   */
  async setActive(ctx: AuthzContext, groupId: string, active: boolean): Promise<void> {
    requireRole(ctx, ...MANAGE_ROLES);

    const { rowCount } = await this.client.query(
      'UPDATE assignment_group SET active = $2 WHERE id = $1',
      [groupId, active],
    );
    // RLS により他組織の行は見えない。見つからない = 存在しないか権限外。
    if (rowCount === 0) throw Problems.notFound('グループ');

    await recordAuditEvent(this.client, {
      eventType: 'config.changed',
      organizationId: ctx.organizationId,
      actorType: 'user',
      actorId: ctx.principal.userId,
      targetType: 'assignment_group',
      targetId: groupId,
      action: active ? 'activate' : 'deactivate',
      outcome: 'success',
      afterState: { active },
    });
  }

  async listMembers(ctx: AuthzContext, groupId: string): Promise<GroupMember[]> {
    requireRole(ctx, ...USE_ROLES);

    const { rows: groups } = await this.client.query(
      'SELECT 1 FROM assignment_group WHERE id = $1',
      [groupId],
    );
    if (groups.length === 0) throw Problems.notFound('グループ');

    const { rows } = await this.client.query(
      `SELECT m.user_id, u.display_name, m.added_at
         FROM assignment_group_member m
         JOIN app_user u ON u.id = m.user_id
        WHERE m.group_id = $1
        ORDER BY u.display_name`,
      [groupId],
    );
    return rows.map((r) => ({
      userId: r.user_id as string,
      displayName: r.display_name as string,
      addedAt: r.added_at as Date,
    }));
  }

  /**
   * メンバーの追加。
   *
   * **同一組織に在籍していることを必ず確認する。** 他組織の利用者を
   * メンバーにできると、そのグループのキューを通してチケットが読める。
   */
  async addMember(ctx: AuthzContext, groupId: string, userId: string): Promise<void> {
    requireRole(ctx, ...MANAGE_ROLES);

    const { rows: groups } = await this.client.query(
      'SELECT 1 FROM assignment_group WHERE id = $1 AND active',
      [groupId],
    );
    if (groups.length === 0) throw Problems.notFound('グループ');

    const { rows: members } = await this.client.query(
      `SELECT 1 FROM role_binding
        WHERE user_id = $1 AND organization_id = $2
          AND valid_from <= now()
          AND (valid_until IS NULL OR valid_until > now())
        LIMIT 1`,
      [userId, ctx.organizationId],
    );
    if (members.length === 0) {
      await this.denialRecorder.record(ctx.organizationId, {
        eventType: 'authz.access.denied',
        organizationId: ctx.organizationId,
        actorType: 'user',
        actorId: ctx.principal.userId,
        targetType: 'assignment_group',
        targetId: groupId,
        action: 'add_member',
        outcome: 'denied',
        policyDecision: { rule: 'member_membership', detail: '対象がこの組織に所属していません' },
      });
      throw Problems.validation([
        { field: 'userId', message: '指定された利用者はこの組織に所属していません' },
      ]);
    }

    await this.client.query(
      `INSERT INTO assignment_group_member (group_id, user_id, organization_id, added_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (group_id, user_id) DO NOTHING`,
      [groupId, userId, ctx.organizationId, ctx.principal.userId],
    );

    await recordAuditEvent(this.client, {
      eventType: 'org.member.added',
      organizationId: ctx.organizationId,
      actorType: 'user',
      actorId: ctx.principal.userId,
      subjectUserId: userId,
      targetType: 'assignment_group',
      targetId: groupId,
      action: 'add_member',
      outcome: 'success',
    });
  }

  async removeMember(ctx: AuthzContext, groupId: string, userId: string): Promise<void> {
    requireRole(ctx, ...MANAGE_ROLES);

    const { rowCount } = await this.client.query(
      'DELETE FROM assignment_group_member WHERE group_id = $1 AND user_id = $2',
      [groupId, userId],
    );
    if (rowCount === 0) throw Problems.notFound('メンバー');

    await recordAuditEvent(this.client, {
      eventType: 'org.member.removed',
      organizationId: ctx.organizationId,
      actorType: 'user',
      actorId: ctx.principal.userId,
      subjectUserId: userId,
      targetType: 'assignment_group',
      targetId: groupId,
      action: 'remove_member',
      outcome: 'success',
    });
  }
}

function toGroup(row: Record<string, unknown>): AssignmentGroup {
  return {
    id: row.id as string,
    code: row.code as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    active: row.active as boolean,
    memberCount: Number(row.member_count ?? 0),
  };
}
