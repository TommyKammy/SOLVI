import type pg from 'pg';
import { TicketAssignmentReadService } from '../ticket/ticket-assignment-read.service.js';
import { Problems, daysUntil, isExpiringSoon } from '@solvi/shared';
import { recordAuditEvent, uuidv7 } from '../../common/audit/audit.js';
import { hasRole, requireRole, type AuthzContext } from '../../common/authz/authz.js';
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
  /**
   * 期限つきの役割 (FR-IDM-006)。兼務・出向はここに出る。
   *
   * **切れてから気付く状態を作らない。** 期限は静かに来る。
   * 一覧に出しておけば、管理者は切れる前に延長を判断できる。
   */
  temporaryRoles: Array<{
    roleCode: string;
    validUntil: string;
    /** 期限までの残り日数。**判定を画面へ持ち出さない。** */
    daysRemaining: number;
    /** まもなく切れるか。予告の通知と**同じ閾値**で決まる (WP-P1-IDM-017)。 */
    expiringSoon: boolean;
  }>;
  /** 対応中(終端でない)のチケット件数。停止前に振り直しを促すために出す。 */
  openTicketCount: number;
  /** 主部署 (WP-P4-IDM-013)。未設定は null。 */
  primaryDepartmentId: string | null;
  primaryDepartmentName: string | null;
  /** 上長 (WP-P4-IDM-013)。未設定は null。 */
  managerUserId: string | null;
  managerDisplayName: string | null;
  jobTitle: string | null;
}

/**
 * 利用者一覧の絞り込み (WP-P4-IDM-013 §6)。
 * **画面から来た値をそのままSQLへ入れない。** ここで既知の項目だけを運ぶ。
 */
export interface MemberFilters {
  departmentId?: string | null;
  managerUserId?: string | null;
  jobTitle?: string | null;
}

/**
 * プロフィール充足率 (WP-P4-IDM-013 §6)。
 *
 * 上長・部署が未設定のままでは、関係ベースの承認経路が解決できない。
 * 人数だけでなく、部署長の居ない部署も数える。
 */
export interface ProfileCompleteness {
  totalMembers: number;
  missingManager: number;
  missingDepartment: number;
  totalDepartments: number;
  missingDepartmentHead: number;
}

/**
 * 組織プロフィールの閲覧結果 (FR-IDM-014)。
 *
 * `visibility: 'limited'` は `agent` 向けで、**表示名と主部署名だけ**を含む。
 * 役職・勤務地・社員番号・上長は含めない。
 */
export interface MemberProfileView {
  userId: string;
  displayName: string;
  visibility: 'full' | 'limited';
  primaryDepartmentId?: string | null;
  primaryDepartmentName?: string | null;
  managerUserId?: string | null;
  managerDisplayName?: string | null;
  jobTitle?: string | null;
  location?: string | null;
  employeeId?: string | null;
}

export interface ProfileUpdateInput {
  primaryDepartmentId?: string | null;
  managerUserId?: string | null;
  jobTitle?: string | null;
  location?: string | null;
  employeeId?: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROFILE_TEXT_MAX = 200;
const EMPLOYEE_ID_MAX = 64;

/** ロックして読んだ現在値。表示用の名前は含まない(監査の before に使う)。 */
interface ProfileSnapshot {
  primaryDepartmentId: string | null;
  managerUserId: string | null;
  jobTitle: string | null;
  location: string | null;
  employeeId: string | null;
}

interface ProfileRow extends ProfileSnapshot {
  primaryDepartmentName: string | null;
  managerDisplayName: string | null;
}

function requireUuid(value: string, field: string): string {
  if (!UUID_RE.test(value)) {
    throw Problems.validation([{ field, message: 'IDの形式が正しくありません' }]);
  }
  return value.toLowerCase();
}

/** 空文字は未設定として扱う。長さはDBのCHECKと同じ上限で先に弾く。 */
function normalizeProfileText(value: string | null, field: string, max: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) {
    throw Problems.validation([{ field, message: `${max}文字以内で入力してください` }]);
  }
  return trimmed;
}

function profileErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function profileErrorMessage(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : '';
}

/** DBトリガの拒否を利用者向けの応答へ変換する。内部の例外文は返さない。 */
function translateProfileError(error: unknown): never {
  const code = profileErrorCode(error);
  const message = profileErrorMessage(error);
  if (code === '23514') {
    if (message.includes('manager_cycle')) {
      throw Problems.conflict('上長の関係が循環します。別の上長候補を選んでください。');
    }
    if (message.includes('department_inactive')) {
      throw Problems.conflict('無効化された部署は主部署に指定できません');
    }
    if (message.includes('org_member_profile_no_self_manager')) {
      throw Problems.validation([
        { field: 'managerUserId', message: '自分自身を上長に指定できません' },
      ]);
    }
    throw Problems.validation([
      { field: 'profile', message: 'プロフィールの内容を確認してください' },
    ]);
  }
  if (code === '23503') {
    throw Problems.notFound('指定された部署または上長');
  }
  throw error;
}

const MANAGE_ROLES = ['org_admin', 'platform_admin'] as const;

/**
 * この画面から配れる役割 (WP-P1-IDM-015)。
 *
 * **platform スコープは含めない。** 02.18 §2 は platform ロールの付与を
 * 「手動+**二重承認**+監査のみ」と定めており、二重承認の仕組みが無い。
 *
 * 承認を伴わない経路をここに作ると、**組織の管理者一人が
 * プラットフォーム全体を奪える。** 仕組みが出来るまで配らない。
 */
const GRANTABLE_ROLES = [
  'org_admin',
  'agent',
  'approver',
  'auditor',
  'requester',
  'catalog_editor',
] as const;
export type GrantableRole = (typeof GRANTABLE_ROLES)[number];

export class UserAdminService {
  constructor(private readonly client: pg.PoolClient | pg.Client) {}

  /**
   * 組織の在籍者。
   *
   * org_admin/platform_admin限定。WP-P2-UX-036では同じ管理者権限の
   * グループ管理画面にも選択候補として利用する。通常の業務画面へは公開しない。
   */
  async listMembers(ctx: AuthzContext, filters: MemberFilters = {}): Promise<OrganizationMember[]> {
    requireRole(ctx, ...MANAGE_ROLES);

    // RLS により、この組織に所属を持つ利用者しか見えない。
    // それでも `role_binding` 側でも組織を絞る(RLSを認可の代わりにしない)。
    // プロフィールは LEFT JOIN。行が無いことは「未設定」であり、一覧から消す理由ではない。
    const { rows } = await this.client.query(
      `SELECT u.id, u.display_name, u.primary_email, u.status, u.deactivated_at,
              array_remove(array_agg(DISTINCT r.code), NULL) AS role_codes,
              -- 期限つきの役割。**まだ効力のあるものだけ**を出す。
              -- 切れたものを混ぜると「いま何ができる人か」が読めなくなる。
              COALESCE(
                jsonb_agg(
                  DISTINCT jsonb_build_object('roleCode', r.code, 'validUntil', rb.valid_until)
                ) FILTER (WHERE rb.valid_until IS NOT NULL),
                '[]'::jsonb
              ) AS temporary_roles,
              p.primary_department_id,
              d.name AS primary_department_name,
              p.manager_user_id,
              mu.display_name AS manager_display_name,
              p.job_title
         FROM app_user u
         JOIN role_binding rb ON rb.user_id = u.id AND rb.organization_id = $1
         LEFT JOIN role r ON r.id = rb.role_id
         LEFT JOIN org_member_profile p
           ON p.organization_id = $1 AND p.user_id = u.id
         LEFT JOIN department d
           ON d.id = p.primary_department_id AND d.organization_id = $1
         LEFT JOIN app_user mu ON mu.id = p.manager_user_id
        WHERE rb.valid_from <= now()
          AND (rb.valid_until IS NULL OR rb.valid_until > now())
          AND ($2::uuid IS NULL OR p.primary_department_id = $2)
          AND ($3::uuid IS NULL OR p.manager_user_id = $3)
          AND ($4::text IS NULL
               OR strpos(lower(coalesce(p.job_title, '')), lower($4)) > 0)
        GROUP BY u.id, u.display_name, u.primary_email, u.status, u.deactivated_at,
                 p.primary_department_id, d.name, p.manager_user_id,
                 mu.display_name, p.job_title
        ORDER BY u.status, u.display_name`,
      [
        ctx.organizationId,
        filters.departmentId ?? null,
        filters.managerUserId ?? null,
        filters.jobTitle ?? null,
      ],
    );

    const counts = await new TicketAssignmentReadService(this.client).countOpenByAssignees(
      ctx,
      rows.map((row) => row.id as string),
    );

    return rows.map((r) => ({
      userId: r.id as string,
      displayName: r.display_name as string,
      email: r.primary_email as string,
      status: r.status as 'active' | 'deactivated',
      deactivatedAt: (r.deactivated_at as Date | null) ?? null,
      roleCodes: (r.role_codes as string[]) ?? [],
      temporaryRoles: ((r.temporary_roles as Array<{ roleCode: string; validUntil: string }>) ?? [])
        .map((t) => ({
          roleCode: t.roleCode,
          validUntil: new Date(t.validUntil).toISOString(),
          daysRemaining: daysUntil(t.validUntil),
          expiringSoon: isExpiringSoon(t.validUntil),
        }))
        .sort((a, b) => a.validUntil.localeCompare(b.validUntil)),
      openTicketCount: counts.get(r.id as string) ?? 0,
      primaryDepartmentId: (r.primary_department_id as string | null) ?? null,
      primaryDepartmentName: (r.primary_department_name as string | null) ?? null,
      managerUserId: (r.manager_user_id as string | null) ?? null,
      managerDisplayName: (r.manager_display_name as string | null) ?? null,
      jobTitle: (r.job_title as string | null) ?? null,
    }));
  }

  /**
   * プロフィール充足率 (WP-P4-IDM-013 §6)。
   *
   * **数えるのは有効な所属を持つ在籍者**である。停止者を含めると、
   * 「設定すべき人」が実態より多く見える。
   */
  async profileCompleteness(ctx: AuthzContext): Promise<ProfileCompleteness> {
    requireRole(ctx, ...MANAGE_ROLES);
    const { rows } = await this.client.query(
      `WITH members AS (
         SELECT DISTINCT rb.user_id
           FROM role_binding rb
           JOIN app_user u ON u.id = rb.user_id
          WHERE rb.organization_id = $1
            AND u.status = 'active'
            AND rb.valid_from <= now()
            AND (rb.valid_until IS NULL OR rb.valid_until > now())
       )
       SELECT count(*)::int AS total_members,
              count(*) FILTER (WHERE p.manager_user_id IS NULL)::int AS missing_manager,
              count(*) FILTER (WHERE p.primary_department_id IS NULL)::int AS missing_department
         FROM members m
         LEFT JOIN org_member_profile p
           ON p.organization_id = $1 AND p.user_id = m.user_id`,
      [ctx.organizationId],
    );
    const { rows: departments } = await this.client.query(
      `SELECT count(*)::int AS total_departments,
              count(*) FILTER (
                WHERE NOT EXISTS (
                  SELECT 1 FROM department_head h
                   WHERE h.department_id = d.id AND h.organization_id = d.organization_id
                     AND h.valid_from <= clock_timestamp()
                     AND (h.valid_until IS NULL OR h.valid_until > clock_timestamp())
                )
              )::int AS missing_department_head
         FROM department d
        WHERE d.organization_id = $1 AND d.active`,
      [ctx.organizationId],
    );
    return {
      totalMembers: Number(rows[0]?.total_members ?? 0),
      missingManager: Number(rows[0]?.missing_manager ?? 0),
      missingDepartment: Number(rows[0]?.missing_department ?? 0),
      totalDepartments: Number(departments[0]?.total_departments ?? 0),
      missingDepartmentHead: Number(departments[0]?.missing_department_head ?? 0),
    };
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
    const counts = await new TicketAssignmentReadService(this.client).countOpenByAssignees(ctx, [
      userId,
    ]);
    const openTicketCount = counts.get(userId) ?? 0;

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

  /**
   * 組織プロフィール(主部署・上長・役職)の空の行を作る (WP-P4-IDM-012)。
   *
   * 役割の付与と**同じトランザクション**で行う。失敗すれば付与も巻き戻る。
   * 既に行があれば何もしない(兼務・再付与)。
   *
   * 行の有無は権限の付与・拒否に影響しない。所属の有効性は `role_binding` で判定し、
   * 行が無いことは上長・部署が未設定であることを意味するだけである (ADR-0023 §1)。
   */
  private async ensureOrgMemberProfile(organizationId: string, userId: string): Promise<void> {
    await this.client.query(
      `INSERT INTO org_member_profile (organization_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (organization_id, user_id) DO NOTHING`,
      [organizationId, userId],
    );
  }

  /**
   * 組織プロフィールの閲覧 (FR-IDM-014 / ADR-0023 §12)。
   *
   * 閲覧範囲:
   *   - 全項目: `org_admin`・本人・その人の上長
   *   - `agent`: 表示名と主部署名だけ
   *   - それ以外: 404(存在を教えない)
   *
   * 上長の判定はロールではなく関係(`manager_user_id`)で行う。
   * 上長は `approver` ロールを持たないことがある(ADR-0023 §2)。
   */
  async getProfile(ctx: AuthzContext, targetUserId: string): Promise<MemberProfileView> {
    const targetId = requireUuid(targetUserId, 'userId');
    const target = await this.loadMember(ctx, targetId);
    const isSelf = targetId === ctx.principal.userId;
    const isAdmin = hasRole(ctx, 'org_admin');
    const isManager = !isSelf && (await this.isManagerOf(ctx, targetId, ctx.principal.userId));
    const profile = await this.loadProfileRow(ctx, targetId);

    if (isAdmin || isSelf || isManager) {
      return {
        userId: target.id,
        displayName: target.displayName,
        visibility: 'full',
        primaryDepartmentId: profile?.primaryDepartmentId ?? null,
        primaryDepartmentName: profile?.primaryDepartmentName ?? null,
        managerUserId: profile?.managerUserId ?? null,
        managerDisplayName: profile?.managerDisplayName ?? null,
        jobTitle: profile?.jobTitle ?? null,
        location: profile?.location ?? null,
        employeeId: profile?.employeeId ?? null,
      };
    }

    if (hasRole(ctx, 'agent')) {
      // **役職・勤務地・社員番号・上長を返さない。** 主部署名と表示名まで。
      return {
        userId: target.id,
        displayName: target.displayName,
        visibility: 'limited',
        primaryDepartmentName: profile?.primaryDepartmentName ?? null,
      };
    }

    throw Problems.notFound('利用者');
  }

  /**
   * 組織プロフィールの更新 (FR-IDM-011 / FR-IDM-013)。
   *
   * **本人は自分の上長・主部署を変更できない**(`org_admin` 本人を含む)。
   * 主部署は別の組織管理者が設定する(ADR-0023 §3)。
   *
   * 監査は同一トランザクションで書く。書込みに失敗すれば変更も巻き戻る。
   * 社員番号は**値を監査に載せず、変更有無だけ**を記録する(03.16 §3.6)。
   */
  async updateProfile(
    ctx: AuthzContext,
    targetUserId: string,
    input: ProfileUpdateInput,
  ): Promise<MemberProfileView> {
    requireRole(ctx, 'org_admin');
    const targetId = requireUuid(targetUserId, 'userId');
    const target = await this.loadMember(ctx, targetId);
    await this.ensureOrgMemberProfile(ctx.organizationId, targetId);
    // **検査の前に、対象利用者のプロフィール行をロックする**(ADR-0023 §3)。
    // ロックしないと、「上長の設定」と「`org_admin` の付与」が同時に走ったとき、
    // 互いの未コミットの変更を見られず**両方が通り**、上長を持つ組織管理者ができる。
    // READ COMMITTED では、このロック取得後の文が先行トランザクションのコミットを見る。
    // ここから下の検査・現在値・監査の before は、必ずロック後に読み直した値を使う。
    const current = await this.lockProfileRow(ctx, targetId);
    if (!current) throw Problems.internal();

    const isSelf = targetId === ctx.principal.userId;

    let primaryDepartmentId = current.primaryDepartmentId;
    if (input.primaryDepartmentId !== undefined) {
      primaryDepartmentId =
        input.primaryDepartmentId === null
          ? null
          : requireUuid(input.primaryDepartmentId, 'primaryDepartmentId');
      if (isSelf && primaryDepartmentId !== current.primaryDepartmentId) {
        throw Problems.forbidden(
          '自分の主部署は自分では変更できません。別の組織管理者に設定を依頼してください。',
        );
      }
      if (primaryDepartmentId !== null) {
        await this.requireActiveDepartment(ctx, primaryDepartmentId);
      }
    }

    let managerUserId = current.managerUserId;
    if (input.managerUserId !== undefined) {
      managerUserId =
        input.managerUserId === null ? null : requireUuid(input.managerUserId, 'managerUserId');
      if (isSelf && managerUserId !== current.managerUserId) {
        throw Problems.forbidden(
          '自分の上長は自分では変更できません。別の組織管理者に設定を依頼してください。',
        );
      }
      if (managerUserId !== null) {
        if (managerUserId === targetId) {
          throw Problems.validation([
            { field: 'managerUserId', message: '自分自身を上長に指定できません' },
          ]);
        }
        // **組織管理者の上長は常に未設定**(ADR-0023 §3)。
        if (await this.hasEffectiveOrgAdminRole(ctx, targetId)) {
          throw Problems.conflict(
            '組織管理者の上長は設定できません。上長を設定するには、先に組織管理者の役割を取り消してください。',
          );
        }
        await this.requireActiveMember(ctx, managerUserId, '上長候補');
        if (!(await this.loadProfileRow(ctx, managerUserId))) {
          throw Problems.conflict(
            '上長候補の組織プロフィールが未設定です。先にプロフィールを設定してください。',
          );
        }
      }
    }

    const jobTitle =
      input.jobTitle !== undefined
        ? normalizeProfileText(input.jobTitle, 'jobTitle', PROFILE_TEXT_MAX)
        : current.jobTitle;
    const location =
      input.location !== undefined
        ? normalizeProfileText(input.location, 'location', PROFILE_TEXT_MAX)
        : current.location;
    const employeeId =
      input.employeeId !== undefined
        ? normalizeProfileText(input.employeeId, 'employeeId', EMPLOYEE_ID_MAX)
        : current.employeeId;

    const employeeIdChanged = employeeId !== current.employeeId;
    const changed =
      employeeIdChanged ||
      jobTitle !== current.jobTitle ||
      location !== current.location ||
      primaryDepartmentId !== current.primaryDepartmentId ||
      managerUserId !== current.managerUserId;
    if (!changed) return this.getProfile(ctx, targetId);

    try {
      await this.client.query(
        `UPDATE org_member_profile
            SET primary_department_id = $3,
                manager_user_id = $4,
                job_title = $5,
                location = $6,
                employee_id = $7
          WHERE organization_id = $1 AND user_id = $2`,
        [
          ctx.organizationId,
          targetId,
          primaryDepartmentId,
          managerUserId,
          jobTitle,
          location,
          employeeId,
        ],
      );
    } catch (error) {
      translateProfileError(error);
    }

    await recordAuditEvent(this.client, {
      eventType: 'org.member.profile.updated',
      organizationId: ctx.organizationId,
      actorType: 'user',
      actorId: ctx.principal.userId,
      subjectUserId: targetId,
      targetType: 'org_member_profile',
      targetId: targetId,
      action: 'update',
      outcome: 'success',
      beforeState: {
        primaryDepartmentId: current.primaryDepartmentId,
        managerUserId: current.managerUserId,
        jobTitle: current.jobTitle,
        location: current.location,
      },
      afterState: {
        primaryDepartmentId,
        managerUserId,
        jobTitle,
        location,
        // **社員番号の値は載せない。** 変更有無だけを残す(02.17 §4 / 03.16 §3.6)。
        employeeIdChanged,
      },
    });

    return this.getProfile(ctx, target.id);
  }

  /** その組織の在籍者を1件読む。見つからなければ 404(他組織の存在も隠す)。 */
  private async loadMember(
    ctx: AuthzContext,
    userId: string,
  ): Promise<{ id: string; displayName: string; status: 'active' | 'deactivated' }> {
    const { rows } = await this.client.query(
      `SELECT u.id, u.display_name, u.status
         FROM app_user u
         JOIN role_binding rb ON rb.user_id = u.id AND rb.organization_id = $2
        WHERE u.id = $1
        LIMIT 1`,
      [userId, ctx.organizationId],
    );
    if (rows.length === 0) throw Problems.notFound('利用者');
    return {
      id: rows[0]!.id as string,
      displayName: rows[0]!.display_name as string,
      status: rows[0]!.status as 'active' | 'deactivated',
    };
  }

  private async isManagerOf(
    ctx: AuthzContext,
    targetUserId: string,
    managerUserId: string,
  ): Promise<boolean> {
    const { rows } = await this.client.query(
      `SELECT 1 FROM org_member_profile
        WHERE organization_id = $1 AND user_id = $2 AND manager_user_id = $3`,
      [ctx.organizationId, targetUserId, managerUserId],
    );
    return rows.length > 0;
  }

  private async loadProfileRow(ctx: AuthzContext, userId: string): Promise<ProfileRow | null> {
    const { rows } = await this.client.query(
      `SELECT p.primary_department_id, d.name AS primary_department_name,
              p.manager_user_id, mu.display_name AS manager_display_name,
              p.job_title, p.location, p.employee_id
         FROM org_member_profile p
         LEFT JOIN department d
           ON d.id = p.primary_department_id AND d.organization_id = p.organization_id
         LEFT JOIN app_user mu ON mu.id = p.manager_user_id
        WHERE p.organization_id = $1 AND p.user_id = $2`,
      [ctx.organizationId, userId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      primaryDepartmentId: (row.primary_department_id as string | null) ?? null,
      primaryDepartmentName: (row.primary_department_name as string | null) ?? null,
      managerUserId: (row.manager_user_id as string | null) ?? null,
      managerDisplayName: (row.manager_display_name as string | null) ?? null,
      jobTitle: (row.job_title as string | null) ?? null,
      location: (row.location as string | null) ?? null,
      employeeId: (row.employee_id as string | null) ?? null,
    };
  }

  /**
   * プロフィール行を `FOR UPDATE` でロックして読む (WP-P4-IDM-013 §6)。
   *
   * 「上長の設定」と「`org_admin` の付与」は**同じ行のロック**で直列化する。
   * ロック待ちの後、READ COMMITTED では次の文が先行トランザクションの
   * コミットを見るため、**ロック取得前に読んだ値を検査に使わない**。
   *
   * デッドロックを避けるため、両経路とも最初に取るロックをこの行にする
   * (DBトリガが取る advisory lock はこの後になる)。
   */
  private async lockProfileRow(ctx: AuthzContext, userId: string): Promise<ProfileSnapshot | null> {
    const { rows } = await this.client.query(
      `SELECT primary_department_id, manager_user_id, job_title, location, employee_id
         FROM org_member_profile
        WHERE organization_id = $1 AND user_id = $2
        FOR UPDATE`,
      [ctx.organizationId, userId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      primaryDepartmentId: (row.primary_department_id as string | null) ?? null,
      managerUserId: (row.manager_user_id as string | null) ?? null,
      jobTitle: (row.job_title as string | null) ?? null,
      location: (row.location as string | null) ?? null,
      employeeId: (row.employee_id as string | null) ?? null,
    };
  }

  /** 主部署に指定できるのは、同一組織の有効な部署だけ。 */
  private async requireActiveDepartment(ctx: AuthzContext, departmentId: string): Promise<void> {
    const { rows } = await this.client.query(
      'SELECT active FROM department WHERE id = $1 AND organization_id = $2',
      [departmentId, ctx.organizationId],
    );
    if (rows.length === 0) throw Problems.notFound('部署');
    if (!(rows[0]!.active as boolean)) {
      throw Problems.conflict('無効化された部署は主部署に指定できません');
    }
  }

  /**
   * 上長候補が有効な所属(ADR-0023 §1)であることを確かめる。
   * ロールの種類は問わない。`org_admin` を候補にすることも妨げない。
   */
  private async requireActiveMember(
    ctx: AuthzContext,
    userId: string,
    label: string,
  ): Promise<void> {
    const { rows } = await this.client.query(
      `SELECT 1
         FROM app_user u
         JOIN role_binding rb ON rb.user_id = u.id AND rb.organization_id = $2
        WHERE u.id = $1
          AND u.status = 'active'
          AND rb.valid_from <= clock_timestamp()
          AND (rb.valid_until IS NULL OR rb.valid_until > clock_timestamp())
        LIMIT 1`,
      [userId, ctx.organizationId],
    );
    if (rows.length === 0) throw Problems.notFound(label);
  }

  /** 当該組織で有効期間内の `org_admin` ロールを持つか。 */
  private async hasEffectiveOrgAdminRole(ctx: AuthzContext, userId: string): Promise<boolean> {
    const { rows } = await this.client.query(
      `SELECT 1
         FROM role_binding rb
         JOIN role r ON r.id = rb.role_id
        WHERE rb.user_id = $1 AND rb.organization_id = $2 AND r.code = 'org_admin'
          AND rb.valid_from <= clock_timestamp()
          AND (rb.valid_until IS NULL OR rb.valid_until > clock_timestamp())
        LIMIT 1`,
      [userId, ctx.organizationId],
    );
    return rows.length > 0;
  }

  /**
   * 役割を与える (WP-P1-IDM-015)。
   *
   * **既に組織に居る人にだけ配れる。** 別の組織の人を招き入れる操作
   * (兼務の開始)は、他組織の利用者を名前やメールで探せることを意味し、
   * **在籍者の総当たりができる経路**になる。危険の質が違うので分けた。
   *
   * @param validUntil 期限。兼務・出向はここを入れる (FR-IDM-006)
   */
  async grantRole(
    ctx: AuthzContext,
    userId: string,
    roleCode: string,
    params: { validUntil: Date | null; reason: string },
  ): Promise<void> {
    requireRole(ctx, ...MANAGE_ROLES);

    const reason = params.reason.trim();
    if (reason.length === 0) {
      // 権限を配ることは、その人にできることを増やす操作である。
      // **理由の無い付与を残さない。**
      throw Problems.validation([{ field: 'reason', message: '付与の理由を入力してください' }]);
    }
    if (reason.length > 500) {
      throw Problems.validation([
        { field: 'reason', message: '理由は500文字以内で入力してください' },
      ]);
    }

    if (!(GRANTABLE_ROLES as readonly string[]).includes(roleCode)) {
      // platform ロールは二重承認が要る(02.18 §2)。**何が足りないかを言う。**
      throw Problems.validation([
        {
          field: 'roleCode',
          message:
            'この画面から配れない役割です。プラットフォーム管理者・監査者は二重承認の手続きが必要です。',
        },
      ]);
    }

    if (params.validUntil !== null && params.validUntil.getTime() <= Date.now()) {
      // 過ぎた期限で与えると、与えた瞬間に失効する。
      // **「与えたのに使えない」を作らない。**
      throw Problems.validation([
        { field: 'validUntil', message: '期限は未来の日付にしてください' },
      ]);
    }

    const member = await this.requireMember(ctx, userId);
    if (member.status !== 'active') {
      throw Problems.conflict('停止された利用者には役割を与えられません');
    }

    const { rows: roles } = await this.client.query(
      "SELECT id, scope FROM role WHERE code = $1 AND scope = 'org'",
      [roleCode],
    );
    if (roles.length === 0) throw Problems.notFound('役割');

    // 既に有効な同じ役割があれば何もしない。**二重に与えても意味が無い。**
    const { rows: existing } = await this.client.query(
      `SELECT 1 FROM role_binding
        WHERE user_id = $1 AND organization_id = $2 AND role_id = $3
          AND valid_from <= now() AND (valid_until IS NULL OR valid_until > now())
        LIMIT 1`,
      [userId, ctx.organizationId, roles[0]!.id],
    );
    if (existing.length > 0) {
      throw Problems.conflict('その役割は既に与えられています');
    }

    // **組織管理者の上長は常に未設定**(ADR-0023 §3)。
    // 自動では外さない。暗黙の変更を作らないため、付与を拒否して人に判断を戻す。
    if (roleCode === 'org_admin') {
      // 「上長の設定」と同じプロフィール行を**先にロックしてから**検査する。
      // ロックが無いと、2つのトランザクションが互いの未コミットの変更を見られず、
      // 両方が通って上長を持つ組織管理者ができる。
      await this.ensureOrgMemberProfile(ctx.organizationId, userId);
      const current = await this.lockProfileRow(ctx, userId);
      if (!current) throw Problems.internal();
      if (current.managerUserId !== null) {
        throw Problems.conflict(
          '上長が設定されている利用者には組織管理者を付与できません。先に上長を外してください。',
        );
      }
    }

    const bindingId = uuidv7();
    await this.client.query(
      `INSERT INTO role_binding
         (id, user_id, role_id, role_scope, organization_id, source, valid_from, valid_until)
       VALUES ($1, $2, $3, 'org', $4, 'manual', now(), $5)`,
      [bindingId, userId, roles[0]!.id, ctx.organizationId, params.validUntil],
    );
    await this.ensureOrgMemberProfile(ctx.organizationId, userId);

    await recordAuditEvent(this.client, {
      eventType: 'role.binding.created',
      organizationId: ctx.organizationId,
      actorType: 'user',
      actorId: ctx.principal.userId,
      subjectUserId: userId,
      targetType: 'role_binding',
      targetId: bindingId,
      action: 'grant',
      outcome: 'success',
      afterState: {
        roleCode,
        source: 'manual',
        validUntil: params.validUntil?.toISOString() ?? null,
        reason,
      },
    });
  }

  /**
   * 役割を取り消す (WP-P1-IDM-015)。
   *
   * **行を消さない。期限を「今」にする。**
   *
   * 失権の仕組みは既に `valid_until` で動いている([[WP-P1-IDM-014]])。
   * 取り消しをそこへ寄せれば、**1つの仕組みに2つの理由**
   * (人が取り消した / 期限が来た)が乗るだけで済む。
   * 別に消す経路を作ると、片方だけ直したときに食い違う。
   *
   * 期限到来の記録済みの印も同時に付ける。付けないと、
   * 定期処理が**同じ失権をもう一度 `expire` として記録する。**
   */
  async revokeRole(
    ctx: AuthzContext,
    userId: string,
    roleCode: string,
    reason: string,
  ): Promise<void> {
    requireRole(ctx, ...MANAGE_ROLES);

    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      throw Problems.validation([{ field: 'reason', message: '取り消しの理由を入力してください' }]);
    }

    await this.requireMember(ctx, userId);

    const { rows } = await this.client.query(
      `SELECT rb.id
         FROM role_binding rb
         JOIN role r ON r.id = rb.role_id
        WHERE rb.user_id = $1 AND rb.organization_id = $2 AND r.code = $3
          AND rb.valid_from <= now() AND (rb.valid_until IS NULL OR rb.valid_until > now())`,
      [userId, ctx.organizationId, roleCode],
    );
    if (rows.length === 0) throw Problems.notFound('役割');

    if ((GRANTABLE_ROLES as readonly string[]).includes(roleCode) === false) {
      throw Problems.validation([
        { field: 'roleCode', message: 'この画面から取り消せない役割です' },
      ]);
    }

    // 締め出しを作らない ([[WP-P1-IDM-011]] と同じ防御)。
    if (roleCode === 'org_admin') {
      if (userId === ctx.principal.userId) {
        throw Problems.validation([
          { field: 'userId', message: '自分自身の組織管理者は取り消せません' },
        ]);
      }
      if ((await this.activeAdminCount(ctx, userId)) === 0) {
        throw Problems.conflict('この組織で最後の管理者です。先に別の管理者を用意してください。');
      }
    }

    for (const row of rows) {
      await this.client.query(
        `UPDATE role_binding
            SET valid_until = now(),
                expiry_recorded_at = now()
          WHERE id = $1`,
        [row.id],
      );

      await recordAuditEvent(this.client, {
        eventType: 'role.binding.deleted',
        organizationId: ctx.organizationId,
        actorType: 'user',
        actorId: ctx.principal.userId,
        subjectUserId: userId,
        targetType: 'role_binding',
        targetId: row.id as string,
        // **期限到来と区別する。** 「切れた」と「取り消した」は別の出来事である。
        action: 'revoke',
        outcome: 'success',
        beforeState: { roleCode },
        afterState: { effective: false, reason: trimmed },
      });
    }
  }

  /**
   * 利用者を作る (ADR-0019 の検証段階運用 / WP-P1-IDM-016)。
   *
   * **これまで人を作る経路が無かった。** `app_user` を作れるのは
   * `tools/seed.mjs` と手書きのSQLだけであり、
   * 新しく構築した環境では**誰も招き入れられなかった。**
   *
   * [[WP-P1-IDM-015]] で役割は配れるようにしたが、配る相手が居ない。
   * 「機能を作るとき、それを管理する手段を同時に作る」(DL-022)の
   * 連鎖が、もう一段残っていた。
   *
   * ## これは FR-IDM-004(SCIM User)ではない
   *
   * SCIM は外部IdPが利用者を押し込む仕組みであり、本番の経路である。
   * これは**検証段階で人を招き入れるための管理操作**にすぎない。
   * 要求IDを借りない。
   *
   * ## メールは識別子ではない (FR-IDM-002)
   *
   * `primary_email` は連絡先であって本人性の根拠ではない。
   * ここで作る利用者は `identity` を持たない —
   * 資格情報は `create_local_user` が別に設定する([[WP-P1-IDM-012]])。
   * **作ることと入れるようにすることを分ける。**
   */
  async createUser(
    ctx: AuthzContext,
    input: { email: string; displayName: string; roleCode: string; reason: string },
  ): Promise<{ userId: string }> {
    requireRole(ctx, ...MANAGE_ROLES);

    const email = input.email.trim().toLowerCase();
    const displayName = input.displayName.trim();
    const reason = input.reason.trim();

    if (reason.length === 0) {
      throw Problems.validation([{ field: 'reason', message: '作成の理由を入力してください' }]);
    }
    if (displayName.length === 0 || displayName.length > 200) {
      throw Problems.validation([
        { field: 'displayName', message: '表示名を200文字以内で入力してください' },
      ]);
    }
    // 形式だけを見る。**到達性は確かめられない** — 確かめたふりをしない。
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
      throw Problems.validation([
        { field: 'email', message: 'メールアドレスの形式が正しくありません' },
      ]);
    }
    if (!(GRANTABLE_ROLES as readonly string[]).includes(input.roleCode)) {
      throw Problems.validation([
        {
          field: 'roleCode',
          message:
            'この画面から配れない役割です。プラットフォーム管理者・監査者は二重承認の手続きが必要です。',
        },
      ]);
    }

    const { rows: roles } = await this.client.query(
      "SELECT id FROM role WHERE code = $1 AND scope = 'org'",
      [input.roleCode],
    );
    if (roles.length === 0) throw Problems.notFound('役割');

    // **同じ組織に同じ連絡先の人を二重に作らない。**
    //
    // ここで見えるのは自組織の利用者だけである(RLS の
    // `app_user_visible_within_org`)。それで足りる — 二重登録が起きるのは
    // 「同じ人をもう一度追加した」ときであり、それは自組織の中で起きる。
    //
    // **他組織の重複は検出しない。できない。** 検出するには組織をまたいで
    // メールを引く必要があり、それは**在籍者の総当たりができる経路**になる。
    // 検出できないことを、検出したふりで隠さない(§残っている制約)。
    //
    // なお `primary_email` に一意制約は無い。連絡先であって識別子ではない
    // (FR-IDM-002 / 0002 のコメント)。制約に頼れないので、ここで見る。
    const { rows: existing } = await this.client.query(
      'SELECT 1 FROM app_user WHERE lower(primary_email) = $1 LIMIT 1',
      [email],
    );
    if (existing.length > 0) {
      throw Problems.conflict('その連絡先の利用者は既にこの組織に居ます');
    }

    const userId = uuidv7();
    await this.client.query(
      `INSERT INTO app_user (id, primary_email, display_name, status, created_via)
       VALUES ($1, $2, $3, 'active', 'admin')`,
      [userId, email, displayName],
    );

    const bindingId = uuidv7();
    await this.client.query(
      `INSERT INTO role_binding
         (id, user_id, role_id, role_scope, organization_id, source, valid_from)
       VALUES ($1, $2, $3, 'org', $4, 'manual', now())`,
      [bindingId, userId, roles[0]!.id, ctx.organizationId],
    );
    await this.ensureOrgMemberProfile(ctx.organizationId, userId);

    await recordAuditEvent(this.client, {
      eventType: 'user.created',
      organizationId: ctx.organizationId,
      actorType: 'user',
      actorId: ctx.principal.userId,
      subjectUserId: userId,
      targetType: 'app_user',
      targetId: userId,
      action: 'create',
      outcome: 'success',
      afterState: { email, displayName, roleCode: input.roleCode, reason },
    });

    // 最初の役割も付与として残す。**人を作ったことと権限を与えたことは別の事実である。**
    await recordAuditEvent(this.client, {
      eventType: 'role.binding.created',
      organizationId: ctx.organizationId,
      actorType: 'user',
      actorId: ctx.principal.userId,
      subjectUserId: userId,
      targetType: 'role_binding',
      targetId: bindingId,
      action: 'grant',
      outcome: 'success',
      afterState: { roleCode: input.roleCode, source: 'manual', reason: '利用者の作成時' },
    });

    return { userId };
  }
}
