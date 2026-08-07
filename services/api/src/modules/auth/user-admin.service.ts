import type pg from 'pg';
import { Problems } from '@solvi/shared';
import { recordAuditEvent } from '../../common/audit/audit.js';
import { requireRole, type AuthzContext } from '../../common/authz/authz.js';
import { SessionService } from './session.service.js';

/**
 * 在籍者の停止と復帰 (FR-IDM-007 / WP-P1-IDM-011)。
 *
 * `SessionService.deactivateUser` は WP-P1-IDM-009 で作られていたが、
 * **呼ぶ経路が無かった。** 退職・停止でアクセスを止める手段が
 * 画面にもAPIにも存在せず、要求の受入基準
 * 「deactivate後のログイン不可」を満たす方法が無かった。
 *
 * これは実害のある欠落である。退職者のアカウントが有効なまま残る。
 *
 * 設計の要点:
 *
 * 1. **止めることを妨げない。** アカウントの停止は security の操作でもある。
 *    「担当チケットが残っている」ことを理由にAPIが拒むと、
 *    漏えいが疑われる状況で止められなくなる。件数を返し、判断は人に残す。
 *
 * 2. **自分自身は止められない。** 締め出しを防ぐ。
 *
 * 3. **最後の管理者は止められない。** 組織を管理できる人が居なくなると、
 *    以後は誰も権限を戻せない。
 *
 * 4. **消さない。** 履歴・担当の表示はそのまま残る(FR-IDM-007)。
 *    停止は `status` の変更だけであり、チケットからも監査からも消えない。
 */

/** 在籍者。管理画面が一覧に出す。 */
export interface OrganizationMember {
  userId: string;
  displayName: string;
  email: string;
  status: 'active' | 'deactivated';
  deactivatedAt: Date | null;
  roleCodes: string[];
  /** 対応中(終端でない)のチケット件数。停止前に振り直しを促すために出す。 */
  openTicketCount: number;
}

const MANAGE_ROLES = ['org_admin', 'platform_admin'] as const;

export class UserAdminService {
  constructor(private readonly client: pg.PoolClient | pg.Client) {}

  /**
   * 組織の在籍者。
   *
   * **ここは名簿を出してよい場所である。** 担当グループの画面では
   * 在籍者の一覧を出さないと決めた([[WP-P2-GRP-015]])が、それは
   * 業務の画面に名簿を置かないという判断だった。
   * 在籍者の管理そのものを行う画面では、一覧が無いと仕事にならない。
   */
  async listMembers(ctx: AuthzContext): Promise<OrganizationMember[]> {
    requireRole(ctx, ...MANAGE_ROLES);

    // RLS により、この組織に所属を持つ利用者しか見えない。
    // それでも `role_binding` 側でも組織を絞る(RLSを認可の代わりにしない)。
    const { rows } = await this.client.query(
      `SELECT u.id, u.display_name, u.primary_email, u.status, u.deactivated_at,
              array_remove(array_agg(DISTINCT r.code), NULL) AS role_codes,
              (SELECT count(*)::int FROM ticket t
                WHERE t.assignee_id = u.id
                  AND t.organization_id = $1
                  AND t.state NOT IN ('resolved', 'closed', 'cancelled', 'merged')
              ) AS open_tickets
         FROM app_user u
         JOIN role_binding rb ON rb.user_id = u.id AND rb.organization_id = $1
         LEFT JOIN role r ON r.id = rb.role_id
        WHERE rb.valid_from <= now()
          AND (rb.valid_until IS NULL OR rb.valid_until > now())
        GROUP BY u.id, u.display_name, u.primary_email, u.status, u.deactivated_at
        ORDER BY u.status, u.display_name`,
      [ctx.organizationId],
    );

    return rows.map((r) => ({
      userId: r.id as string,
      displayName: r.display_name as string,
      email: r.primary_email as string,
      status: r.status as 'active' | 'deactivated',
      deactivatedAt: (r.deactivated_at as Date | null) ?? null,
      roleCodes: (r.role_codes as string[]) ?? [],
      openTicketCount: Number(r.open_tickets ?? 0),
    }));
  }

  /**
   * 在籍しているかを確かめる。
   *
   * RLS でも他組織の行は見えないが、**認可をRLSに任せない**(ADR-0015)。
   * 見つからない場合は 404 — 「他組織に居る」ことを教えない。
   */
  private async requireMember(ctx: AuthzContext, userId: string): Promise<{ status: string }> {
    const { rows } = await this.client.query(
      `SELECT u.status
         FROM app_user u
         JOIN role_binding rb ON rb.user_id = u.id AND rb.organization_id = $2
        WHERE u.id = $1
        LIMIT 1`,
      [userId, ctx.organizationId],
    );
    if (rows.length === 0) throw Problems.notFound('利用者');
    return { status: rows[0]!.status as string };
  }

  /** その組織で有効な管理者の数。最後の1人を止めさせないために数える。 */
  private async activeAdminCount(ctx: AuthzContext, excludingUserId?: string): Promise<number> {
    const { rows } = await this.client.query(
      `SELECT count(DISTINCT u.id)::int AS n
         FROM app_user u
         JOIN role_binding rb ON rb.user_id = u.id AND rb.organization_id = $1
         JOIN role r ON r.id = rb.role_id
        WHERE u.status = 'active'
          AND r.code IN ('org_admin', 'platform_admin')
          AND rb.valid_from <= now()
          AND (rb.valid_until IS NULL OR rb.valid_until > now())
          AND ($2::uuid IS NULL OR u.id <> $2)`,
      [ctx.organizationId, excludingUserId ?? null],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * 停止 (FR-IDM-007)。
   *
   * セッションは同時に失効する(FR-IDM-008 の15分以内を、即時で満たす)。
   *
   * @returns 失効したセッション数と、**残っている対応中チケットの件数**
   */
  async deactivate(
    ctx: AuthzContext,
    userId: string,
    reason: string,
  ): Promise<{ revokedSessions: number; openTicketCount: number }> {
    requireRole(ctx, ...MANAGE_ROLES);

    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      // 停止は本人の業務を止める操作である。理由の無い停止を残さない。
      throw Problems.validation([{ field: 'reason', message: '停止の理由を入力してください' }]);
    }
    if (trimmed.length > 500) {
      throw Problems.validation([
        { field: 'reason', message: '理由は500文字以内で入力してください' },
      ]);
    }

    if (userId === ctx.principal.userId) {
      // 自分を止めると、その場でセッションが切れて元に戻せなくなる。
      throw Problems.validation([
        { field: 'userId', message: '自分自身を停止することはできません' },
      ]);
    }

    const member = await this.requireMember(ctx, userId);
    if (member.status !== 'active') {
      throw Problems.conflict('この利用者は既に停止されています');
    }

    if ((await this.activeAdminCount(ctx, userId)) === 0) {
      // 管理できる人が居なくなると、以後は誰も権限を戻せない。
      throw Problems.conflict('この組織で最後の管理者です。先に別の管理者を用意してください。');
    }

    // **担当チケットが残っていても止める。** 停止は security の操作でもあり、
    // 「担当が残っている」ことを理由に拒むと、漏えいが疑われる状況で
    // 止められなくなる。件数を返し、振り直しの判断は人に残す。
    const { rows: open } = await this.client.query(
      `SELECT count(*)::int AS n FROM ticket
        WHERE assignee_id = $1 AND organization_id = $2
          AND state NOT IN ('resolved', 'closed', 'cancelled', 'merged')`,
      [userId, ctx.organizationId],
    );
    const openTicketCount = Number(open[0]?.n ?? 0);

    const sessions = new SessionService(this.client);
    const { revokedSessions } = await sessions.deactivateUser({
      userId,
      actorUserId: ctx.principal.userId,
      organizationId: ctx.organizationId,
    });

    // 理由は `deactivateUser` の監査に入らないため、ここで別に残す。
    // **「なぜ止めたか」が無いと、退職と事故対応を後から区別できない。**
    await recordAuditEvent(this.client, {
      eventType: 'user.updated',
      organizationId: ctx.organizationId,
      actorType: 'user',
      actorId: ctx.principal.userId,
      subjectUserId: userId,
      targetType: 'app_user',
      targetId: userId,
      action: 'deactivate.reason',
      outcome: 'success',
      afterState: { reason: trimmed, openTicketCount },
    });

    return { revokedSessions, openTicketCount };
  }

  /**
   * 復帰。
   *
   * 停止が誤りだった場合と、休職から戻る場合の両方がある。
   * **停止と同じ重さで扱う** — 理由を要求し、監査へ残す。
   */
  async reactivate(ctx: AuthzContext, userId: string, reason: string): Promise<void> {
    requireRole(ctx, ...MANAGE_ROLES);

    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      throw Problems.validation([{ field: 'reason', message: '復帰の理由を入力してください' }]);
    }

    const member = await this.requireMember(ctx, userId);
    if (member.status === 'active') {
      throw Problems.conflict('この利用者は停止されていません');
    }

    await this.client.query(
      `UPDATE app_user SET status = 'active', deactivated_at = NULL WHERE id = $1`,
      [userId],
    );

    // **セッションは戻さない。** 停止時に失効させたものを復活させると、
    // 停止中に窃取された可能性のあるトークンまで生き返る。
    // 本人に改めてログインしてもらう。
    await recordAuditEvent(this.client, {
      eventType: 'user.updated',
      organizationId: ctx.organizationId,
      actorType: 'user',
      actorId: ctx.principal.userId,
      subjectUserId: userId,
      targetType: 'app_user',
      targetId: userId,
      action: 'reactivate',
      outcome: 'success',
      beforeState: { status: 'deactivated' },
      afterState: { status: 'active', reason: trimmed },
    });
  }
}
