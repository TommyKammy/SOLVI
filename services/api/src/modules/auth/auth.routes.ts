import type pg from 'pg';
import {
  Problems,
  ProblemError,
  buildSessionCookie,
  buildClearedSessionCookie,
  parseSessionCookie,
  recordAuthzDenial,
} from '@solvi/shared';
import { SessionService } from './session.service.js';
import { LocalAuthService, type LocalAuthOptions } from './local-auth.service.js';
import type { AuthzContext } from '../../common/authz/authz.js';
import { beginAuthTransaction } from './auth-context.js';

/**
 * 認証のHTTP面 (WP-P1-IDM-009)。
 *
 * ここで守るのは1点だけ: **失敗の詳細を外へ出さない。**
 *
 * サービス層は失敗理由(ユーザ不在 / パスワード不一致 / ロックアウト / 無効化済み)を
 * 区別して返すが、それは**ログと監査のため**である。
 * 応答は常に同じ 401 と同じ本文にする。区別して返すと、
 * 攻撃者は有効なユーザ名の一覧を作れてしまう。
 *
 * ロックアウトだけは例外にしたくなるが、しない。
 * 「ロックされています」を返すと、そのユーザ名が実在することを教えることになる。
 */

/** 認証済みリクエストの文脈。ハンドラはここから principal を受け取る。 */
export interface AuthenticatedRequest {
  authz: AuthzContext;
  sessionId: string;
  userId: string;
}

export interface AuthRouteOptions {
  localAuthEnabled: boolean;
  cookieSecure: boolean;
  localAuth: LocalAuthOptions;
}

/**
 * 認証失敗時の応答。**理由を問わず同一。**
 *
 * `Problems.unauthenticated()` は detail を持たない。
 * 「メールアドレスが違う」「パスワードが違う」「ロックされている」を
 * 区別して返すと、そのまま有効なユーザ名の判別材料になる。
 */
function unauthorized(): ProblemError {
  return Problems.unauthenticated();
}

export class AuthController {
  constructor(
    private readonly pool: pg.Pool,
    private readonly options: AuthRouteOptions,
  ) {}

  /**
   * ログイン。
   *
   * ローカル認証が無効なとき、このエンドポイントは 404 を返す。
   * 「無効です」と答えると、その機能の存在を教えることになる。
   * 存在しないものとして扱うほうが、外から見た攻撃面が小さい。
   */
  async login(body: unknown) {
    if (!this.options.localAuthEnabled) {
      throw Problems.notFound();
    }

    const input = parseLoginBody(body);

    const client = await this.pool.connect();
    try {
      await beginAuthTransaction(client);
      const sessions = new SessionService(client);
      const auth = new LocalAuthService(client, sessions, this.options.localAuth);

      const result = await auth.authenticate({
        email: input.email,
        password: input.password,
        organizationId: input.organizationId,
      });

      await client.query('COMMIT');

      if (!result.ok) {
        recordAuthzDenial(`auth.login.${result.reason}`);
        throw unauthorized();
      }

      // Cookie の有効期限はアイドル期限に合わせる。絶対期限に合わせると、
      // アイドルで無効になった後もブラウザがトークンを送り続け、
      // 無駄なDB参照と紛らわしいログを生む。
      const cookieExpiry = new Date(Date.now() + 60 * 60 * 1000);

      return {
        status: 200,
        headers: {
          'set-cookie': buildSessionCookie({
            token: result.token,
            expiresAt: cookieExpiry,
            secure: this.options.cookieSecure,
          }),
        },
        // **トークンを本文に含めない。** Cookie でのみ渡す。
        // 本文に入れると、SPAが localStorage へ保存する誘惑が生まれ、
        // HttpOnly の意味が失われる。
        body: {
          userId: result.userId,
          // 所属が1つなら決まっている。兼務者は null で返り、画面が選ばせる。
          organizationId: result.organizationId,
          organizations: result.organizations,
        },
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 操作する組織を選ぶ / 切り替える (WP-P1-IDM-010)。
   *
   * **ログイン済みでなければ呼べない。** 未認証の利用者へ組織の一覧を
   * 見せる経路は作らない — 組織名の一覧は、それ自体が顧客リストである。
   */
  async selectOrganization(headers: Record<string, string | string[] | undefined>, body: unknown) {
    const token = parseSessionCookie(headerValue(headers, 'cookie'));
    if (!token) {
      recordAuthzDenial('auth.session.missing');
      throw Problems.unauthenticated();
    }

    const record = (typeof body === 'object' && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    const organizationId =
      typeof record.organizationId === 'string' ? record.organizationId.trim() : '';
    if (organizationId.length === 0) {
      throw Problems.validation([{ field: 'organizationId', message: '組織を選んでください' }]);
    }

    const client = await this.pool.connect();
    try {
      await beginAuthTransaction(client);
      const sessions = new SessionService(client);
      const validation = await sessions.validate(token);
      if (!validation.valid) {
        recordAuthzDenial(`auth.session.${validation.reason}`);
        throw Problems.unauthenticated();
      }

      const auth = new LocalAuthService(client, sessions, this.options.localAuth);
      const changed = await auth.selectOrganization({
        sessionId: validation.session.id,
        userId: validation.session.userId,
        organizationId,
        previousOrganizationId: validation.session.organizationId,
      });
      await client.query('COMMIT');

      if (!changed) {
        // 所属していない組織。**存在するかどうかは答えない。**
        recordAuthzDenial('auth.organization.not_a_member');
        throw Problems.forbidden('その組織では操作できません');
      }

      return { status: 200, body: { organizationId } };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 本人が所属する組織の一覧 (WP-P1-IDM-010)。
   *
   * 組織が未選択でも呼べる。`authenticate()` は未選択を拒むため、
   * ここではセッションの検証だけを行う — **選択画面を出すために必要な情報が、
   * 選択していないと取れない**という行き止まりを作らない。
   */
  async myOrganizations(headers: Record<string, string | string[] | undefined>) {
    const token = parseSessionCookie(headerValue(headers, 'cookie'));
    if (!token) {
      recordAuthzDenial('auth.session.missing');
      throw Problems.unauthenticated();
    }

    const client = await this.pool.connect();
    try {
      await beginAuthTransaction(client);
      const sessions = new SessionService(client);
      const validation = await sessions.validate(token);
      if (!validation.valid) {
        recordAuthzDenial(`auth.session.${validation.reason}`);
        throw Problems.unauthenticated();
      }
      const auth = new LocalAuthService(client, sessions, this.options.localAuth);
      const organizations = await auth.memberOrganizations(validation.session.userId);
      return {
        status: 200,
        body: { selected: validation.session.organizationId, organizations },
      };
    } finally {
      await client.query('COMMIT').catch(() => undefined);
      client.release();
    }
  }

  /** ログアウト。冪等 — 既に無効なセッションでも 204 を返す。 */
  async logout(headers: Record<string, string | string[] | undefined>) {
    const token = parseSessionCookie(headerValue(headers, 'cookie'));
    const cleared = buildClearedSessionCookie(this.options.cookieSecure);

    if (!token) {
      return { status: 204, headers: { 'set-cookie': cleared }, body: null };
    }

    const client = await this.pool.connect();
    try {
      await beginAuthTransaction(client);
      const sessions = new SessionService(client);
      const validation = await sessions.validate(token);

      if (validation.valid) {
        const auth = new LocalAuthService(client, sessions, this.options.localAuth);
        await auth.logout(
          validation.session.id,
          validation.session.userId,
          validation.session.organizationId,
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    // セッションが無効でも Cookie は必ず消す。
    // 消さないと、ブラウザが死んだトークンを送り続ける。
    return { status: 204, headers: { 'set-cookie': cleared }, body: null };
  }

  /** 現在のセッション情報。ログイン状態の確認に使う。 */
  async me(headers: Record<string, string | string[] | undefined>) {
    const authenticated = await this.authenticate(headers);
    return {
      status: 200,
      body: {
        userId: authenticated.userId,
        organizationId: authenticated.authz.organizationId,
        roles: authenticated.authz.principal.bindings.map((b) => ({
          roleCode: b.roleCode,
          organizationId: b.organizationId,
        })),
      },
    };
  }

  /**
   * セッションを検証し、認可文脈を組み立てる。
   *
   * すべての保護されたハンドラがここを通る。
   * **役割は毎回読み直す**(SessionService.validate)。焼き込むと、
   * 権限を剥奪してもセッションが切れるまで古い権限で動いてしまう。
   */
  async authenticate(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<AuthenticatedRequest> {
    const token = parseSessionCookie(headerValue(headers, 'cookie'));
    if (!token) {
      recordAuthzDenial('auth.session.missing');
      throw Problems.unauthenticated();
    }

    const client = await this.pool.connect();
    try {
      await beginAuthTransaction(client);
      const sessions = new SessionService(client);
      const validation = await sessions.validate(token);

      if (!validation.valid) {
        // 理由はメトリクスにだけ残す。応答は一律。
        recordAuthzDenial(`auth.session.${validation.reason}`);
        throw Problems.unauthenticated();
      }

      const organizationId = validation.session.organizationId;
      if (!organizationId) {
        // 組織が未選択のセッションでは業務APIを呼べない。
        // 「どの組織として操作しているか」が決まらないまま
        // RLS のコンテキストを設定すると、fail-closed で0件になるだけで
        // 原因が分かりにくい。ここで明示的に落とす。
        // **専用の型で返す。** 画面はこれを見て組織の選択へ誘導する。
        // 一般の 403 と同じにすると「権限がありません」としか出せず、
        // 兼務者は自分が何をすべきか分からないまま行き止まりになる。
        recordAuthzDenial('auth.session.no_organization');
        throw Problems.organizationNotSelected();
      }

      return {
        authz: { principal: validation.principal, organizationId },
        sessionId: validation.session.id,
        userId: validation.session.userId,
      };
    } finally {
      // validate() はアイドル期限を更新するため COMMIT が要る。
      // 失敗経路でも、更新が無いだけで COMMIT して差し支えない。
      await client.query('COMMIT').catch(() => undefined);
      client.release();
    }
  }
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

interface LoginInput {
  email: string;
  password: string;
  organizationId: string | null;
}

function parseLoginBody(body: unknown): LoginInput {
  if (typeof body !== 'object' || body === null) {
    throw unauthorized();
  }
  const record = body as Record<string, unknown>;
  const email = record.email;
  const password = record.password;

  // 形式の検証で失敗理由を細かく返さない。
  // 「メールアドレスの形式が不正」と「パスワードが空」を区別しても
  // 利用者の役には立たず、攻撃者の役には立つ。
  if (typeof email !== 'string' || email.length === 0 || email.length > 320) {
    throw unauthorized();
  }
  if (typeof password !== 'string' || password.length === 0 || password.length > 1024) {
    throw unauthorized();
  }

  const organizationId =
    typeof record.organizationId === 'string' && record.organizationId.length > 0
      ? record.organizationId
      : null;

  return { email, password, organizationId };
}
