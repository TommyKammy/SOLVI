import type pg from 'pg';
import {
  hashPassword,
  verifyPassword,
  consumeTimingBudget,
  validatePasswordStrength,
} from '@solvi/shared';
import { recordAuditEvent, uuidv7 } from '../../common/audit/audit.js';
import type { SessionService } from './session.service.js';

/**
 * ローカルアカウント認証 (WP-P1-IDM-009 / ADR-0019)。
 *
 * **検証段階限定。** 本番構成では `AUTH_LOCAL_ENABLED` の検証で
 * プロセスが起動しないため、この経路は存在しない(脅威 T-25)。
 *
 * 実装の中心は「失敗の理由を漏らさないこと」にある。
 *
 * 攻撃者にとって最初の仕事は、有効なユーザ名を集めることである。
 * 「そのユーザは存在しません」と「パスワードが違います」を区別して返すと、
 * それだけで名簿ができあがる。メッセージだけでなく**応答時間も**揃える必要がある。
 * 存在しないユーザに即座に返せば、時間を測るだけで同じことが分かってしまう。
 */

export const LOCAL_ISSUER = 'urn:solvi:local';

/** 認証の失敗理由。**ログ用であり、利用者へは返さない。** */
export type AuthFailureReason =
  | 'unknown_user'
  | 'no_credential'
  | 'bad_password'
  | 'locked_out'
  | 'user_inactive'
  | 'no_organization_access';

export type AuthResult =
  | { ok: true; userId: string; token: string; sessionId: string }
  | { ok: false; reason: AuthFailureReason };

export interface LocalAuthOptions {
  maxFailedAttempts: number;
  lockoutSeconds: number;
}

export class LocalAuthService {
  constructor(
    private readonly client: pg.PoolClient | pg.Client,
    private readonly sessions: SessionService,
    private readonly options: LocalAuthOptions,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * ログイン。
   *
   * 早期returnで組み立てているが、**どの経路でも scrypt 1回分の時間を消費する**。
   * `consumeTimingBudget()` がその役目を負う。これを省くと、
   * 「ユーザが存在しない」経路だけが桁違いに速くなり、時間差で判別できてしまう。
   */
  async authenticate(params: {
    email: string;
    password: string;
    organizationId: string | null;
  }): Promise<AuthResult> {
    const now = this.now();

    const { rows } = await this.client.query<{
      user_id: string;
      user_status: 'active' | 'deactivated';
      credential_id: string | null;
      password_hash: string | null;
      failed_attempts: number;
      locked_until: Date | null;
    }>(
      `SELECT u.id AS user_id, u.status AS user_status,
              c.id AS credential_id, c.password_hash,
              COALESCE(c.failed_attempts, 0) AS failed_attempts, c.locked_until
         FROM app_user u
         LEFT JOIN local_credential c ON c.user_id = u.id
        WHERE u.primary_email = $1`,
      [params.email],
    );

    const row = rows[0];

    // ユーザが存在しない、または資格情報が無い。
    // ここでも scrypt を1回回す。回さないと応答時間で存在有無が分かる。
    if (!row || !row.password_hash || !row.credential_id) {
      await consumeTimingBudget(params.password);
      await this.recordFailure(null, params.email, row ? 'no_credential' : 'unknown_user');
      return { ok: false, reason: row ? 'no_credential' : 'unknown_user' };
    }

    // ロックアウト中。**正しいパスワードでも通さない。**
    // 「正しければ通す」にすると、ロックアウトが総当たりの抑止にならない。
    if (row.locked_until && row.locked_until > now) {
      await consumeTimingBudget(params.password);
      await this.recordFailure(row.user_id, params.email, 'locked_out');
      return { ok: false, reason: 'locked_out' };
    }

    const matched = await verifyPassword(params.password, row.password_hash);

    if (!matched) {
      await this.registerFailedAttempt(row.credential_id, row.failed_attempts, now);
      await this.recordFailure(row.user_id, params.email, 'bad_password');
      return { ok: false, reason: 'bad_password' };
    }

    // 無効化済みユーザはパスワードが正しくても入れない。
    // **パスワード照合の後で判定する。** 先に判定すると、
    // 無効化済みユーザだけ応答が速くなり、在籍状況が漏れる。
    if (row.user_status !== 'active') {
      await this.recordFailure(row.user_id, params.email, 'user_inactive');
      return { ok: false, reason: 'user_inactive' };
    }

    // 要求された組織に有効な役割束縛があるか確認する。
    //
    // **これが無いと、利用者は任意の組織IDを名乗ってセッションを取れる。**
    // 後段の認可判定が束縛を見るため越境は起きないが、RLSのコンテキストが
    // 他組織に設定された状態で動くことになり、防御が1枚だけになる。
    // 入口で閉じておけば、その先の全ての層が正しい前提で動く。
    if (params.organizationId) {
      const { rowCount } = await this.client.query(
        `SELECT 1 FROM role_binding
          WHERE user_id = $1 AND organization_id = $2
            AND valid_from <= now()
            AND (valid_until IS NULL OR valid_until > now())
          LIMIT 1`,
        [row.user_id, params.organizationId],
      );
      if (rowCount === 0) {
        await this.recordFailure(row.user_id, params.email, 'no_organization_access');
        return { ok: false, reason: 'no_organization_access' };
      }
    }

    // 成功。失敗カウンタを戻す。
    await this.client.query(
      `UPDATE local_credential SET failed_attempts = 0, locked_until = NULL WHERE id = $1`,
      [row.credential_id],
    );

    // 組織が確定したのでRLSのコンテキストを設定する。
    // 監査イベントは組織スコープのRLS配下にあり、これが無いと書けない。
    // **所属確認の後に設定する**ことで、名乗っただけの組織で監査を書けないようにしている。
    if (params.organizationId) {
      await this.client.query('SELECT set_config($1, $2, true)', [
        'app.current_org',
        params.organizationId,
      ]);
    }

    // セッションは必ず新規発行する(セッション固定攻撃の防止)。
    // 既存のセッションIDを再利用すると、攻撃者が事前に用意したIDへ
    // 被害者をログインさせる経路ができる。
    const { token, session } = await this.sessions.issue({
      userId: row.user_id,
      authMethod: 'local',
      organizationId: params.organizationId,
    });

    await recordAuditEvent(this.client, {
      eventType: 'auth.login.success',
      organizationId: params.organizationId,
      actorType: 'user',
      actorId: row.user_id,
      subjectUserId: row.user_id,
      targetType: 'session',
      targetId: session.id,
      action: 'login',
      outcome: 'success',
      // auth_method は必ず載せる。本番の監査に 'local' が現れたら
      // それ自体が重大インシデントである(脅威 T-25)。
      // **パスワードもトークンも載せない。**
      afterState: { authMethod: 'local' },
    });

    return { ok: true, userId: row.user_id, token, sessionId: session.id };
  }

  /**
   * 失敗回数を加算し、上限に達したらロックする。
   *
   * ロックはユーザ単位である。IP単位ではないため、分散した総当たりも止まる。
   * 一方、正当な利用者を締め出す道具にもなるため、期間は限定する。
   */
  private async registerFailedAttempt(
    credentialId: string,
    currentAttempts: number,
    now: Date,
  ): Promise<void> {
    const next = currentAttempts + 1;
    const shouldLock = next >= this.options.maxFailedAttempts;
    const lockedUntil = shouldLock
      ? new Date(now.getTime() + this.options.lockoutSeconds * 1000)
      : null;

    await this.client.query(
      `UPDATE local_credential
          SET failed_attempts = $2, locked_until = $3
        WHERE id = $1`,
      // ロックしたら回数を戻す。戻さないと、ロック解除直後の1回で再びロックされ、
      // 実質的に永久ロックになる。
      [credentialId, shouldLock ? 0 : next, lockedUntil],
    );
  }

  /**
   * 認証失敗の記録。
   *
   * **監査にはメールアドレスもパスワードも入れない。**
   * 認証失敗のログは攻撃時に大量に出るため、そこに識別情報を載せると
   * ログそのものが名簿になる。理由コードと利用者ID(判明していれば)で足りる。
   */
  private async recordFailure(
    userId: string | null,
    _email: string,
    reason: AuthFailureReason,
  ): Promise<void> {
    await recordAuditEvent(this.client, {
      eventType: 'auth.login.denied',
      organizationId: null,
      // 利用者を特定できない場合も system として必ず記録する。
      // 「誰か分からないので記録しない」にすると、名簿収集の試行が痕跡なしで通る。
      actorType: userId ? 'user' : 'system',
      ...(userId ? { actorId: userId, subjectUserId: userId } : {}),
      targetType: 'session',
      targetId: null,
      action: 'login',
      outcome: 'denied',
      policyDecision: { rule: 'local_authentication', reason },
      afterState: { authMethod: 'local' },
    });
  }

  /** ログアウト。セッションを失効させる。 */
  async logout(sessionId: string, userId: string, organizationId: string | null): Promise<void> {
    await this.sessions.revoke(sessionId, 'logout');
    // 監査を書くために組織コンテキストを設定する。
    // セッションに記録された組織であり、利用者が名乗った値ではない。
    if (organizationId) {
      await this.client.query('SELECT set_config($1, $2, true)', [
        'app.current_org',
        organizationId,
      ]);
    }
    await recordAuditEvent(this.client, {
      eventType: 'auth.session.revoked',
      organizationId,
      actorType: 'user',
      actorId: userId,
      subjectUserId: userId,
      targetType: 'session',
      targetId: sessionId,
      action: 'logout',
      outcome: 'success',
      afterState: { authMethod: 'local', revocationReason: 'logout' },
    });
  }

  /**
   * ローカルアカウントの作成。管理ツールから呼ぶ。
   *
   * `identity` も同時に作る。issuer は予約値に固定されており、
   * DB制約が外部IdPのissuerを騙ることを防いでいる。
   */
  async createCredential(params: {
    userId: string;
    password: string;
    subject: string;
  }): Promise<{ ok: true } | { ok: false; reason: string }> {
    const strength = validatePasswordStrength(params.password);
    if (!strength.ok) return { ok: false, reason: strength.reason ?? 'パスワードが不正です' };

    const hash = await hashPassword(params.password);

    await this.client.query(
      `INSERT INTO identity (id, user_id, idp_type, issuer, subject)
       VALUES ($1, $2, 'local', $3, $4)
       ON CONFLICT (issuer, subject) DO NOTHING`,
      [uuidv7(), params.userId, LOCAL_ISSUER, params.subject],
    );

    await this.client.query(
      `INSERT INTO local_credential (id, user_id, password_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE
          SET password_hash = EXCLUDED.password_hash,
              password_changed_at = now(),
              failed_attempts = 0,
              locked_until = NULL`,
      [uuidv7(), params.userId, hash],
    );

    // パスワード変更時は既存セッションを全て失効させる。
    // 変更の動機が「漏えいしたかもしれない」である以上、
    // 古いセッションを生かしたままでは変更した意味が無い。
    await this.sessions.revokeAllForUser(params.userId, 'password_changed');

    return { ok: true };
  }
}
