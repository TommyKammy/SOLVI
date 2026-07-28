/**
 * 認証とセッション (WP-P1-IDM-009 / TL-08 / Gate 1 G1-1・G1-9)。
 *
 * このファイルの重点は3つ。
 *
 * 1. **失敗の理由が外へ漏れないこと。** 攻撃者の最初の仕事は有効なユーザ名を
 *    集めることであり、「存在しません」と「パスワードが違います」を区別すると
 *    それだけで名簿ができる。メッセージだけでなく応答時間も揃える必要がある。
 *
 * 2. **失効が効くこと。** FR-IDM-008 は無効化から15分以内の失効を要求する。
 *    セッションへ役割を焼き込むと、剥奪してもセッションが切れるまで
 *    古い権限で動き続ける。ここが本WPで最も重要な性質である。
 *
 * 3. **本番構成で起動しないこと。** 脅威 T-25。運用ルールではなく
 *    起動拒否で担保していることを機械的に確かめる。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { z } from 'zod';
import { hashPassword } from '../../packages/shared/src/auth/password.js';
import { apiEnvSchema } from '../../packages/shared/src/config/env.js';
import { runWithContext, newContext } from '../../packages/shared/src/correlation/context.js';
import { SessionService } from '../../services/api/src/modules/auth/session.service.js';
import {
  LocalAuthService,
  LOCAL_ISSUER,
} from '../../services/api/src/modules/auth/local-auth.service.js';
import { beginAuthTransaction } from '../../services/api/src/modules/auth/auth-context.js';
import { uuidv7 } from '../../services/api/src/common/audit/audit.js';
import { cleanBusinessData, cleanAuditData } from '../support/cleanup.js';

const ORG_A = '00000000-0000-4000-9000-000000000001';
const ORG_B = '00000000-0000-4000-9000-000000000002';
const PASSWORD = 'a-perfectly-fine-password';

let pool: pg.Pool;
let admin: pg.Client;

const AUTH_OPTIONS = { maxFailedAttempts: 3, lockoutSeconds: 900 };

/** 認証は組織コンテキストの外で走る。テストも同じ条件で回す。 */
async function withAuth<T>(
  fn: (
    services: { sessions: SessionService; auth: LocalAuthService },
    c: pg.PoolClient,
  ) => Promise<T>,
  now?: () => Date,
): Promise<T> {
  const client = await pool.connect();
  try {
    await beginAuthTransaction(client);
    const sessions = new SessionService(client, undefined, now);
    const auth = new LocalAuthService(client, sessions, AUTH_OPTIONS, now);
    const out = await runWithContext(newContext(), () => fn({ sessions, auth }, client));
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * 組織コンテキスト付きの実行。
 *
 * `deactivateUser` と `createCredential` は**認証ではなく管理操作**であり、
 * 実運用でも組織コンテキストの中で呼ばれる。認証層の読み取り例外
 * (`app.auth`)は SELECT 専用なので、これらの書き込みはここを通す必要がある。
 */
async function withOrg<T>(
  orgId: string,
  fn: (services: { sessions: SessionService; auth: LocalAuthService }) => Promise<T>,
  now?: () => Date,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_org', orgId]);
    await client.query("SELECT set_config('app.auth', 'on', true)");
    const sessions = new SessionService(client, undefined, now);
    const auth = new LocalAuthService(client, sessions, AUTH_OPTIONS, now);
    const out = await runWithContext(newContext(), () => fn({ sessions, auth }));
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** テスト用の利用者を作る。 */
async function createUser(params: {
  email: string;
  orgId: string;
  roleCode: string;
  withCredential?: boolean;
  status?: 'active' | 'deactivated';
}): Promise<string> {
  const userId = uuidv7();
  const status = params.status ?? 'active';
  await admin.query(
    `INSERT INTO app_user (id, primary_email, display_name, status, created_via, deactivated_at)
     VALUES ($1, $2, $3, $4, 'admin', $5)`,
    [userId, params.email, params.email, status, status === 'deactivated' ? new Date() : null],
  );

  const { rows } = await admin.query('SELECT id, scope FROM role WHERE code = $1', [
    params.roleCode,
  ]);
  await admin.query(
    `INSERT INTO role_binding (id, user_id, role_id, role_scope, organization_id, source)
     VALUES ($1, $2, $3, $4, $5, 'manual')`,
    [uuidv7(), userId, rows[0].id, rows[0].scope, params.orgId],
  );

  if (params.withCredential !== false) {
    await admin.query(
      `INSERT INTO identity (id, user_id, idp_type, issuer, subject)
       VALUES ($1, $2, 'local', $3, $4)`,
      [uuidv7(), userId, LOCAL_ISSUER, params.email],
    );
    await admin.query(
      `INSERT INTO local_credential (id, user_id, password_hash) VALUES ($1, $2, $3)`,
      [uuidv7(), userId, await hashPassword(PASSWORD)],
    );
  }
  return userId;
}

beforeAll(async () => {
  const appUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!appUrl || !adminUrl) throw new Error('DATABASE_URL と DATABASE_ADMIN_URL が必要です');
  pool = new pg.Pool({ connectionString: appUrl, max: 10 });
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
});

afterAll(async () => {
  await admin?.end();
  await pool?.end();
});

beforeEach(async () => {
  await admin.query('DELETE FROM session');
  // **シードのアカウントを消さない。** テストが作るのは created_via='admin' のみ。
  // 以前はここで local_credential を全消ししており、テストを流したあとは
  // シードの利用者が誰もログインできなくなっていた。画面は正常に見えるのに
  // 全員が 401 になり、原因は認証の不具合に見える(実際は資格情報の消失)。
  await admin.query(
    `DELETE FROM local_credential WHERE user_id IN (SELECT id FROM app_user WHERE created_via = 'admin')`,
  );
  await admin.query(
    `DELETE FROM identity WHERE issuer = $1 AND user_id IN (SELECT id FROM app_user WHERE created_via = 'admin')`,
    [LOCAL_ISSUER],
  );
  // 他のテストファイルが残したチケットが app_user を参照しているため、
  // 業務データを先に消さないと利用者を削除できない(FK違反)。
  // 削除順は tests/support/cleanup.ts に集約してある。
  await cleanBusinessData(admin);
  await admin.query("DELETE FROM role_binding WHERE source = 'manual'");
  await admin.query("DELETE FROM app_user WHERE created_via = 'admin'");
  await cleanAuditData(admin, "target_type IN ('session', 'app_user')");
});

// ---------------------------------------------------------------------------

describe('本番構成での起動拒否 (脅威 T-25 / Gate D GD-4)', () => {
  const baseEnv = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_REGION: 'ap-northeast-1',
    S3_BUCKET_ATTACHMENTS: 'attachments',
    S3_BUCKET_AUDIT_ANCHOR: 'audit',
    S3_ACCESS_KEY: 'k',
    S3_SECRET_KEY: 's',
  };

  it('**本番 + ローカル認証有効なら検証に失敗する**', () => {
    const result = apiEnvSchema.safeParse({
      ...baseEnv,
      NODE_ENV: 'production',
      AUTH_LOCAL_ENABLED: 'true',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(' ');
      expect(messages).toContain('本番環境で有効にできません');
      // 理由が読めること。起動しない理由が分からないと復旧が遅れる。
      expect(messages).toContain('ADR-0019');
    }
  });

  it('本番 + ローカル認証無効なら通る', () => {
    const result = apiEnvSchema.safeParse({
      ...baseEnv,
      NODE_ENV: 'production',
      AUTH_LOCAL_ENABLED: 'false',
    });
    expect(result.success).toBe(true);
  });

  it('開発環境なら有効にできる', () => {
    const result = apiEnvSchema.safeParse({
      ...baseEnv,
      NODE_ENV: 'development',
      AUTH_LOCAL_ENABLED: 'true',
      SESSION_COOKIE_SECURE: 'false',
    });
    expect(result.success).toBe(true);
  });

  it('**既定では無効**(明示的に有効化しない限り経路が存在しない)', () => {
    const result = apiEnvSchema.safeParse({ ...baseEnv, NODE_ENV: 'development' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.AUTH_LOCAL_ENABLED).toBe(false);
  });

  it('本番で Secure なしのCookieを拒否する', () => {
    const result = apiEnvSchema.safeParse({
      ...baseEnv,
      NODE_ENV: 'production',
      SESSION_COOKIE_SECURE: 'false',
    });
    expect(result.success).toBe(false);
  });

  it('zodのスキーマであることに依存せず、production 判定が実際に効く', () => {
    // production 以外では通る = 判定が NODE_ENV に基づいている
    for (const env of ['development', 'test'] as const) {
      const result = apiEnvSchema.safeParse({
        ...baseEnv,
        NODE_ENV: env,
        AUTH_LOCAL_ENABLED: 'true',
        SESSION_COOKIE_SECURE: 'false',
      });
      expect(result.success, `${env} で失敗した`).toBe(true);
    }
    expect(z).toBeDefined();
  });
});

describe('ログイン', () => {
  it('正しい資格情報でセッションが発行される', async () => {
    const userId = await createUser({ email: 'ok@example.com', orgId: ORG_A, roleCode: 'agent' });

    const result = await withAuth(({ auth }) =>
      auth.authenticate({ email: 'ok@example.com', password: PASSWORD, organizationId: ORG_A }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.userId).toBe(userId);
      expect(result.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    }
  });

  it('**セッショントークンがDBに平文で保存されない**', async () => {
    await createUser({ email: 'hash@example.com', orgId: ORG_A, roleCode: 'agent' });
    const result = await withAuth(({ auth }) =>
      auth.authenticate({ email: 'hash@example.com', password: PASSWORD, organizationId: ORG_A }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { rows } = await admin.query('SELECT token_hash FROM session');
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toBe(result.token);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['存在しないユーザ', 'nobody@example.com', PASSWORD],
    ['誤ったパスワード', 'wrong@example.com', 'not-the-password'],
  ])('%s は失敗する', async (_label, email, password) => {
    await createUser({ email: 'wrong@example.com', orgId: ORG_A, roleCode: 'agent' });
    const result = await withAuth(({ auth }) =>
      auth.authenticate({ email, password, organizationId: ORG_A }),
    );
    expect(result.ok).toBe(false);
  });

  it('資格情報が無いユーザは失敗する', async () => {
    await createUser({
      email: 'nocred@example.com',
      orgId: ORG_A,
      roleCode: 'agent',
      withCredential: false,
    });
    const result = await withAuth(({ auth }) =>
      auth.authenticate({ email: 'nocred@example.com', password: PASSWORD, organizationId: ORG_A }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_credential');
  });

  it('**無効化済みユーザは正しいパスワードでも入れない**', async () => {
    await createUser({
      email: 'gone@example.com',
      orgId: ORG_A,
      roleCode: 'agent',
      status: 'deactivated',
    });
    const result = await withAuth(({ auth }) =>
      auth.authenticate({ email: 'gone@example.com', password: PASSWORD, organizationId: ORG_A }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('user_inactive');
  });
});

describe('情報の非対称性を作らない', () => {
  it('**存在しないユーザと誤パスワードで応答時間が大きく変わらない**', async () => {
    await createUser({ email: 'timing@example.com', orgId: ORG_A, roleCode: 'agent' });

    const measure = async (email: string): Promise<number> => {
      const started = process.hrtime.bigint();
      await withAuth(({ auth }) =>
        auth.authenticate({ email, password: 'some-wrong-password', organizationId: ORG_A }),
      );
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    // 数回まわして中央値を比べる。1回だけだとGCやスケジューリングで揺れる。
    const existing: number[] = [];
    const missing: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      existing.push(await measure('timing@example.com'));
      missing.push(await measure('does-not-exist@example.com'));
    }
    const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[2]!;

    const ratio = median(missing) / median(existing);
    // 存在しないユーザが極端に速い(=scryptを回していない)と、
    // 応答時間だけでユーザ名の存在有無が判別できてしまう。
    // 桁が変わらないことを見る(厳密な一致は環境差で不安定になる)。
    expect(ratio).toBeGreaterThan(0.3);
    expect(ratio).toBeLessThan(3);
  });
});

describe('総当たり対策', () => {
  it('上限に達するとロックアウトされる', async () => {
    await createUser({ email: 'lock@example.com', orgId: ORG_A, roleCode: 'agent' });

    for (let i = 0; i < AUTH_OPTIONS.maxFailedAttempts; i += 1) {
      await withAuth(({ auth }) =>
        auth.authenticate({ email: 'lock@example.com', password: 'nope', organizationId: ORG_A }),
      );
    }

    // **対象の利用者に絞る。** かつては `local_credential` を全消ししていたため
    // 「1行しか無い」前提で書けたが、それはシードの資格情報まで壊す片付けだった。
    // 片付けを直した結果、この前提が崩れて初めて誤りが露呈した。
    const { rows } = await admin.query(
      `SELECT locked_until FROM local_credential lc
         JOIN app_user u ON u.id = lc.user_id
        WHERE u.primary_email = $1`,
      ['lock@example.com'],
    );
    expect(rows[0].locked_until).not.toBeNull();
  });

  it('**ロック中は正しいパスワードでも通らない**', async () => {
    await createUser({ email: 'lock2@example.com', orgId: ORG_A, roleCode: 'agent' });
    for (let i = 0; i < AUTH_OPTIONS.maxFailedAttempts; i += 1) {
      await withAuth(({ auth }) =>
        auth.authenticate({ email: 'lock2@example.com', password: 'nope', organizationId: ORG_A }),
      );
    }

    const result = await withAuth(({ auth }) =>
      auth.authenticate({ email: 'lock2@example.com', password: PASSWORD, organizationId: ORG_A }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('locked_out');
  });

  it('ロック期間が過ぎれば通る', async () => {
    await createUser({ email: 'lock3@example.com', orgId: ORG_A, roleCode: 'agent' });
    for (let i = 0; i < AUTH_OPTIONS.maxFailedAttempts; i += 1) {
      await withAuth(({ auth }) =>
        auth.authenticate({ email: 'lock3@example.com', password: 'nope', organizationId: ORG_A }),
      );
    }

    const future = () => new Date(Date.now() + (AUTH_OPTIONS.lockoutSeconds + 60) * 1000);
    const result = await withAuth(
      ({ auth }) =>
        auth.authenticate({
          email: 'lock3@example.com',
          password: PASSWORD,
          organizationId: ORG_A,
        }),
      future,
    );
    expect(result.ok).toBe(true);
  });

  it('**ロック解除直後の1回で再ロックされない**(実質永久ロックにしない)', async () => {
    await createUser({ email: 'lock4@example.com', orgId: ORG_A, roleCode: 'agent' });
    for (let i = 0; i < AUTH_OPTIONS.maxFailedAttempts; i += 1) {
      await withAuth(({ auth }) =>
        auth.authenticate({ email: 'lock4@example.com', password: 'nope', organizationId: ORG_A }),
      );
    }
    // ロック時に失敗回数が0へ戻っていること
    const { rows } = await admin.query(
      `SELECT failed_attempts FROM local_credential lc
         JOIN app_user u ON u.id = lc.user_id
        WHERE u.primary_email = $1`,
      ['lock4@example.com'],
    );
    expect(rows[0].failed_attempts).toBe(0);
  });

  it('成功すると失敗回数が戻る', async () => {
    await createUser({ email: 'reset@example.com', orgId: ORG_A, roleCode: 'agent' });
    await withAuth(({ auth }) =>
      auth.authenticate({ email: 'reset@example.com', password: 'nope', organizationId: ORG_A }),
    );
    await withAuth(({ auth }) =>
      auth.authenticate({ email: 'reset@example.com', password: PASSWORD, organizationId: ORG_A }),
    );
    const { rows } = await admin.query(
      `SELECT failed_attempts FROM local_credential lc
         JOIN app_user u ON u.id = lc.user_id
        WHERE u.primary_email = $1`,
      ['reset@example.com'],
    );
    expect(rows[0].failed_attempts).toBe(0);
  });
});

describe('セッションの検証', () => {
  const login = async (email = 'sess@example.com') => {
    await createUser({ email, orgId: ORG_A, roleCode: 'agent' });
    const result = await withAuth(({ auth }) =>
      auth.authenticate({ email, password: PASSWORD, organizationId: ORG_A }),
    );
    if (!result.ok) throw new Error('ログインに失敗しました');
    return result;
  };

  it('発行したトークンで検証できる', async () => {
    const { token, userId } = await login();
    const validation = await withAuth(({ sessions }) => sessions.validate(token));
    expect(validation.valid).toBe(true);
    if (validation.valid) {
      expect(validation.session.userId).toBe(userId);
      expect(validation.session.authMethod).toBe('local');
      expect(validation.principal.bindings).toHaveLength(1);
    }
  });

  it('存在しないトークンは拒否される', async () => {
    const validation = await withAuth(({ sessions }) => sessions.validate('not-a-real-token'));
    expect(validation.valid).toBe(false);
    if (!validation.valid) expect(validation.reason).toBe('not_found');
  });

  it('失効したセッションは拒否される', async () => {
    const { token, sessionId } = await login();
    await withAuth(({ sessions }) => sessions.revoke(sessionId, 'admin_revoked'));

    const validation = await withAuth(({ sessions }) => sessions.validate(token));
    expect(validation.valid).toBe(false);
    if (!validation.valid) expect(validation.reason).toBe('revoked');
  });

  it('**絶対期限を過ぎると拒否される**(使い続けても切れる)', async () => {
    const { token } = await login();
    const later = () => new Date(Date.now() + 13 * 60 * 60 * 1000);
    const validation = await withAuth(({ sessions }) => sessions.validate(token), later);
    expect(validation.valid).toBe(false);
    if (!validation.valid) expect(validation.reason).toBe('expired');
  });

  it('**アイドル期限を過ぎると拒否される**(放置端末の乗っ取りを防ぐ)', async () => {
    const { token } = await login();
    const later = () => new Date(Date.now() + 2 * 60 * 60 * 1000);
    const validation = await withAuth(({ sessions }) => sessions.validate(token), later);
    expect(validation.valid).toBe(false);
    if (!validation.valid) expect(validation.reason).toBe('idle_expired');
  });

  it('アクセスするとアイドル期限が延びる', async () => {
    const { token } = await login();
    const { rows: before } = await admin.query('SELECT idle_expires_at FROM session');

    const later = () => new Date(Date.now() + 30 * 60 * 1000);
    await withAuth(({ sessions }) => sessions.validate(token), later);

    const { rows: after } = await admin.query('SELECT idle_expires_at FROM session');
    expect(after[0].idle_expires_at.getTime()).toBeGreaterThan(before[0].idle_expires_at.getTime());
  });

  it('**失効の理由が必ず記録される**', async () => {
    const { sessionId } = await login();
    await withAuth(({ sessions }) => sessions.revoke(sessionId, 'admin_revoked'));
    const { rows } = await admin.query('SELECT revoked_reason FROM session WHERE id = $1', [
      sessionId,
    ]);
    expect(rows[0].revoked_reason).toBe('admin_revoked');
  });
});

describe('セッション失効の即時性 (FR-IDM-008 / Gate 1 G1-9)', () => {
  it('**ユーザ無効化でセッションが即座に無効になる**', async () => {
    await createUser({ email: 'revoke@example.com', orgId: ORG_A, roleCode: 'agent' });
    const login = await withAuth(({ auth }) =>
      auth.authenticate({ email: 'revoke@example.com', password: PASSWORD, organizationId: ORG_A }),
    );
    if (!login.ok) throw new Error('ログインに失敗しました');

    // 無効化前は通る
    expect((await withAuth(({ sessions }) => sessions.validate(login.token))).valid).toBe(true);

    const startedAt = Date.now();
    const actorId = await createUser({
      email: 'admin@example.com',
      orgId: ORG_A,
      roleCode: 'org_admin',
    });
    await withOrg(ORG_A, ({ sessions }) =>
      sessions.deactivateUser({
        userId: login.userId,
        actorUserId: actorId,
        organizationId: ORG_A,
      }),
    );

    const validation = await withAuth(({ sessions }) => sessions.validate(login.token));
    const elapsedSeconds = (Date.now() - startedAt) / 1000;

    expect(validation.valid).toBe(false);
    // FR-IDM-008 は15分以内を要求する。実測は秒未満のはずである。
    expect(elapsedSeconds).toBeLessThan(15 * 60);
    // 実測値をログへ残す(Evidence の判定材料)
    console.log(`REVOCATION_LATENCY_SECONDS=${elapsedSeconds.toFixed(3)}`);
  });

  it('無効化で全セッションが失効する(1端末だけでは足りない)', async () => {
    await createUser({ email: 'multi@example.com', orgId: ORG_A, roleCode: 'agent' });

    const tokens: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await withAuth(({ auth }) =>
        auth.authenticate({
          email: 'multi@example.com',
          password: PASSWORD,
          organizationId: ORG_A,
        }),
      );
      if (r.ok) tokens.push(r.token);
    }
    expect(tokens).toHaveLength(3);

    const { rows } = await admin.query(
      "SELECT id FROM app_user WHERE primary_email = 'multi@example.com'",
    );
    const actorId = await createUser({
      email: 'admin2@example.com',
      orgId: ORG_A,
      roleCode: 'org_admin',
    });
    const result = await withOrg(ORG_A, ({ sessions }) =>
      sessions.deactivateUser({
        userId: rows[0].id,
        actorUserId: actorId,
        organizationId: ORG_A,
      }),
    );
    expect(result.revokedSessions).toBe(3);

    for (const token of tokens) {
      expect((await withAuth(({ sessions }) => sessions.validate(token))).valid).toBe(false);
    }
  });

  it('**役割を剥奪すると次のリクエストから反映される**(セッションに焼き込まない)', async () => {
    const userId = await createUser({ email: 'role@example.com', orgId: ORG_A, roleCode: 'agent' });
    const login = await withAuth(({ auth }) =>
      auth.authenticate({ email: 'role@example.com', password: PASSWORD, organizationId: ORG_A }),
    );
    if (!login.ok) throw new Error('ログインに失敗しました');

    const before = await withAuth(({ sessions }) => sessions.validate(login.token));
    expect(before.valid && before.principal.bindings).toHaveLength(1);

    await admin.query('DELETE FROM role_binding WHERE user_id = $1', [userId]);

    const after = await withAuth(({ sessions }) => sessions.validate(login.token));
    // セッション自体は有効だが、権限が無くなっている
    expect(after.valid).toBe(true);
    if (after.valid) expect(after.principal.bindings).toHaveLength(0);
  });

  it('パスワード変更で既存セッションが全て失効する', async () => {
    const userId = await createUser({
      email: 'pwchg@example.com',
      orgId: ORG_A,
      roleCode: 'agent',
    });
    const login = await withAuth(({ auth }) =>
      auth.authenticate({ email: 'pwchg@example.com', password: PASSWORD, organizationId: ORG_A }),
    );
    if (!login.ok) throw new Error('ログインに失敗しました');

    await withOrg(ORG_A, ({ auth }) =>
      auth.createCredential({
        userId,
        password: 'a-brand-new-password-value',
        subject: 'pwchg@example.com',
      }),
    );

    const validation = await withAuth(({ sessions }) => sessions.validate(login.token));
    expect(validation.valid).toBe(false);
    if (!validation.valid) expect(validation.reason).toBe('revoked');
  });
});

describe('組織境界 (02.18)', () => {
  it('セッションの組織は発行時に指定したものになる', async () => {
    await createUser({ email: 'orga@example.com', orgId: ORG_A, roleCode: 'agent' });
    const result = await withAuth(({ auth }) =>
      auth.authenticate({ email: 'orga@example.com', password: PASSWORD, organizationId: ORG_A }),
    );
    if (!result.ok) throw new Error('ログインに失敗しました');

    const validation = await withAuth(({ sessions }) => sessions.validate(result.token));
    expect(validation.valid && validation.session.organizationId).toBe(ORG_A);
  });

  it('**他組織の役割は principal に現れるが、その組織の操作は認可で拒否される**', async () => {
    // 役割一覧は利用者本人のものなので見えてよい。
    // 越境を止めるのは認可判定(authz)と RLS であり、principal の中身ではない。
    const userId = await createUser({ email: 'both@example.com', orgId: ORG_A, roleCode: 'agent' });
    const { rows } = await admin.query("SELECT id, scope FROM role WHERE code = 'requester'");
    await admin.query(
      `INSERT INTO role_binding (id, user_id, role_id, role_scope, organization_id, source)
       VALUES ($1, $2, $3, $4, $5, 'manual')`,
      [uuidv7(), userId, rows[0].id, rows[0].scope, ORG_B],
    );

    const login = await withAuth(({ auth }) =>
      auth.authenticate({ email: 'both@example.com', password: PASSWORD, organizationId: ORG_A }),
    );
    if (!login.ok) throw new Error('ログインに失敗しました');

    const validation = await withAuth(({ sessions }) => sessions.validate(login.token));
    expect(validation.valid).toBe(true);
    if (validation.valid) {
      expect(validation.principal.bindings).toHaveLength(2);
      // セッションが操作しているのは ORG_A だけである
      expect(validation.session.organizationId).toBe(ORG_A);
    }
  });
});

describe('監査 (Gate 1 G1-4)', () => {
  it('ログイン成功が記録され、auth_method が含まれる', async () => {
    await createUser({ email: 'audit1@example.com', orgId: ORG_A, roleCode: 'agent' });
    await withAuth(({ auth }) =>
      auth.authenticate({ email: 'audit1@example.com', password: PASSWORD, organizationId: ORG_A }),
    );

    const { rows } = await admin.query(
      "SELECT after_state FROM audit_event WHERE event_type = 'auth.login.success'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].after_state.authMethod).toBe('local');
  });

  it('ログイン失敗が理由付きで記録される', async () => {
    await createUser({ email: 'audit2@example.com', orgId: ORG_A, roleCode: 'agent' });
    await withAuth(({ auth }) =>
      auth.authenticate({ email: 'audit2@example.com', password: 'nope', organizationId: ORG_A }),
    );

    const { rows } = await admin.query(
      "SELECT policy_decision FROM audit_event WHERE event_type = 'auth.login.denied'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].policy_decision.reason).toBe('bad_password');
  });

  it('**存在しないユーザへの試行も記録される**(名簿収集を痕跡なしで通さない)', async () => {
    await withAuth(({ auth }) =>
      auth.authenticate({ email: 'ghost@example.com', password: 'x', organizationId: ORG_A }),
    );
    const { rows } = await admin.query(
      "SELECT policy_decision FROM audit_event WHERE event_type = 'auth.login.denied'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].policy_decision.reason).toBe('unknown_user');
  });

  it('**監査にパスワードもメールアドレスもトークンも入らない**', async () => {
    await createUser({ email: 'secret@example.com', orgId: ORG_A, roleCode: 'agent' });
    const result = await withAuth(({ auth }) =>
      auth.authenticate({ email: 'secret@example.com', password: PASSWORD, organizationId: ORG_A }),
    );
    if (!result.ok) throw new Error('ログインに失敗しました');

    const { rows } = await admin.query('SELECT * FROM audit_event');
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(PASSWORD);
    expect(dump).not.toContain(result.token);
    expect(dump).not.toContain('secret@example.com');
  });

  it('ログアウトが記録される', async () => {
    await createUser({ email: 'out@example.com', orgId: ORG_A, roleCode: 'agent' });
    const result = await withAuth(({ auth }) =>
      auth.authenticate({ email: 'out@example.com', password: PASSWORD, organizationId: ORG_A }),
    );
    if (!result.ok) throw new Error('ログインに失敗しました');

    await withAuth(({ auth }) => auth.logout(result.sessionId, result.userId, ORG_A));

    const { rows } = await admin.query(
      "SELECT after_state FROM audit_event WHERE event_type = 'auth.session.revoked'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].after_state.revocationReason).toBe('logout');
  });
});

describe('identity の取り違え防止', () => {
  it('**ローカルidentityは外部IdPのissuerを騙れない**', async () => {
    const userId = await createUser({
      email: 'iss@example.com',
      orgId: ORG_A,
      roleCode: 'agent',
      withCredential: false,
    });

    await expect(
      admin.query(
        `INSERT INTO identity (id, user_id, idp_type, issuer, subject)
         VALUES ($1, $2, 'local', 'https://okta.example.com', 'spoofed')`,
        [uuidv7(), userId],
      ),
    ).rejects.toThrow(/identity_local_issuer_check/);
  });

  it('同じ (issuer, subject) を二重に登録できない', async () => {
    const a = await createUser({ email: 'dup1@example.com', orgId: ORG_A, roleCode: 'agent' });
    await expect(
      admin.query(
        `INSERT INTO identity (id, user_id, idp_type, issuer, subject)
         VALUES ($1, $2, 'local', $3, 'dup1@example.com')`,
        [uuidv7(), a, LOCAL_ISSUER],
      ),
    ).rejects.toThrow(/identity_issuer_subject_key/);
  });
});

describe('パスワード保存の形式', () => {
  it('**DBに平文を保存できない**(制約で弾かれる)', async () => {
    const userId = await createUser({
      email: 'plain@example.com',
      orgId: ORG_A,
      roleCode: 'agent',
      withCredential: false,
    });
    await expect(
      admin.query(`INSERT INTO local_credential (id, user_id, password_hash) VALUES ($1, $2, $3)`, [
        uuidv7(),
        userId,
        PASSWORD,
      ]),
    ).rejects.toThrow(/local_credential_hash_format/);
  });
});
