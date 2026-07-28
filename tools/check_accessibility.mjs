#!/usr/bin/env node
/**
 * アクセシビリティの自動検査 (Gate A GA-5 / NFR-UX-002)
 *
 * **実ブラウザで検査する。** jsdom のような擬似DOMでも一部の規則は評価できるが、
 * コントラスト比とフォーカスの可視性は**実際に描画しないと判定できない**。
 * そこを落とすと、最も見落としやすい欠陥を検査対象から外すことになる。
 *
 * 検査は「作り込んだこと」の確認ではなく「**通ったこと**」の確認である。
 * ラベルを付けたつもり・コントラストを取ったつもりを、機械が否定する場である。
 *
 * 自動検査で見つかるのはアクセシビリティ問題の一部にすぎない。
 * 読み上げ順序の妥当性や文言の分かりやすさは人が確かめる必要がある(GA-4)。
 * violation 0 は「合格」ではなく「**最低限の水準を割っていない**」を意味する。
 */

import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

const WEB_BASE = process.env.A11Y_WEB_BASE ?? 'http://127.0.0.1:3000';
const API_BASE = process.env.A11Y_API_BASE ?? 'http://127.0.0.1:3001';
const EMAIL = process.env.A11Y_EMAIL;
const PASSWORD = process.env.A11Y_PASSWORD;
const ORG = process.env.A11Y_ORG;

/**
 * 適用する規則。
 *
 * WCAG 2.2 AA まで(11.10 / NFR-UX-002)。
 * `best-practice` は含めない — 望ましいが必須ではない指摘が混ざり、
 * 「対応しなくてよい違反」が一覧に並ぶことになる。
 * そうなると一覧そのものが読まれなくなり、本当の違反が埋もれる。
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** ログインして、認証済みの画面も検査できるようにする。 */
async function authenticate(context) {
  if (!EMAIL || !PASSWORD || !ORG) return false;

  const response = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, organizationId: ORG }),
  });
  if (!response.ok) throw new Error(`ログインに失敗しました: ${response.status}`);

  const setCookie = response.headers.get('set-cookie') ?? '';
  const pair = setCookie.split(';')[0] ?? '';
  const index = pair.indexOf('=');
  if (index <= 0) throw new Error('セッションCookieを取得できませんでした');

  await context.addCookies([
    {
      name: pair.slice(0, index),
      value: pair.slice(index + 1),
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ]);
  return true;
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext();

  const authenticated = await authenticate(context);
  if (!authenticated) {
    process.stdout.write(
      '注記 A11Y_EMAIL / A11Y_PASSWORD / A11Y_ORG が未設定のため、\n' +
        '     認証が必要な画面は検査できません。ログイン画面のみを検査します。\n\n',
    );
  }

  /** @type {Array<{name: string, path: string, requiresAuth: boolean}>} */
  const screens = [
    { name: 'ログイン', path: '/login', requiresAuth: false },
    { name: 'ログイン(エラー表示)', path: '/login?error=1', requiresAuth: false },
    { name: 'Portalトップ', path: '/', requiresAuth: true },
    { name: '起票フォーム(障害)', path: '/tickets/new?kind=incident', requiresAuth: true },
    { name: '起票フォーム(依頼)', path: '/tickets/new?kind=request', requiresAuth: true },
    { name: '対応待ちの一覧(担当者)', path: '/ops', requiresAuth: true },
    {
      name: '起票フォーム(エラー表示)',
      path: '/tickets/new?kind=incident&error=1&field=subject:%E4%BB%B6%E5%90%8D%E3%82%92%E5%85%A5%E5%8A%9B%E3%81%97%E3%81%A6%E3%81%8F%E3%81%A0%E3%81%95%E3%81%84',
      requiresAuth: true,
    },
  ];

  // 担当者の作業画面は実チケットが必要なため、パスを実行時に決める。
  // 「画面が無いから検査しない」にすると、最も操作の多い画面が
  // 検査対象から外れることになる。
  if (authenticated && process.env.A11Y_TICKET_ID) {
    screens.push({
      name: '担当者の作業画面',
      path: `/ops/${process.env.A11Y_TICKET_ID}`,
      requiresAuth: true,
    });
    screens.push({
      name: '問い合わせ詳細(依頼者)',
      path: `/tickets/${process.env.A11Y_TICKET_ID}`,
      requiresAuth: true,
    });
    // 統合の確認画面 (WP-P2-RELUI-012)。**取り消せない操作の画面**であり、
    // ここで読み違えると元に戻せない。確認表が支援技術から読めることを確かめる。
    screens.push({
      name: '統合の確認(相手未指定)',
      path: `/ops/${process.env.A11Y_TICKET_ID}/merge`,
      requiresAuth: true,
    });
    if (process.env.A11Y_MERGE_TARGET) {
      screens.push({
        name: '統合の確認(確認表あり)',
        path: `/ops/${process.env.A11Y_TICKET_ID}/merge?target=${encodeURIComponent(
          process.env.A11Y_MERGE_TARGET,
        )}`,
        requiresAuth: true,
      });
    }
  }

  let totalViolations = 0;
  let checked = 0;
  let skipped = 0;

  const page = await context.newPage();

  for (const screen of screens) {
    if (screen.requiresAuth && !authenticated) {
      process.stdout.write(`  SKIP ${screen.name} — 認証が必要\n`);
      skipped += 1;
      continue;
    }

    await page.goto(`${WEB_BASE}${screen.path}`, { waitUntil: 'networkidle' });

    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    checked += 1;

    if (results.violations.length === 0) {
      process.stdout.write(`  OK   ${screen.name}\n`);
      continue;
    }

    totalViolations += results.violations.length;
    process.stdout.write(`  NG   ${screen.name} — ${results.violations.length} 件\n`);
    for (const violation of results.violations) {
      process.stdout.write(`         [${violation.impact}] ${violation.id}: ${violation.help}\n`);
      for (const node of violation.nodes.slice(0, 3)) {
        process.stdout.write(`           ${node.target.join(' ')}\n`);
        // 修正の手がかりを出す。規則名だけでは何を直せばよいか分からない。
        const summary = (node.failureSummary ?? '').split('\n').filter(Boolean).slice(1, 3);
        for (const line of summary) process.stdout.write(`             ${line.trim()}\n`);
      }
      if (violation.nodes.length > 3) {
        process.stdout.write(`           ほか ${violation.nodes.length - 3} 箇所\n`);
      }
    }
  }

  await browser.close();

  process.stdout.write(`\n検査した画面: ${checked}`);
  if (skipped > 0) process.stdout.write(` / 未検査: ${skipped}`);
  process.stdout.write('\n');

  if (skipped > 0) {
    // 未検査があるまま「合格」と書かない。検査できていない画面は
    // 「違反が無い」ことの根拠にならない。
    process.stdout.write(
      `\n未検査の画面があるため、GA-5 の判定には使えません。\n` +
        `A11Y_EMAIL / A11Y_PASSWORD / A11Y_ORG を設定して再実行してください。\n`,
    );
    process.exit(1);
  }

  if (totalViolations > 0) {
    process.stdout.write(`\n${totalViolations} 件の違反があります\n`);
    process.exit(1);
  }

  process.stdout.write(
    '\nOK: WCAG 2.2 AA の自動検査で違反はありません\n' +
      '    ただし自動検査で見つかるのは一部にすぎません。読み上げ順序や\n' +
      '    文言の分かりやすさは人による確認が必要です(Gate A GA-4)。\n',
  );
}

await main();
