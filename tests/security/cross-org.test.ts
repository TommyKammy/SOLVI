/**
 * Organization境界の越境テスト(TL-06 / NFR-SEC-001 / Gate 1 G1-2)。
 *
 * 検査対象は「アプリのコードが正しく絞り込むか」ではなく、
 * **アプリがバグっていてもDBが越境を止めるか** である。
 * そのため、ここではアプリロールで直接SQLを発行する。
 *
 * 実行: DATABASE_URL=... vitest run tests/security
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const ORG_A = '00000000-0000-4000-9000-000000000001'; // acme
const ORG_B = '00000000-0000-4000-9000-000000000002'; // beta

/** organization_id で分離されるテーブル */
const ORG_SCOPED_TABLES = ['role_binding', 'idp_group_mapping'] as const;
/** role_binding 経由で分離されるテーブル */
const MEMBERSHIP_SCOPED_TABLES = ['app_user', 'identity'] as const;

let pool: pg.Pool;

/** アプリロールで、指定した組織コンテキストのトランザクションを実行する */
async function asOrg<T>(
  organizationId: string | null,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_org', organizationId ?? '']);
    const result = await fn(client);
    await client.query('ROLLBACK'); // テストは状態を残さない
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(() => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL(アプリロール)が必要です');
  if (url.includes('solvi_owner')) {
    throw new Error(
      'DATABASE_URL に owner ロールが指定されています。' +
        'owner は RLS を素通りするため、このテストの意味がなくなります。',
    );
  }
  pool = new pg.Pool({ connectionString: url, max: 5 });
});

afterAll(async () => {
  await pool?.end();
});

describe('組織コンテキスト未設定 (fail closed)', () => {
  it.each([...ORG_SCOPED_TABLES, ...MEMBERSHIP_SCOPED_TABLES, 'organization'])(
    '%s が 0 行を返す',
    async (table) => {
      const rows = await asOrg(null, async (c) => {
        const { rows } = await c.query(`SELECT count(*)::int AS n FROM ${table}`);
        return rows[0].n;
      });
      expect(rows).toBe(0);
    },
  );
});

describe('組織コンテキストありの可視範囲', () => {
  it('自組織のみが見える(organization)', async () => {
    const ids = await asOrg(ORG_A, async (c) => {
      const { rows } = await c.query('SELECT id FROM organization');
      return rows.map((r) => r.id);
    });
    expect(ids).toEqual([ORG_A]);
  });

  it.each(ORG_SCOPED_TABLES)('%s に他組織の行が混ざらない', async (table) => {
    const otherOrgRows = await asOrg(ORG_A, async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE organization_id <> $1`,
        [ORG_A],
      );
      return rows[0].n;
    });
    expect(otherOrgRows).toBe(0);
  });

  it('他組織のユーザが app_user から見えない', async () => {
    // ORG_B のユーザ数を ORG_B 文脈で数え、ORG_A 文脈では見えないことを確認する
    const inB = await asOrg(ORG_B, async (c) => {
      const { rows } = await c.query('SELECT id FROM app_user');
      return rows.map((r) => r.id);
    });
    expect(inB.length).toBeGreaterThan(0);

    const visibleFromA = await asOrg(ORG_A, async (c) => {
      const { rows } = await c.query('SELECT id FROM app_user WHERE id = ANY($1)', [inB]);
      return rows.map((r) => r.id);
    });
    // 兼務ユーザ(acmeのagentがbetaのrequesterを兼ねる)は両方から見えてよい
    const exclusiveToB = inB.filter((uid) => !visibleFromA.includes(uid));
    expect(exclusiveToB.length).toBeGreaterThan(0);
    expect(visibleFromA.length).toBeLessThan(inB.length);
  });

  it('他組織のidentityが直接ID指定でも取得できない(IDOR / 脅威 T-02)', async () => {
    const identityIds = await asOrg(ORG_B, async (c) => {
      const { rows } = await c.query('SELECT id FROM identity LIMIT 5');
      return rows.map((r) => r.id);
    });
    expect(identityIds.length).toBeGreaterThan(0);

    const leaked = await asOrg(ORG_A, async (c) => {
      const { rows } = await c.query('SELECT count(*)::int AS n FROM identity WHERE id = ANY($1)', [
        identityIds,
      ]);
      return rows[0].n;
    });
    // 兼務ユーザのidentityは両組織から見えるため、全件が漏れていないことを確認する
    expect(leaked).toBeLessThan(identityIds.length);
  });
});

describe('書き込みの越境', () => {
  it('他組織のorganization_idを持つrole_bindingをINSERTできない', async () => {
    await expect(
      asOrg(ORG_A, async (c) => {
        const { rows: users } = await c.query('SELECT id FROM app_user LIMIT 1');
        const { rows: roles } = await c.query("SELECT id, scope FROM role WHERE code = 'requester'");
        return c.query(
          `INSERT INTO role_binding (id, user_id, role_id, role_scope, organization_id, source)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, 'manual')`,
          [users[0].id, roles[0].id, roles[0].scope, ORG_B],
        );
      }),
    ).rejects.toThrow(/row-level security|policy/i);
  });

  it('他組織のrole_bindingをUPDATEできない(0行更新)', async () => {
    const updated = await asOrg(ORG_A, async (c) => {
      const { rowCount } = await c.query(
        'UPDATE role_binding SET source = $1 WHERE organization_id = $2',
        ['manual', ORG_B],
      );
      return rowCount;
    });
    expect(updated).toBe(0);
  });
});

describe('権限昇格の遮断 (脅威 T-07)', () => {
  // 二層で防いでいる。層ごとに独立して検証する。
  // 層1(RLS): アプリロールは platform binding(organization_id IS NULL)を書き込めない
  // 層2(CHECK制約): RLS を通過できる経路でも source='idp_group' は拒否される

  it('層1: アプリロールはplatform role_bindingを書き込めない(RLS)', async () => {
    await expect(
      asOrg(ORG_A, async (c) => {
        const { rows: users } = await c.query('SELECT id FROM app_user LIMIT 1');
        const { rows: roles } = await c.query(
          "SELECT id, scope FROM role WHERE code = 'platform_admin'",
        );
        return c.query(
          `INSERT INTO role_binding (id, user_id, role_id, role_scope, organization_id, source)
           VALUES (gen_random_uuid(), $1, $2, $3, NULL, 'manual')`,
          [users[0].id, roles[0].id, roles[0].scope],
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('層2: RLSを迂回できる接続でもIdPグループ由来のplatform付与は拒否される(CHECK制約)', async () => {
    // 管理接続(RLSを素通りする)で CHECK 制約そのものを検証する。
    // アプリのバグやSQL直接実行でRLSを回避されても、この制約が残る。
    const adminUrl = process.env.DATABASE_ADMIN_URL;
    if (!adminUrl) throw new Error('DATABASE_ADMIN_URL が必要です');
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query('BEGIN');
      const { rows: users } = await admin.query('SELECT id FROM app_user LIMIT 1');
      const { rows: roles } = await admin.query(
        "SELECT id, scope FROM role WHERE code = 'platform_admin'",
      );
      await expect(
        admin.query(
          `INSERT INTO role_binding (id, user_id, role_id, role_scope, organization_id, source)
           VALUES (gen_random_uuid(), $1, $2, $3, NULL, 'idp_group')`,
          [users[0].id, roles[0].id, roles[0].scope],
        ),
      ).rejects.toThrow(/role_binding_platform_manual_only/);
      await admin.query('ROLLBACK');
    } finally {
      await admin.end();
    }
  });

  it('platformロールをidp_group_mappingへ登録できない', async () => {
    await expect(
      asOrg(ORG_A, async (c) => {
        const { rows: roles } = await c.query(
          "SELECT id, scope FROM role WHERE code = 'platform_admin'",
        );
        return c.query(
          `INSERT INTO idp_group_mapping
             (id, organization_id, idp_type, group_external_id, role_id, role_scope)
           VALUES (gen_random_uuid(), $1, 'okta', 'ITSM-Admins', $2, $3)`,
          [ORG_A, roles[0].id, roles[0].scope],
        );
      }),
    ).rejects.toThrow(/idp_group_mapping_org_scope_only/);
  });

  it('role_scopeを偽ってorgロールとして登録することもできない', async () => {
    await expect(
      asOrg(ORG_A, async (c) => {
        const { rows: roles } = await c.query("SELECT id FROM role WHERE code = 'platform_admin'");
        // scope を 'org' と偽る → 複合外部キーが role(id, scope) と一致せず失敗する
        return c.query(
          `INSERT INTO idp_group_mapping
             (id, organization_id, idp_type, group_external_id, role_id, role_scope)
           VALUES (gen_random_uuid(), $1, 'okta', 'ITSM-Admins', $2, 'org')`,
          [ORG_A, roles[0].id],
        );
      }),
    ).rejects.toThrow(/idp_group_mapping_role_fk|foreign key/i);
  });
});

describe('DBロールの属性', () => {
  it('アプリロールがBYPASSRLSを持たない', async () => {
    const client = await pool.connect();
    try {
      const { rows } = await client.query(
        'SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user',
      );
      expect(rows[0].rolbypassrls).toBe(false);
      expect(rows[0].rolsuper).toBe(false);
    } finally {
      client.release();
    }
  });

  it('アプリロールが業務テーブルの所有者ではない', async () => {
    const client = await pool.connect();
    try {
      const { rows } = await client.query(`
        SELECT count(*)::int AS n
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r'
           AND pg_get_userbyid(c.relowner) = current_user
      `);
      expect(rows[0].n).toBe(0);
    } finally {
      client.release();
    }
  });
});
