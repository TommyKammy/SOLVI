/**
 * ローカルで、ナレッジ・通知のセキュリティテスト専用の PostgreSQL コンテナを作って消す
 * (WP-P3-KNWUI-059)。
 *
 * 元は `evidence/WP-P3-KNWUI-054/20261007/isolated-knowledge-db.mjs` にあったが、
 * `751d6ae`(スナップショット取り込み)で失われた。テストが要求する性質から作り直した(DEC-009)。
 *
 * 開発用のDB(docker compose の `solvi`)には一切触れない。テストごとに新しいコンテナを作る。
 * - イメージは docker-compose.yml / CI と同じ digest 固定の postgres。
 * - データは tmpfs だけに置く(永続ボリュームを作らない)。
 * - ポートは 127.0.0.1 にだけ公開する。
 * - ラベル(`solvi.work-package` / `solvi.owner` の使い捨ての値)で自分のコンテナと確かめてから消す。
 *   ラベルの値は元の WP-P3-KNWUI-054 のまま(既存の片付け手順と区別しないため)。
 */
import { randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { seedKnowledgeFixture } from './knowledge-fixture.js';
import { assertAppRoleIsolation } from './ci-knowledge-db.js';

const POSTGRES_IMAGE =
  'postgres:16.6-alpine@sha256:1d04b9ba1d4996401f2552b51beda8187f175c0645c091e4781134fc9c9a3eef';
const WORK_PACKAGE_LABEL = 'WP-P3-KNWUI-054';
const DATA_DIRECTORY = '/var/lib/postgresql/data';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PREPARATION_MS = 120_000;

function fail(code: string): never {
  throw new Error(code);
}

export interface ExpectedKnowledgeContainer {
  containerId: string;
  imageId: string;
  name: string;
  nonce: string;
  port: number | undefined;
}

interface ContainerInspect {
  Id?: string;
  Image?: string;
  Name?: string;
  Config?: { Labels?: Record<string, string> | null };
  HostConfig?: {
    Tmpfs?: Record<string, string> | null;
    PortBindings?: Record<string, { HostIp?: string; HostPort?: string }[] | null> | null;
  };
  Mounts?: { Type?: string }[] | null;
  State?: { Running?: boolean };
  NetworkSettings?: {
    Ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null> | null;
  };
}

/**
 * `docker inspect` の結果が自分のコンテナで、tmpfs だけを使い、ループバックにだけ公開していることを確かめる。
 * 停止済みのコンテナは、片付けのとき(allowStopped)だけ受け付ける。
 * @returns ホスト側のポート
 */
export function validateKnowledgeContainer(
  container: ContainerInspect,
  expected: ExpectedKnowledgeContainer,
  allowStopped = false,
): number {
  const labels = container.Config?.Labels ?? {};
  if (
    container.Id !== expected.containerId ||
    container.Image !== expected.imageId ||
    container.Name !== `/${expected.name}` ||
    labels['solvi.work-package'] !== WORK_PACKAGE_LABEL ||
    labels['solvi.owner'] !== expected.nonce
  )
    fail('KNOWLEDGE_OWNER_MISMATCH');
  const tmpfs = container.HostConfig?.Tmpfs ?? {};
  const mounts = container.Mounts ?? [];
  if (!(DATA_DIRECTORY in tmpfs) || mounts.some((mount) => mount.Type !== 'tmpfs'))
    fail('KNOWLEDGE_STORAGE_MISMATCH');
  const bindings = container.HostConfig?.PortBindings ?? {};
  const allBindings = Object.values(bindings).flatMap((list) => list ?? []);
  if (
    Object.keys(bindings).some((key) => key !== '5432/tcp') ||
    allBindings.length === 0 ||
    allBindings.some((binding) => binding.HostIp !== '127.0.0.1')
  )
    fail('KNOWLEDGE_NOT_LOOPBACK');
  if (!container.State?.Running) {
    // 起動直後に失敗した片付けでは、まだポートを知らないことがある
    if (allowStopped) return expected.port ?? 0;
    fail('KNOWLEDGE_DATABASE_NOT_READY');
  }
  const live = container.NetworkSettings?.Ports?.['5432/tcp'] ?? [];
  if (live.length === 0 || live.some((binding) => binding.HostIp !== '127.0.0.1'))
    fail('KNOWLEDGE_DATABASE_NOT_READY');
  const port = Number(live[0]!.HostPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) fail('KNOWLEDGE_DATABASE_NOT_READY');
  if (expected.port !== undefined && port !== expected.port) fail('KNOWLEDGE_OWNER_MISMATCH');
  return port;
}

function docker(args: string[], timeout = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout, maxBuffer: 4 << 20 }, (error, stdout) => {
      if (error) reject(new Error('KNOWLEDGE_DOCKER_FAILED'));
      else resolve(stdout);
    });
  });
}

function runTool(script: string, env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [script, ...(script.endsWith('migrate.mjs') ? ['up'] : [])],
      {
        cwd: REPO_ROOT,
        env: { PATH: process.env.PATH ?? '', ...env },
        stdio: 'ignore',
        timeout: PREPARATION_MS,
      },
    );
    child.on('error', () => reject(new Error('KNOWLEDGE_TOOL_FAILED')));
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('KNOWLEDGE_TOOL_FAILED')),
    );
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface IsolatedKnowledgeDatabase {
  database: string;
  adminUrl: string;
  appUrl: string;
  cleanup: () => Promise<{ success: boolean; containerRemoved: boolean }>;
}

/** 使い捨てのコンテナを作り、マイグレーション・ロールのパスワード・合成データを入れて返す。 */
export async function createKnowledgeDatabase(): Promise<IsolatedKnowledgeDatabase> {
  const nonce = randomBytes(12).toString('hex');
  const name = `solvi-wp054-db-${nonce.slice(0, 12)}`;
  const database = `solvi_wp054_test_${Date.now()}_${randomBytes(4).toString('hex')}`;
  // パスワードはこのコンテナだけの使い捨て。ログ・エラーに出さない
  const ownerPassword = randomBytes(18).toString('hex');
  const appPassword = randomBytes(18).toString('hex');
  const executorPassword = randomBytes(18).toString('hex');
  const expected: ExpectedKnowledgeContainer = {
    containerId: '',
    imageId: '',
    name,
    nonce,
    port: undefined,
  };
  let created = false;
  let result: { success: boolean; containerRemoved: boolean } | undefined;

  const cleanup = async () => {
    if (result) return result;
    let containerRemoved = !created;
    if (created) {
      try {
        const [info] = JSON.parse(await docker(['inspect', expected.containerId || name])) as [
          ContainerInspect,
        ];
        if (!expected.containerId) {
          // 起動直後に失敗した場合は、ラベルの使い捨ての値で自分のものと確かめる
          expected.containerId = info.Id ?? '';
          expected.imageId = info.Image ?? '';
        }
        validateKnowledgeContainer(info, expected, true);
        await docker(['rm', '--force', '--volumes', expected.containerId]);
        containerRemoved = true;
      } catch {
        containerRemoved = false;
      }
    }
    result = { success: containerRemoved, containerRemoved };
    return result;
  };

  try {
    const id = (
      await docker(
        [
          'run',
          '--detach',
          '--name',
          name,
          '--label',
          `solvi.work-package=${WORK_PACKAGE_LABEL}`,
          '--label',
          `solvi.owner=${nonce}`,
          '--tmpfs',
          `${DATA_DIRECTORY}:rw`,
          '--publish',
          '127.0.0.1::5432',
          '--env',
          'POSTGRES_USER=solvi_owner',
          '--env',
          `POSTGRES_PASSWORD=${ownerPassword}`,
          '--env',
          `POSTGRES_DB=${database}`,
          POSTGRES_IMAGE,
        ],
        PREPARATION_MS,
      )
    ).trim();
    created = true;
    const [info] = JSON.parse(await docker(['inspect', id])) as [ContainerInspect];
    expected.containerId = id;
    expected.imageId = info.Image ?? '';
    expected.port = validateKnowledgeContainer(info, expected);

    const host = `127.0.0.1:${expected.port}/${database}`;
    const adminUrl = `postgresql://solvi_owner:${ownerPassword}@${host}`;
    const appUrl = `postgresql://solvi_app:${appPassword}@${host}`;

    // 初期化(initdb と再起動)が終わり、実際に接続できるまで待つ
    const deadline = Date.now() + PREPARATION_MS;
    for (;;) {
      const probe = new pg.Client({ connectionString: adminUrl });
      try {
        await probe.connect();
        await probe.query('SELECT 1');
        await probe.end();
        break;
      } catch {
        await probe.end().catch(() => undefined);
        if (Date.now() > deadline) fail('KNOWLEDGE_DATABASE_NOT_READY');
        await sleep(500);
      }
    }

    await runTool('tools/migrate.mjs', { DATABASE_ADMIN_URL: adminUrl });
    await runTool('tools/bootstrap_roles.mjs', {
      DATABASE_ADMIN_URL: adminUrl,
      POSTGRES_APP_PASSWORD: appPassword,
      POSTGRES_EXECUTOR_PASSWORD: executorPassword,
    });
    const owner = new pg.Client({ connectionString: adminUrl, statement_timeout: 30_000 });
    await owner.connect();
    try {
      await seedKnowledgeFixture(owner, database);
    } finally {
      await owner.end();
    }
    await assertAppRoleIsolation(appUrl, database);
    return { database, adminUrl, appUrl, cleanup };
  } catch {
    const cleanupReport = await cleanup();
    throw Object.assign(new Error('KNOWLEDGE_ISOLATED_PREPARATION_FAILED'), { cleanupReport });
  }
}
