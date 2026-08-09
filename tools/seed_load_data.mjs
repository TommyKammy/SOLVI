#!/usr/bin/env node
/**
 * 負荷測定用のチケット生成 (NFR-PERF-001 / WP-P2-PERF-020)
 *
 * **2件で測った p95 に意味は無い。** 一覧の応答は件数に依存する。
 *
 * とくに [[WP-P2-SLAUI-016]] は「SLAの判定を保存せず、読むたびに計算する」
 * と決め、こう書いた。
 *
 * > **件数が増えたときの索引が無い。** 計算列なので既存の索引が効かない。
 * > パイロット規模では問題にならないが、増えたときは…
 *
 * **その仮定を確かめたことが無い。** 測るためのデータを作る。
 *
 * 使い方:
 *   node tools/seed_load_data.mjs --count 5000     生成
 *   node tools/seed_load_data.mjs --clean          片付け
 *
 * 生成したチケットは件名で見分ける(`[loadtest]` 接頭辞)。
 * **片付けられる形にしておく** — 測定のためのデータを本番相当の場所へ
 * 置きっぱなしにしない。
 */
import pg from 'pg';

const MARKER = '[loadtest]';
const ORG = '00000000-0000-4000-9000-000000000001';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};
const clean = process.argv.includes('--clean');
const count = arg('count', 5000);

const url = process.env.DATABASE_ADMIN_URL;
if (!url) {
  process.stderr.write('DATABASE_ADMIN_URL が必要です\n');
  process.exit(78);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  if (clean) {
    const { rowCount } = await client.query('DELETE FROM ticket WHERE subject LIKE $1', [
      `${MARKER}%`,
    ]);
    process.stdout.write(`片付け: ${rowCount} 件を削除しました\n`);
  } else {
    // 既に何件あるかを見て、番号の開始位置をずらす。
    const { rows: existing } = await client.query(
      'SELECT count(*)::int AS n FROM ticket WHERE subject LIKE $1',
      [`${MARKER}%`],
    );
    const offset = existing[0].n;

    const { rows: users } = await client.query(
      `SELECT u.id FROM app_user u
        JOIN role_binding rb ON rb.user_id = u.id AND rb.organization_id = $1
       WHERE u.created_via = 'seed' LIMIT 3`,
      [ORG],
    );
    if (users.length === 0) throw new Error('シードの利用者が居ません');

    // **1文でまとめて入れる。** 5000回の往復は測定前の待ち時間になるだけ。
    // 状態と優先度をばらけさせる — 一様なデータでは絞り込みの負荷が測れない。
    await client.query(
      `INSERT INTO ticket
         (id, organization_id, number, kind, state, subject, body,
          requester_id, assignee_id, impact, urgency, priority,
          sla_clock_started_at, sla_elapsed_seconds, created_at, resolved_at)
       SELECT
         gen_random_uuid(),
         $1::uuid,
         -- **既にある番号と衝突させない。** 追加で生成するとき、
         -- 1から振り直すと ticket_number_key で落ちる(実際に落ちた)。
         'LOAD-' || lpad((g + $6)::text, 7, '0'),
         (ARRAY['incident','request'])[1 + (g % 2)],
         -- 解決済みは resolved_at を伴わなければならない
         -- (ticket_resolved_at_consistency)。制約に合う形で作る --
         -- 合成データだからといって、実在しえない状態を入れない。
         -- (SQL文はテンプレートリテラルの中にある。**バッククォートを書かない**)
         (ARRAY['new','assigned','in_progress','resolved'])[1 + (g % 4)],
         $2 || ' 負荷測定用 ' || g,
         '負荷測定のために生成した合成データです。',
         $3::uuid,
         CASE WHEN g % 3 = 0 THEN NULL ELSE $4::uuid END,
         (ARRAY['low','medium','high'])[1 + (g % 3)],
         (ARRAY['low','medium','high'])[1 + ((g + 1) % 3)],
         (ARRAY['low','medium','high','critical'])[1 + (g % 4)],
         now() - (g % 500) * interval '1 hour',
         (g % 7200),
         now() - (g % 700) * interval '1 hour',
         CASE WHEN g % 4 = 3 THEN now() - (g % 300) * interval '1 hour' ELSE NULL END
       FROM generate_series(1, $5) AS g`,
      [ORG, MARKER, users[0].id, users[users.length - 1].id, count, offset],
    );

    const { rows } = await client.query('SELECT count(*)::int AS n FROM ticket');
    process.stdout.write(`生成: ${count} 件を追加しました(総数 ${rows[0].n} 件)\n`);
  }
} finally {
  await client.end();
}
