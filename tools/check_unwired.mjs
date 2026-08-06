#!/usr/bin/env node
/**
 * 「定義したが動いていない」欠陥の棚卸し
 *
 * この検査は、実際に見つかった欠陥の傾向から作った。
 *
 *   1. OpenTelemetry の自動計装が tsx/ESM で無言で無効 → スパン0件、エラーも無し
 *   2. MeterProvider 未接続 → すべてのメトリクス記録が黙って捨てられていた
 *   3. 署名付きURLのエンコード不一致 → ダウンロードが一度も成功していなかった
 *   4. ClamAV が5か月古い定義で稼働 → スキャンは成功し clean が返り続けた
 *   5. SLA目標値がシードに無い → 新規構築では判定基準が空
 *   6. Alertmanager の抑止規則が一致しない → 抑止が成立していなかった
 *
 * **6件すべてが同じ形である。** 設定・定義は存在し、ヘルスチェックも通り、
 * テストも緑で、外から見て何も壊れていない。**動いていないだけ**である。
 *
 * 共通する原因は「宣言」と「実行経路」を突き合わせていないこと。
 * この検査はその突き合わせを機械的に行う。
 *
 * 検査するもの:
 *   A. 監査イベント型のうち、どこからも記録されないもの
 *   B. アラート式が参照するメトリクスのうち、存在しないもの
 *   C. 公開されているが誰も使っていない関数
 *   D. 定義されているが誰も読まない環境変数
 *   E. down を一度も実行していないマイグレーション
 *
 * **この検査自体も「動いていない」状態になりうる。** 対象が0件のときは
 * 「検査できなかった」ことを明示する。静かに OK を返さない。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = process.cwd();
const PROM = process.env.PROMETHEUS_URL ?? 'http://127.0.0.1:9090';

/** 検査対象のソース。テストは「使っている」に数えない。 */
const SOURCE_DIRS = ['packages', 'services', 'apps', 'tools'];
const TEST_DIRS = ['tests'];

let problems = 0;
let notes = 0;

function report(level, message, detail = '') {
  const mark = level === 'ng' ? 'NG  ' : level === 'note' ? '注記 ' : 'OK  ';
  process.stdout.write(`  ${mark} ${message}${detail ? `\n       ${detail}` : ''}\n`);
  if (level === 'ng') problems += 1;
  if (level === 'note') notes += 1;
}

function collectFiles(dirs, extensions = ['.ts', '.tsx', '.mjs']) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (extensions.includes(extname(full))) files.push(full);
    }
  };
  for (const dir of dirs) walk(join(ROOT, dir));
  return files;
}

/**
 * エントリポイントから import を辿って到達できるファイルを求める。
 *
 * 到達できないファイルは、中で何を呼び合っていても**一度も実行されない**。
 * 監査アンカーの欠陥はこの形だった — 関数は互いに呼び合い、テストも通り、
 * しかし worker の main.ts はそのファイルを読み込んでいなかった。
 */
function reachableFiles(files) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const exists = (p) => byPath.has(p);

  /** 相対指定を実ファイルへ解決する。`.js` 表記は TypeScript の出力名である。 */
  const resolve = (fromPath, spec) => {
    if (spec.startsWith('@solvi/shared')) return join(ROOT, 'packages/shared/src/index.ts');
    if (!spec.startsWith('.')) return null;
    const base = join(fromPath, '..', spec).replace(/\.js$/, '');
    for (const cand of [`${base}.ts`, `${base}.tsx`, `${base}.mjs`, join(base, 'index.ts')]) {
      if (exists(cand)) return cand;
    }
    return null;
  };

  // エントリポイント: 各サービスの main、画面(Next.js の app 配下)、tools。
  // 画面は import されずにフレームワークから呼ばれるため、明示的に含める。
  const entries = files
    .filter(
      (f) =>
        /\/src\/main\.ts$/.test(f.path) ||
        f.path.includes('/apps/web/src/app/') ||
        (f.path.includes('/tools/') && f.path.endsWith('.mjs')),
    )
    .map((f) => f.path);

  const seen = new Set(entries);
  const queue = [...entries];
  while (queue.length > 0) {
    const current = queue.pop();
    const file = byPath.get(current);
    if (!file) continue;
    for (const m of file.text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const target = resolve(current, m[1]);
      if (target && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return seen;
}

const sourceFiles = collectFiles(SOURCE_DIRS);
const testFiles = collectFiles(TEST_DIRS);
const sourceText = sourceFiles.map((f) => ({ path: f, text: readFileSync(f, 'utf8') }));
const testText = testFiles.map((f) => ({ path: f, text: readFileSync(f, 'utf8') }));

if (sourceFiles.length === 0) {
  process.stdout.write('NG: ソースファイルを1件も読めませんでした。検査が成立していません。\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// A. 監査イベント型のうち、どこからも記録されないもの
//
// 監査カタログに載っているのに一度も書かれない型は、
// 「記録しているつもり」の状態である。監査は事後に見るものなので、
// 空であることに気付くのは事故の後になる。
// ---------------------------------------------------------------------------
process.stdout.write('\nA. 監査イベント型と実際の記録\n');
{
  const auditFile = sourceText.find((f) => f.path.endsWith('common/audit/audit.ts'));
  if (!auditFile) {
    report('ng', 'audit.ts を読めませんでした', '検査が成立していません');
  } else {
    const block = /AUDIT_EVENT_TYPES = \[([\s\S]*?)\] as const/.exec(auditFile.text);
    const declared = block ? [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];

    if (declared.length === 0) {
      report('ng', '監査イベント型を1件も抽出できませんでした', '検査が成立していません');
    } else {
      // 宣言そのものの行を除いて、実際に eventType として使われているかを見る
      const emitted = new Set();
      for (const { path, text } of sourceText) {
        if (path.endsWith('common/audit/audit.ts')) continue;
        for (const type of declared) {
          if (text.includes(`'${type}'`)) emitted.add(type);
        }
      }

      const never = declared.filter((t) => !emitted.has(t));
      if (never.length === 0) {
        report('ok', `監査イベント型 ${declared.length} 件すべてが記録経路を持つ`);
      } else {
        report(
          'note',
          `${never.length}/${declared.length} 件の監査イベント型が未使用`,
          never.join(', '),
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// B. アラート式が参照するメトリクスのうち、存在しないもの
//
// **存在しないメトリクスを参照するアラートは、絶対に発火しない。**
// ルールとしては正しく読み込まれ、Prometheus も健全と報告する。
// 鳴らないことは、鳴るべき事象が起きるまで分からない。
// ---------------------------------------------------------------------------
process.stdout.write('\nB. アラート式とメトリクスの実在\n');
{
  let ruleText = '';
  try {
    ruleText = readFileSync(join(ROOT, 'infra/monitoring/alerts/slo.yml'), 'utf8');
  } catch {
    report('ng', 'アラート定義を読めませんでした', '検査が成立していません');
  }

  // solvi_* のメトリクス名を式から抜き出す
  const referenced = [...new Set([...ruleText.matchAll(/\b(solvi_[a-z0-9_]+)/g)].map((m) => m[1]))];

  if (referenced.length === 0) {
    report('ng', 'アラート式から solvi_* を1件も抽出できませんでした', '検査が成立していません');
  } else {
    let known = null;
    try {
      const res = await fetch(`${PROM}/api/v1/label/__name__/values`);
      if (res.ok) known = new Set((await res.json()).data ?? []);
    } catch {
      known = null;
    }

    if (known === null) {
      report(
        'note',
        `Prometheus へ接続できないため ${referenced.length} 件のメトリクス実在を確認できません`,
        'docker compose up -d prometheus を実行してから再検査してください',
      );
    } else {
      // ヒストグラムは _bucket / _sum / _count、カウンタは _total が付く。
      // 接尾辞を剥がして突き合わせる。
      const base = (name) => name.replace(/_(bucket|sum|count|total)$/, '');
      const knownBases = new Set([...known].map(base));

      const missing = referenced.filter((name) => !known.has(name) && !knownBases.has(base(name)));
      if (missing.length === 0) {
        report('ok', `アラートが参照する ${referenced.length} 件のメトリクスがすべて存在する`);
      } else {
        report(
          'ng',
          `${missing.length} 件のメトリクスが存在しない — **参照するアラートは発火しない**`,
          missing.join(', '),
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// C. 公開されているが誰も使っていない関数
//
// 「作ったが繋いでいない」機能を見つける。
// テストからしか呼ばれない公開関数は、**テストは緑だが本番では動かない**。
// これが今回の欠陥のうち少なくとも2件の形だった。
// ---------------------------------------------------------------------------
/**
 * 繋がっていないことを**承知のうえで残している**もの。
 *
 * 黙って除外しない。理由を書き、出力にも並べる。
 * 理由を書けないものはここに入れられない — それが除外の条件である。
 * 消すか繋ぐかしたら、この表からも消すこと。
 */
const ACCEPTED_UNWIRED = {
  signWebhook: 'Webhook送信の受け口がまだ無い。署名だけ先に作った(WP-P2-NTF-005 §6)',
  verifyWebhook: 'signWebhook と同じ理由',
  InMemoryNonceStore: 'signWebhook と同じ理由。永続化版は受け口を作るときに決める',
  assertCanSwitchOrganization:
    'platform_admin の組織横断操作の門番。横断操作の画面と経路がまだ無い',
  // RelationService は WP-P2-RELUI-012 で繋いだので、この表から外した。
  // 繋いだら消す — 残したままだと、次に見た人が「まだ未接続」と読む。
};

process.stdout.write('\nC. 公開されているが本番経路から呼ばれない関数\n');
{
  /**
   * 検査対象は shared パッケージと各サービスの実装。
   *
   * shared だけに絞ってはいけない。**今回見つかった最大の欠陥
   * (Outboxが業務経路から呼ばれていなかった)は services/api の中にあった。**
   * 「共通部品だけ疑う」という絞り方そのものが取りこぼしを作る。
   */
  const candidates = sourceText.filter(
    (f) => f.path.includes('packages/shared/src') || f.path.includes('/src/'),
  );
  const exported = [];
  for (const { path, text } of candidates) {
    for (const m of text.matchAll(/export (?:async )?function ([A-Za-z0-9_]+)/g)) {
      exported.push({ name: m[1], path });
    }
    for (const m of text.matchAll(/export class ([A-Za-z0-9_]+)/g)) {
      exported.push({ name: m[1], path });
    }
    // **公開クラスのメソッドも見る。**
    //
    // ここを見ていなかったため、`TicketService.slaStatus` が
    // 「テストからしか呼ばれていない」ことを捉えられなかった。
    // クラス自体はあちこちで使われているので、検査は「使われている」と
    // 判定してしまう。**使われている物の中に、誰も呼ばないものが隠れる。**
    //
    // `private` は対象外。インデント2つの宣言だけを拾う
    // (入れ子の関数式まで拾うと雑音になる)。
    // クラスを含むファイルだけを対象にする。SQL文字列の中の
    // `concat_ws(` のような行を拾わないため。
    if (!/export class /.test(text)) continue;
    for (const m of text.matchAll(/^ {2}(?:async )?([a-z][A-Za-z0-9_]*)\s*\(/gm)) {
      const line = text.slice(text.lastIndexOf('\n', m.index) + 1, m.index + m[0].length);
      if (/\b(private|protected|constructor|if|for|while|switch|catch|return)\b/.test(line)) {
        continue;
      }
      exported.push({ name: m[1], path, kind: 'method' });
    }
  }

  if (exported.length === 0) {
    report('ng', '公開関数を1件も抽出できませんでした', '検査が成立していません');
  } else {
    const usedInProduction = new Set();
    const usedInTests = new Set();

    // 「呼ばれているか」だけでは足りない。**呼んでいる側が動いていなければ
    // 同じことである。** 実際、監査アンカーの関数群は互いに呼び合っていたが、
    // そのファイル自体をどのエントリポイントも読み込んでいなかった。
    //
    // そこでエントリポイント(各サービスの main、画面、tools)から
    // import を辿り、**到達できるファイル**を先に求める。
    const reachable = reachableFiles(sourceText);

    for (const { path, text } of sourceText) {
      if (!reachable.has(path)) continue;
      // この検査自身は数えない。ACCEPTED_UNWIRED に名前を書いた途端、
      // その名前が「使われている」ことになってしまう。
      if (path.endsWith('tools/check_unwired.mjs')) continue;
      for (const e of exported) {
        if (e.path === path) {
          // 自ファイル内での使用。宣言そのものを除いて2回以上現れるなら、
          // 同じファイルの別の関数から呼ばれている。到達可能なファイルの
          // 中でなら、これは本番で動く経路である。
          const occurrences = text.match(new RegExp(`\\b${e.name}\\b`, 'g'))?.length ?? 0;
          if (occurrences >= 2) usedInProduction.add(e.name);
          continue;
        }
        // メソッドは `service.name(` の形で呼ばれる。名前だけの一致だと
        // 別物の同名変数を拾うため、呼び出しの形で見る。
        if (e.kind === 'method') {
          if (new RegExp(`\\.${e.name}\\s*\\(`).test(text)) usedInProduction.add(e.name);
          continue;
        }
        if (new RegExp(`\\b${e.name}\\b`).test(text)) usedInProduction.add(e.name);
      }
    }
    for (const { text } of testText) {
      for (const e of exported) {
        const pattern =
          e.kind === 'method' ? new RegExp(`\\.${e.name}\\s*\\(`) : new RegExp(`\\b${e.name}\\b`);
        if (pattern.test(text)) usedInTests.add(e.name);
      }
    }

    // **テストからしか呼ばれない**もの。これが最も危険な分類である。
    const testOnly = [...new Set(exported.map((e) => e.name))]
      .filter((n) => usedInTests.has(n) && !usedInProduction.has(n))
      .filter((n) => !(n in ACCEPTED_UNWIRED));
    const unused = [...new Set(exported.map((e) => e.name))].filter(
      (n) => !usedInTests.has(n) && !usedInProduction.has(n),
    );

    if (testOnly.length > 0) {
      report(
        'ng',
        `${testOnly.length} 件が**テストからしか呼ばれていない**`,
        testOnly.join(', ') + '\n       テストは緑だが本番経路では動かない可能性がある',
      );
    } else {
      report('ok', 'テストからしか呼ばれない公開関数は無い');
    }

    if (unused.length > 0) {
      report('note', `${unused.length} 件がどこからも参照されていない`, unused.join(', '));
    }

    // 承知のうえで残しているものを毎回並べる。**一覧に出し続ける。**
    // 除外したものを黙らせると、そのまま忘れられる。
    const accepted = Object.entries(ACCEPTED_UNWIRED).filter(([n]) => !usedInProduction.has(n));
    if (accepted.length > 0) {
      report(
        'note',
        `${accepted.length} 件は未接続を承知で残している`,
        accepted.map(([n, why]) => `${n} — ${why}`).join('\n       '),
      );
    }
    // 表に残ったまま繋がったものは、表から消す。
    const staleEntries = Object.keys(ACCEPTED_UNWIRED).filter((n) => usedInProduction.has(n));
    if (staleEntries.length > 0) {
      report(
        'note',
        `${staleEntries.length} 件は既に接続済み。ACCEPTED_UNWIRED から削除してください`,
        staleEntries.join(', '),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// D. 定義されているが誰も読まない環境変数
//
// 設定したつもりで効いていない状態を見つける。
// ---------------------------------------------------------------------------
process.stdout.write('\nD. 環境変数の定義と参照\n');
{
  const envFile = sourceText.find((f) => f.path.endsWith('config/env.ts'));
  if (!envFile) {
    report('ng', 'env.ts を読めませんでした', '検査が成立していません');
  } else {
    const declared = [
      ...new Set([...envFile.text.matchAll(/^\s{2,4}([A-Z][A-Z0-9_]{2,}):/gm)].map((m) => m[1])),
    ];

    if (declared.length === 0) {
      report('ng', '環境変数を1件も抽出できませんでした', '検査が成立していません');
    } else {
      const used = new Set();
      for (const { path, text } of sourceText) {
        if (path.endsWith('config/env.ts')) continue;
        for (const name of declared) {
          if (text.includes(`env.${name}`) || text.includes(`process.env.${name}`)) used.add(name);
        }
      }
      const never = declared.filter((n) => !used.has(n));
      if (never.length === 0) {
        report('ok', `環境変数 ${declared.length} 件すべてが参照されている`);
      } else {
        report(
          'note',
          `${never.length}/${declared.length} 件の環境変数が読まれていない`,
          never.join(', '),
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// E. down を持たないマイグレーション
//
// 戻せない変更は、問題が起きたときに前へ進むしかなくなる。
// ---------------------------------------------------------------------------
process.stdout.write('\nE. マイグレーションの巻き戻し\n');
{
  let files = [];
  try {
    files = readdirSync(join(ROOT, 'db/migrations')).filter((f) => f.endsWith('.sql'));
  } catch {
    report('ng', 'マイグレーションを読めませんでした', '検査が成立していません');
  }

  if (files.length === 0) {
    report('ng', 'マイグレーションが1件もありません', '検査が成立していません');
  } else {
    const withoutDown = files.filter((f) => {
      const text = readFileSync(join(ROOT, 'db/migrations', f), 'utf8');
      const downIndex = text.indexOf('+migrate down');
      if (downIndex === -1) return true;
      // down 節が空(コメントだけ)も「戻せない」に数える
      const body = text
        .slice(downIndex)
        .split('\n')
        .slice(1)
        .filter((line) => line.trim().length > 0 && !line.trim().startsWith('--'));
      return body.length === 0;
    });

    if (withoutDown.length === 0) {
      report('ok', `マイグレーション ${files.length} 件すべてに down がある`);
    } else {
      report('ng', `${withoutDown.length} 件に down が無い`, withoutDown.join(', '));
    }
  }
}

// ---------------------------------------------------------------------------
process.stdout.write('\n');
if (problems > 0) {
  process.stdout.write(`${problems} 件の問題があります(注記 ${notes} 件)\n`);
  process.exit(1);
}
process.stdout.write(
  `OK: 「定義したが動いていない」箇所は見つかりませんでした(注記 ${notes} 件)\n` +
    '    ただしこの検査は静的な突き合わせであり、実際に動くことの証明ではない。\n' +
    '    実経路の確認は verify_tracing / verify_slo_pipeline / e2e が担う。\n',
);
