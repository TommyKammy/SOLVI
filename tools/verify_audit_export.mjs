#!/usr/bin/env node
/**
 * 書き出した監査とアンカーの照合 (AUD-003 / WP-P1-AUD-018)
 *
 * AUD-003 の受入基準は「**export実行+アンカー再計算の一致**」。
 *
 * 追記専用にしても、**取り出して確かめられなければ意味が無い。**
 * この道具は書き出した JSONL だけを入力に連鎖を組み直し、
 * 保存されているアンカーと突き合わせる。
 *
 * 使い方:
 *   node tools/verify_audit_export.mjs <export.jsonl>
 *
 * ## 何を証明し、何を証明しないか
 *
 * 証明する: **書き出しに載っている出来事の集合と順序**が、
 * アンカーを取った時点のものと同じであること。
 * 1件でも消えていれば、足されていれば、順序が入れ替わっていれば合わない。
 *
 * 証明しない: 正準形の作り方そのものの正しさ。
 * `canonical` は書き出し側が作っている。**独立に検証するには
 * 正準形の仕様(ADR-0009)から組み直す必要がある。**
 * ここでは連鎖の一致だけを見る。
 *
 * アンカーの実体は外部(S3 Object Lock)へ書き出す前提であり
 * (ADR-0009)、その外部の値と照合して初めて改ざん検知になる。
 * **DB の中だけで完結する照合は、DB を書ける者には破れる。**
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import pg from 'pg';

const path = process.argv[2];
if (!path) {
  process.stderr.write('使い方: node tools/verify_audit_export.mjs <export.jsonl>\n');
  process.exit(2);
}

let failed = 0;
const check = (name, ok, detail = '') => {
  process.stdout.write(`${ok ? 'OK  ' : 'NG  '} ${name}${detail ? ' — ' + detail : ''}\n`);
  if (!ok) failed++;
};

const lines = readFileSync(path, 'utf8')
  .split('\n')
  .filter((l) => l.trim().length > 0);
const manifest = JSON.parse(lines[0]);
const events = lines.slice(1).map((l) => JSON.parse(l));

check('1行目が manifest', manifest.kind === 'manifest', `kind=${manifest.kind}`);
check(
  '件数が manifest と一致する',
  events.length === manifest.eventCount,
  `manifest=${manifest.eventCount} 実際=${events.length}`,
);

if (!manifest.anchorVerifiable) {
  // **できないことを、できるふりで隠さない。**
  process.stdout.write(
    `\n照合できません: scope=${manifest.scope}${manifest.truncated ? ' (打ち切りあり)' : ''}\n` +
      '連鎖は組織をまたいで1本のため、組織で絞った書き出しからは\n' +
      '日次ルートを再計算できません。platform_auditor の全体書き出しを使ってください。\n',
  );
  process.exit(failed === 0 ? 0 : 1);
}

// 連鎖を組み直す。h_0 = sha256(""), h_n = sha256(h_{n-1} || canonical(event_n))
let chain = createHash('sha256').update('').digest('hex');
for (const event of events) {
  chain = createHash('sha256').update(chain).update(event.canonical).digest('hex');
}

// **順序が event_id 昇順であることを確かめる。** 連鎖は順序に依存する。
const sorted = [...events].map((e) => e.eventId).sort();
check(
  '書き出しが event_id 昇順である',
  events.every((e, i) => e.eventId === sorted[i]),
);

const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!url) {
  process.stderr.write('DATABASE_ADMIN_URL または DATABASE_URL が未設定です\n');
  process.exit(78);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const { rows } = await client.query(
    'SELECT event_count, root_hash FROM audit_anchor WHERE anchor_date = $1',
    [manifest.date],
  );

  if (rows.length === 0) {
    // アンカーがまだ無い(当日など)。**「合った」とは言わない。**
    process.stdout.write(
      `\n${manifest.date} のアンカーがまだありません。前日分までが固定の対象です。\n`,
    );
    process.exit(failed === 0 ? 0 : 1);
  }

  check(
    'アンカーの件数と一致する',
    Number(rows[0].event_count) === events.length,
    `アンカー=${rows[0].event_count} 書き出し=${events.length}`,
  );
  check(
    '**再計算したルートがアンカーと一致する**',
    rows[0].root_hash === chain,
    `アンカー=${String(rows[0].root_hash).slice(0, 16)}… 再計算=${chain.slice(0, 16)}…`,
  );
} finally {
  await client.end();
}

process.stdout.write(
  failed === 0
    ? '\n照合: 一致しました\n' +
        '  ただしこれは**連鎖の一致**であり、正準形の作り方そのものは検証していない。\n' +
        '  アンカーの実体を外部(S3 Object Lock)の値と突き合わせて初めて改ざん検知になる。\n'
    : `\n照合: ${failed} 件 NG\n`,
);
process.exit(failed === 0 ? 0 : 1);
