/**
 * 部署・組織プロフィール・部署長のスキーマとRLS (WP-P4-IDM-012 / ADR-0023 §3・§12 / TL-04・05・06)。
 *
 * 上長・部署長は承認権限の根拠になるため(脅威 T-26)、制約の欠落は承認者の作出につながる。
 * ここでは制約・トリガ・RLS・Migration の網羅を固定する。同時更新は
 * `department-profile-concurrency.test.ts` が扱う。
 *
 * 接続先は使い捨てDB(名前に `test` を含むこと)に限る。Migration の up/down を実行するため、
 * 開発用DBに対しては最初のガードで失敗させる。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

let admin: pg.Client;
let pool: pg.Pool;
const sfx = randomUUID().slice(0, 8);
const orgIds: string[] = [];
const userIds: string[] = [];

const CODE = {
  check: '23514',
  fk: '23503',
  exclusion: '23P01',
  restrict: '23001',
  privilege: '42501',
  txState: '25000',
} as const;

async function mkOrg(label: string): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO organization (id, code, name) VALUES ($1, $2, $3)`, [
    id,
    `wp012-${label}-${sfx}`,
    `wp012 ${label}`,
  ]);
  orgIds.push(id);
  return id;
}

/** 利用者を作る。`bindingOrg` を渡すと有効期間内の org ロール(requester)も付ける。 */
async function mkUser(
  label: string,
  opts: {
    bindingOrg?: string;
    status?: 'active' | 'deactivated';
    from?: string;
    until?: string | null;
  } = {},
): Promise<string> {
  const id = randomUUID();
  const status = opts.status ?? 'active';
  await admin.query(
    `INSERT INTO app_user (id, primary_email, display_name, status, created_via, deactivated_at)
     VALUES ($1, $2, $3, $4, 'admin', CASE WHEN $4 = 'deactivated' THEN now() END)`,
    [id, `${label}-${id.slice(0, 8)}@example.test`, label, status],
  );
  userIds.push(id);
  if (opts.bindingOrg) {
    await admin.query(
      `INSERT INTO role_binding (id, user_id, role_id, role_scope, organization_id, source, valid_from, valid_until)
       VALUES ($1, $2, (SELECT id FROM role WHERE code = 'requester'), 'org', $3, 'manual',
               COALESCE($4::timestamptz, now() - interval '1 day'), $5::timestamptz)`,
      [randomUUID(), id, opts.bindingOrg, opts.from ?? null, opts.until ?? null],
    );
  }
  return id;
}

/** 管理者権限で直接作る(制約・トリガは働く。RLS は越える)。 */
async function mkDept(
  orgId: string,
  code: string,
  parentId: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `INSERT INTO department (id, organization_id, code, name, parent_id) VALUES ($1, $2, $3, $3, $4)`,
    [id, orgId, `${code}-${sfx}-${id.slice(0, 4)}`, parentId],
  );
  return id;
}

async function mkProfile(
  orgId: string,
  userId: string,
  fields: { dept?: string | null; manager?: string | null } = {},
): Promise<void> {
  await admin.query(
    `INSERT INTO org_member_profile (organization_id, user_id, primary_department_id, manager_user_id)
     VALUES ($1, $2, $3, $4)`,
    [orgId, userId, fields.dept ?? null, fields.manager ?? null],
  );
}

async function mkHead(
  orgId: string,
  deptId: string,
  userId: string,
  from: string,
  until: string | null,
): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `INSERT INTO department_head (id, department_id, organization_id, user_id, valid_from, valid_until, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $4)`,
    [id, deptId, orgId, userId, from, until],
  );
  return id;
}

/** アプリロール(solvi_app)で、組織コンテキストを設定したトランザクションとして実行する。 */
async function asApp<T>(orgId: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (orgId) await client.query("SELECT set_config('app.current_org', $1, true)", [orgId]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** 分離レベルを指定して実行する(既定の READ COMMITTED 以外の検査用)。 */
async function asAppIsolation<T>(
  orgId: string,
  level: 'REPEATABLE READ' | 'SERIALIZABLE' | 'READ UNCOMMITTED',
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${level}`);
    await client.query("SELECT set_config('app.current_org', $1, true)", [orgId]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** 失敗することと、そのSQLSTATE・メッセージの一部を確かめる。 */
async function expectFail(
  promise: Promise<unknown>,
  code: string,
  messagePart?: string,
): Promise<void> {
  let caught: (Error & { code?: string }) | undefined;
  try {
    await promise;
  } catch (error) {
    caught = error as Error & { code?: string };
  }
  expect(caught, '拒否されるべき操作が成功した').toBeDefined();
  expect(caught?.code, caught?.message).toBe(code);
  if (messagePart) expect(caught?.message).toContain(messagePart);
}

const insertDept = (c: pg.PoolClient, org: string, code: string, parent: string | null = null) =>
  c.query(
    `INSERT INTO department (id, organization_id, code, name, parent_id) VALUES ($1, $2, $3, $3, $4)`,
    [randomUUID(), org, code, parent],
  );

function migrate(...args: string[]): { ok: boolean; output: string } {
  try {
    const out = execFileSync('node', ['tools/migrate.mjs', ...args], {
      cwd: join(__dirname, '../..'),
      env: process.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output: out };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

beforeAll(async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  const appUrl = process.env.DATABASE_URL;
  if (!adminUrl || !appUrl) throw new Error('DATABASE_URL と DATABASE_ADMIN_URL が必要です');
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  pool = new pg.Pool({ connectionString: appUrl, max: 4 });
  // **開発用DBへ書かない。** 使い捨てDB(名前に test を含む)でなければここで止める。
  const appName = (await pool.query('SELECT current_database() AS n')).rows[0].n as string;
  const adminName = (await admin.query('SELECT current_database() AS n')).rows[0].n as string;
  for (const name of [appName, adminName]) {
    if (!name.includes('test')) {
      await pool.end();
      await admin.end();
      throw new Error(`接続先 ${name} は使い捨てDB(名前に test を含む)ではありません。中止します`);
    }
  }
});

afterAll(async () => {
  if (admin) {
    const scope = [orgIds];
    await admin.query('DELETE FROM department_head WHERE organization_id = ANY($1::uuid[])', scope);
    await admin.query(
      'UPDATE org_member_profile SET manager_user_id = NULL, primary_department_id = NULL WHERE organization_id = ANY($1::uuid[])',
      scope,
    );
    await admin.query(
      'DELETE FROM org_member_profile WHERE organization_id = ANY($1::uuid[])',
      scope,
    );
    await admin.query(
      'UPDATE department SET parent_id = NULL WHERE organization_id = ANY($1::uuid[])',
      scope,
    );
    await admin.query('DELETE FROM department WHERE organization_id = ANY($1::uuid[])', scope);
    await admin.query('DELETE FROM role_binding WHERE organization_id = ANY($1::uuid[])', scope);
    await admin.query('DELETE FROM role_binding WHERE user_id = ANY($1::uuid[])', [userIds]);
    await admin.query('DELETE FROM app_user WHERE id = ANY($1::uuid[])', [userIds]);
    await admin.query('DELETE FROM organization WHERE id = ANY($1::uuid[])', scope);
    await admin.end();
  }
  await pool?.end();
});

describe('RLS: fail closed と組織分離', () => {
  it('**組織コンテキスト未設定では SELECT が0件で、INSERT が拒否される**', async () => {
    const org = await mkOrg('rls0');
    const dept = await mkDept(org, 'd');
    const user = await mkUser('u0');
    await mkProfile(org, user);
    await mkHead(org, dept, user, '2032-01-01T00:00:00Z', null);

    for (const table of ['department', 'org_member_profile', 'department_head']) {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(rows[0].n, `${table} が組織なしで見えている`).toBe(0);
    }
    await expectFail(
      pool.query(
        `INSERT INTO department (id, organization_id, code, name) VALUES ($1, $2, 'x', 'x')`,
        [randomUUID(), org],
      ),
      CODE.privilege,
    );
    await expectFail(
      pool.query(`INSERT INTO org_member_profile (organization_id, user_id) VALUES ($1, $2)`, [
        org,
        user,
      ]),
      CODE.privilege,
    );
    await expectFail(
      pool.query(
        `INSERT INTO department_head (id, department_id, organization_id, user_id, valid_from, created_by)
         VALUES ($1, $2, $3, $4, '2033-01-01T00:00:00Z', $4)`,
        [randomUUID(), dept, org, user],
      ),
      CODE.privilege,
    );
  });

  it('**組織Aのコンテキストから組織Bの3テーブルを読めず、書けない**', async () => {
    const orgA = await mkOrg('rlsa');
    const orgB = await mkOrg('rlsb');
    const deptB = await mkDept(orgB, 'b');
    const userB = await mkUser('ub');
    await mkProfile(orgB, userB, { dept: deptB });
    const headB = await mkHead(orgB, deptB, userB, '2032-01-01T00:00:00Z', null);
    const deptA = await mkDept(orgA, 'a');

    await asApp(orgA, async (c) => {
      expect((await c.query('SELECT id FROM department WHERE id = $1', [deptB])).rowCount).toBe(0);
      expect(
        (await c.query('SELECT 1 FROM org_member_profile WHERE user_id = $1', [userB])).rowCount,
      ).toBe(0);
      expect((await c.query('SELECT 1 FROM department_head WHERE id = $1', [headB])).rowCount).toBe(
        0,
      );
      expect((await c.query('SELECT id FROM department WHERE id = $1', [deptA])).rowCount).toBe(1);
      // 他組織の行は UPDATE の対象にもならない(0行)
      expect(
        (await c.query(`UPDATE department SET name = 'x' WHERE id = $1`, [deptB])).rowCount,
      ).toBe(0);
      expect(
        (await c.query(`UPDATE org_member_profile SET job_title = 'x' WHERE user_id = $1`, [userB]))
          .rowCount,
      ).toBe(0);
    });
    // 他組織の organization_id を書き込む INSERT は WITH CHECK で拒否される
    await expectFail(
      asApp(orgA, (c) => insertDept(c, orgB, 'cross')),
      CODE.privilege,
    );
    await expectFail(
      asApp(orgA, (c) =>
        c.query(`INSERT INTO org_member_profile (organization_id, user_id) VALUES ($1, $2)`, [
          orgB,
          randomUUID(),
        ]),
      ),
      CODE.privilege,
    );
    const { rows } = await admin.query('SELECT name FROM department WHERE id = $1', [deptB]);
    expect(rows[0].name).not.toBe('x');
  });

  it('**アプリロールは DELETE できない**(3テーブルとも権限エラー)', async () => {
    const org = await mkOrg('del');
    const dept = await mkDept(org, 'd');
    const user = await mkUser('udel');
    await mkProfile(org, user);
    const head = await mkHead(org, dept, user, '2032-01-01T00:00:00Z', null);
    await expectFail(
      asApp(org, (c) => c.query('DELETE FROM department WHERE id = $1', [dept])),
      CODE.privilege,
    );
    await expectFail(
      asApp(org, (c) => c.query('DELETE FROM org_member_profile WHERE user_id = $1', [user])),
      CODE.privilege,
    );
    await expectFail(
      asApp(org, (c) => c.query('DELETE FROM department_head WHERE id = $1', [head])),
      CODE.privilege,
    );
  });
});

describe('複合外部キーが他組織の参照を拒否する', () => {
  it('**他組織の部署を primary_department_id に指定できない**(INSERT / UPDATE)', async () => {
    const orgA = await mkOrg('fka');
    const orgB = await mkOrg('fkb');
    const deptB = await mkDept(orgB, 'b');
    const user = await mkUser('fk1');
    await expectFail(
      asApp(orgA, (c) =>
        c.query(
          `INSERT INTO org_member_profile (organization_id, user_id, primary_department_id) VALUES ($1, $2, $3)`,
          [orgA, user, deptB],
        ),
      ),
      CODE.fk,
    );
    await mkProfile(orgA, user);
    await expectFail(
      asApp(orgA, (c) =>
        c.query(
          `UPDATE org_member_profile SET primary_department_id = $3 WHERE organization_id = $1 AND user_id = $2`,
          [orgA, user, deptB],
        ),
      ),
      CODE.fk,
    );
  });

  it('**他組織のプロフィールを manager_user_id に指定できない**(INSERT / UPDATE)', async () => {
    const orgA = await mkOrg('fkma');
    const orgB = await mkOrg('fkmb');
    const managerB = await mkUser('mgr-b');
    await mkProfile(orgB, managerB);
    const user = await mkUser('fk2');
    await expectFail(
      asApp(orgA, (c) =>
        c.query(
          `INSERT INTO org_member_profile (organization_id, user_id, manager_user_id) VALUES ($1, $2, $3)`,
          [orgA, user, managerB],
        ),
      ),
      CODE.fk,
    );
    await mkProfile(orgA, user);
    await expectFail(
      asApp(orgA, (c) =>
        c.query(
          `UPDATE org_member_profile SET manager_user_id = $3 WHERE organization_id = $1 AND user_id = $2`,
          [orgA, user, managerB],
        ),
      ),
      CODE.fk,
    );
  });

  it('**他組織の親部署を指定できない**(INSERT / UPDATE)', async () => {
    const orgA = await mkOrg('fkpa');
    const orgB = await mkOrg('fkpb');
    const deptB = await mkDept(orgB, 'b');
    const deptA = await mkDept(orgA, 'a');
    await expectFail(
      asApp(orgA, (c) => insertDept(c, orgA, 'child', deptB)),
      CODE.fk,
    );
    await expectFail(
      asApp(orgA, (c) =>
        c.query('UPDATE department SET parent_id = $2 WHERE id = $1', [deptA, deptB]),
      ),
      CODE.fk,
    );
  });

  it('**他組織の部署・利用者を department_head に指定できない**(INSERT / UPDATE)', async () => {
    const orgA = await mkOrg('fkha');
    const orgB = await mkOrg('fkhb');
    const deptA = await mkDept(orgA, 'a');
    const deptB = await mkDept(orgB, 'b');
    const userA = await mkUser('ha');
    const userB = await mkUser('hb');
    await mkProfile(orgA, userA);
    await mkProfile(orgB, userB);
    const insert = (dept: string, user: string) =>
      asApp(orgA, (c) =>
        c.query(
          `INSERT INTO department_head (id, department_id, organization_id, user_id, valid_from, created_by)
           VALUES ($1, $2, $3, $4, '2034-01-01T00:00:00Z', $5)`,
          [randomUUID(), dept, orgA, user, userA],
        ),
      );
    await expectFail(insert(deptB, userA), CODE.fk); // 他組織の部署
    await expectFail(insert(deptA, userB), CODE.fk); // 他組織の利用者
    const head = await mkHead(orgA, deptA, userA, '2034-01-01T00:00:00Z', '2034-02-01T00:00:00Z');
    // UPDATE でも付け替えられない(不変トリガと複合FKのいずれでも拒否される)
    await expectFail(
      asApp(orgA, (c) =>
        c.query('UPDATE department_head SET department_id = $2 WHERE id = $1', [head, deptB]),
      ),
      CODE.check,
    );
  });

  it('**プロフィールの無い利用者は部署長にできない**(複合FK)', async () => {
    const org = await mkOrg('nohead');
    const dept = await mkDept(org, 'a');
    const user = await mkUser('noprofile');
    await expectFail(
      asApp(org, (c) =>
        c.query(
          `INSERT INTO department_head (id, department_id, organization_id, user_id, valid_from, created_by)
           VALUES ($1, $2, $3, $4, '2034-01-01T00:00:00Z', $4)`,
          [randomUUID(), dept, org, user],
        ),
      ),
      CODE.fk,
    );
  });
});

describe('CHECK と循環・深さ', () => {
  it('**自分自身を上長・親部署にできない**(INSERT / UPDATE)', async () => {
    const org = await mkOrg('self');
    const user = await mkUser('self');
    await expectFail(
      asApp(org, (c) =>
        c.query(
          `INSERT INTO org_member_profile (organization_id, user_id, manager_user_id) VALUES ($1, $2, $2)`,
          [org, user],
        ),
      ),
      CODE.check,
    );
    await mkProfile(org, user);
    await expectFail(
      asApp(org, (c) =>
        c.query(
          `UPDATE org_member_profile SET manager_user_id = $2 WHERE organization_id = $1 AND user_id = $2`,
          [org, user],
        ),
      ),
      CODE.check,
    );
    const dept = await mkDept(org, 'a');
    await expectFail(
      asApp(org, (c) => c.query('UPDATE department SET parent_id = id WHERE id = $1', [dept])),
      CODE.check,
    );
    await expectFail(
      asApp(org, (c) =>
        c.query(
          `INSERT INTO department (id, organization_id, code, name, parent_id) VALUES ($1, $2, 'sp', 'sp', $1)`,
          [randomUUID(), org],
        ),
      ),
      // 自己参照は INSERT 時点では存在しない行を指すため、CHECK(23514)が先に働く
      CODE.check,
    );
  });

  it('**部署の親の循環を拒否する**(A→B→A、A→B→C→A)', async () => {
    const org = await mkOrg('dcyc');
    const a = await mkDept(org, 'a');
    const b = await mkDept(org, 'b', a); // B の親は A
    await expectFail(
      asApp(org, (c) => c.query('UPDATE department SET parent_id = $2 WHERE id = $1', [a, b])),
      CODE.check,
      'department_cycle',
    );
    const c3 = await mkDept(org, 'c', b); // C の親は B(A→B→C の連鎖)
    await expectFail(
      asApp(org, (c) => c.query('UPDATE department SET parent_id = $2 WHERE id = $1', [a, c3])),
      CODE.check,
      'department_cycle',
    );
    // 循環でない付け替えは通る
    await asApp(org, (c) => c.query('UPDATE department SET parent_id = $2 WHERE id = $1', [c3, a]));
  });

  it('**上長の循環を拒否する**(甲→乙→甲、3人以上の輪)', async () => {
    const org = await mkOrg('mcyc');
    const u1 = await mkUser('m1');
    const u2 = await mkUser('m2');
    const u3 = await mkUser('m3');
    const u4 = await mkUser('m4');
    await mkProfile(org, u1);
    await mkProfile(org, u2, { manager: u1 }); // u2 の上長は u1
    const setManager = (user: string, manager: string | null) =>
      asApp(org, (c) =>
        c.query(
          'UPDATE org_member_profile SET manager_user_id = $3 WHERE organization_id = $1 AND user_id = $2',
          [org, user, manager],
        ),
      );
    await expectFail(setManager(u1, u2), CODE.check, 'manager_cycle');
    await mkProfile(org, u3, { manager: u2 });
    await mkProfile(org, u4, { manager: u3 });
    // u4→u3→u2→u1。u1 の上長を u4 にすると4人の輪になる
    await expectFail(setManager(u1, u4), CODE.check, 'manager_cycle');
    // 輪にならない付け替えは通る
    await setManager(u4, u1);
    await setManager(u4, null);
  });

  it('**部署の深さ**: 深さ10までは許可し、11になる親の設定は拒否する', async () => {
    const org = await mkOrg('depth');
    const chain: string[] = [];
    let parent: string | null = null;
    for (let level = 1; level <= 10; level += 1) {
      parent = await mkDept(org, `l${level}`, parent);
      chain.push(parent);
    }
    // 深さ11になる子の追加(INSERT)
    await expectFail(
      asApp(org, (c) => insertDept(c, org, 'l11', chain[9]!)),
      CODE.check,
      'department_depth',
    );
    // 既存の孤立部署を深さ10の末端の下へ移す(UPDATE)
    const loose = await mkDept(org, 'loose');
    await expectFail(
      asApp(org, (c) =>
        c.query('UPDATE department SET parent_id = $2 WHERE id = $1', [loose, chain[9]]),
      ),
      CODE.check,
      'department_depth',
    );
    // 深さ10の連鎖を別の連鎖の下へ付け替えると、子孫が上限を超える(配下の深さも見る)
    const root2 = await mkDept(org, 'root2');
    await expectFail(
      asApp(org, (c) =>
        c.query('UPDATE department SET parent_id = $2 WHERE id = $1', [chain[0], root2]),
      ),
      CODE.check,
      'department_depth',
    );
    // 深さ9の部署の下(=深さ10)は許可される
    await asApp(org, (c) => insertDept(c, org, 'l10b', chain[8]!));
  });
});

describe('部署長', () => {
  it('**時間が重なる部署長を2名登録できない**(境界: 終了=開始は許可、1ミリ秒の重複は拒否)', async () => {
    const org = await mkOrg('head');
    const dept = await mkDept(org, 'a');
    const [u1, u2, u3, u4] = [
      await mkUser('h1'),
      await mkUser('h2'),
      await mkUser('h3'),
      await mkUser('h4'),
    ] as [string, string, string, string];
    for (const u of [u1, u2, u3, u4]) await mkProfile(org, u);
    const insert = (user: string, from: string, until: string | null) =>
      asApp(org, (c) =>
        c.query(
          `INSERT INTO department_head (id, department_id, organization_id, user_id, valid_from, valid_until, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $4)`,
          [randomUUID(), dept, org, user, from, until],
        ),
      );
    await insert(u1, '2040-01-01T00:00:00.000Z', '2040-02-01T00:00:00.000Z');
    // 終了 = 開始は許可
    await insert(u2, '2040-02-01T00:00:00.000Z', '2040-03-01T00:00:00.000Z');
    // 1ミリ秒の重複は拒否
    await expectFail(
      insert(u3, '2040-02-28T23:59:59.999Z', '2040-04-01T00:00:00.000Z'),
      CODE.exclusion,
    );
    // 完全に内包される期間も拒否
    await expectFail(
      insert(u3, '2040-01-10T00:00:00.000Z', '2040-01-20T00:00:00.000Z'),
      CODE.exclusion,
    );
    // 終了なし(無期限)は、以降のすべてと重なる
    await insert(u3, '2040-03-01T00:00:00.000Z', null);
    await expectFail(insert(u4, '2041-01-01T00:00:00.000Z', null), CODE.exclusion);
    // 別の部署なら同時刻でも登録できる
    const other = await mkDept(org, 'b');
    await asApp(org, (c) =>
      c.query(
        `INSERT INTO department_head (id, department_id, organization_id, user_id, valid_from, created_by)
         VALUES ($1, $2, $3, $4, '2040-03-01T00:00:00Z', $4)`,
        [randomUUID(), other, org, u4],
      ),
    );
  });

  it('**valid_until <= valid_from は拒否される**', async () => {
    const org = await mkOrg('headrange');
    const dept = await mkDept(org, 'a');
    const user = await mkUser('hr');
    await mkProfile(org, user);
    for (const until of ['2040-01-01T00:00:00Z', '2039-12-31T23:59:59.999Z']) {
      await expectFail(
        asApp(org, (c) =>
          c.query(
            `INSERT INTO department_head (id, department_id, organization_id, user_id, valid_from, valid_until, created_by)
             VALUES ($1, $2, $3, $4, '2040-01-01T00:00:00Z', $5, $4)`,
            [randomUUID(), dept, org, user, until],
          ),
        ),
        CODE.check,
      );
    }
  });

  it('**UPDATE は valid_until の短縮だけが許可される**', async () => {
    const org = await mkOrg('headupd');
    const dept = await mkDept(org, 'a');
    const user = await mkUser('hu1');
    const other = await mkUser('hu2');
    await mkProfile(org, user);
    await mkProfile(org, other);
    const open = await mkHead(org, dept, user, '2040-01-01T00:00:00Z', null);
    const update = (sql: string, ...values: unknown[]) =>
      asApp(org, (c) => c.query(`UPDATE department_head SET ${sql}`, values));

    // 短縮(終了日付け)は許可される
    await update('valid_until = $2 WHERE id = $1', open, '2040-06-01T00:00:00Z');
    // さらに短縮は許可、延長は拒否、解除(NULL)も拒否
    await update('valid_until = $2 WHERE id = $1', open, '2040-05-01T00:00:00Z');
    await expectFail(
      update('valid_until = $2 WHERE id = $1', open, '2040-07-01T00:00:00Z'),
      CODE.check,
      'department_head_immutable',
    );
    await expectFail(
      update('valid_until = NULL WHERE id = $1', open),
      CODE.check,
      'department_head_immutable',
    );
    // user_id・valid_from・部署・作成者の変更は拒否
    await expectFail(
      update('user_id = $2 WHERE id = $1', open, other),
      CODE.check,
      'department_head_immutable',
    );
    await expectFail(
      update(`valid_from = $2 WHERE id = $1`, open, '2039-01-01T00:00:00Z'),
      CODE.check,
      'department_head_immutable',
    );
    await expectFail(
      update('created_by = $2 WHERE id = $1', open, other),
      CODE.check,
      'department_head_immutable',
    );
    // valid_from 以下への短縮は CHECK で拒否
    await expectFail(
      update('valid_until = $2 WHERE id = $1', open, '2040-01-01T00:00:00Z'),
      CODE.check,
    );
  });
});

describe('部署の無効化 (active=false)', () => {
  it('**子部署・有効な所属・有効な部署長が残る部署は無効化できない**', async () => {
    const org = await mkOrg('inact');
    const deactivate = (dept: string) =>
      asApp(org, (c) => c.query('UPDATE department SET active = false WHERE id = $1', [dept]));

    // 子部署
    const parent = await mkDept(org, 'p');
    const child = await mkDept(org, 'c', parent);
    await expectFail(deactivate(parent), CODE.restrict, 'child departments');
    await deactivate(child); // 末端は無効化できる
    // 無効化済みの子が残っていても、子が「残っている」ので親は拒否される(文書どおりの厳格な解釈)
    await expectFail(deactivate(parent), CODE.restrict, 'child departments');

    // 有効な所属プロフィール
    const dept = await mkDept(org, 'm');
    const member = await mkUser('inact-member', { bindingOrg: org });
    await mkProfile(org, member, { dept });
    await expectFail(deactivate(dept), CODE.restrict, 'active members');
    // 所属が外れれば(プロフィールの主部署を外せば)無効化できる
    await admin.query(
      'UPDATE org_member_profile SET primary_department_id = NULL WHERE user_id = $1',
      [member],
    );
    await deactivate(dept);

    // 有効な部署長(現在有効・将来開始)
    const hdept = await mkDept(org, 'h');
    const head = await mkUser('inact-head');
    await mkProfile(org, head);
    const headId = await mkHead(org, hdept, head, '2020-01-01T00:00:00Z', null);
    await expectFail(deactivate(hdept), CODE.restrict, 'department head');
    await admin.query(
      `UPDATE department_head SET valid_until = now() - interval '1 hour' WHERE id = $1`,
      [headId],
    );
    await deactivate(hdept); // 終了済みの部署長だけなら無効化できる
    const fdept = await mkDept(org, 'f');
    await mkHead(org, fdept, head, '2099-01-01T00:00:00Z', null);
    await expectFail(deactivate(fdept), CODE.restrict, 'department head');
  });

  it('**有効な所属でない利用者(期限切れ・停止・将来開始)のプロフィールは無効化を妨げない**', async () => {
    const org = await mkOrg('inact2');
    const cases: Array<[string, Parameters<typeof mkUser>[1]]> = [
      ['expired', { bindingOrg: org, from: '2020-01-01T00:00:00Z', until: '2020-02-01T00:00:00Z' }],
      ['deactivated', { bindingOrg: org, status: 'deactivated' }],
      ['future', { bindingOrg: org, from: '2099-01-01T00:00:00Z' }],
      ['unbound', {}],
    ];
    for (const [label, opts] of cases) {
      const dept = await mkDept(org, `x-${label}`);
      const user = await mkUser(`inact-${label}`, opts);
      await mkProfile(org, user, { dept });
      await asApp(org, (c) =>
        c.query('UPDATE department SET active = false WHERE id = $1', [dept]),
      );
    }
  });

  it('**識別列(id・organization_id)は変更できない**', async () => {
    const orgA = await mkOrg('imma');
    const orgB = await mkOrg('immb');
    const dept = await mkDept(orgA, 'a');
    await expectFail(
      asApp(orgA, (c) =>
        c.query('UPDATE department SET organization_id = $2 WHERE id = $1', [dept, orgB]),
      ),
      // BEFORE UPDATE トリガが先に拒否する(RLS の WITH CHECK はその後に評価される)
      CODE.check,
      'department_immutable',
    );
    await expectFail(
      admin.query('UPDATE department SET organization_id = $2 WHERE id = $1', [dept, orgB]),
      CODE.check,
      'department_immutable',
    );
    const user = await mkUser('imm');
    await mkProfile(orgA, user);
    await expectFail(
      admin.query('UPDATE org_member_profile SET organization_id = $2 WHERE user_id = $1', [
        user,
        orgB,
      ]),
      CODE.check,
      'org_member_profile_immutable',
    );
  });
});

describe('無効な部署への新規の参照を拒否する (WP §6-4)', () => {
  it('**無効な部署を、主部署・部署長・親にできない**(INSERT / UPDATE とも)', async () => {
    const org = await mkOrg('inref');
    const dead = await mkDept(org, 'dead');
    const live = await mkDept(org, 'live');
    const user = await mkUser('inref-u');
    await mkProfile(org, user);
    await admin.query('UPDATE department SET active = false WHERE id = $1', [dead]);

    // 主部署: INSERT(別の利用者)・UPDATE
    const other = await mkUser('inref-o');
    await expectFail(
      asApp(org, (c) =>
        c.query(
          'INSERT INTO org_member_profile (organization_id, user_id, primary_department_id) VALUES ($1, $2, $3)',
          [org, other, dead],
        ),
      ),
      CODE.check,
      'department_inactive',
    );
    await expectFail(
      asApp(org, (c) =>
        c.query(
          'UPDATE org_member_profile SET primary_department_id = $3 WHERE organization_id = $1 AND user_id = $2',
          [org, user, dead],
        ),
      ),
      CODE.check,
      'department_inactive',
    );
    // 部署長(過去の期間でも新規の登録は拒否)
    await expectFail(
      asApp(org, (c) =>
        c.query(
          `INSERT INTO department_head (id, department_id, organization_id, user_id, valid_from, valid_until, created_by)
           VALUES ($1, $2, $3, $4, '2020-01-01T00:00:00Z', '2020-02-01T00:00:00Z', $4)`,
          [randomUUID(), dead, org, user],
        ),
      ),
      CODE.check,
      'department_inactive',
    );
    // 親: INSERT・UPDATE
    await expectFail(
      asApp(org, (c) => insertDept(c, org, 'under-dead', dead)),
      CODE.check,
      'department_inactive',
    );
    await expectFail(
      asApp(org, (c) =>
        c.query('UPDATE department SET parent_id = $2 WHERE id = $1', [live, dead]),
      ),
      CODE.check,
      'department_inactive',
    );
    // 有効な部署へは通る。既に主部署が無効な部署でも、他の列の更新は妨げない。
    await asApp(org, (c) =>
      c.query(
        'UPDATE org_member_profile SET primary_department_id = $3, job_title = $4 WHERE organization_id = $1 AND user_id = $2',
        [org, user, live, '合成'],
      ),
    );
  });

  it('**無効化済みの子部署が残っていても親の無効化は拒否される**(維持)', async () => {
    const org = await mkOrg('inref2');
    const parent = await mkDept(org, 'p');
    const child = await mkDept(org, 'c', parent);
    await admin.query('UPDATE department SET active = false WHERE id = $1', [child]);
    await expectFail(
      asApp(org, (c) => c.query('UPDATE department SET active = false WHERE id = $1', [parent])),
      CODE.restrict,
      'child departments',
    );
  });
});

describe('分離レベルの前提 (WP §6-4)', () => {
  it('**REPEATABLE READ / SERIALIZABLE / READ UNCOMMITTED では親・上長の変更が拒否される**', async () => {
    const org = await mkOrg('iso');
    const a = await mkDept(org, 'a');
    const b = await mkDept(org, 'b');
    const u1 = await mkUser('iso1');
    const u2 = await mkUser('iso2');
    await mkProfile(org, u1);
    await mkProfile(org, u2);
    for (const level of ['REPEATABLE READ', 'SERIALIZABLE', 'READ UNCOMMITTED'] as const) {
      await expectFail(
        asAppIsolation(org, level, (c) =>
          c.query('UPDATE department SET parent_id = $2 WHERE id = $1', [a, b]),
        ),
        CODE.txState,
        'isolation_level',
      );
      await expectFail(
        asAppIsolation(org, level, (c) => insertDept(c, org, `iso-${level}`, b)),
        CODE.txState,
        'isolation_level',
      );
      await expectFail(
        asAppIsolation(org, level, (c) =>
          c.query(
            'UPDATE org_member_profile SET manager_user_id = $3 WHERE organization_id = $1 AND user_id = $2',
            [org, u1, u2],
          ),
        ),
        CODE.txState,
        'isolation_level',
      );
    }
    // 無効化(同じ advisory lock を取る)も同様
    await expectFail(
      asAppIsolation(org, 'REPEATABLE READ', (c) =>
        c.query('UPDATE department SET active = false WHERE id = $1', [a]),
      ),
      CODE.txState,
      'isolation_level',
    );
    // 何も変わっていない
    const { rows } = await admin.query('SELECT parent_id FROM department WHERE id = $1', [a]);
    expect(rows[0].parent_id).toBeNull();
    // READ COMMITTED(既定)では同じ変更が通る
    await asApp(org, (c) => c.query('UPDATE department SET parent_id = $2 WHERE id = $1', [a, b]));
    await asApp(org, (c) =>
      c.query(
        'UPDATE org_member_profile SET manager_user_id = $3 WHERE organization_id = $1 AND user_id = $2',
        [org, u1, u2],
      ),
    );
  });

  it('**親・上長・無効化を伴わない書込みは、REPEATABLE READ でも通る**(バックフィル・読み取り経路を落とさない)', async () => {
    const org = await mkOrg('iso2');
    const user = await mkUser('iso-ok');
    await asAppIsolation(org, 'REPEATABLE READ', async (c) => {
      await insertDept(c, org, 'root-ok'); // 親なし
      await c.query('INSERT INTO org_member_profile (organization_id, user_id) VALUES ($1, $2)', [
        org,
        user,
      ]); // 上長なし
      await c.query(
        `UPDATE org_member_profile SET job_title = 'x' WHERE organization_id = $1 AND user_id = $2`,
        [org, user],
      );
      const { rows } = await c.query('SELECT count(*)::int AS n FROM department');
      expect(rows[0].n).toBeGreaterThanOrEqual(1);
    });
  });
});

describe('文字列の長さ制約 (WP §6-4)', () => {
  it('**部署コード1〜64・部署名1〜200**(境界を含む)', async () => {
    const org = await mkOrg('len');
    const ins = (code: string, name: string) =>
      asApp(org, (c) =>
        c.query(
          'INSERT INTO department (id, organization_id, code, name) VALUES ($1, $2, $3, $4)',
          [randomUUID(), org, code, name],
        ),
      );
    await ins('c'.repeat(64), 'n'.repeat(200)); // 上限は許可
    await ins('c', 'n'); // 下限は許可
    await expectFail(ins('c'.repeat(65), 'n'), CODE.check, 'department_code_length');
    await expectFail(ins('', 'n'), CODE.check, 'department_code_length');
    await expectFail(ins('d', 'n'.repeat(201)), CODE.check, 'department_name_length');
    await expectFail(ins('e', ''), CODE.check, 'department_name_length');
    // UPDATE でも同じ
    await expectFail(
      asApp(org, (c) =>
        c.query(`UPDATE department SET code = $2 WHERE organization_id = $1 AND code = 'c'`, [
          org,
          'x'.repeat(65),
        ]),
      ),
      CODE.check,
      'department_code_length',
    );
  });

  it('**役職・勤務地は200以下、社員番号は64以下**(NULLは許可)', async () => {
    const org = await mkOrg('len2');
    const user = await mkUser('len-u');
    await mkProfile(org, user);
    const upd = (col: string, value: string | null) =>
      asApp(org, (c) =>
        c.query(
          `UPDATE org_member_profile SET ${col} = $3 WHERE organization_id = $1 AND user_id = $2`,
          [org, user, value],
        ),
      );
    for (const [col, max] of [
      ['job_title', 200],
      ['location', 200],
      ['employee_id', 64],
    ] as const) {
      await upd(col, 'x'.repeat(max)); // 上限は許可
      await upd(col, null); // NULL は許可
      await upd(col, ''); // 空文字は長さ制約の対象外(NULL可の列)
      await expectFail(upd(col, 'x'.repeat(max + 1)), CODE.check, `${col}_length`);
    }
  });
});

describe('Migration: バックフィル・up/down (TL-05)', () => {
  const migrationSql = readFileSync(
    join(__dirname, '../../db/migrations/0037_department_and_member_profile.sql'),
    'utf8',
  );
  const backfill = migrationSql.slice(
    migrationSql.indexOf('-- BACKFILL-BEGIN') + '-- BACKFILL-BEGIN'.length,
    migrationSql.indexOf('-- BACKFILL-END'),
  );

  async function allProfilesEmpty(): Promise<void> {
    await admin.query('DELETE FROM department_head');
    await admin.query(
      'UPDATE org_member_profile SET manager_user_id = NULL, primary_department_id = NULL',
    );
    await admin.query('DELETE FROM org_member_profile');
    await admin.query('UPDATE department SET parent_id = NULL');
    await admin.query('DELETE FROM department');
  }

  /** 0039 の down を検証する前に、後続Migrationが残した承認ルール/設定を空にする。 */
  async function allApprovalRulesEmpty(): Promise<void> {
    let disabled = false;
    await admin.query('BEGIN');
    try {
      await admin.query('SET CONSTRAINTS approval_rule_current_revision_fk DEFERRED');
      await admin.query(
        'ALTER TABLE approval_rule_revision DISABLE TRIGGER approval_rule_revision_immutable',
      );
      disabled = true;
      await admin.query('DELETE FROM approval_rule_revision');
      await admin.query('DELETE FROM approval_rule');
      await admin.query('DELETE FROM org_approval_setting');
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      if (disabled)
        await admin
          .query(
            'ALTER TABLE approval_rule_revision ENABLE TRIGGER approval_rule_revision_immutable',
          )
          .catch(() => undefined);
    }
  }

  it('**バックフィルは有効な org スコープの所属ごとに1行を作る**(期限切れ・将来開始・platform のみは作らない)', async () => {
    const org = await mkOrg('bf');
    const other = await mkOrg('bf2');
    const valid = await mkUser('bf-valid', { bindingOrg: org });
    const expired = await mkUser('bf-expired', {
      bindingOrg: org,
      from: '2020-01-01T00:00:00Z',
      until: '2020-02-01T00:00:00Z',
    });
    const future = await mkUser('bf-future', { bindingOrg: org, from: '2099-01-01T00:00:00Z' });
    const platformOnly = await mkUser('bf-platform');
    await admin.query(
      `INSERT INTO role_binding (id, user_id, role_id, role_scope, organization_id, source)
       VALUES ($1, $2, (SELECT id FROM role WHERE code = 'platform_admin'), 'platform', NULL, 'manual')`,
      [randomUUID(), platformOnly],
    );
    // 兼務: 2つの組織に有効な所属 → 2行。同一組織に複数のロール → 1行
    const dual = await mkUser('bf-dual', { bindingOrg: org });
    await admin.query(
      `INSERT INTO role_binding (id, user_id, role_id, role_scope, organization_id, source, valid_from)
       VALUES ($1, $2, (SELECT id FROM role WHERE code = 'agent'), 'org', $3, 'manual', now() - interval '1 day'),
              ($4, $2, (SELECT id FROM role WHERE code = 'requester'), 'org', $5, 'manual', now() - interval '1 day')`,
      [randomUUID(), dual, org, randomUUID(), other],
    );

    // 本物のMigrationのバックフィルを管理者権限(BYPASSRLS)で実行する。冪等であること。
    await admin.query('BEGIN');
    await admin.query(backfill);
    await admin.query(backfill);
    await admin.query('COMMIT');

    const has = async (orgId: string, userId: string) =>
      (
        await admin.query(
          'SELECT 1 FROM org_member_profile WHERE organization_id = $1 AND user_id = $2',
          [orgId, userId],
        )
      ).rowCount === 1;
    expect(await has(org, valid)).toBe(true);
    expect(await has(org, dual)).toBe(true);
    expect(await has(other, dual)).toBe(true);
    expect(await has(org, expired)).toBe(false);
    expect(await has(org, future)).toBe(false);
    const { rows: platformRows } = await admin.query(
      'SELECT 1 FROM org_member_profile WHERE user_id = $1',
      [platformOnly],
    );
    expect(platformRows).toHaveLength(0);

    // 全体の件数一致: 有効な org 所属の (組織, 利用者) 数 = プロフィール行数(バックフィル後に空のものだけではないが、
    // 全ての有効な所属にプロフィールがあることを確かめる)
    const { rows: missing } = await admin.query(
      `SELECT count(*)::int AS n FROM (
         SELECT DISTINCT rb.organization_id, rb.user_id FROM role_binding rb
          WHERE rb.role_scope = 'org' AND rb.organization_id IS NOT NULL
            AND rb.valid_from <= clock_timestamp()
            AND (rb.valid_until IS NULL OR rb.valid_until > clock_timestamp())
       ) m WHERE NOT EXISTS (
         SELECT 1 FROM org_member_profile p WHERE p.organization_id = m.organization_id AND p.user_id = m.user_id)`,
    );
    expect(missing[0].n).toBe(0);
  });

  it('**row_security を回避できないロールでは、バックフィルは失敗する**(黙って0件にならない)', async () => {
    const org = await mkOrg('bfrls');
    await mkUser('bfrls-u', { bindingOrg: org });
    await admin.query('BEGIN');
    try {
      await admin.query('SET LOCAL ROLE solvi_app'); // NOBYPASSRLS
      let caught: (Error & { code?: string }) | undefined;
      try {
        await admin.query(backfill);
      } catch (error) {
        caught = error as Error & { code?: string };
      }
      expect(caught, 'RLS を回避できないロールでバックフィルが成功した').toBeDefined();
      expect(caught?.code).toBe(CODE.privilege);
    } finally {
      await admin.query('ROLLBACK');
    }
  });

  it('**down は3テーブルのいずれかに行があれば拒否し、すべて空なら成功する(up→down→up)**', async () => {
    // このテストは Migration を巻き戻す。使い捨てDBの全体を触るので、最後に必ず up へ戻す。
    // 0037 より後の Migration があっても成り立つよう、先に後続をすべて巻き戻して
    // 0037 を最後の適用済みにしてから down を検証する(「0037 が最後」という前提を置かない)。
    const org = await mkOrg('updown');
    const user = await mkUser('ud', { bindingOrg: org });
    try {
      await allApprovalRulesEmpty();
      const reverted = migrate('down', '--to', '0037');
      expect(reverted.ok, reverted.output).toBe(true);
      const { rows: latest } = await admin.query<{ version: string | null }>(
        'SELECT max(version) AS version FROM schema_migration',
      );
      expect(latest[0]?.version).toBe('0037');

      await allProfilesEmpty();

      // 1. department に行がある
      const dept = await mkDept(org, 'a');
      let result = migrate('down');
      expect(result.ok, result.output).toBe(false);
      expect(result.output).toContain('0037 rollback refused');
      // 2. org_member_profile に行がある(department は空にする)
      await admin.query('DELETE FROM department');
      await mkProfile(org, user);
      result = migrate('down');
      expect(result.ok, result.output).toBe(false);
      expect(result.output).toContain('0037 rollback refused');
      // 3. department_head に行がある
      const dept2 = await mkDept(org, 'b');
      await mkHead(org, dept2, user, '2050-01-01T00:00:00Z', null);
      result = migrate('down');
      expect(result.ok, result.output).toBe(false);
      expect(result.output).toContain('0037 rollback refused');
      // 拒否後も記録は残っている
      const { rows: stillApplied } = await admin.query(
        `SELECT 1 FROM schema_migration WHERE version = '0037'`,
      );
      expect(stillApplied).toHaveLength(1);
      void dept;

      // 4. すべて空なら成功する
      await allProfilesEmpty();
      result = migrate('down');
      expect(result.ok, result.output).toBe(true);
      const { rows: gone } = await admin.query(
        `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'
          AND tablename IN ('department', 'org_member_profile', 'department_head')`,
      );
      expect(gone[0].n).toBe(0);
      const { rows: functions } = await admin.query(
        `SELECT count(*)::int AS n FROM pg_proc WHERE proname IN (
           'department_check_hierarchy', 'department_guard_update', 'org_member_profile_check_manager',
           'org_member_profile_guard', 'department_head_guard', 'department_require_read_committed')`,
      );
      expect(functions[0].n).toBe(0);
      const { rows: ext } = await admin.query(
        `SELECT 1 FROM pg_extension WHERE extname = 'btree_gist'`,
      );
      expect(ext).toHaveLength(1); // 拡張は削除しない
    } finally {
      // 再 up(バックフィルが走る)。2回目も成功し、有効な所属にプロフィールができる。
      const up = migrate('up');
      expect(up.ok, up.output).toBe(true);
    }
    const { rows: backfilled } = await admin.query(
      'SELECT 1 FROM org_member_profile WHERE organization_id = $1 AND user_id = $2',
      [org, user],
    );
    expect(backfilled).toHaveLength(1);
    // 再 up のバックフィルは、他のテストファイルが残した利用者(created_via <> 'seed')にも
    // プロフィールを作る。それが残ると、他のファイルの `DELETE FROM app_user` が外部キーで失敗するため、
    // シード以外の利用者のプロフィールを片付ける(使い捨てDB上でのみ実行される)。
    await admin.query(
      `DELETE FROM org_member_profile
        WHERE user_id IN (SELECT id FROM app_user WHERE created_via <> 'seed')`,
    );
  });
});
