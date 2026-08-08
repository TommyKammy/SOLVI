import type pg from 'pg';
import { Problems, daysUntil, isExpiringSoon } from '@solvi/shared';
import { recordAuditEvent, uuidv7 } from '../../common/audit/audit.js';
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
const GRANTABLE_ROLES = ['org_admin', 'agent', 'approver', 'auditor', 'requester'] as const;
export type GrantableRole = (typeof GRANTABLE_ROLES)[number];

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
              -- 期限つきの役割。**まだ効力のあるものだけ**を出す。
              -- 切れたものを混ぜると「いま何ができる人か」が読めなくなる。
              COALESCE(
                jsonb_agg(
                  DISTINCT jsonb_build_object('roleCode', r.code, 'validUntil', rb.valid_until)
                ) FILTER (WHERE rb.valid_until IS NOT NULL),
                '[]'::jsonb
              ) AS temporary_roles,
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
      temporaryRoles: ((r.temporary_roles as Array<{ roleCode: string; validUntil: string }>) ?? [])
        .map((t) => ({
          roleCode: t.roleCode,
          validUntil: new Date(t.validUntil).toISOString(),
          daysRemaining: daysUntil(t.validUntil),
          expiringSoon: isExpiringSoon(t.validUntil),
        }))
        .sort((a, b) => a.validUntil.localeCompare(b.validUntil)),
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

    const bindingId = uuidv7();
    await this.client.query(
      `INSERT INTO role_binding
         (id, user_id, role_id, role_scope, organization_id, source, valid_from, valid_until)
       VALUES ($1, $2, $3, 'org', $4, 'manual', now(), $5)`,
      [bindingId, userId, roles[0]!.id, ctx.organizationId, params.validUntil],
    );

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
