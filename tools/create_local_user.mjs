#!/usr/bin/env node
/**
 * ローカルアカウントの作成 (WP-P1-IDM-009 / ADR-0019)
 *
 * 検証段階の利用者を用意するための管理ツール。
 * **本番では使わない。** 本番構成ではローカル認証そのものが起動を拒否される。
 *
 * パスワードは引数で受け取らない。コマンドライン引数は `ps` で他の利用者から
 * 見え、シェル履歴にも残る。標準入力か環境変数で渡す。
 *
 * 使い方:
 *   SOLVI_PASSWORD='...' npm run user:create -- --email a@example.com
 *   echo '...' | npm run user:create -- --email a@example.com
 *
 * `node` で直接は動かない。TypeScript のサービスを呼ぶため tsx が要る
 * (`npm run user:create` がそれを担う)。`tools/seed.mjs` と同じ扱いである。
 *
 * ----------------------------------------------------------------------------
 * このツールは**判断を持たない**。
 *
 * 以前は scrypt の形式・identity の登録・資格情報の upsert・セッションの失効を
 * すべて自前で書き写していた。`LocalAuthService.createCredential` と
 * **同じ処理が二か所にあり、scryptの形式が二重に定義されていた。**
 * 片方だけコストを上げれば、その経路で作った利用者だけがログインできなくなる。
 *
 * いまは入力を読み、利用者を引き、サービスを呼ぶだけである。
 * パスワードの強度も、停止された利用者の拒否も、セッションの失効も、
 * すべてサービス側の規則として1か所にある。
 */

import pg from 'pg';
import { LocalAuthService } from '../services/api/src/modules/auth/local-auth.service.js';
import { SessionService } from '../services/api/src/modules/auth/session.service.js';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i], process.argv[i + 1]);
}

const email = args.get('--email');
if (!email) {
  process.stderr.write('使い方: node tools/create_local_user.mjs --email a@example.com\n');
  process.exit(2);
}

async function readPassword() {
  const fromEnv = process.env.SOLVI_PASSWORD;
  if (fromEnv) return fromEnv;
  if (process.stdin.isTTY) {
    process.stderr.write('パスワードは SOLVI_PASSWORD か標準入力で渡してください\n');
    process.exit(2);
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

const password = await readPassword();

const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!url) {
  process.stderr.write('DATABASE_ADMIN_URL または DATABASE_URL が未設定です\n');
  process.exit(78);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  await client.query('BEGIN');

  const { rows } = await client.query('SELECT id FROM app_user WHERE primary_email = $1', [email]);
  const user = rows[0];
  if (!user) {
    process.stderr.write(
      `ユーザが見つかりません: ${email}\n` +
        'app_user と role_binding を先に用意してください(tools/seed.mjs)。\n',
    );
    process.exit(1);
  }

  // **失効する件数は呼ぶ前に数える。** 呼んだあとでは「今回いくつ切ったか」と
  // 「以前から切れていたもの」を区別できない。
  const { rows: live } = await client.query(
    'SELECT count(*)::int AS n FROM session WHERE user_id = $1 AND revoked_at IS NULL',
    [user.id],
  );

  // 停止された利用者かどうかの判定はサービスが持つ。ここでは問わない。
  const sessions = new SessionService(client);
  const auth = new LocalAuthService(client, sessions, {
    maxFailedAttempts: 5,
    lockoutSeconds: 900,
  });

  const result = await auth.createCredential({
    userId: user.id,
    password,
    subject: email,
  });

  if (!result.ok) {
    await client.query('ROLLBACK');
    process.stderr.write(`設定できませんでした: ${result.reason}\n`);
    process.exit(1);
  }

  await client.query('COMMIT');
  process.stdout.write(
    `OK: ${email} のローカル資格情報を設定しました(既存セッション ${live[0].n} 件を失効)\n`,
  );
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  // **パスワードもハッシュもエラー出力に載せない。**
  process.stderr.write(`失敗しました: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
} finally {
  await client.end();
}
