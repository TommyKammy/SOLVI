#!/usr/bin/env node
/**
 * 開発・テスト用の合成データ投入。
 *
 * **実データ・実PIIを入れない**(AGENTS.md §4)。
 * 越境テストが成立するよう、必ず 2 つの Organization と各ロールのユーザを作る。
 * 冪等に実行できる(再実行しても増殖しない)。
 */
import pg from 'pg';
import { hashPassword } from '../packages/shared/src/auth/password.js';

/**
 * 開発用の共通パスワード。
 *
 * **合成データ専用である。** `AUTH_LOCAL_ENABLED` は本番で有効にできない
 * (env.ts の superRefine で拒否する)ため、この値が本番へ届く経路は無い。
 * それでも seed.mjs 自体を本番で実行しないこと。
 */
const DEV_PASSWORD = 'local-dev-password-1';

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

      // ローカル認証の資格情報 (ADR-0019)。
      //
      // **これが無いと誰もログインできない。** 以前は別のツール
      // (`create_local_user.mjs`)を手で叩く前提だったが、その手順は
      // 立ち上げ手順のどこにも書かれておらず、テストが
      // `local_credential` を消したあとは seed を再実行しても戻らなかった。
      // 画面は正常に出るのに全員が 401 になり、原因は認証の不具合に見える。
      await client.query(
        `INSERT INTO identity (id, user_id, idp_type, issuer, subject)
         VALUES ($1, $2, 'local', 'urn:solvi:local', $3)
         ON CONFLICT (issuer, subject) DO NOTHING`,
        [id(seq + 3000), userId, email],
      );
      await client.query(
        `INSERT INTO local_credential (id, user_id, password_hash)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE
            SET password_hash = EXCLUDED.password_hash,
                failed_attempts = 0,
                locked_until = NULL`,
        [id(seq + 4000), userId, await hashPassword(DEV_PASSWORD)],
      );

      created.push({ org: org.code, role: code, userId, email });
    }
  }

  // 兼務の例(FR-IDM-006): acme の agent が beta の requester も兼ねる。
  //
  // `source` は 'seed' にする。合成データであって手動付与ではない。
  // 以前は 'manual' としていたため、テストの片付け
  // (`DELETE FROM role_binding WHERE source = 'manual'`)で消えていた。
  // 消えると兼務者が居なくなり、**組織選択の経路が誰も通らないまま緑になる。**
  const dualUser = created.find((c) => c.org === 'acme' && c.role === 'agent');
  const requesterRole = roleByCode.get('requester');
  await client.query(
    `INSERT INTO role_binding (id, user_id, role_id, role_scope, organization_id, source, valid_until)
     VALUES ($1, $2, $3, $4, $5, 'seed', now() + interval '90 days')
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
     VALUES ($1, $2, $3, 'platform', NULL, 'seed') ON CONFLICT DO NOTHING`,
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

  // ---------------------------------------------------------------------------
  // SLAの目標値
  //
  // **これが無いとSLAの判定基準が存在しない。** テーブルはマイグレーションが
  // 作るが中身は入らないため、新規構築した環境では目標値が空になる。
  // 画面もAPIも動くが、期限が「無い」状態になる — 動いているように見えて
  // 機能していない、という形になる。
  //
  // 暦時間(24時間)での目標値。営業時間・祝日の考慮は Gate A 後に判断する。
  //
  // > [!warning] **これは開発用の既定値であり、業務側の合意を経ていない。**
  // > パイロット開始前に、実際の運用体制で守れる値かを確認する必要がある。
  // > 守れない目標は「常に超過している」状態を作り、SLAそのものが見られなくなる。
  // ---------------------------------------------------------------------------
  const SLA_TARGETS = [
    // priority, 初回応答(分), 解決(分)
    ['critical', 30, 4 * 60], //  30分 /  4時間
    ['high', 60, 24 * 60], //  1時間 / 24時間
    ['medium', 4 * 60, 3 * 24 * 60], //  4時間 /  3日
    ['low', 8 * 60, 7 * 24 * 60], //  8時間 /  7日
  ];

  let slaSeq = 9700;
  for (const org of ORGS) {
    for (const [priority, response, resolution] of SLA_TARGETS) {
      await client.query(
        `INSERT INTO sla_policy
           (id, organization_id, priority, response_target_minutes, resolution_target_minutes)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (organization_id, priority) DO UPDATE
            SET response_target_minutes = EXCLUDED.response_target_minutes,
                resolution_target_minutes = EXCLUDED.resolution_target_minutes`,
        [id(slaSeq++), org.id, priority, response, resolution],
      );
    }
  }

  await client.query('COMMIT');

  console.log(
    `seed 完了: organization ${ORGS.length} 件 / user ${created.length + 2} 件 / ` +
      `SLA目標 ${ORGS.length * SLA_TARGETS.length} 件`,
  );
  console.log('  組織:');
  for (const o of ORGS) console.log(`    ${o.code} (${o.id})`);
  console.log(`  ログイン: <role>@<org>.example.test / ${DEV_PASSWORD}`);
  console.log('  ※ すべて合成データ。実在の人物・組織とは無関係。');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
