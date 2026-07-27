#!/usr/bin/env node
/**
 * RLS 設定と接続ロール権限の検査(ADR-0015 / Gate 1 G1-3)。
 *
 * 検査するのは「今あるテーブルが正しいか」だけではなく、
 * **新しいテーブルが追加されたときに設定漏れを検出できるか** である。
 * organization_id を持つテーブルは RLS 必須、という機械的な規則で判定する。
 *
 * 使い方: node tools/check_rls.mjs
 * 前提: DATABASE_ADMIN_URL(なければ DATABASE_URL)
 */
import pg from 'pg';

/**
 * 組織に属さないことが設計上意図されているテーブル。
 * ここへ追加するときは理由を書くこと(安易な除外を防ぐ)。
 */
const NON_ORG_SCOPED = new Map([
  ['schema_migration', 'マイグレーション管理。業務データではない'],
  ['role', 'ロール定義は参照データ。組織に依存しない'],
  ['app_user', '1人が複数組織へ所属しうる。role_binding 経由で分離する'],
  ['identity', 'app_user に従属。role_binding 経由で分離する'],
  ['organization', 'organization_id ではなく id 自身が組織を表す。RLSは id で分離する'],
  [
    'audit_anchor',
    '日次ハッシュは組織横断の整合性を担保するため分割しない。参照は監査者ロールで制御する',
  ],
]);

/** アプリ接続ロール。いずれも非owner・NOBYPASSRLS でなければならない。 */
const APP_ROLES = ['solvi_app', 'solvi_executor'];

const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_ADMIN_URL または DATABASE_URL が未設定です。');
  process.exit(78);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

const problems = [];
const notes = [];

try {
  // ---- 1. ロールの属性 ----
  const { rows: roles } = await client.query(
    `SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
       FROM pg_roles WHERE rolname = ANY($1)`,
    [APP_ROLES],
  );
  for (const name of APP_ROLES) {
    const role = roles.find((r) => r.rolname === name);
    if (!role) {
      problems.push(`ロール ${name} が存在しません`);
      continue;
    }
    if (role.rolsuper) problems.push(`${name} が SUPERUSER です`);
    if (role.rolbypassrls)
      problems.push(`${name} が BYPASSRLS を持っています(RLSが無効化されます)`);
    if (role.rolcreaterole) problems.push(`${name} が CREATEROLE を持っています(権限昇格の経路)`);
  }

  // ---- 2. テーブル所有者 ----
  const { rows: tables } = await client.query(`
    SELECT c.relname          AS table_name,
           pg_get_userbyid(c.relowner) AS owner,
           c.relrowsecurity   AS rls_enabled,
           c.relforcerowsecurity AS rls_forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname
  `);
  for (const t of tables) {
    if (APP_ROLES.includes(t.owner)) {
      // owner は RLS を素通しできる。アプリロールが owner だと FORCE の意味が薄れる。
      problems.push(`テーブル ${t.table_name} の所有者がアプリロール(${t.owner})です`);
    }
  }

  // ---- 3. organization_id を持つテーブルは RLS 必須 ----
  const { rows: orgScoped } = await client.query(`
    SELECT table_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'organization_id'
     GROUP BY table_name ORDER BY table_name
  `);
  const orgScopedNames = new Set(orgScoped.map((r) => r.table_name));

  for (const t of tables) {
    const isOrgScoped = orgScopedNames.has(t.table_name);
    const excused = NON_ORG_SCOPED.has(t.table_name);

    if (!isOrgScoped && !excused) {
      problems.push(
        `テーブル ${t.table_name} に organization_id がありません。` +
          `組織に属さない設計なら tools/check_rls.mjs の NON_ORG_SCOPED へ理由付きで登録してください`,
      );
      continue;
    }
    if (excused)
      notes.push(`${t.table_name}: 非組織スコープ — ${NON_ORG_SCOPED.get(t.table_name)}`);

    // schema_migration 以外はすべて RLS を要求する
    if (t.table_name === 'schema_migration') continue;
    if (!t.rls_enabled) problems.push(`テーブル ${t.table_name} で RLS が有効になっていません`);
    if (!t.rls_forced)
      problems.push(
        `テーブル ${t.table_name} で FORCE ROW LEVEL SECURITY が設定されていません(所有者に適用されません)`,
      );
  }

  // ---- 4. ポリシーの存在 ----
  const { rows: policies } = await client.query(
    `SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public'`,
  );
  const withPolicy = new Set(policies.map((p) => p.tablename));
  for (const t of tables) {
    if (t.table_name === 'schema_migration') continue;
    if (!withPolicy.has(t.table_name))
      problems.push(
        `テーブル ${t.table_name} に RLS ポリシーがありません(RLS有効=全行不可視のまま)`,
      );
  }

  // ---- 5. 実際に組織コンテキストなしで 0 行になるか ----
  // 設定を「している/していない」ではなく、挙動で確認する。
  const appUrl = process.env.DATABASE_URL;
  if (appUrl && appUrl !== url) {
    const appClient = new pg.Client({ connectionString: appUrl });
    await appClient.connect();
    try {
      for (const table of ['organization', 'role_binding', 'idp_group_mapping', 'app_user']) {
        if (!tables.some((t) => t.table_name === table)) continue;
        const { rows } = await appClient.query(
          `SELECT count(*)::int AS n FROM ${pg.escapeIdentifier(table)}`,
        );
        if (rows[0].n !== 0) {
          problems.push(
            `app.current_org 未設定で ${table} が ${rows[0].n} 行返しました(fail closed になっていません)`,
          );
        }
      }
    } finally {
      await appClient.end();
    }
  } else {
    notes.push('DATABASE_URL(アプリロール)が未指定のため、挙動での確認をスキップしました');
  }
} finally {
  await client.end();
}

console.log(`RLS検査: 問題 ${problems.length} 件`);
for (const n of notes) console.log(`  note: ${n}`);
if (problems.length > 0) {
  console.error('');
  for (const p of problems) console.error(`  NG: ${p}`);
  process.exit(1);
}
console.log('OK: RLS設定と接続ロール権限は期待どおりです。');
