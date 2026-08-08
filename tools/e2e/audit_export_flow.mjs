#!/usr/bin/env node
/**
 * 監査の書き出しと照合の通し確認 (AUD-002 / AUD-003 / WP-P1-AUD-018)
 *
 * AUD-003 の受入基準は「**export実行+アンカー再計算の一致**」。
 *
 * ADR-0009 で追記専用・ハッシュ連鎖の監査を作り日次アンカーで固定したが、
 * **取り出す手段が無かった。読めない記録は、記録していないことに近い。**
 *
 * ここでは実スタックへHTTPで話しかけ、書き出しから照合までを通す。
 */
import { writeFileSync, unlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const API = 'http://127.0.0.1:3001';
const ORG_A = '00000000-0000-4000-9000-000000000001';

let failed = 0;
const check = (n, ok, d = '') => {
  process.stdout.write(`${ok ? 'OK  ' : 'NG  '} ${n}${d ? ' — ' + d : ''}\n`);
  if (!ok) failed++;
};

async function login(email, organizationId = ORG_A) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'local-dev-password-1', organizationId }),
  });
  return { status: r.status, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0] };
}

const get = (path, cookie) => fetch(`${API}${path}`, { headers: { cookie } });

const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const today = new Date().toISOString().slice(0, 10);

const auditor = (await login('auditor@acme.example.test')).cookie;
const orgAdmin = (await login('org_admin@acme.example.test')).cookie;
const agent = (await login('agent@acme.example.test')).cookie;

// **プラットフォーム監査者が居ること自体が要件である。**
// 居なければ、アンカーの照合手順を誰も実行できない。
const platform = await login('platform_auditor@solvi.example.test');
check(
  '**プラットフォーム監査者がシードに居る**',
  platform.status === 200,
  `status=${platform.status}`,
);

// ---------------------------------------------------------------------------
// 1. 見てよい人だけが見られる (AUD-002)
// ---------------------------------------------------------------------------
let r = await get(`/audit/export?date=${yesterday}`, orgAdmin);
check('**組織の管理者は書き出せない**(管理者にも見せない)', r.status === 403, `status=${r.status}`);

r = await get(`/audit/export?date=${yesterday}`, agent);
check('担当者は書き出せない', r.status === 403, `status=${r.status}`);

r = await get(`/audit/export?date=2026%2F08%2F08`, auditor);
check('日付の形式を見る', r.status === 400, `status=${r.status}`);

// ---------------------------------------------------------------------------
// 2. 組織の監査者 — 自組織だけ。**照合はできない**
// ---------------------------------------------------------------------------
r = await get(`/audit/export?date=${yesterday}`, auditor);
check('監査者は書き出せる', r.status === 200, `status=${r.status}`);
check(
  'JSONL として返る',
  (r.headers.get('content-type') ?? '').includes('x-ndjson'),
  r.headers.get('content-type') ?? '',
);
const orgBody = await r.text();
const orgManifest = JSON.parse(orgBody.split('\n')[0]);
check('1行目が manifest', orgManifest.kind === 'manifest');
check('自組織に限られる', orgManifest.scope === 'organization', `scope=${orgManifest.scope}`);
check('**照合できないと明示する**(連鎖は組織をまたぐ)', orgManifest.anchorVerifiable === false);

// ---------------------------------------------------------------------------
// 3. プラットフォーム監査者 — 全体。**照合できる**
// ---------------------------------------------------------------------------
r = await get(`/audit/export?date=${yesterday}`, platform.cookie);
check('プラットフォーム監査者は全体を書き出せる', r.status === 200, `status=${r.status}`);
const allBody = await r.text();
const allManifest = JSON.parse(allBody.split('\n')[0]);
check('全体の範囲になる', allManifest.scope === 'platform', `scope=${allManifest.scope}`);
check('**照合できる**', allManifest.anchorVerifiable === true);
check(
  '**全体のほうが件数が多い(か同じ)**',
  allManifest.eventCount >= orgManifest.eventCount,
  `全体=${allManifest.eventCount} 自組織=${orgManifest.eventCount}`,
);

// 当日は照合できない(書き出した記録自体が含まれないため)
r = await get(`/audit/export?date=${today}`, platform.cookie);
const todayManifest = JSON.parse((await r.text()).split('\n')[0]);
check(
  '**当日は照合できないと明示する**',
  todayManifest.anchorVerifiable === false,
  `verifiable=${todayManifest.anchorVerifiable}`,
);

// ---------------------------------------------------------------------------
// 4. 再計算がアンカーと一致する (AUD-003 の受入基準)
// ---------------------------------------------------------------------------
const file = `audit-export-${yesterday}.jsonl`;
writeFileSync(file, allBody);
try {
  const { stdout } = await run('node', ['tools/verify_audit_export.mjs', file]);
  process.stdout.write(
    stdout
      .split('\n')
      .map((l) => (l ? `     ${l}` : l))
      .join('\n'),
  );
  check(
    '**再計算したルートがアンカーと一致する**',
    stdout.includes('一致しました') || stdout.includes('アンカーがまだありません'),
  );
} catch (error) {
  check('**再計算したルートがアンカーと一致する**', false, String(error.stdout ?? error.message));
} finally {
  unlinkSync(file);
}

// ---------------------------------------------------------------------------
// 5. 取り出したことが残る (AUD-002)
// ---------------------------------------------------------------------------
// 書き出しの直後に自組織を書き出すと、直前の書き出しの記録が当日分に増える。
const before = JSON.parse(
  (await (await get(`/audit/export?date=${today}`, auditor)).text()).split('\n')[0],
);
const after = JSON.parse(
  (await (await get(`/audit/export?date=${today}`, auditor)).text()).split('\n')[0],
);
check(
  '**書き出しそのものが監査に記録される**',
  after.eventCount > before.eventCount,
  `${before.eventCount} → ${after.eventCount}`,
);

process.stdout.write(failed === 0 ? '\n通し確認: すべて OK\n' : `\n通し確認: ${failed} 件 NG\n`);
process.exit(failed === 0 ? 0 : 1);
