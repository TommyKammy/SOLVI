#!/usr/bin/env node
/**
 * WP台帳とWPノートの突き合わせ (WP-P2-REG-023 / NFR-MNT-001)。
 *
 * `06.0_WorkPackage_Register.md` は自分を「全Work Packageの正本台帳」と呼ぶ。
 * **その台帳に 25 件のWPが載っていなかった。25 件すべてが完了済みである。**
 *
 * 計画に無いものを実行したのではない。実行したものを書き戻さなかった。
 *
 * ## 件数が5つあった
 *
 * 59(README ×2 / Roadmap / Project Map / Validation Report)/
 * 60(台帳)/ 66(Dashboard)/ 85(実体)/ 51(baseline のみ)。
 *
 * **同じものを6か所が別々に書き、5か所が実体と違っていた。**
 * 数を配ると、写した時点からそれぞれ独立に古くなる(DL-050)。
 *
 * ここが数を導出し、他の文書は数を持たずこの台帳を指す。
 *
 * 使い方:
 *   node tools/check_workpackages.mjs          検査(食い違えば exit 1)
 *   node tools/check_workpackages.mjs --write  台帳とfrontmatterを揃える
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const WP_DIR = join(ROOT, 'docs/planning/06_WorkPackages');
const REGISTER = join(WP_DIR, '06.0_WorkPackage_Register.md');
const WRITE = process.argv.includes('--write');

/** WP ID の形。**台帳もノートも、これに合うものだけをWPと数える。** */
const WP_ID = /^WP-P\d-[A-Z]+-\d{3}$/;

let problems = 0;
const report = (level, title, detail = '') => {
  const mark = level === 'ng' ? 'NG  ' : level === 'note' ? '注記 ' : 'OK  ';
  process.stdout.write(`  ${mark} ${title}${detail ? `\n       ${detail}` : ''}\n`);
  if (level === 'ng') problems++;
};

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. WPノートを読む
// ---------------------------------------------------------------------------
/**
 * `06.4_Backlog` は `doc_id: WP-BACKLOG` を持つが**台帳であってWPではない**。
 * ID の形で弾く — 「WPディレクトリに在るもの」を全部WPと見なさない。
 */
const notes = new Map();
for (const file of walk(WP_DIR)) {
  const text = readFileSync(file, 'utf8');
  const field = (k) => text.match(new RegExp(`^${k}:\\s*"?([^"\\n]*?)"?\\s*$`, 'm'))?.[1];
  const id = field('doc_id');
  if (!id || !WP_ID.test(id)) continue;
  const list = (k) =>
    (text.match(new RegExp(`^${k}:\\s*\\[([^\\]]*)\\]`, 'm'))?.[1] ?? '')
      .split(',')
      .map((s) => s.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);
  notes.set(id, {
    file,
    text,
    title: field('title'),
    status: field('status'),
    phase: field('phase'),
    workstream: field('workstream'),
    risk: field('risk'),
    points: field('story_points'),
    requirements: list('requirement_ids'),
    dependsOn: list('depends_on'),
  });
}

// ---------------------------------------------------------------------------
// 2. 台帳を読む
// ---------------------------------------------------------------------------
const regLines = readFileSync(REGISTER, 'utf8').split('\n');
const headerIndex = regLines.findIndex((l) => /^\|\s*WP ID\s*\|/.test(l));
if (headerIndex < 0) {
  process.stdout.write('台帳にWP表の見出し行が見つかりません。\n');
  process.exit(1);
}

const rows = [];
const unreadable = [];
let tableEnd = headerIndex;
for (let i = headerIndex + 1; i < regLines.length; i++) {
  const line = regLines[i];
  if (!line.startsWith('|')) break;
  tableEnd = i;
  const cells = line
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim());
  if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
  const id = cells[0]?.match(/WP-P\d-[A-Z]+-\d{3}/)?.[0];
  if (cells.length < 8 || !id) {
    // **読めない行を件数から黙って消さない**(WP-P2-RTM-022 と同じ)。
    unreadable.push(`${i + 1}行目: ${line.slice(0, 72)}`);
    continue;
  }
  rows.push({ lineNo: i, id, cells });
}

// ---------------------------------------------------------------------------
// 3. 突き合わせ
// ---------------------------------------------------------------------------
process.stdout.write('A. WPノートと台帳の突き合わせ\n');

const inRegister = new Set(rows.map((r) => r.id));
const missingRows = [...notes.keys()].filter((id) => !inRegister.has(id)).sort();
const orphanRows = rows.filter((r) => !notes.has(r.id)).map((r) => r.id);

if (unreadable.length > 0) {
  report(
    'ng',
    `台帳のWP表に、WPとして読めない行が ${unreadable.length} 件ある`,
    unreadable.slice(0, 8).join('\n       '),
  );
}

if (orphanRows.length > 0) {
  // **機械では直せない。** 行を消すのか、ノートを作るのかは判断が要る。
  report('ng', `台帳に在るがノートが無い WP が ${orphanRows.length} 件`, orphanRows.join(', '));
}

/** 台帳の行を frontmatter から組み立てる。 */
function buildRow(id) {
  const n = notes.get(id);
  const reqs = n.requirements.length > 0 ? n.requirements.join(', ') : '-';
  const deps = n.dependsOn.length > 0 ? n.dependsOn.map((d) => `[[${d}]]`).join(', ') : '-';
  return `| [[${id}]] | ${n.phase ?? '-'} | ${n.workstream ?? '-'} | ${n.title ?? '-'} | ${
    n.risk ?? '-'
  } | ${n.points ?? '-'} | ${reqs} | ${deps} |`;
}

if (missingRows.length === 0) {
  report('ok', `WPノート ${notes.size} 件すべてに台帳の行がある`);
} else if (WRITE) {
  // **Phase のまとまりを崩さない。** 同じ Phase の最後の行の後ろへ入れる。
  for (const id of missingRows) {
    const phase = notes.get(id).phase;
    const anchor = [...regLines.keys()]
      .filter((i) => i > headerIndex && regLines[i].startsWith('| [[WP-'))
      .filter((i) => regLines[i].split('|')[2]?.trim() === phase)
      .pop();
    const at = (anchor ?? tableEnd) + 1;
    regLines.splice(at, 0, buildRow(id));
  }
  writeFileSync(REGISTER, regLines.join('\n'));
  report('ok', `台帳へ ${missingRows.length} 件の行を追加した`, missingRows.join(', '));
  process.stdout.write('\n台帳を書き換えました。もう一度実行してください。\n');
  process.exit(0);
} else {
  report(
    'ng',
    `${missingRows.length} 件のWPが台帳に無い`,
    `${missingRows.slice(0, 8).join(', ')}${missingRows.length > 8 ? ' …' : ''}\n` +
      '       `node tools/check_workpackages.mjs --write` で追加する',
  );
}

// ---------------------------------------------------------------------------
// 4. frontmatter の欠落と食い違い
// ---------------------------------------------------------------------------
process.stdout.write('\nB. 台帳の行とノートの frontmatter\n');

/** 台帳の列 → frontmatter の項目。 */
const FIELDS = [
  { key: 'phase', col: 1, quoted: true },
  { key: 'workstream', col: 2, quoted: true },
  { key: 'risk', col: 4, quoted: true },
  { key: 'points', col: 5, quoted: false, fm: 'story_points' },
];

const conflicts = [];
const fills = new Map();
for (const row of rows) {
  const n = notes.get(row.id);
  if (!n) continue;
  for (const f of FIELDS) {
    const fromRow = row.cells[f.col];
    const fromNote = n[f.key];
    if (!fromNote) {
      if (!fills.has(row.id)) fills.set(row.id, []);
      fills.get(row.id).push({ ...f, value: fromRow });
    } else if (fromNote !== fromRow) {
      // **どちらが正かは機械には決められない。** 報告して止める。
      conflicts.push(`${row.id}: ${f.fm ?? f.key} 台帳=「${fromRow}」ノート=「${fromNote}」`);
    }
  }
}

if (conflicts.length > 0) {
  report(
    'ng',
    `${conflicts.length} 件が台帳とノートで食い違う`,
    conflicts.slice(0, 8).join('\n       '),
  );
}

if (fills.size === 0) {
  report('ok', 'すべてのWPノートが phase / workstream / risk / story_points を持つ');
} else if (WRITE && conflicts.length === 0) {
  let added = 0;
  for (const [id, list] of fills) {
    const n = notes.get(id);
    let text = n.text;
    for (const f of list) {
      const name = f.fm ?? f.key;
      const line = f.quoted ? `${name}: "${f.value}"` : `${name}: ${f.value}`;
      // **欄が無いノートがある。** 初期に作られたものは項目が揃っていない
      // (WP-P2-RTM-019 §4 と同じ)。無いなら足す。
      const anchor = text.match(/^implementation_status:.*$/m);
      if (!anchor) continue;
      text = text.replace(anchor[0], `${anchor[0]}\n${line}`);
      added++;
    }
    writeFileSync(n.file, text);
    n.text = text;
    for (const f of list) n[f.key] = f.value;
  }
  report('ok', `${fills.size} 件のノートへ ${added} 件の項目を足した`);
} else {
  report(
    'ng',
    `${fills.size} 件のノートが台帳の値を持っていない`,
    `${[...fills.keys()].slice(0, 8).join(', ')}\n` +
      '       `node tools/check_workpackages.mjs --write` で台帳の値を書き写す',
  );
}

// ---------------------------------------------------------------------------
// 5. 集計を導出する
// ---------------------------------------------------------------------------
process.stdout.write('\nC. 集計(台帳の記載と導出値)\n');

const points = (r) => Number(r.cells[5]) || 0;
const total = rows.length;
const totalPoints = rows.reduce((n, r) => n + points(r), 0);
const byPhase = {};
for (const r of rows) byPhase[r.cells[1]] = (byPhase[r.cells[1]] ?? 0) + points(r);
const phaseLine = Object.keys(byPhase)
  .sort()
  .map((p) => `${p} ${byPhase[p]}`)
  .join(' / ');

const derived = {
  total: `- WP総数 **${total}** / Story Point合計 **${totalPoints}**`,
  phase: `- Phase別: ${phaseLine}`,
};

const totalLine = regLines.findIndex((l) => l.startsWith('- WP総数'));
const phaseLineNo = regLines.findIndex((l) => l.startsWith('- Phase別:'));
const stale = [];
if (totalLine < 0 || regLines[totalLine] !== derived.total) stale.push(['total', totalLine]);
if (phaseLineNo < 0 || regLines[phaseLineNo] !== derived.phase) stale.push(['phase', phaseLineNo]);

report('ok', `導出値: WP ${total} 件 / ${totalPoints} ポイント`, phaseLine);

if (stale.length === 0) {
  report('ok', '台帳の集計は導出値と一致している');
} else if (WRITE) {
  for (const [key, lineNo] of stale) {
    if (lineNo < 0) continue;
    regLines[lineNo] = derived[key];
  }
  writeFileSync(REGISTER, regLines.join('\n'));
  report('ok', `${stale.length} 行の集計を書き換えた`);
} else {
  report(
    'ng',
    `${stale.length} 行の集計が導出値と食い違う`,
    `${stale
      .map(([k, n]) => (n < 0 ? `${k}: 行が無い` : `台帳=「${regLines[n]}」`))
      .join('\n       ')}\n` + '       `node tools/check_workpackages.mjs --write` で更新する',
  );
}

// ---------------------------------------------------------------------------
// 6. 件数の写しが他所に無いか
// ---------------------------------------------------------------------------
process.stdout.write('\nD. 件数の写し\n');

/**
 * **数を配ると、写した時点から古くなる。**
 * 件数を書いてよいのは台帳だけである。他の文書は台帳を指す。
 *
 * 生成日つきの点検記録([[99.13_Vault_Validation_Report]])は対象外 —
 * あれは「その日に数えた値」であり、古いこと自体は誤りではない。
 */
/**
 * 探すのは「**いま何件あるか**」を述べている箇所である。
 *
 * 「WPを28件完了した時点で」のような**ある時点の記録**は写しではない。
 * 古くなるのが正しいものと、古くなってはいけないものを混ぜない。
 * 機械にこの区別は付かないので、**総数を述べる形**だけを見る —
 * 表の欄・図のノード・語のすぐ後ろに数が来る書き方の3つ。
 *
 * 限界: 「WP は現在 85 個」のように助詞を挟む書き方は捕まらない。
 * この検査は**写しを増やさないための歯止め**であって、網羅ではない。
 */
const COPY_SHAPES = [
  { what: '表の欄', re: /^\|\s*(?:WP|Work ?Packages?)\s*\|[^|]*?(\d+)\s*件/ },
  { what: '図のノード', re: /Work ?Packages?<br\s*\/?>\s*(\d+)\s*件/ },
  { what: '語の直後', re: /(?:WP|Work ?Packages?)(?![-\w])\s*(\d+)\s*件/ },
];
const copies = [];
for (const file of walk(join(ROOT, 'docs/planning'))) {
  if (file === REGISTER) continue;
  if (file.endsWith('99.13_Vault_Validation_Report.md')) continue;
  if (file.endsWith('MANIFEST.md')) continue;
  if (file.includes('06_WorkPackages')) continue; // WP自身の記述は台帳の写しではない
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((l, i) => {
    for (const shape of COPY_SHAPES) {
      const m = l.match(shape.re);
      if (!m) continue;
      // **「0件」は総数の写しではなく、不在の主張である**(「孤立WP 0件」など)。
      // 総数は増えるので古くなるが、不在の主張は別の検査が確かめている。
      if (m[1] === '0') continue;
      copies.push(
        `${file.replace(ROOT + '/', '')}:${i + 1}(${shape.what}): ${l.trim().slice(0, 56)}`,
      );
      return;
    }
  });
}

if (copies.length === 0) {
  report('ok', '台帳の外にWP件数の写しは無い');
} else {
  report(
    'ng',
    `${copies.length} 件の写しがある`,
    `${copies.slice(0, 8).join('\n       ')}\n       数を消し、[[06.0_WorkPackage_Register]] を指す`,
  );
}

// ---------------------------------------------------------------------------
process.stdout.write('\n');
if (problems > 0) {
  process.stdout.write(`${problems} 件の問題があります\n`);
  process.exit(1);
}
process.stdout.write(
  'OK: WP台帳は実体と一致しています\n' +
    '    件数は台帳が導出する。他の文書は数を持たず、台帳を指す。\n',
);
