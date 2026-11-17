/**
 * CI 上で、ナレッジ・通知のセキュリティテスト専用の使い捨てDBを作って消す (WP-P3-KNWUI-059)。
 *
 * 元は `evidence/WP-P3-KNWUI-054/20261007/ci-knowledge-db.mjs` にあったが、
 * `751d6ae`(スナップショット取り込み)で失われた。テストが要求する性質から作り直した(DEC-009)。
 *
 * CI の「DB・認可・監査」ジョブは全テストでサービスのDBを共有する。そこへ合成データを
 * 足さないよう、同じサーバーに別のDBを作り、マイグレーションと合成データを入れて渡す。
 *
 * 安全のための決まり(fail closed):
 * - 受け付ける接続先は、CI の明示した契約(localhost:5432、`solvi_app` / `solvi_owner`、
 *   ジョブのサービスDB)だけ。それ以外は接続する前に拒否する。
 * - DROP するのは、自分が作ったと証明できるDBだけ。名前・OID・所有者・コメントの印
 *   (`WP-P3-KNWUI-054:<24桁>`)を照合する。印を付け終える前に失敗した場合は、
 *   同じセッションの CREATE が成功を返したときに限り、印が無いことを確かめて消す。
 * - CREATE の結果が分からないときは消さない(他人のDBを消す危険を取らない)。
 * - エラーに接続文字列・SQL・DBの詳細を含めない。
 */
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { KNOWLEDGE_DATABASE_NAME, seedKnowledgeFixture } from './knowledge-fixture.js';

export const KNOWLEDGE_CI_PREPARATION_MS = 120_000;
export const KNOWLEDGE_CI_CLEANUP_HOOK_MS = 30_000;
export const KNOWLEDGE_CI_SETUP_HOOK_MS = 180_000;

/** CI のサービスDB。ジョブ本体と、DB 名 `solvi` を要求するテスト用の手順の両方。 */
const CI_SERVICE_DATABASES = new Set(['solvi', 'solvi_wp021_wp020_wp019_wp018_wp015_test']);
/** 印は元の WP-P3-KNWUI-054 と同じ形にする(作り直したことで、残ったDBを区別できなくしない)。 */
const MARKER_PREFIX = 'WP-P3-KNWUI-054:';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

type Env = Record<string, string | undefined>;

function fail(code: string): never {
  throw new Error(code);
}

function parse(url: string | undefined): URL | undefined {
  try {
    return url ? new URL(url) : undefined;
  } catch {
    return undefined;
  }
}

/** CI の明示した接続先の契約だけを受け付ける。接続はしない。 */
export function assertCiKnowledgeEndpoints(env: Env = process.env): true {
  const app = parse(env.DATABASE_URL);
  const owner = parse(env.DATABASE_ADMIN_URL);
  const ok =
    env.CI === 'true' &&
    env.GITHUB_ACTIONS === 'true' &&
    app !== undefined &&
    owner !== undefined &&
    [app, owner].every(
      (u) =>
        ['postgres:', 'postgresql:'].includes(u.protocol) &&
        u.hostname === 'localhost' &&
        u.port === '5432' &&
        u.search === '' &&
        u.hash === '',
    ) &&
    app.pathname === owner.pathname &&
    CI_SERVICE_DATABASES.has(app.pathname.replace(/^\//, '')) &&
    decodeURIComponent(app.username) === 'solvi_app' &&
    decodeURIComponent(owner.username) === 'solvi_owner';
  if (!ok) fail('KNOWLEDGE_CI_TARGET_REJECTED');
  return true;
}

export interface CiDatabaseRow {
  name: string;
  oid: number;
  owner: string;
  marker: string | null;
}

export interface CiDatabaseExpectation {
  database: string;
  oid: number | undefined;
  marker: string;
}

export interface CiInitializingExpectation extends CiDatabaseExpectation {
  ownerPid: number;
  createAcknowledged: boolean;
  markerConfirmed: boolean;
}

export interface CiConnectionIdentity {
  database: string;
  role: string;
  pid: number;
}

/** 印まで付け終えた、自分のDBであることを確かめる。 */
export function assertOwnedCiDatabase(db: CiDatabaseRow, expected: CiDatabaseExpectation): void {
  if (
    !KNOWLEDGE_DATABASE_NAME.test(expected.database) ||
    db.name !== expected.database ||
    expected.oid === undefined ||
    db.oid !== expected.oid ||
    db.owner !== 'solvi_owner' ||
    !expected.marker.startsWith(MARKER_PREFIX) ||
    db.marker !== expected.marker
  )
    fail('KNOWLEDGE_CI_OWNER_MISMATCH');
}

/**
 * 印を付け終える前に失敗したDBを、消してよいか確かめる。
 * 同じセッション(PID)で CREATE が成功を返し、印がまだ無く、OID を読めていればそれも一致すること。
 */
export function assertInitializingCiDatabase(
  db: CiDatabaseRow,
  expected: CiInitializingExpectation,
  connection: CiConnectionIdentity,
): void {
  if (
    !KNOWLEDGE_DATABASE_NAME.test(expected.database) ||
    expected.createAcknowledged !== true ||
    expected.markerConfirmed !== false ||
    expected.ownerPid !== connection.pid ||
    connection.role !== 'solvi_owner' ||
    connection.database === expected.database ||
    db.name !== expected.database ||
    db.owner !== 'solvi_owner' ||
    db.marker !== null ||
    (expected.oid !== undefined && db.oid !== expected.oid)
  )
    fail('KNOWLEDGE_CI_OWNER_MISMATCH');
}

export interface CiCleanupReport {
  success: boolean;
  databaseRemoved: boolean;
  ownerClosed: boolean;
  fixtureOwnerClosed: boolean;
}

export interface CiKnowledgeDatabase {
  database: string;
  adminUrl: string;
  appUrl: string;
  cleanup: () => Promise<CiCleanupReport>;
}

const quote = (name: string) => {
  if (!KNOWLEDGE_DATABASE_NAME.test(name)) fail('KNOWLEDGE_CI_OWNER_MISMATCH');
  return `"${name}"`;
};

const IDENTITY_SQL = `SELECT d.datname AS name, d.oid::int AS oid, r.rolname AS owner,
  shobj_description(d.oid, 'pg_database') AS marker
  FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE d.datname = $1`;

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/** マイグレーションを子プロセスで当てる。出力は捨てる(接続先や SQL を残さない)。 */
function migrate(adminUrl: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('KNOWLEDGE_ABORTED'));
    const child = spawn(process.execPath, ['tools/migrate.mjs', 'up'], {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH ?? '', DATABASE_ADMIN_URL: adminUrl },
      stdio: 'ignore',
    });
    const abort = () => child.kill('SIGKILL');
    signal.addEventListener('abort', abort, { once: true });
    child.on('error', () => reject(new Error('KNOWLEDGE_MIGRATION_FAILED')));
    child.on('exit', (code) => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(new Error('KNOWLEDGE_ABORTED'));
      else if (code === 0) resolve();
      else reject(new Error('KNOWLEDGE_MIGRATION_FAILED'));
    });
  });
}

/** 接続ロールが RLS を迂回できず、ナレッジの表に FORCE RLS が掛かっていることを確かめる。 */
export async function assertAppRoleIsolation(appUrl: string, database: string): Promise<void> {
  const app = new pg.Client({ connectionString: appUrl, statement_timeout: 10_000 });
  try {
    await app.connect();
    const rows = (
      await app.query(
        `SELECT current_database() AS database, current_user AS role, r.rolsuper, r.rolbypassrls,
           c.relowner = r.oid AS owns_table, c.relrowsecurity, c.relforcerowsecurity,
           current_setting('row_security') AS row_security
         FROM pg_roles r CROSS JOIN pg_class c
         WHERE r.rolname = current_user
           AND c.oid IN ('knowledge_article'::regclass, 'knowledge_version'::regclass)`,
      )
    ).rows;
    const ok =
      rows.length === 2 &&
      rows.every(
        (row) =>
          row.database === database &&
          row.role === 'solvi_app' &&
          row.rolsuper === false &&
          row.rolbypassrls === false &&
          row.owns_table === false &&
          row.relrowsecurity === true &&
          row.relforcerowsecurity === true &&
          row.row_security === 'on',
      );
    if (!ok) fail('KNOWLEDGE_APP_ROLE_UNSAFE');
  } finally {
    await app.end().catch(() => undefined);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 使い捨てDBを作り、マイグレーションと合成データを入れて返す。
 * 途中で失敗したら片付けてから `KNOWLEDGE_CI_PREPARATION_FAILED` を投げる
 * (`cleanupReport` に片付けの結果を載せる。詳細は載せない)。
 */
export async function createCiKnowledgeDatabase(
  env: Env = process.env,
): Promise<CiKnowledgeDatabase> {
  assertCiKnowledgeEndpoints(env);
  const adminBase = env.DATABASE_ADMIN_URL!;
  const appBase = env.DATABASE_URL!;
  const serviceDatabase = new URL(adminBase).pathname.replace(/^\//, '');
  const database = `solvi_wp054_test_${Date.now()}_${randomBytes(4).toString('hex')}`;
  const expected: CiInitializingExpectation = {
    database,
    oid: undefined,
    marker: MARKER_PREFIX + randomBytes(12).toString('hex'),
    ownerPid: -1,
    createAcknowledged: false,
    markerConfirmed: false,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KNOWLEDGE_CI_PREPARATION_MS);
  const owner = new pg.Client({ connectionString: adminBase, statement_timeout: 30_000 });
  let ownerConnected = false;
  let ownerClosed = false;
  let fixtureOwner: pg.Client | undefined;
  let fixtureOwnerClosed = true;
  let connection: CiConnectionIdentity | undefined;
  let report: CiCleanupReport | undefined;

  const closeFixtureOwner = async () => {
    if (!fixtureOwner || fixtureOwnerClosed) return;
    try {
      await fixtureOwner.end();
      fixtureOwnerClosed = true;
    } catch {
      fixtureOwnerClosed = false;
    }
  };

  const readRow = async (): Promise<CiDatabaseRow | undefined> =>
    (await owner.query(IDENTITY_SQL, [database])).rows[0] as CiDatabaseRow | undefined;

  const cleanup = async (): Promise<CiCleanupReport> => {
    if (report) return report;
    clearTimeout(timer);
    await closeFixtureOwner();
    let databaseRemoved = false;
    try {
      if (ownerConnected && connection) {
        const row = await readRow();
        if (!row) {
          // 作られていない(CREATE が失敗した)、または既に無い
          databaseRemoved = true;
        } else if (expected.createAcknowledged) {
          if (expected.markerConfirmed) assertOwnedCiDatabase(row, expected);
          else assertInitializingCiDatabase(row, expected, connection);
          // 接続が残っていれば DROP は失敗する。テスト側の切断が届くまで少し待つ
          for (let i = 0; i < 50; i++) {
            const n = Number(
              (
                await owner.query(
                  'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
                  [database],
                )
              ).rows[0]?.n,
            );
            if (n === 0) break;
            if (i === 49) fail('KNOWLEDGE_CI_DATABASE_IN_USE');
            await sleep(100);
          }
          await owner.query(`DROP DATABASE ${quote(database)}`);
          databaseRemoved = (await readRow()) === undefined;
        }
        // CREATE の結果が分からないDBは、自分のものと証明できないので消さない
      } else if (!expected.createAcknowledged) {
        databaseRemoved = true; // 接続前に失敗した。何も作っていない
      }
    } catch {
      databaseRemoved = false;
    }
    if (ownerConnected) {
      try {
        await owner.end();
        ownerClosed = true;
      } catch {
        ownerClosed = false;
      }
    } else ownerClosed = true;
    report = {
      success: databaseRemoved && ownerClosed && fixtureOwnerClosed,
      databaseRemoved,
      ownerClosed,
      fixtureOwnerClosed,
    };
    return report;
  };

  try {
    await owner.connect();
    ownerConnected = true;
    const identity = (
      await owner.query(
        `SELECT current_database() AS database, current_user AS role,
           (SELECT d.datdba = r.oid FROM pg_database d, pg_roles r
             WHERE d.datname = current_database() AND r.rolname = current_user) AS owns_database,
           pg_backend_pid() AS pid`,
      )
    ).rows[0] as { database: string; role: string; owns_database: boolean; pid: number };
    if (
      identity?.database !== serviceDatabase ||
      identity.role !== 'solvi_owner' ||
      identity.owns_database !== true ||
      !Number.isInteger(identity.pid)
    )
      fail('KNOWLEDGE_CI_TARGET_REJECTED');
    connection = { database: identity.database, role: identity.role, pid: identity.pid };
    expected.ownerPid = identity.pid;

    await owner.query(`CREATE DATABASE ${quote(database)}`);
    expected.createAcknowledged = true;
    const created = await readRow();
    if (!created || created.owner !== 'solvi_owner' || created.marker !== null)
      fail('KNOWLEDGE_CI_OWNER_MISMATCH');
    expected.oid = created.oid;
    // 印は固定の形(英数字とコロン)なので、文字列リテラルへそのまま埋め込める
    if (!/^WP-P3-KNWUI-054:[a-f0-9]{24}$/.test(expected.marker))
      fail('KNOWLEDGE_CI_OWNER_MISMATCH');
    await owner.query(`COMMENT ON DATABASE ${quote(database)} IS '${expected.marker}'`);
    const marked = await readRow();
    if (!marked) fail('KNOWLEDGE_CI_OWNER_MISMATCH');
    assertOwnedCiDatabase(marked, expected);
    expected.markerConfirmed = true;

    const adminUrl = withDatabase(adminBase, database);
    const appUrl = withDatabase(appBase, database);
    await migrate(adminUrl, controller.signal);

    fixtureOwner = new pg.Client({ connectionString: adminUrl, statement_timeout: 30_000 });
    fixtureOwnerClosed = false;
    await fixtureOwner.connect();
    await seedKnowledgeFixture(fixtureOwner, database, { signal: controller.signal });
    await closeFixtureOwner();
    if (!fixtureOwnerClosed) fail('KNOWLEDGE_CI_FIXTURE_OWNER_OPEN');

    await assertAppRoleIsolation(appUrl, database);
    if (controller.signal.aborted) fail('KNOWLEDGE_ABORTED');
    clearTimeout(timer);
    return { database, adminUrl, appUrl, cleanup };
  } catch {
    const cleanupReport = await cleanup();
    throw Object.assign(new Error('KNOWLEDGE_CI_PREPARATION_FAILED'), { cleanupReport });
  }
}
