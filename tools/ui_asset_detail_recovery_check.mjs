/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import { access, chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidenceRoot = resolve(root, 'evidence/WP-P2-ASTDET-066');
const privateMarker = 'WP066_PRIVATE_PROBLEM_MARKER';
const assetId = '06600000-0000-4000-8000-000000000100';
const ticketId = '06600000-0000-4000-8000-000000000200';
const basePath = '/assets/' + assetId;
const returnQuery = new URLSearchParams({
  q: '合成 & %_\\?',
  state: 'in_use',
  kind: 'pc',
  assignment: 'mine',
  page: '2',
}).toString();
const returnPath = '/assets?' + returnQuery;
const detailPath = basePath + '?' + new URLSearchParams({ returnTo: returnPath });
const assetHeading = 'SYN-AST-001 · 合成検証資産 001';
const expectedChecks = 22;
const faultModes = [
  '400',
  '401',
  '403',
  '500',
  '503',
  'network',
  'body_cut',
  '403_body_cut',
  'invalid_json',
];
const errorMessages = {
  400: '資産を指定する情報が正しくありません。一覧から資産を選び直してください。',
  401: 'ログイン状態を確認できませんでした。ログインし直してから、もう一度お試しください。',
  403: 'この資産を表示する権限がありません。必要な場合は管理者に確認してください。',
  503: '一時的に資産を取得できませんでした。時間をおいて、もう一度お試しください。',
};

/** Real Next.js/Chromium only; every backend response and cookie is synthetic. */
export async function runAssetDetailRecoveryChecks({
  baseURL,
  outputDirectory,
  control,
  assetReads,
  allReads,
  assertOwned,
  signal,
}) {
  const target = new URL(baseURL);
  assert.ok(
    target.protocol === 'http:' &&
      target.hostname === '127.0.0.1' &&
      target.port &&
      !['3000', '3001'].includes(target.port) &&
      target.pathname === '/' &&
      !target.username &&
      !target.password &&
      !target.search &&
      !target.hash,
  );
  assert.equal(typeof control, 'function');
  assert.equal(typeof assetReads, 'function');
  assert.equal(typeof allReads, 'function');
  assert.equal(typeof assertOwned, 'function');
  const output = resolve(outputDirectory);
  const within = relative(evidenceRoot, output);
  assert.ok(within && !within.startsWith('..') && !isAbsolute(within));
  assert.equal(await realpath(dirname(output)), dirname(output));
  await access(chromium.executablePath()); // Never install or download a browser.
  if (signal?.aborted) throw new Error('ASSET_UI_ABORTED');
  await mkdir(output, { mode: 0o700 });
  const report = {
    workPackage: 'WP-P2-ASTDET-066',
    model: 'Real copied production Next.js UI with loopback synthetic API and synthetic session.',
    actualDetailRendererTested: true,
    realDatabaseTested: false,
    realAuthorizationTested: false,
    productionAcceptance: false,
    startedAt: new Date().toISOString(),
    checks: [],
    screenshots: [],
    axe: [],
    browserRequests: { nonReadCount: 0, methods: {} },
    cleanup: { browserClosed: false },
    success: false,
  };
  let browser, context, page;
  let mode = 'normal';
  let step = 'initial';
  let cancellation = Promise.resolve();
  const onBrowserRequest = (request) => {
    const method = request.method();
    if (method === 'GET' || method === 'HEAD') return;
    const safeMethod = ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE'].includes(
      method,
    )
      ? method
      : 'OTHER';
    report.browserRequests.nonReadCount++;
    report.browserRequests.methods[safeMethod] =
      (report.browserRequests.methods[safeMethod] ?? 0) + 1;
  };
  const onAbort = () => {
    cancellation = Promise.allSettled([
      Promise.resolve().then(() => context?.close()),
      Promise.resolve().then(() => browser?.close()),
    ]).then(() => undefined);
  };
  const live = async () => {
    if (signal?.aborted) throw new Error('ASSET_UI_ABORTED');
    await assertOwned();
    if (signal?.aborted) throw new Error('ASSET_UI_ABORTED');
  };
  const scenario = async (next) => {
    await live();
    await control(next);
    mode = next;
  };
  const main = () => page.locator('main');
  const retry = () => main().getByRole('link', { name: '再取得する', exact: true });
  const editor = () =>
    main().getByRole('link', { name: '資産・状態・利用者を編集する', exact: true });
  const back = () => main().getByRole('link', { name: '元の画面へ戻る', exact: true });
  const fallback = () => main().getByRole('link', { name: '資産一覧へ戻る', exact: true });
  async function open(path = detailPath) {
    step = 'open';
    await live();
    await page.goto(target.origin + path, { waitUntil: 'networkidle' });
    await main().getByRole('heading', { level: 1 }).waitFor();
  }
  async function successful() {
    step = 'normal-detail';
    await main().getByRole('heading', { name: assetHeading, level: 1, exact: true }).waitFor();
    await main().getByRole('heading', { name: '関連するチケット', exact: true }).waitFor();
    assert.equal(await main().getByRole('alert').count(), 0);
    assert.equal(await retry().count(), 0);
    assert.equal(await main().locator('form').count(), 0);
    for (const text of [
      'PC',
      '使用中',
      '合成利用者',
      '合成モデル',
      'SYN-0',
      'synthetic-0',
      'Synthetic vendor',
    ])
      assert.ok((await main().innerText()).includes(text));
  }
  async function rejected(status) {
    step = 'error-boundary';
    await main()
      .getByRole('heading', { name: '資産を読み込めませんでした', level: 1, exact: true })
      .waitFor();
    await main().getByRole('alert').waitFor();
    assert.equal(await main().getByRole('alert').innerText(), errorMessages[status]);
    assert.equal(await main().getByRole('status').count(), 0);
    assert.equal(await main().locator('form, dl, table, details').count(), 0);
    assert.equal(await editor().count(), 0);
    const text = await main().innerText();
    for (const value of [
      privateMarker,
      'SYN-AST-001',
      '合成モデル',
      '合成内部メモ',
      '合成保管場所',
      '合成変更理由',
      '合成関連理由',
      'SYN-TKT-001',
    ])
      assert.equal(text.includes(value), false);
    assert.equal(
      await main().getByRole('link', { name: 'ポータルへ戻る', exact: true }).getAttribute('href'),
      '/portal',
    );
  }
  async function freshNavigation(link, path, keyboard = false) {
    step = 'native-anchor';
    assert.equal(await link.evaluate((node) => node.tagName), 'A');
    assert.equal(await link.getAttribute('href'), path);
    const url = new URL(path, target);
    assert.equal(url.origin, target.origin);
    assert.equal(url.pathname, basePath);
    const before = assetReads().length;
    const navigation = page.waitForRequest(
      (request) =>
        request.isNavigationRequest() &&
        request.method() === 'GET' &&
        request.url() === target.origin + path,
    );
    if (keyboard) await page.keyboard.press('Enter');
    else await link.click();
    await navigation;
    await page.waitForLoadState('networkidle');
    await successful();
    step = 'fresh-api-get';
    const fresh = assetReads().slice(before);
    assert.ok(fresh.length > 0);
    assert.ok(fresh.every((request) => request.route === 'detail' && request.query === ''));
    assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, path);
    assert.equal(await main().getByRole('status').count(), 0);
    return {
      apiReadsIncreased: true,
      nativeDocumentGet: true,
      sameAssetPath: true,
      returnToRetained: url.searchParams.get('returnTo'),
      successFlashOmitted: true,
    };
  }
  async function shot(name, captureTarget = null) {
    step = 'capture';
    await live();
    if (captureTarget) {
      await captureTarget.scrollIntoViewIfNeeded();
      const box = await captureTarget.boundingBox();
      assert.ok(box && box.y >= 0 && box.y + box.height <= page.viewportSize().height + 1);
    } else {
      await page.evaluate(() => globalThis.scrollTo(0, 0));
    }
    const file = resolve(output, name + '.png');
    await page.screenshot({ path: file, fullPage: false });
    await chmod(file, 0o600);
    report.screenshots.push({
      name,
      captureType: 'viewport',
      captureTarget: captureTarget ? 'asserted-visible-guidance-or-first-item' : 'page-top',
      viewport: page.viewportSize(),
      model: 'synthetic API',
      scenario: mode,
    });
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    await writeFile(resolve(output, name + '-axe.json'), JSON.stringify(result, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    report.axe.push({
      name,
      violations: result.violations.map(({ id, impact, nodes }) => ({
        id,
        impact,
        count: nodes.length,
      })),
    });
    assert.equal(result.violations.length, 0);
  }
  async function tabTo(locator) {
    step = 'keyboard-focus';
    for (let i = 0; i < 100; i++) {
      await page.keyboard.press('Tab');
      if (await locator.evaluate((node) => document.activeElement === node)) {
        const focused = await locator.evaluate((node) => {
          const style = getComputedStyle(node);
          return (
            node.matches(':focus-visible') &&
            parseFloat(style.outlineWidth) > 0 &&
            style.outlineStyle !== 'none'
          );
        });
        assert.ok(focused);
        return;
      }
    }
    assert.fail('ASSET_UI_FOCUS');
  }
  async function geometry() {
    step = 'viewport-width';
    const widths = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }));
    return { pageOverflow: widths.document > widths.viewport + 1, ...widths };
  }
  async function role(value) {
    assert.ok(['agent', 'auditor', 'requester'].includes(value));
    await context.addCookies([
      {
        name: 'solvi_session_wp066_synthetic',
        value,
        url: target.origin,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
  }
  async function check(name, operation) {
    await live();
    step = 'start';
    try {
      const observations = await operation();
      await live();
      report.checks.push({ name, passed: true, observations: observations ?? {} });
    } catch {
      report.checks.push({
        name,
        passed: false,
        step,
        failureCode: signal?.aborted ? 'ASSET_UI_ABORTED' : 'ASSET_UI_ASSERTION_FAILED',
      });
    } finally {
      if (!signal?.aborted) {
        await scenario('normal');
        if (context) await role('agent');
      }
    }
  }
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await live();
    browser = await chromium.launch({ headless: true });
    await live();
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
      locale: 'ja-JP',
    });
    context.on('request', onBrowserRequest);
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (!['data:', 'blob:', 'about:'].includes(url.protocol) && url.origin !== target.origin)
        return route.abort();
      return route.continue();
    });
    await context.addCookies([
      {
        name: 'solvi_session_wp066_synthetic',
        value: 'agent',
        url: target.origin,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    page = await context.newPage();
    page.setDefaultTimeout(12_000);
    const relatedCreate = () =>
      main().getByRole('link', { name: 'この資産から変更計画を作成する', exact: true });
    const snapshot = () => main().getByText('この版の内容を見る', { exact: true });
    async function hrefReady(link, pathname, from) {
      await page.waitForFunction(
        ({ text, expected }) => {
          const a = [...document.querySelectorAll('main a')].find(
            (node) => node.textContent === text,
          );
          return a && new URL(a.href).searchParams.get('returnTo') === expected;
        },
        { text: await link.textContent(), expected: from },
      );
      const url = new URL(await link.getAttribute('href'), target);
      assert.equal(url.origin, target.origin);
      assert.equal(url.pathname, pathname);
      assert.equal(url.searchParams.get('returnTo'), from);
      return url;
    }
    async function privateDetailsPresent() {
      assert.equal(await main().getByRole('heading', { name: '内部メモ', exact: true }).count(), 1);
      assert.ok((await main().innerText()).includes('合成保管場所'));
      assert.ok((await main().innerText()).includes('合成内部メモ'));
      await main().getByRole('heading', { name: '資産の変更履歴', exact: true }).waitFor();
      assert.equal(await snapshot().count(), 2);
      assert.equal(await main().getByText('版1 → 版2：変更した2項目', { exact: true }).count(), 1);
      const history = main().getByText('チケットとの関連履歴（最新100件）', { exact: true });
      await history.click();
      assert.equal(await main().getByText('合成関連理由', { exact: true }).isVisible(), true);
      await snapshot().first().click();
      assert.ok((await main().innerText()).includes('合成変更理由'));
    }
    await check('agent-detail-saved-editor-private-fields-and-history', async () => {
      await open(detailPath + '&saved=1');
      await successful();
      assert.equal(await main().getByRole('status').innerText(), '資産と履歴を保存しました。');
      assert.equal(await editor().count(), 1);
      assert.equal(await relatedCreate().count(), 1);
      await privateDetailsPresent();
      const cleanFrom = detailPath;
      await hrefReady(editor(), basePath + '/edit', cleanFrom);
      const changes = await hrefReady(
        main().getByRole('link', { name: '関連する変更一覧を開く', exact: true }),
        '/changes',
        cleanFrom,
      );
      assert.equal(changes.searchParams.get('assetId'), assetId);
      assert.equal(
        await main()
          .getByRole('link', { name: 'SYN-TKT-001 · 合成関連チケット', exact: true })
          .getAttribute('href'),
        '/ops/' + ticketId,
      );
      await page.waitForFunction(
        (expected) =>
          [...document.querySelectorAll('main a')].some(
            (a) => a.textContent === '元の画面へ戻る' && a.getAttribute('href') === expected,
          ),
        returnPath,
      );
      await shot('agent-desktop');
      await shot(
        'agent-revisions',
        main().getByRole('heading', { name: '資産の変更履歴', exact: true }),
      );
      return {
        renderer: 'real Next asset detail',
        syntheticRole: 'agent',
        canManage: true,
        privateFields: true,
        realAuthorizationTested: false,
      };
    });
    await check('auditor-detail-private-read-without-editor', async () => {
      await role('auditor');
      await open();
      await successful();
      assert.equal(await editor().count(), 0);
      assert.equal(await relatedCreate().count(), 0);
      await privateDetailsPresent();
      assert.equal(
        await main()
          .getByRole('link', { name: 'SYN-TKT-001 · 合成関連チケット', exact: true })
          .getAttribute('href'),
        '/tickets/' + ticketId,
      );
      await shot('auditor-desktop');
      return { canManage: false, privateFields: true, realAuthorizationTested: false };
    });
    await check('requester-detail-redacted-dto-and-ticket-link', async () => {
      await role('requester');
      await open();
      await successful();
      assert.equal(await editor().count(), 0);
      assert.equal(await relatedCreate().count(), 0);
      assert.equal(await main().getByRole('heading', { name: '内部メモ', exact: true }).count(), 0);
      assert.equal(
        await main().getByRole('heading', { name: '資産の変更履歴', exact: true }).count(),
        0,
      );
      assert.equal(await snapshot().count(), 0);
      assert.equal(
        await main().getByText('チケットとの関連履歴（最新100件）', { exact: true }).count(),
        0,
      );
      assert.equal(
        await main().getByRole('heading', { name: '関連する通常変更', exact: true }).count(),
        0,
      );
      for (const text of ['合成保管場所', '合成内部メモ', '合成変更理由', '合成関連理由'])
        assert.equal((await main().innerText()).includes(text), false);
      assert.equal(
        await main()
          .getByRole('link', { name: 'SYN-TKT-001 · 合成関連チケット', exact: true })
          .getAttribute('href'),
        '/tickets/' + ticketId,
      );
      await shot('requester-desktop');
      return { syntheticPrivateFieldsOmitted: true, realAssignedPopulationTested: false };
    });
    await check('dto-can-manage-controls-editor-without-role-inference', async () => {
      await scenario('no_manage');
      await open();
      await successful();
      assert.equal(await editor().count(), 0);
      assert.equal(
        await main()
          .getByRole('link', { name: 'SYN-TKT-001 · 合成関連チケット', exact: true })
          .getAttribute('href'),
        '/tickets/' + ticketId,
      );
    });
    for (const fault of faultModes) {
      await check('failure-' + fault + '-native-detail-recovery', async () => {
        await scenario(fault);
        const relatedBefore = allReads().filter((r) => r.route === 'related-changes').length;
        await open(detailPath + '&saved=1&created=1&updated=1&unknown=synthetic');
        const status =
          fault === '403_body_cut' ? '403' : Object.hasOwn(errorMessages, fault) ? fault : '503';
        await rejected(status);
        assert.equal(await retry().getAttribute('href'), detailPath);
        assert.equal(await back().getAttribute('href'), returnPath);
        assert.equal(allReads().filter((r) => r.route === 'related-changes').length, relatedBefore);
        await shot('error-' + fault, main().getByRole('alert'));
        await scenario('normal');
        return {
          ...(await freshNavigation(retry(), detailPath)),
          expectedReaderStatus:
            fault === 'invalid_json' ? 502 : fault === '500' ? 500 : Number(status),
          readerStatusMeasuredInUi: false,
          sessionEndpointHealthy: true,
          errorBodyMarkerHidden: true,
          relatedPanelNotReadOnError: true,
        };
      });
    }
    for (const fault of ['404', '404_body_cut']) {
      await check('not-found-' + fault + '-preserves-existing-exits', async () => {
        await scenario(fault);
        await open();
        await main()
          .getByRole('heading', { name: 'お探しの画面は見つかりませんでした', exact: true })
          .waitFor();
        assert.ok(
          (await main().innerText()).includes(
            'URLが変わったか、閲覧できる範囲の外にある可能性があります。',
          ),
        );
        assert.equal(await retry().count(), 0);
        assert.equal(await editor().count(), 0);
        assert.equal(await main().locator('dl, table, details').count(), 0);
        assert.equal((await main().innerText()).includes(privateMarker), false);
        assert.equal(
          await main()
            .getByRole('link', { name: '問い合わせの一覧(依頼者)へ', exact: true })
            .getAttribute('href'),
          '/',
        );
        assert.equal(
          await main()
            .getByRole('link', { name: '対応待ちの一覧(担当者)へ', exact: true })
            .getAttribute('href'),
          '/ops',
        );
        await shot('not-found-' + fault);
        return { existingNotFound: true, noExistenceDisclosure: true, noRetryAdded: true };
      });
    }
    await check('valid-filtered-asset-list-return-uses-real-list-renderer', async () => {
      await scenario('503');
      await open();
      await rejected('503');
      assert.equal(await back().getAttribute('href'), returnPath);
      const before = allReads().filter((r) => r.route === 'list').length;
      const navigation = page.waitForRequest(
        (r) =>
          r.isNavigationRequest() && r.method() === 'GET' && r.url() === target.origin + returnPath,
      );
      await back().click();
      await navigation;
      await page.waitForLoadState('networkidle');
      await main().getByRole('heading', { name: '資産台帳', exact: true }).waitFor();
      assert.equal(page.url(), target.origin + returnPath);
      assert.equal(await main().getByLabel('状態', { exact: true }).inputValue(), 'in_use');
      assert.equal(await main().getByLabel('種別', { exact: true }).inputValue(), 'pc');
      assert.equal(await main().getByLabel('利用者の割当', { exact: true }).inputValue(), 'mine');
      assert.ok(allReads().filter((r) => r.route === 'list').length > before);
      assert.ok(allReads().some((r) => r.route === 'list' && r.query === returnQuery));
      await shot('return-filtered-list');
      return { realAssetListRenderer: true, conditionsRetained: 5, nativeDocumentGet: true };
    });
    await check('other-allowed-return-target-is-preserved-without-navigation', async () => {
      await scenario('503');
      const from = '/requests?q=synthetic&state=submitted&page=2';
      const path = basePath + '?' + new URLSearchParams({ returnTo: from });
      await open(path);
      await rejected('503');
      assert.equal(await back().getAttribute('href'), from);
      assert.equal(await retry().getAttribute('href'), path);
      await scenario('normal');
      return await freshNavigation(retry(), path);
    });
    await check('missing-unsafe-and-repeated-return-target-fallback', async () => {
      for (const query of [
        '',
        'returnTo=https%3A%2F%2Fexample.test',
        'returnTo=%2F%2Fexample.test',
        'returnTo=%2Fassets%5Cunsafe',
        'returnTo=%2Fassets&returnTo=%2Frequests',
      ]) {
        await scenario('503');
        await open(basePath + (query ? '?' + query : ''));
        await rejected('503');
        assert.equal(await retry().getAttribute('href'), basePath);
        assert.equal(await fallback().getAttribute('href'), '/assets');
        assert.equal(await back().count(), 0);
      }
      await shot('fallback-return', main().getByRole('alert'));
      await scenario('normal');
      return await freshNavigation(retry(), basePath);
    });
    await check('return-target-flash-and-top-unknown-parameters-removed', async () => {
      await scenario('503');
      const rawReturn = returnPath + '&saved=1&created=1&updated=1';
      await open(
        basePath +
          '?' +
          new URLSearchParams({
            returnTo: rawReturn,
            saved: '1',
            created: '1',
            updated: '1',
            unknown: 'synthetic',
          }),
      );
      await rejected('503');
      assert.equal(await retry().getAttribute('href'), detailPath);
      assert.equal(await back().getAttribute('href'), returnPath);
      await scenario('normal');
      return await freshNavigation(retry(), detailPath);
    });
    await check('invalid-uuid-fails-before-api-without-retry', async () => {
      const before = allReads().length;
      await open('/assets/not-a-uuid?returnTo=%2Fassets');
      await rejected('400');
      assert.equal(await retry().count(), 0);
      assert.equal(allReads().length, before);
      assert.equal(await back().getAttribute('href'), '/assets');
      await shot('invalid-uuid-400', main().getByRole('alert'));
      return { apiAssetOrRelatedReads: 0, endpointInjectionTestedInUnit: true, retryAbsent: true };
    });
    await check('keyboard-retry-visible-focus-enter-and-recovered-detail', async () => {
      await scenario('503');
      await open();
      await rejected('503');
      await tabTo(retry());
      await shot('keyboard-retry-focus', retry());
      await scenario('normal');
      return {
        ...(await freshNavigation(retry(), detailPath, true)),
        keyboard: 'Tab then Enter',
        focusVisible: true,
      };
    });
    await check('mobile-real-detail-error-and-recovery', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await role('requester');
      await open();
      await successful();
      assert.equal((await geometry()).pageOverflow, false);
      await shot('requester-mobile-390');
      await scenario('503');
      await open();
      await rejected('503');
      assert.equal((await geometry()).pageOverflow, false);
      await shot('error-mobile-390', main().getByRole('alert'));
      await scenario('normal');
      return await freshNavigation(retry(), detailPath);
    });
  } catch {
    report.failureCode = signal?.aborted ? 'ASSET_UI_ABORTED' : 'ASSET_UI_RUN_FAILED';
  } finally {
    await cancellation;
    try {
      await browser?.close();
      report.cleanup.browserClosed = true;
    } catch {
      report.cleanup.browserClosed = false;
    }
    signal?.removeEventListener('abort', onAbort);
    context?.off('request', onBrowserRequest);
    if (signal?.aborted) report.failureCode = 'ASSET_UI_ABORTED';
    report.finishedAt = new Date().toISOString();
    report.success =
      !signal?.aborted &&
      !report.failureCode &&
      report.checks.length === expectedChecks &&
      report.checks.every((item) => item.passed) &&
      report.browserRequests.nonReadCount === 0 &&
      report.cleanup.browserClosed;
    writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  }
  if (signal?.aborted) throw new Error('ASSET_UI_ABORTED');
  return report;
}
