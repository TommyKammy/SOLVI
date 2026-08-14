#!/usr/bin/env node
/**
 * 要求と実装・検査の対応の検査 (WP-P2-RTM-019, WP-P2-RTM-022 / NFR-MNT-001)。
 *
 * `03.18_Requirements_Traceability_Matrix.md` の Status 欄は**手で書かれていた**。
 * その結果、WPを28件完了し検査が1352件通っている時点でも、
 * 93行のうち92行が `Not tested` のままだった。
 *
 * **何が検証済みかを知るための台帳が、それを知る役に立っていなかった。**
 *
 * 手で書いた欄は腐る。書き換える人が居なければ、
 * 台帳は「最後に誰かが気にした日」で止まる。
 *
 * ## この検査がやること
 *
 * Status を**導出**し、台帳の記載と食い違えば失敗する。
 * 台帳を直さないと検査が通らないので、腐りようが無くなる。
 *
 * ## 導出できることと、できないこと
 *
 * 導出できるのは「**検査が要求IDを名指ししている**」までである。
 * それは「要求を満たしている」証明ではない。
 *
 * 名指しは人が書く。書き忘れれば「検査の名指し無し」になるし、
 * 見当違いの検査に名前を書いても機械には分からない。
 * **この検査は台帳の鮮度を保つのであって、品質を保証しない。**
 *
 * ## 何を要求と見なすか (WP-P2-RTM-022)
 *
 * **台帳の表に在る行が要求である。** 種別を列挙して選別しない。
 *
 * 以前はここに `BR|FR|NFR|CON` と書いていた。`AUD` と `MIG` が無く、
 * 台帳 101 行のうち 93 行しか見ていなかった。
 * **見ていない 8 行について、この検査は何も言わない。**
 * だから緑のまま、8 件が導出以前の手書きの値 `Not tested` で残っていた。
 * そのうち AUD-001〜003 は Gate 1 の要求である。
 *
 * 選別する条件を持つと、条件の外は「無い」ことになる(04.23 §16)。
 *
 * 使い方:
 *   node tools/check_traceability.mjs          検査(食い違えば exit 1)
 *   node tools/check_traceability.mjs --write  台帳の Status を書き換える
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const RTM = join(ROOT, 'docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md');
const WRITE = process.argv.includes('--write');

/** 要求IDの一般形。**種別は書かない** — 形だけを決める。 */
const ID_SHAPE = /^[A-Z]{2,5}(?:-[A-Z]{2,6})?-\d{3}$/;

/** 追記によって導出値が変わったら、自分をもう一度回す。 */
let rerunNeeded = false;
/** 暴走を防ぐ。収束しないなら、それ自体が報告すべきことである。 */
const PASS = Number(process.env.SOLVI_TRACE_PASS ?? '1');

let problems = 0;
const report = (level, title, detail = '') => {
  const mark = level === 'ng' ? 'NG  ' : level === 'note' ? '注記 ' : 'OK  ';
  process.stdout.write(`  ${mark} ${title}${detail ? `\n       ${detail}` : ''}\n`);
  if (level === 'ng') problems++;
};

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. 台帳を読む
// ---------------------------------------------------------------------------
const rtmText = readFileSync(RTM, 'utf8');
const rtmLines = rtmText.split('\n');

/**
 * 要求表を「どこからどこまでか」で捉える。
 * 見出し行から、表が途切れるまでの行がすべて対象である。
 */
const headerIndex = rtmLines.findIndex((l) => /^\|\s*Requirement\s*\|/.test(l));
if (headerIndex < 0) {
  process.stdout.write('台帳に要求表の見出し行が見つかりません。\n');
  process.exit(1);
}

/** @type {Array<{lineNo: number, id: string, cells: string[]}>} */
const rows = [];
/** **読めなかった行を捨てない。** 捨てると件数から消え、消えたことも消える。 */
const unreadable = [];
for (let i = headerIndex + 1; i < rtmLines.length; i++) {
  const line = rtmLines[i];
  if (!line.startsWith('|')) break;
  const cells = line
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim());
  if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // 区切り行
  if (cells.length < 8 || !ID_SHAPE.test(cells[0])) {
    unreadable.push(`${i + 1}行目: ${line.slice(0, 72)}`);
    continue;
  }
  rows.push({ lineNo: i, id: cells[0], cells });
}

/** 台帳に在るIDの集合。**照合の基準はここだけ**である。 */
const known = new Set(rows.map((r) => r.id));

/**
 * 参照を探すための正規表現も、台帳から作る。
 *
 * 種別(`BR` `FR-TKT` `AUD` `MIG` …)は台帳の行から取り出す。
 * 形だけで探すと `UC-001` `DL-030` `RISK-013` まで拾ってしまい、
 * **要求でないものを「台帳に無い要求ID」として報告する**ことになる。
 *
 * 限界も書いておく。台帳に一行も無い種別は、この検査からは見えない。
 * 新しい種別の要求は、**まず台帳に行を作ること**で見えるようになる。
 *
 * 前を見ないと **WP ID を要求IDとして拾う**。
 * `WP-P9-MIG-001` の中に `MIG-001` が、`WP-P1-AUD-018` の中に `AUD-018` が在る。
 * 拾うと二つ壊れる — WPを話題にしただけの検査が「要求を名指しした」ことになり、
 * **台帳に無い WP 番号が「実在しない要求ID」として報告される**。
 * 直前が `-` か語中なら、それは別のものの一部である。
 */
const families = [...new Set([...known].map((id) => id.replace(/-\d+$/, '')))].sort(
  (a, b) => b.length - a.length,
);
const REQ_REF = new RegExp(`(?<![-\\w])(?:${families.join('|')})-\\d{3}\\b`, 'g');

// ---------------------------------------------------------------------------
// 2. WPノートの frontmatter を読む
// ---------------------------------------------------------------------------
const wpFiles = walk(join(ROOT, 'docs/planning/06_WorkPackages')).filter((f) => f.endsWith('.md'));

/** 要求ID → それを担う done な WP の doc_id */
const doneBy = new Map();
/** 要求ID → それを担う全WPの doc_id(未着手を含む) */
const claimedBy = new Map();
/** doc_id → ファイルパス */
const wpPath = new Map();

for (const file of wpFiles) {
  const text = readFileSync(file, 'utf8');
  const docId = text.match(/doc_id:\s*"([^"]+)"/)?.[1];
  if (!docId) continue;
  wpPath.set(docId, file);
  const done = /implementation_status:\s*"?done"?/.test(text);
  const ids = (text.match(/requirement_ids:\s*\[([^\]]*)\]/)?.[1] ?? '').match(REQ_REF) ?? [];
  for (const id of ids) {
    if (!claimedBy.has(id)) claimedBy.set(id, []);
    claimedBy.get(id).push(docId);
    if (done) {
      if (!doneBy.has(id)) doneBy.set(id, []);
      doneBy.get(id).push(docId);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. 検査が名指ししている要求
// ---------------------------------------------------------------------------
/**
 * 検証の出どころ。
 *
 * 単体・結合の検査(`tests/`)と通し確認(`tools/e2e/`)に加えて、
 * **`tools/check_*.mjs` も数える。** アクセシビリティ(NFR-UX-002)や
 * 禁止依存(NFR-MNT-001)は vitest ではなく専用の検査が確かめており、
 * 見ないと「実装済みだが検査の名指し無し」と誤って報告する。
 *
 * ただし自分自身は除く。**台帳の検査は要求の検査ではない。**
 */
const testFiles = [
  ...walk(join(ROOT, 'tests')),
  ...walk(join(ROOT, 'tools/e2e')),
  ...readdirSync(join(ROOT, 'tools'))
    .filter((f) => /^check_.*\.mjs$/.test(f) && f !== 'check_traceability.mjs')
    .map((f) => join(ROOT, 'tools', f)),
].filter((f) => /\.(ts|mjs)$/.test(f));

/** 要求ID → 名指ししているファイル */
const namedBy = new Map();
for (const file of testFiles) {
  const text = readFileSync(file, 'utf8');
  for (const id of new Set(text.match(REQ_REF) ?? [])) {
    if (!namedBy.has(id)) namedBy.set(id, []);
    namedBy.get(id).push(relative(ROOT, file));
  }
}

// ---------------------------------------------------------------------------
// 4. Status を導出する
// ---------------------------------------------------------------------------
/**
 * **言葉を選ぶ。** 「検査あり」は「検査が要求IDを名指ししている」であって
 * 「要求を満たしている」ではない。台帳に強い言葉を書くと、
 * 読んだ人が確かめずに信じる。
 */
function deriveStatus(id) {
  const done = doneBy.get(id) ?? [];
  const named = namedBy.get(id) ?? [];
  if (done.length === 0) return named.length > 0 ? '検査のみ(WP未完)' : '未着手';
  if (named.length === 0) return '実装済み・検査の名指し無し';
  return `検査あり (${named.length}ファイル)`;
}

process.stdout.write('A. 要求の状態(導出値と台帳の突き合わせ)\n');

const updates = [];
for (const row of rows) {
  const derived = deriveStatus(row.id);
  const recorded = row.cells[row.cells.length - 1];
  if (recorded !== derived) updates.push({ row, derived, recorded });
}

const tally = {};
for (const row of rows) {
  const d = deriveStatus(row.id).replace(/ \(\d+ファイル\)/, '');
  tally[d] = (tally[d] ?? 0) + 1;
}
report(
  'ok',
  `要求 ${rows.length} 件の内訳(種別 ${families.length}: ${families.slice().sort().join(', ')})`,
  Object.entries(tally)
    .map(([k, v]) => `${k}: ${v}`)
    .join(' / '),
);

/**
 * **読めなかった行を、件数から黙って消さない。**
 *
 * この検査が 8 件を見落としていたとき、出力は「93 件」とだけ言っていた。
 * 表には 101 行あったのに、8 行が消えたことは**どこにも出ていなかった**。
 * 表に在って読めない行は、無い行ではない。
 */
if (unreadable.length > 0) {
  report(
    'ng',
    `要求表に、要求として読めない行が ${unreadable.length} 件ある`,
    `${unreadable.slice(0, 8).join('\n       ')}\n       ID列の形(${ID_SHAPE.source})か列数を直す`,
  );
}

// **名指しの無いものを見えるようにする。** 件数だけでは何を足せばよいか分からない。
const unnamed = rows
  .map((r) => r.id)
  .filter((id) => (doneBy.get(id) ?? []).length > 0 && (namedBy.get(id) ?? []).length === 0);
if (unnamed.length > 0) {
  report(
    'note',
    `${unnamed.length} 件は実装済みだが検査が名指ししていない`,
    `${unnamed.join(', ')}\n       検査のコメントへ要求IDを書くと対応が付く`,
  );
}

if (updates.length === 0) {
  report('ok', '台帳の Status は導出値と一致している');
} else if (WRITE) {
  for (const { row, derived } of updates) {
    const cells = [...row.cells];
    cells[cells.length - 1] = derived;
    rtmLines[row.lineNo] = `| ${cells.join(' | ')} |`;
  }
  writeFileSync(RTM, rtmLines.join('\n'));
  report('ok', `${updates.length} 行の Status を書き換えた`);
} else {
  report(
    'ng',
    `${updates.length} 行の Status が導出値と食い違う`,
    `例: ${updates
      .slice(0, 3)
      .map((u) => `${u.row.id} 台帳=「${u.recorded}」導出=「${u.derived}」`)
      .join(' / ')}\n       `.trimEnd() +
      '\n       `node tools/check_traceability.mjs --write` で更新する',
  );
}

// ---------------------------------------------------------------------------
// 5. 双方向の突き合わせ
// ---------------------------------------------------------------------------
process.stdout.write('\nB. 台帳とWPノートの相互参照\n');

/**
 * **片方だけを見ると、繋ぎ目の欠落を見逃す**(04.23 §7)。
 * 台帳が「この要求はWP Xが担う」と書き、
 * WP X が「私はその要求を担う」と書いていること、両方を確かめる。
 */
const oneSided = [];
const wpUpdates = [];
/** doc_id → frontmatter へ足すべき要求ID */
const frontmatterUpdates = new Map();
for (const row of rows) {
  const inRtm = new Set(row.cells[3].match(/WP-[A-Z0-9-]+/g) ?? []);
  const inWp = new Set(claimedBy.get(row.id) ?? []);

  const missingFromRtm = [...inWp].filter((wp) => !inRtm.has(wp));
  for (const wp of missingFromRtm) {
    oneSided.push(`${row.id}: ${wp} が自分で担うと書いているが台帳に無い`);
  }
  if (missingFromRtm.length > 0) wpUpdates.push({ row, add: missingFromRtm });

  // 逆向き。**台帳が「担う」と書いた WP が、自分ではそう書いていない。**
  // こちらは機械では直せない — 台帳が誤っているのか、WPが書き忘れたのか、
  // 判断が要る。報告だけする。
  for (const wp of inRtm) {
    if (!inWp.has(wp) && wpPath.has(wp)) {
      oneSided.push(`${row.id}: 台帳は ${wp} が担うと書くが、${wp} は自分でそう書いていない`);
      if (!frontmatterUpdates.has(wp)) frontmatterUpdates.set(wp, new Set());
      frontmatterUpdates.get(wp).add(row.id);
    }
  }
}

if (oneSided.length === 0) {
  report('ok', '台帳とWPノートの主張が一致している');
} else if (WRITE && (wpUpdates.length > 0 || frontmatterUpdates.size > 0)) {
  // **足すのは片方向だけ。** WPが自分で担うと書いたものを台帳へ写す。
  // 逆(台帳にあってWPに無い)は、どちらが誤りか機械には決められない。
  for (const { row, add } of wpUpdates) {
    const cells = [...row.cells];
    const links = [
      ...(cells[3].match(/\[\[WP-[A-Z0-9-]+\]\]/g) ?? []),
      ...add.map((w) => `[[${w}]]`),
    ];
    cells[3] = [...new Set(links)].sort().join(', ');
    rtmLines[row.lineNo] = `| ${cells.join(' | ')} |`;
  }
  writeFileSync(RTM, rtmLines.join('\n'));
  report(
    'ok',
    `${wpUpdates.length} 行の Work Package 欄へ ${wpUpdates.reduce((n, u) => n + u.add.length, 0)} 件を追記した`,
  );

  // 逆向きも直す。**台帳が「担う」と書いたなら、WPは自分でそう書くべきである。**
  // 片方だけを正とすると、次に食い違ったとき同じ判断を繰り返すことになる。
  let touched = 0;
  let added = 0;
  for (const [wp, ids] of frontmatterUpdates) {
    const file = wpPath.get(wp);
    const text = readFileSync(file, 'utf8');
    const match = text.match(/requirement_ids:\s*\[([^\]]*)\]/);
    const existing = match ? (match[1].match(REQ_REF) ?? []) : [];
    const merged = [...new Set([...existing, ...ids])].sort();
    if (merged.length === existing.length) continue;
    const field = `requirement_ids: [${merged.map((i) => `"${i}"`).join(', ')}]`;

    if (match) {
      writeFileSync(file, text.replace(match[0], field));
    } else {
      // **欄そのものが無いWPノートがある。** 初期に作られたものは
      // frontmatter の項目が揃っていない。無いなら足す —
      // 「欄が無い」と「担う要求が無い」は違う。
      const anchor = text.match(/^implementation_status:.*$/m);
      if (!anchor) continue;
      writeFileSync(file, text.replace(anchor[0], `${anchor[0]}\n${field}`));
    }
    touched++;
    added += merged.length - existing.length;
  }
  if (touched > 0) {
    report('ok', `${touched} 件のWPノートの requirement_ids へ ${added} 件を追記した`);
    // **もう一度回す。** frontmatter を足すと導出値(Status)が変わる。
    // 「2回実行してください」という口伝を残さない。
    rerunNeeded = true;
  }
} else {
  report('ng', `${oneSided.length} 件の片側だけの主張`, oneSided.slice(0, 8).join('\n       '));
}

// ---------------------------------------------------------------------------
// 6. 実在しない要求ID
// ---------------------------------------------------------------------------
process.stdout.write('\nC. 実在しない要求IDの参照\n');

// `known` は §1 で台帳から作った集合をそのまま使う。
// **照合の基準を二か所に持たない**(WP-P1-IDM-012 と同じ形)。
const ghosts = [];
for (const [id, files] of namedBy) {
  if (!known.has(id)) ghosts.push(`${id} (${files[0]})`);
}
for (const [id, wps] of claimedBy) {
  if (!known.has(id)) ghosts.push(`${id} (${wps[0]} の frontmatter)`);
}

if (ghosts.length === 0) {
  report('ok', '参照されている要求IDはすべて台帳に存在する');
} else {
  // **台帳に無いIDを名指しする検査は、何も追跡していない。**
  report(
    'ng',
    `${ghosts.length} 件が台帳に無いIDを指している`,
    ghosts.slice(0, 8).join('\n       '),
  );
}

// ---------------------------------------------------------------------------
process.stdout.write('\n');

if (rerunNeeded) {
  if (PASS >= 5) {
    process.stdout.write('収束しませんでした。追記の規則が循環しています。\n');
    process.exit(1);
  }
  process.stdout.write(`追記により導出値が変わりました。もう一度回します (${PASS + 1}周目)。\n\n`);
  const { status } = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    {
      stdio: 'inherit',
      env: { ...process.env, SOLVI_TRACE_PASS: String(PASS + 1) },
    },
  );
  process.exit(status ?? 1);
}

if (problems > 0) {
  process.stdout.write(`${problems} 件の問題があります\n`);
  process.exit(1);
}
process.stdout.write(
  'OK: 要求と実装・検査の対応は台帳と一致しています\n' +
    '    ただし「検査あり」は**検査が要求IDを名指ししている**という意味であり、\n' +
    '    要求を満たしている証明ではない。名指しは人が書く。\n',
);
