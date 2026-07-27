#!/usr/bin/env node
/**
 * 一覧の応答時間計測(NFR-PERF-001 / TL-15)。
 * 1万件の合成データに対する p95 を測る。
 *
 * 使い方: node tools/bench_ticket_list.mjs [件数]
 * 注意: テスト用DBに大量データを投入する。実行後に片付けること。
 */
import pg from 'pg';

const TARGET = Number(process.argv[2] ?? 10_000);
const ORG = '00000000-0000-4000-9000-000000000001';
const ITERATIONS = 50;

const admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
await admin.connect();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

const { rows: u } = await admin.query(
  `SELECT u.id FROM role_binding rb JOIN role r ON r.id = rb.role_id
     JOIN app_user u ON u.id = rb.user_id
    WHERE rb.organization_id = $1 AND r.code = 'agent' AND rb.source = 'seed' LIMIT 1`,
  [ORG],
);
const agent = u[0].id;

const { rows: before } = await admin.query(
  'SELECT count(*)::int n FROM ticket WHERE organization_id=$1',
  [ORG],
);
const toCreate = Math.max(0, TARGET - before[0].n);
if (toCreate > 0) {
  console.log(`合成データを ${toCreate} 件投入します...`);
  // generate_series で一括投入。created_at をばらけさせ、索引の効きを現実に近づける。
  await admin.query(
    // state='resolved' には resolved_at が必要(ticket_resolved_at_consistency)。
    // 制約が合成データの不備を捕捉したため、生成側を状態に合わせる。
    `INSERT INTO ticket (id, organization_id, number, kind, state, subject, body,
                         requester_id, impact, urgency, priority, created_at, resolved_at)
     SELECT gen_random_uuid(), $1,
            'INC-2026-' || lpad((900000 + g)::text, 6, '0'),
            CASE WHEN g % 3 = 0 THEN 'request' ELSE 'incident' END,
            (ARRAY['new','assigned','in_progress','pending','resolved'])[1 + g % 5],
            'ベンチマーク用チケット ' || g,
            '本文 ' || g,
            $2,
            (ARRAY['low','medium','high'])[1 + g % 3],
            (ARRAY['low','medium','high'])[1 + g % 3],
            (ARRAY['low','medium','high','critical'])[1 + g % 4],
            now() - (g || ' minutes')::interval,
            CASE WHEN g % 5 = 4 THEN now() - (g || ' minutes')::interval + interval '1 hour' END
       FROM generate_series(1, $3) g`,
    [ORG, agent, toCreate],
  );
  await admin.query('ANALYZE ticket');
}

const { rows: total } = await admin.query(
  'SELECT count(*)::int n FROM ticket WHERE organization_id=$1',
  [ORG],
);
console.log(`対象件数: ${total[0].n}`);

async function measure(label, sql, params) {
  const durations = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.current_org', $1, true)", [ORG]);
      const start = process.hrtime.bigint();
      await c.query(sql, params);
      durations.push(Number(process.hrtime.bigint() - start) / 1e6);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  }
  durations.sort((a, b) => a - b);
  const p = (q) => durations[Math.min(durations.length - 1, Math.floor(durations.length * q))];
  console.log(
    `${label.padEnd(28)} p50=${p(0.5).toFixed(1)}ms  p95=${p(0.95).toFixed(1)}ms  max=${durations.at(-1).toFixed(1)}ms`,
  );
  return p(0.95);
}

const results = [];
results.push(
  await measure(
    '一覧(50件、担当者視点)',
    `SELECT t.*, t.created_at::text AS cursor_created_at FROM ticket t
    WHERE t.organization_id = $1 ORDER BY t.created_at DESC, t.id DESC LIMIT 50`,
    [ORG],
  ),
);
results.push(
  await measure(
    '件数(担当者視点)',
    'SELECT count(*)::int AS total FROM ticket t WHERE t.organization_id = $1',
    [ORG],
  ),
);
results.push(
  await measure(
    '状態フィルタ + 一覧',
    `SELECT t.* FROM ticket t WHERE t.organization_id = $1 AND t.state = ANY($2::text[])
    ORDER BY t.created_at DESC, t.id DESC LIMIT 50`,
    [ORG, ['new', 'assigned']],
  ),
);
results.push(
  await measure(
    '件名の部分一致',
    `SELECT t.* FROM ticket t WHERE t.organization_id = $1 AND t.subject ILIKE $2
    ORDER BY t.created_at DESC, t.id DESC LIMIT 50`,
    [ORG, '%ベンチマーク%'],
  ),
);
results.push(
  await measure(
    '依頼者視点(自分の分)',
    `SELECT t.* FROM ticket t WHERE t.organization_id = $1 AND t.requester_id = $2
    ORDER BY t.created_at DESC, t.id DESC LIMIT 50`,
    [ORG, agent],
  ),
);

const worst = Math.max(...results);
const THRESHOLD_MS = 1500; // NFR-PERF-001
console.log(`\n最も遅いクエリの p95: ${worst.toFixed(1)}ms / 目標 ${THRESHOLD_MS}ms`);

await pool.end();
await admin.end();
process.exit(worst <= THRESHOLD_MS ? 0 : 1);
