#!/usr/bin/env node
/**
 * 開発環境用: DBロールのパスワードを .env の値で設定する。
 *
 * パスワードをマイグレーションSQLへ書かないための補助ツール(AGENTS.md §1.8)。
 * 本番では Secrets Manager の値を使い、この手順はIaC側で行う(ADR-0016)。
 */
import pg from 'pg';

const url = process.env.DATABASE_ADMIN_URL;
if (!url) {
  console.error('DATABASE_ADMIN_URL が未設定です。');
  process.exit(78);
}

const roles = [
  ['solvi_app', process.env.POSTGRES_APP_PASSWORD],
  ['solvi_executor', process.env.POSTGRES_EXECUTOR_PASSWORD],
];

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  for (const [role, password] of roles) {
    if (!password) {
      console.error(`${role} のパスワードが環境変数にありません。`);
      process.exit(78);
    }
    // ALTER ROLE はパラメータバインドを受け付けないため、エスケープして埋め込む。
    // クエリ文字列はログへ出さない(パスワードが含まれるため / AGENTS.md §1.8)。
    await client.query(
      `ALTER ROLE ${pg.escapeIdentifier(role)} WITH PASSWORD ${pg.escapeLiteral(password)}`,
    );
    console.log(`ok: ${role} のパスワードを設定しました`);
  }
} finally {
  await client.end();
}
