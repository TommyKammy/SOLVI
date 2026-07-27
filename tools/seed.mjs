#!/usr/bin/env node
/**
 * 開発・テスト用の合成データ投入。
 *
 * **実データ・実PIIを入れない**(AGENTS.md §4)。
 * 越境テストが成立するよう、必ず 2 つの Organization と各ロールのユーザを作る。
 * 冪等に実行できる(再実行しても増殖しない)。
 */
import pg from 'pg';

const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_ADMIN_URL または DATABASE_URL が未設定です。');
  process.exit(78);
}

/** 決定的なUUID(再実行で同じ値になるようにする) */
const id = (n) => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;

const ORGS = [
  { id: id(1), code: 'acme', name: 'サンプル株式会社' },
  { id: id(2), code: 'beta', name: 'ベータ商事株式会社' },
];

const ROLE_CODES = ['org_admin', 'agent', 'approver', 'auditor', 'requester'];

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  await client.query('BEGIN');

  for (const org of ORGS) {
    await client.query(
      `INSERT INTO organization (id, code, name) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [org.id, org.code, org.name],
    );
  }

  const { rows: roles } = await client.query('SELECT id, code, scope FROM role');
  const roleByCode = new Map(roles.map((r) => [r.code, r]));

  let seq = 100;
  const created = [];

  for (const org of ORGS) {
    for (const code of ROLE_CODES) {
      const role = roleByCode.get(code);
      const userId = id(++seq);
      const email = `${code}@${org.code}.example.test`;

      await client.query(
        `INSERT INTO app_user (id, primary_email, display_name, status, created_via)
         VALUES ($1, $2, $3, 'active', 'seed')
         ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`,
        [userId, email, `${org.name} ${code}`],
      );

      await client.query(
        `INSERT INTO identity (id, user_id, idp_type, issuer, subject)
         VALUES ($1, $2, 'okta', $3, $4)
         ON CONFLICT (issuer, subject) DO NOTHING`,
        [id(seq + 1000), userId, 'https://example.okta.test', `seed|${org.code}|${code}`],
      );

      await client.query(
        `INSERT INTO role_binding (id, user_id, role_id, role_scope, organization_id, source)
         VALUES ($1, $2, $3, $4, $5, 'seed')
         ON CONFLICT DO NOTHING`,
        [id(seq + 2000), userId, role.id, role.scope, org.id],
      );

      created.push({ org: org.code, role: code, userId, email });
    }
  }

  // 兼務の例(FR-IDM-006): acme の agent が beta の requester も兼ねる
  const dualUser = created.find((c) => c.org === 'acme' && c.role === 'agent');
  const requesterRole = roleByCode.get('requester');
  await client.query(
    `INSERT INTO role_binding (id, user_id, role_id, role_scope, organization_id, source, valid_until)
     VALUES ($1, $2, $3, $4, $5, 'manual', now() + interval '90 days')
     ON CONFLICT DO NOTHING`,
    [id(9001), dualUser.userId, requesterRole.id, requesterRole.scope, ORGS[1].id],
  );

  // platform_admin は手動付与のみ(IdPグループ経由は DB 制約で禁止 / 脅威 T-07)
  const platformAdminRole = roleByCode.get('platform_admin');
  const platformUserId = id(9500);
  await client.query(
    `INSERT INTO app_user (id, primary_email, display_name, status, created_via)
     VALUES ($1, $2, $3, 'active', 'seed') ON CONFLICT (id) DO NOTHING`,
    [platformUserId, 'platform-admin@solvi.example.test', 'プラットフォーム管理者(seed)'],
  );
  await client.query(
    `INSERT INTO role_binding (id, user_id, role_id, role_scope, organization_id, source)
     VALUES ($1, $2, $3, 'platform', NULL, 'manual') ON CONFLICT DO NOTHING`,
    [id(9502), platformUserId, platformAdminRole.id],
  );

  // 無効化済みユーザ(退職者)の例。履歴が残ることを確認するために置く。
  const leaverId = id(9600);
  await client.query(
    `INSERT INTO app_user (id, primary_email, display_name, status, created_via, deactivated_at)
     VALUES ($1, $2, $3, 'deactivated', 'seed', now())
     ON CONFLICT (id) DO UPDATE SET status = 'deactivated', deactivated_at = EXCLUDED.deactivated_at`,
    [leaverId, 'leaver@acme.example.test', 'サンプル株式会社 退職者'],
  );
  await client.query(
    `INSERT INTO role_binding (id, user_id, role_id, role_scope, organization_id, source)
     VALUES ($1, $2, $3, $4, $5, 'seed') ON CONFLICT DO NOTHING`,
    [id(9602), leaverId, roleByCode.get('requester').id, 'org', ORGS[0].id],
  );

  await client.query('COMMIT');

  console.log(`seed 完了: organization ${ORGS.length} 件 / user ${created.length + 2} 件`);
  console.log('  組織:');
  for (const o of ORGS) console.log(`    ${o.code} (${o.id})`);
  console.log('  ※ すべて合成データ。実在の人物・組織とは無関係。');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
