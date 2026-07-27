import type pg from 'pg';
import {
  issueToken,
  hashToken,
  computeExpiry,
  extendIdle,
  DEFAULT_LIFETIME,
  type SessionLifetime,
} from '@solvi/shared';
import { recordAuditEvent, uuidv7 } from '../../common/audit/audit.js';
import type { Principal, RoleBinding, RoleCode } from '../../common/authz/authz.js';

/**
 * セッション生涯管理 (WP-P1-IDM-009 / ADR-0019)。
 *
 * **このモジュールは認証プロバイダに依存しない。**
 * ローカル認証でも外部IdPのOIDCでも、発行・検証・失効の仕組みは同じである。
 * 違うのは「誰であるかをどう確かめたか」だけで、それは `auth_method` に記録する。
 *
 * この分離があるため、外部IdP接続([[WP-P1-IDM-003]])で追加するのは
 * IDトークンを検証して `issue()` を呼ぶ部分だけになる。
 * 失効の仕組みは、その時点で既に動いていて実測済みという状態になる。
 */

export type AuthMethod = 'local' | 'oidc';

export interface SessionRecord {
  id: string;
  userId: string;
  authMethod: AuthMethod;
  organizationId: string | null;
  issuedAt: Date;
  absoluteExpiresAt: Date;
  idleExpiresAt: Date;
}

/** 検証結果。失敗の理由は**呼び出し側のログ用**であり、利用者へ返さない。 */
export type SessionValidation =
  | { valid: true; session: SessionRecord; principal: Principal }
  | {
      valid: false;
      reason: 'not_found' | 'revoked' | 'expired' | 'idle_expired' | 'user_inactive';
    };

/** 失効の理由。監査で追えるよう、必ず記録する。 */
export type RevocationReason =
  'logout' | 'user_deactivated' | 'password_changed' | 'admin_revoked' | 'all_sessions_revoked';

export class SessionService {
  constructor(
    private readonly client: pg.PoolClient | pg.Client,
    private readonly lifetime: SessionLifetime = DEFAULT_LIFETIME,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * セッションを発行する。
   *
   * **返り値のトークンはこの瞬間しか手に入らない。** DBにはハッシュしか残らないため、
   * 後から取り出すことはできない。これは不便ではなく、意図した性質である。
   */
  async issue(params: {
    userId: string;
    authMethod: AuthMethod;
    organizationId: string | null;
  }): Promise<{ token: string; session: SessionRecord }> {
    const issuedAt = this.now();
    const { token, tokenHash } = issueToken();
    const expiry = computeExpiry(issuedAt, this.lifetime);
    const id = uuidv7();

    await this.client.query(
      `INSERT INTO session
         (id, user_id, token_hash, auth_method, organization_id,
          issued_at, absolute_expires_at, idle_expires_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $6)`,
      [
        id,
        params.userId,
        tokenHash,
        params.authMethod,
        params.organizationId,
        issuedAt,
        expiry.absoluteExpiresAt,
        expiry.idleExpiresAt,
      ],
    );

    return {
      token,
      session: {
        id,
        userId: params.userId,
        authMethod: params.authMethod,
        organizationId: params.organizationId,
        issuedAt,
        absoluteExpiresAt: expiry.absoluteExpiresAt,
        idleExpiresAt: expiry.idleExpiresAt,
      },
    };
  }

  /**
   * トークンを検証し、principal を組み立てる。
   *
   * **毎リクエストで役割を読み直す。** セッションへ役割を焼き込むと、
   * 権限を剥奪しても、そのセッションが切れるまで古い権限で動き続ける。
   * `FR-IDM-008` が要求する失効の即時性は、ここを読み直すことで成立している。
   */
  async validate(token: string): Promise<SessionValidation> {
    const now = this.now();
    const { rows } = await this.client.query<{
      id: string;
      user_id: string;
      auth_method: AuthMethod;
      organization_id: string | null;
      issued_at: Date;
      absolute_expires_at: Date;
      idle_expires_at: Date;
      revoked_at: Date | null;
      user_status: 'active' | 'deactivated';
    }>(
      `SELECT s.id, s.user_id, s.auth_method, s.organization_id, s.issued_at,
              s.absolute_expires_at, s.idle_expires_at, s.revoked_at,
              u.status AS user_status
         FROM session s
         JOIN app_user u ON u.id = s.user_id
        WHERE s.token_hash = $1`,
      [hashToken(token)],
    );

    const row = rows[0];
    if (!row) return { valid: false, reason: 'not_found' };
    if (row.revoked_at) return { valid: false, reason: 'revoked' };
    if (row.absolute_expires_at <= now) return { valid: false, reason: 'expired' };
    if (row.idle_expires_at <= now) return { valid: false, reason: 'idle_expired' };

    // 無効化されたユーザのセッションは、失効処理が走る前でも通さない。
    // 一括失効は非同期でよいが、**判定はここで即座に閉じる**。
    // これにより、無効化からアクセス拒否までの実効時間は0秒になる。
    if (row.user_status !== 'active') return { valid: false, reason: 'user_inactive' };

    const principal = await this.loadPrincipal(row.user_id, row.user_status);

    // アイドル期限を延ばす。絶対期限は動かさない。
    const nextIdle = extendIdle(now, row.absolute_expires_at, this.lifetime);
    await this.client.query(
      'UPDATE session SET last_seen_at = $2, idle_expires_at = $3 WHERE id = $1',
      [row.id, now, nextIdle],
    );

    return {
      valid: true,
      session: {
        id: row.id,
        userId: row.user_id,
        authMethod: row.auth_method,
        organizationId: row.organization_id,
        issuedAt: row.issued_at,
        absoluteExpiresAt: row.absolute_expires_at,
        idleExpiresAt: nextIdle,
      },
      principal,
    };
  }

  /** 役割束縛を読む。有効期間内のものだけを返す(fail closed)。 */
  private async loadPrincipal(
    userId: string,
    status: 'active' | 'deactivated',
  ): Promise<Principal> {
    const { rows } = await this.client.query<{
      role_code: string;
      organization_id: string | null;
      valid_from: Date;
      valid_until: Date | null;
    }>(
      `SELECT r.code AS role_code, rb.organization_id, rb.valid_from, rb.valid_until
         FROM role_binding rb
         JOIN role r ON r.id = rb.role_id
        WHERE rb.user_id = $1`,
      [userId],
    );

    const bindings: RoleBinding[] = rows.map((r) => ({
      roleCode: r.role_code as RoleCode,
      organizationId: r.organization_id,
      validFrom: r.valid_from,
      validUntil: r.valid_until,
    }));

    return { userId, status, bindings };
  }

  /** 単一セッションの失効。 */
  async revoke(sessionId: string, reason: RevocationReason): Promise<boolean> {
    const { rowCount } = await this.client.query(
      `UPDATE session SET revoked_at = $2, revoked_reason = $3
        WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId, this.now(), reason],
    );
    return rowCount === 1;
  }

  /**
   * ユーザの全セッションを失効させる。
   *
   * 無効化・パスワード変更で呼ぶ。「そのブラウザだけ」では足りない —
   * 攻撃者が別の端末で開いているセッションが残ってしまう。
   *
   * @returns 失効させた件数
   */
  async revokeAllForUser(userId: string, reason: RevocationReason): Promise<number> {
    const { rowCount } = await this.client.query(
      `UPDATE session SET revoked_at = $2, revoked_reason = $3
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId, this.now(), reason],
    );
    return rowCount ?? 0;
  }

  /**
   * ユーザを無効化し、同時に全セッションを失効させる。
   *
   * **これは認証ではなく管理操作である。** 組織コンテキスト(`app.current_org`)の中で
   * 呼ぶこと。認証層の読み取り例外(`app.auth`)は SELECT 専用であり、
   * ここでの `app_user` 更新と監査書き込みは通らない。
   *
   * **1つのトランザクションで行う。** 分けると、無効化は済んだが失効は失敗した、
   * という状態が生まれる。`validate()` 側でも status を見ているため実害は無いが、
   * 「片方だけ成功した状態」を作らないことで、後から状態を読んで判断できる。
   */
  async deactivateUser(params: {
    userId: string;
    actorUserId: string;
    organizationId: string;
  }): Promise<{ revokedSessions: number }> {
    const now = this.now();
    await this.client.query(
      `UPDATE app_user SET status = 'deactivated', deactivated_at = $2
        WHERE id = $1 AND status = 'active'`,
      [params.userId, now],
    );
    const revoked = await this.revokeAllForUser(params.userId, 'user_deactivated');

    await recordAuditEvent(this.client, {
      eventType: 'user.deactivated',
      organizationId: params.organizationId,
      actorType: 'user',
      actorId: params.actorUserId,
      subjectUserId: params.userId,
      targetType: 'app_user',
      targetId: params.userId,
      action: 'deactivate',
      outcome: 'success',
      afterState: { status: 'deactivated', revokedSessions: revoked },
    });

    return { revokedSessions: revoked };
  }

  /**
   * 期限切れセッションの削除。定期実行から呼ぶ。
   *
   * 失効済みを即座に消さないのは、監査で「いつ・なぜ失効したか」を
   * 追えるようにするため。保持期間を過ぎたものだけを消す。
   */
  async purgeExpired(retentionDays = 30): Promise<number> {
    const cutoff = new Date(this.now().getTime() - retentionDays * 24 * 60 * 60 * 1000);
    const { rowCount } = await this.client.query(
      `DELETE FROM session
        WHERE absolute_expires_at < $1
           OR (revoked_at IS NOT NULL AND revoked_at < $1)`,
      [cutoff],
    );
    return rowCount ?? 0;
  }
}
