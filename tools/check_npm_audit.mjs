#!/usr/bin/env node
/**
 * 依存の脆弱性検査(NFR-SEC-008 / G1-6)
 *
 * `npm audit --audit-level=high` の置き換え。**判定基準は緩めない。**
 * Critical/High が1件でもあれば失敗する。例外は次の条件をすべて満たすときに限る。
 *
 *   1. 本番依存(`npm audit --omit=dev`)には**例外を一切認めない**。
 *      本番依存に Critical/High があれば、例外一覧に関係なく失敗する。
 *   2. 開発依存の例外は GHSA ID 単位で、下の DEV_EXCEPTIONS に**理由と期限**を書く。
 *   3. 期限を過ぎた例外は無効になり、CI は再び失敗する。延長するには
 *      期限を書き換えるPR(=人間のレビュー)が必要になる。
 *   4. アドバイザリの影響範囲(range)が記録と変わったら例外は無効になる。
 *      修正版が出ると range が変わるので、そこで依存を更新する。
 *   5. 監査結果に現れない例外が残っていたら失敗する。不要な例外を残さない。
 *
 * npm audit の出力を解釈できないときは失敗する(fail closed)。
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BLOCKING = new Set(['high', 'critical']);

/**
 * 開発依存に限った、期限付きの例外。
 * 追加・延長はセキュリティ関連の変更として人間のレビューを受ける(AGENTS.md §1.16)。
 */
export const DEV_EXCEPTIONS = [];

/** npm audit の JSON から、アドバイザリ単位の一覧を作る。 */
function advisoriesOf(report) {
  if (!report || typeof report !== 'object' || typeof report.vulnerabilities !== 'object') {
    throw new Error('npm audit の出力を解釈できません');
  }
  const byId = new Map();
  for (const vuln of Object.values(report.vulnerabilities)) {
    for (const via of vuln.via ?? []) {
      if (typeof via !== 'object' || via === null) continue; // 推移的な参照。本体は別項目で数える
      const id = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i.exec(via.url ?? '')?.[0];
      const key = id ?? `${via.name}:${via.source}`;
      if (!byId.has(key)) {
        byId.set(key, {
          id: key,
          package: via.name,
          severity: via.severity,
          range: via.range,
          title: via.title,
        });
      }
    }
  }
  return [...byId.values()];
}

/**
 * @param {{ full: object, prod: object, exceptions?: typeof DEV_EXCEPTIONS, today: string }} input
 *   today は UTC の YYYY-MM-DD
 * @returns {{ ok: boolean, failures: string[], allowed: string[] }}
 */
export function evaluateAudit({ full, prod, exceptions = DEV_EXCEPTIONS, today }) {
  const failures = [];
  const allowed = [];

  for (const a of advisoriesOf(prod)) {
    if (BLOCKING.has(a.severity)) {
      failures.push(`本番依存: ${a.id} ${a.package} (${a.severity}) ${a.title} — 例外は認めない`);
    }
  }

  const fullAdvisories = advisoriesOf(full);
  for (const a of fullAdvisories) {
    if (!BLOCKING.has(a.severity)) continue;
    const ex = exceptions.find((e) => e.id === a.id);
    if (!ex) {
      failures.push(`${a.id} ${a.package} (${a.severity}) ${a.title}`);
    } else if (ex.package !== a.package || ex.range !== a.range) {
      failures.push(
        `${a.id}: 影響範囲が例外の記録と異なる(記録 ${ex.package} ${ex.range} / 現在 ${a.package} ${a.range})。修正版を確認して依存を更新する`,
      );
    } else if (today > ex.expires) {
      failures.push(`${a.id}: 例外の期限 ${ex.expires} を過ぎた`);
    } else {
      allowed.push(`${a.id} ${a.package} ${a.range} (${a.severity}) — 期限 ${ex.expires}`);
    }
  }

  for (const ex of exceptions) {
    if (!fullAdvisories.some((a) => a.id === ex.id)) {
      failures.push(`${ex.id}: 監査結果に現れない例外が残っている。DEV_EXCEPTIONS から削除する`);
    }
  }

  return { ok: failures.length === 0, failures, allowed };
}

function runAudit(extraArgs) {
  // npm audit は脆弱性があると非0で終わる。終了コードではなく JSON で判定する。
  const r = spawnSync('npm', ['audit', '--json', ...extraArgs], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  try {
    const parsed = JSON.parse(r.stdout);
    if (parsed.error) throw new Error(parsed.error.summary ?? 'npm audit がエラーを返した');
    return parsed;
  } catch (e) {
    process.stderr.write(r.stderr ?? '');
    throw new Error(`npm audit ${extraArgs.join(' ')} を実行できません: ${e.message}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const result = evaluateAudit({
      full: runAudit([]),
      prod: runAudit(['--omit=dev']),
      today,
    });
    for (const line of result.allowed) process.stdout.write(`  例外  ${line}\n`);
    for (const line of result.failures) process.stdout.write(`  NG    ${line}\n`);
    if (!result.ok) {
      process.stdout.write(`\n依存の脆弱性検査: 失敗 (${result.failures.length} 件)\n`);
      process.exit(1);
    }
    process.stdout.write('\n依存の脆弱性検査: OK(Critical/High は例外一覧のもののみ)\n');
  } catch (e) {
    process.stdout.write(`  NG    ${e.message}\n`);
    process.exit(1);
  }
}
