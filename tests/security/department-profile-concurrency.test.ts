/**
 * 部署・上長の循環と部署長の重複を、**同時に**作ろうとしたときの拒否
 * (WP-P4-IDM-012 / ADR-0023 §3 / 脅威 T-26 / TL-04)。
 *
 * 逐次の検査(department-profile.test.ts)では、トリガが「いま見えている行」だけを
 * たどっても通る。**循環はそれでは防げない。** 2つのトランザクションが
 * 逆向きの関係(A の親を B に / B の親を A に)を同時に作ると、
 * どちらのトリガも相手の未コミットの変更を見られず、両方が通って循環が残る。
 *
 * 組織単位の `pg_advisory_xact_lock` を取ってから祖先をたどるトリガは、
 * 後続のトランザクションを待たせ、先行のコミット後に検査し直す。
 * ここでは実PostgreSQLの2接続で、次を確かめる。
 *
 *   1. 後続は**待機する**(ロックが効いている証拠。`pg_stat_activity` で観測する)
 *   2. 先行のコミット後、後続は**拒否される**
 *   3. コミット済みのデータに**循環が残らない**
 *
 * 接続先は使い捨てDBに限る(名前に `test` を含むこと)。
 * 開発用DBに対しては最初のガードで失敗させる。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

let admin: pg.Client;
let appUrl: string;
let orgId: string;
const sfx = randomUUID().slice(0, 8);
const clients: pg.Client[] = [];

async function connectApp(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: appUrl });
  await client.connect();
  clients.push(client);
  return client;
}

/** トランザクションを開き、組織コンテキストを設定する。 */
async function begin(client: pg.Client): Promise<void> {
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.current_org', $1, true)", [orgId]);
}

/** 他方のセッションが advisory ロック待ちになるまで待つ。 */
async function waitUntilBlocked(pid: number, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await admin.query(
      `SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = $1`,
      [pid],
    );
    if (rows[0]?.wait_event_type === 'Lock') return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

async function backendPid(client: pg.Client): Promise<number> {
  const { rows } = await client.query('SELECT pg_backend_pid() AS pid');
  return rows[0].pid as number;
}

async function mkDepartment(code: string): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `INSERT INTO department (id, organization_id, code, name) VALUES ($1, $2, $3, $3)`,
    [id, orgId, `${code}-${sfx}-${id.slice(0, 4)}`],
  );
  return id;
}

async function mkMember(label: string): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `INSERT INTO app_user (id, primary_email, display_name, status, created_via)
     VALUES ($1, $2, $3, 'active', 'admin')`,
    [id, `${label}-${id.slice(0, 8)}@example.test`, label],
  );
  await admin.query(`INSERT INTO org_member_profile (organization_id, user_id) VALUES ($1, $2)`, [
    orgId,
    id,
  ]);
  return id;
}

/**
 * 逆向きの2つの更新を、先行を未コミットのまま後続へ流す。
 * 後続が待機すること・拒否されることを返す。
 */
async function raceOpposite(
  statementA: { text: string; values: unknown[] },
  statementB: { text: string; values: unknown[] },
): Promise<{ waited: boolean; secondFailed: boolean; secondMessage: string }> {
  const c1 = await connectApp();
  const c2 = await connectApp();
  const pid2 = await backendPid(c2);

  await begin(c1);
  await begin(c2);
  await c1.query(statementA.text, statementA.values); // 先行: 未コミット

  // 後続: ロックなしなら即座に成功し、待機しない
  const second = c2.query(statementB.text, statementB.values).then(
    () => ({ ok: true as const, message: '' }),
    (error: Error) => ({ ok: false as const, message: error.message }),
  );
  const waited = await waitUntilBlocked(pid2);

  await c1.query('COMMIT');
  const secondResult = await second;
  if (secondResult.ok) {
    await c2.query('COMMIT');
  } else {
    await c2.query('ROLLBACK');
  }
  return { waited, secondFailed: !secondResult.ok, secondMessage: secondResult.message };
}

beforeAll(async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  const url = process.env.DATABASE_URL;
  if (!adminUrl || !url) throw new Error('DATABASE_URL と DATABASE_ADMIN_URL が必要です');
  appUrl = url;
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  // **開発用DBへ書かない。** 使い捨てDB(名前に test を含む)でなければここで止める。
  const probe = new pg.Client({ connectionString: appUrl });
  await probe.connect();
  const names = [
    (await admin.query('SELECT current_database() AS n')).rows[0].n as string,
    (await probe.query('SELECT current_database() AS n')).rows[0].n as string,
  ];
  await probe.end();
  for (const name of names) {
    if (!name.includes('test')) {
      await admin.end();
      throw new Error(`接続先 ${name} は使い捨てDB(名前に test を含む)ではありません。中止します`);
    }
  }
  orgId = randomUUID();
  await admin.query(`INSERT INTO organization (id, code, name) VALUES ($1, $2, $3)`, [
    orgId,
    `wp012-c-${sfx}`,
    'wp012 concurrency',
  ]);
});

afterAll(async () => {
  for (const c of clients) await c.end().catch(() => undefined);
  if (!admin || !orgId) return;
  await admin.query('DELETE FROM department_head WHERE organization_id = $1', [orgId]);
  await admin.query(
    'UPDATE org_member_profile SET manager_user_id = NULL, primary_department_id = NULL WHERE organization_id = $1',
    [orgId],
  );
  const users = await admin.query(
    'SELECT user_id FROM org_member_profile WHERE organization_id = $1',
    [orgId],
  );
  await admin.query('DELETE FROM org_member_profile WHERE organization_id = $1', [orgId]);
  await admin.query('UPDATE department SET parent_id = NULL WHERE organization_id = $1', [orgId]);
  await admin.query('DELETE FROM department WHERE organization_id = $1', [orgId]);
  for (const row of users.rows) {
    await admin.query('DELETE FROM app_user WHERE id = $1', [row.user_id]);
  }
  await admin.query('DELETE FROM organization WHERE id = $1', [orgId]);
  await admin.end();
});

describe('同時更新で循環を作れない (ADR-0023 §3)', () => {
  it('**部署の親**: 逆向きの設定を同時に行うと、後続は待機して拒否され、循環が残らない', async () => {
    const a = await mkDepartment('a');
    const b = await mkDepartment('b');

    const result = await raceOpposite(
      { text: 'UPDATE department SET parent_id = $1 WHERE id = $2', values: [b, a] },
      { text: 'UPDATE department SET parent_id = $1 WHERE id = $2', values: [a, b] },
    );

    const { rows } = await admin.query(
      'SELECT id, parent_id FROM department WHERE id = ANY($1::uuid[])',
      [[a, b]],
    );
    const parents = new Map(rows.map((r) => [r.id as string, r.parent_id as string | null]));
    const cycle = parents.get(a) === b && parents.get(b) === a;
    expect(cycle, '循環が残っている').toBe(false);
    expect(result.waited, '後続が待機していない(ロックが効いていない)').toBe(true);
    expect(result.secondFailed, '後続が拒否されていない').toBe(true);
    expect(result.secondMessage).toContain('department_cycle');
  });

  it('**部署の親**: 3つの輪(A→B→C→A)を、別々の2本が同時に閉じようとしても残らない', async () => {
    const a = await mkDepartment('a3');
    const b = await mkDepartment('b3');
    const c = await mkDepartment('c3');
    // A→B は確定済み。 先行: B→C。 後続: C→A。 合成すると A→B→C→A の輪になる。
    await admin.query('UPDATE department SET parent_id = $1 WHERE id = $2', [b, a]);

    const result = await raceOpposite(
      { text: 'UPDATE department SET parent_id = $1 WHERE id = $2', values: [c, b] },
      { text: 'UPDATE department SET parent_id = $1 WHERE id = $2', values: [a, c] },
    );

    const { rows } = await admin.query(
      `WITH RECURSIVE walk(start_id, id, depth) AS (
         SELECT id, parent_id, 1 FROM department WHERE organization_id = $1
         UNION ALL
         SELECT w.start_id, d.parent_id, w.depth + 1
           FROM walk w JOIN department d ON d.id = w.id
          WHERE w.id IS NOT NULL AND w.depth < 30
       )
       SELECT count(*)::int AS n FROM walk WHERE id = start_id`,
      [orgId],
    );
    expect(rows[0].n, '循環が残っている').toBe(0);
    expect(result.waited).toBe(true);
    expect(result.secondFailed).toBe(true);
  });

  it('**部署の親**: 行を共有しない2本(A→B、C→D が確定済みで B→C と D→A)が同時に輪を閉じても残らない', async () => {
    // 親の部署行に FOR SHARE を取る検査(無効な親の拒否)が、隣接する更新を偶然に直列化することがある。
    // この組み合わせは行ロックを共有しないため、組織単位の advisory lock だけが輪を防ぐ。
    const a = await mkDepartment('a4');
    const b = await mkDepartment('b4');
    const c = await mkDepartment('c4');
    const d = await mkDepartment('d4');
    await admin.query('UPDATE department SET parent_id = $1 WHERE id = $2', [b, a]);
    await admin.query('UPDATE department SET parent_id = $1 WHERE id = $2', [d, c]);

    const result = await raceOpposite(
      { text: 'UPDATE department SET parent_id = $1 WHERE id = $2', values: [c, b] },
      { text: 'UPDATE department SET parent_id = $1 WHERE id = $2', values: [a, d] },
    );
    const { rows } = await admin.query(
      `WITH RECURSIVE walk(start_id, id, depth) AS (
         SELECT id, parent_id, 1 FROM department WHERE id = ANY($1::uuid[])
         UNION ALL
         SELECT w.start_id, x.parent_id, w.depth + 1
           FROM walk w JOIN department x ON x.id = w.id
          WHERE w.id IS NOT NULL AND w.depth < 30
       )
       SELECT count(*)::int AS n FROM walk WHERE id = start_id`,
      [[a, b, c, d]],
    );
    expect(rows[0].n, '循環が残っている').toBe(0);
    expect(result.waited).toBe(true);
    expect(result.secondFailed).toBe(true);
    expect(result.secondMessage).toContain('department_cycle');
  });

  it('**上長**: 逆向きの設定を同時に行うと、後続は待機して拒否され、循環が残らない', async () => {
    const x = await mkMember('x');
    const y = await mkMember('y');

    const result = await raceOpposite(
      {
        text: 'UPDATE org_member_profile SET manager_user_id = $1 WHERE organization_id = $3 AND user_id = $2',
        values: [y, x, orgId],
      },
      {
        text: 'UPDATE org_member_profile SET manager_user_id = $1 WHERE organization_id = $3 AND user_id = $2',
        values: [x, y, orgId],
      },
    );

    const { rows } = await admin.query(
      'SELECT user_id, manager_user_id FROM org_member_profile WHERE user_id = ANY($1::uuid[])',
      [[x, y]],
    );
    const managers = new Map(rows.map((r) => [r.user_id as string, r.manager_user_id as string]));
    expect(managers.get(x) === y && managers.get(y) === x, '循環が残っている').toBe(false);
    expect(result.waited, '後続が待機していない(ロックが効いていない)').toBe(true);
    expect(result.secondFailed, '後続が拒否されていない').toBe(true);
    expect(result.secondMessage).toContain('manager_cycle');
  });

  it('**上長**: 3人の輪を、別々の2本が同時に閉じようとしても残らない', async () => {
    const p = await mkMember('p');
    const q = await mkMember('q');
    const r = await mkMember('r');
    // p→q は確定済み。 先行: q→r。 後続: r→p。 合成すると p→q→r→p の輪になる。
    await admin.query(
      'UPDATE org_member_profile SET manager_user_id = $1 WHERE organization_id = $3 AND user_id = $2',
      [q, p, orgId],
    );

    const result = await raceOpposite(
      {
        text: 'UPDATE org_member_profile SET manager_user_id = $1 WHERE organization_id = $3 AND user_id = $2',
        values: [r, q, orgId],
      },
      {
        text: 'UPDATE org_member_profile SET manager_user_id = $1 WHERE organization_id = $3 AND user_id = $2',
        values: [p, r, orgId],
      },
    );

    const { rows } = await admin.query(
      `WITH RECURSIVE walk(start_id, id, depth) AS (
         SELECT user_id, manager_user_id, 1 FROM org_member_profile WHERE organization_id = $1
         UNION ALL
         SELECT w.start_id, m.manager_user_id, w.depth + 1
           FROM walk w JOIN org_member_profile m
             ON m.user_id = w.id AND m.organization_id = $1
          WHERE w.id IS NOT NULL AND w.depth < 30
       )
       SELECT count(*)::int AS n FROM walk WHERE id = start_id`,
      [orgId],
    );
    expect(rows[0].n, '循環が残っている').toBe(0);
    expect(result.waited).toBe(true);
    expect(result.secondFailed).toBe(true);
  });
});

describe('同時更新でも部署長は重ならない・使用中の部署を無効化できない', () => {
  it('**部署長**: 時間が重なる2名を同時に登録すると、後続は待機して拒否される(EXCLUDE)', async () => {
    const dept = await mkDepartment('h');
    const u1 = await mkMember('h1');
    const u2 = await mkMember('h2');
    const insert = (user: string) => ({
      text: `INSERT INTO department_head
               (id, department_id, organization_id, user_id, valid_from, valid_until, created_by)
             VALUES ($1, $2, $3, $4, '2031-01-01T00:00:00Z', NULL, $4)`,
      values: [randomUUID(), dept, orgId, user],
    });

    const result = await raceOpposite(insert(u1), insert(u2));
    expect(result.waited).toBe(true);
    expect(result.secondFailed).toBe(true);
    const { rows } = await admin.query(
      'SELECT count(*)::int AS n FROM department_head WHERE department_id = $1',
      [dept],
    );
    expect(rows[0].n).toBe(1);
  });

  it('**無効化**: 部署長を登録するトランザクションが未コミットの間に無効化しても、両立しない', async () => {
    const dept = await mkDepartment('inact');
    const u = await mkMember('inact-head');
    const c1 = await connectApp();
    const c2 = await connectApp();
    const pid2 = await backendPid(c2);
    await begin(c1);
    await begin(c2);
    // 先行: 現在有効な部署長を登録(未コミット)
    await c1.query(
      `INSERT INTO department_head
         (id, department_id, organization_id, user_id, valid_from, valid_until, created_by)
       VALUES ($1, $2, $3, $4, now() - interval '1 hour', NULL, $4)`,
      [randomUUID(), dept, orgId, u],
    );
    // 後続: 無効化。先行の未コミットの部署長を見られないと、無効化が通ってしまう。
    const second = c2.query('UPDATE department SET active = false WHERE id = $1', [dept]).then(
      () => ({ ok: true as const, message: '' }),
      (error: Error) => ({ ok: false as const, message: error.message }),
    );
    const waited = await waitUntilBlocked(pid2);
    await c1.query('COMMIT');
    const result = await second;
    await c2.query(result.ok ? 'COMMIT' : 'ROLLBACK');

    expect(waited, '後続が待機していない').toBe(true);
    expect(result.ok, '有効な部署長が残る部署が無効化された').toBe(false);
    expect(result.message).toContain('department_in_use');
    const { rows } = await admin.query('SELECT active FROM department WHERE id = $1', [dept]);
    expect(rows[0].active).toBe(true);
  });

  /**
   * 先行が無効化(未コミット)、後続が参照の追加。後続は待機し、無効化のコミット後に拒否される。
   * (逆順は上のテスト。どちらの順でも「無効な部署に参照が付いた状態」は残らない。)
   */
  async function raceDeactivateThen(
    insert: (dept: string, user: string) => { text: string; values: unknown[] },
  ) {
    const dept = await mkDepartment('rev');
    const user = await mkMember('rev-u');
    const c1 = await connectApp();
    const c2 = await connectApp();
    const pid2 = await backendPid(c2);
    await begin(c1);
    await begin(c2);
    await c1.query('UPDATE department SET active = false WHERE id = $1', [dept]);
    const stmt = insert(dept, user);
    const second = c2.query(stmt.text, stmt.values).then(
      () => ({ ok: true as const, message: '' }),
      (error: Error) => ({ ok: false as const, message: error.message }),
    );
    const waited = await waitUntilBlocked(pid2);
    await c1.query('COMMIT');
    const result = await second;
    await c2.query(result.ok ? 'COMMIT' : 'ROLLBACK');
    return { dept, user, waited, result };
  }

  it('**無効化が先**: 部署長の登録は待機して拒否される(無効な部署に部署長が付かない)', async () => {
    const { dept, waited, result } = await raceDeactivateThen((d, u) => ({
      text: `INSERT INTO department_head (id, department_id, organization_id, user_id, valid_from, created_by)
             VALUES ($1, $2, $3, $4, now() - interval '1 hour', $4)`,
      values: [randomUUID(), d, orgId, u],
    }));
    const { rows } = await admin.query(
      'SELECT count(*)::int AS n FROM department_head WHERE department_id = $1',
      [dept],
    );
    expect(rows[0].n, '無効な部署に部署長が付いた').toBe(0);
    expect(waited).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('department_inactive');
  });

  it('**無効化が先**: 主部署の設定は待機して拒否される', async () => {
    const { dept, user, waited, result } = await raceDeactivateThen((d, u) => ({
      text: 'UPDATE org_member_profile SET primary_department_id = $1 WHERE organization_id = $2 AND user_id = $3',
      values: [d, orgId, u],
    }));
    const { rows } = await admin.query(
      'SELECT count(*)::int AS n FROM org_member_profile WHERE primary_department_id = $1 AND user_id = $2',
      [dept, user],
    );
    expect(rows[0].n, '無効な部署が主部署になった').toBe(0);
    expect(waited).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('department_inactive');
  });

  it('**無効化が先**: 子部署の追加は待機して拒否される', async () => {
    const { dept, waited, result } = await raceDeactivateThen((d) => ({
      text: 'INSERT INTO department (id, organization_id, code, name, parent_id) VALUES ($1, $2, $3, $3, $4)',
      values: [randomUUID(), orgId, `child-${sfx}-${randomUUID().slice(0, 4)}`, d],
    }));
    const { rows } = await admin.query(
      'SELECT count(*)::int AS n FROM department WHERE parent_id = $1',
      [dept],
    );
    expect(rows[0].n, '無効な部署の下に子部署ができた').toBe(0);
    expect(waited).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('department_inactive');
  });

  it('**子部署の追加が先**: 親の無効化は待機して拒否される', async () => {
    const parent = await mkDepartment('par');
    const c1 = await connectApp();
    const c2 = await connectApp();
    const pid2 = await backendPid(c2);
    await begin(c1);
    await begin(c2);
    await c1.query(
      'INSERT INTO department (id, organization_id, code, name, parent_id) VALUES ($1, $2, $3, $3, $4)',
      [randomUUID(), orgId, `kid-${sfx}-${randomUUID().slice(0, 4)}`, parent],
    );
    const second = c2.query('UPDATE department SET active = false WHERE id = $1', [parent]).then(
      () => ({ ok: true as const, message: '' }),
      (error: Error) => ({ ok: false as const, message: error.message }),
    );
    const waited = await waitUntilBlocked(pid2);
    await c1.query('COMMIT');
    const result = await second;
    await c2.query(result.ok ? 'COMMIT' : 'ROLLBACK');
    expect(waited).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('department_in_use');
  });
});
