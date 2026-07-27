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
 *   SOLVI_PASSWORD='...' node tools/create_local_user.mjs --email a@example.com
 *   echo '...' | node tools/create_local_user.mjs --email a@example.com
 */

import pg from 'pg';
import { randomUUID, scrypt as scryptCb, randomBytes } from 'node:crypto';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i]?.replace(/^--/, ''), process.argv[i + 1]);
}

const email = args.get('email');
if (!email) {
  process.stderr.write('--email は必須です\n');
  process.exit(2);
}

if (process.env.NODE_ENV === 'production') {
  process.stderr.write(
    'このツールは本番環境では使用できません。ローカル認証は検証段階限定です(ADR-0019)。\n',
  );
  process.exit(2);
}

async function readPassword() {
  if (process.env.SOLVI_PASSWORD) return process.env.SOLVI_PASSWORD;
  if (process.stdin.isTTY) {
    process.stderr.write('パスワードは SOLVI_PASSWORD か標準入力で渡してください\n');
    process.exit(2);
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

const password = await readPassword();
if (password.length < 12) {
  process.stderr.write('パスワードは12文字以上にしてください\n');
  process.exit(2);
}

function scrypt(pw, salt, keyLength, options) {
  return new Promise((resolve, reject) => {
    scryptCb(pw, salt, keyLength, options, (error, derived) =>
      error ? reject(error) : resolve(derived),
    );
  });
}

const PARAMS = { N: 16384, r: 8, p: 1 };
const salt = randomBytes(16);
const derived = await scrypt(password, salt, 64, { ...PARAMS, maxmem: 128 * 1024 * 1024 });
const passwordHash = [
  'scrypt',
  PARAMS.N,
  PARAMS.r,
  PARAMS.p,
  salt.toString('base64'),
  derived.toString('base64'),
].join('$');

const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!url) {
  process.stderr.write('DATABASE_ADMIN_URL または DATABASE_URL が未設定です\n');
  process.exit(78);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  await client.query('BEGIN');

  const { rows } = await client.query('SELECT id, status FROM app_user WHERE primary_email = $1', [
    email,
  ]);
  const user = rows[0];
  if (!user) {
    process.stderr.write(
      `ユーザが見つかりません: ${email}\n` +
        'app_user と role_binding を先に用意してください(tools/seed.mjs)。\n',
    );
    process.exit(1);
  }
  if (user.status !== 'active') {
    process.stderr.write(`ユーザが無効化されています: ${email}\n`);
    process.exit(1);
  }

  await client.query(
    `INSERT INTO identity (id, user_id, idp_type, issuer, subject)
     VALUES ($1, $2, 'local', 'urn:solvi:local', $3)
     ON CONFLICT (issuer, subject) DO NOTHING`,
    [randomUUID(), user.id, email],
  );

  await client.query(
    `INSERT INTO local_credential (id, user_id, password_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE
        SET password_hash = EXCLUDED.password_hash,
            password_changed_at = now(),
            failed_attempts = 0,
            locked_until = NULL`,
    [randomUUID(), user.id, passwordHash],
  );

  // パスワード設定・変更時は既存セッションを全て失効させる。
  // 変更の動機が「漏れたかもしれない」である以上、古いセッションを
  // 生かしたままでは変更した意味が無い。
  const { rowCount: revoked } = await client.query(
    `UPDATE session SET revoked_at = now(), revoked_reason = 'password_changed'
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [user.id],
  );

  await client.query('COMMIT');
  process.stdout.write(
    `OK: ${email} のローカル資格情報を設定しました(既存セッション ${revoked} 件を失効)\n`,
  );
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  // **パスワードもハッシュもエラー出力に載せない。**
  process.stderr.write(`失敗しました: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
} finally {
  await client.end();
}
