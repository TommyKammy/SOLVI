#!/usr/bin/env node
/**
 * マイグレーション実行ツール。
 *
 * 方針(ADR-0003 / AGENTS.md §1.10):
 *  - up と down を必ず対で持つ。down が書けない変更は、書けない理由をSQL内に明記する。
 *  - マイグレーションは **owner ロール**(DATABASE_ADMIN_URL)で実行する。
 *    アプリロールは非owner・NOBYPASSRLS のままにする(ADR-0015)。
 *  - 適用済みマイグレーションのチェックサムを保存し、適用後の書き換えを検出する。
 *    「本番に当てたSQLが後から書き換わっていた」という事故を防ぐため。
 *
 * 使い方:
 *   node tools/migrate.mjs up            # 未適用をすべて適用
 *   node tools/migrate.mjs down          # 最後の1件を巻き戻す
 *   node tools/migrate.mjs down --to 003 # 指定バージョンまで巻き戻す
 *   node tools/migrate.mjs status
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(repoRoot, 'db/migrations');

const UP_MARKER = '-- +migrate up';
const DOWN_MARKER = '-- +migrate down';

function loadMigrations() {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const raw = readFileSync(join(migrationsDir, file), 'utf8');
      const lower = raw.toLowerCase();
      const upIdx = lower.indexOf(UP_MARKER);
      const downIdx = lower.indexOf(DOWN_MARKER);
      if (upIdx === -1 || downIdx === -1) {
        throw new Error(
          `${file}: '${UP_MARKER}' と '${DOWN_MARKER}' の両方が必要です(down を書けない場合も、` +
            `理由をコメントで記した空のセクションを置いてください)`,
        );
      }
      if (downIdx < upIdx) throw new Error(`${file}: down セクションが up より前にあります`);
      return {
        version: file.slice(0, file.indexOf('_')),
        name: file,
        up: raw.slice(upIdx + UP_MARKER.length, downIdx).trim(),
        down: raw.slice(downIdx + DOWN_MARKER.length).trim(),
        checksum: createHash('sha256').update(raw).digest('hex'),
      };
    });
}

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      version     text PRIMARY KEY,
      name        text NOT NULL,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      applied_by  text NOT NULL DEFAULT current_user
    )
  `);
}

async function applied(client) {
  const { rows } = await client.query(
    'SELECT version, name, checksum, applied_at FROM schema_migration ORDER BY version',
  );
  return rows;
}

function connect() {
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_ADMIN_URL(なければ DATABASE_URL)が未設定です。');
    process.exit(78);
  }
  if (!process.env.DATABASE_ADMIN_URL) {
    console.warn(
      '警告: DATABASE_ADMIN_URL が未設定のため DATABASE_URL で実行します。' +
        'アプリロールにDDL権限がある状態は本番では避けてください。',
    );
  }
  return new pg.Client({ connectionString: url });
}

async function cmdStatus() {
  const client = connect();
  await client.connect();
  try {
    await ensureTable(client);
    const done = await applied(client);
    const doneMap = new Map(done.map((r) => [r.version, r]));
    const all = loadMigrations();
    console.log(`migrations: ${all.length} / applied: ${done.length}\n`);
    let drift = 0;
    for (const m of all) {
      const rec = doneMap.get(m.version);
      if (!rec) {
        console.log(`  [ ] ${m.name}`);
      } else if (rec.checksum !== m.checksum) {
        drift++;
        console.log(`  [!] ${m.name}  適用後にファイルが変更されています`);
      } else {
        console.log(`  [x] ${m.name}  (${rec.applied_at.toISOString()})`);
      }
    }
    const orphaned = done.filter((r) => !all.some((m) => m.version === r.version));
    for (const o of orphaned) console.log(`  [?] ${o.name}  DBに記録があるがファイルがありません`);
    if (drift > 0 || orphaned.length > 0) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

async function cmdUp() {
  const client = connect();
  await client.connect();
  try {
    await ensureTable(client);
    const done = new Map((await applied(client)).map((r) => [r.version, r]));
    const pending = [];
    for (const m of loadMigrations()) {
      const rec = done.get(m.version);
      if (!rec) {
        pending.push(m);
      } else if (rec.checksum !== m.checksum) {
        // 適用済みSQLの書き換えは環境間の差異を生む。ここで止める。
        throw new Error(
          `${m.name} は適用済みですが内容が変更されています。` +
            `修正は新しいマイグレーションとして追加してください。`,
        );
      }
    }
    if (pending.length === 0) {
      console.log('適用すべきマイグレーションはありません。');
      return;
    }
    for (const m of pending) {
      // 1マイグレーション=1トランザクション。途中失敗で中途半端な状態を残さない。
      await client.query('BEGIN');
      try {
        console.log(`applying ${m.name} ...`);
        await client.query(m.up);
        await client.query(
          'INSERT INTO schema_migration (version, name, checksum) VALUES ($1, $2, $3)',
          [m.version, m.name, m.checksum],
        );
        await client.query('COMMIT');
        console.log(`  ok`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`${m.name} の適用に失敗しました: ${error.message}`);
      }
    }
    console.log(`\n${pending.length} 件を適用しました。`);
  } finally {
    await client.end();
  }
}

async function cmdDown(target) {
  const client = connect();
  await client.connect();
  try {
    await ensureTable(client);
    const done = await applied(client);
    if (done.length === 0) {
      console.log('巻き戻すマイグレーションがありません。');
      return;
    }
    const all = new Map(loadMigrations().map((m) => [m.version, m]));
    // 新しいものから順に戻す
    const toRevert = [...done].reverse().filter((r) => (target ? r.version > target : true));
    const targets = target ? toRevert : toRevert.slice(0, 1);
    for (const rec of targets) {
      const m = all.get(rec.version);
      if (!m) throw new Error(`${rec.name} のファイルがありません。巻き戻せません。`);
      if (!m.down) {
        throw new Error(
          `${m.name} に down が記述されていません。巻き戻す場合は前進修復で対応してください。`,
        );
      }
      await client.query('BEGIN');
      try {
        console.log(`reverting ${m.name} ...`);
        await client.query(m.down);
        await client.query('DELETE FROM schema_migration WHERE version = $1', [m.version]);
        await client.query('COMMIT');
        console.log('  ok');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`${m.name} の巻き戻しに失敗しました: ${error.message}`);
      }
    }
  } finally {
    await client.end();
  }
}

const [, , command, ...args] = process.argv;
const toIndex = args.indexOf('--to');
const target = toIndex >= 0 ? args[toIndex + 1] : undefined;

const run =
  command === 'up'
    ? cmdUp()
    : command === 'down'
      ? cmdDown(target)
      : command === 'status'
        ? cmdStatus()
        : Promise.reject(new Error('usage: migrate.mjs <up|down|status> [--to <version>]'));

run.catch((error) => {
  console.error(String(error.message ?? error));
  process.exit(1);
});
