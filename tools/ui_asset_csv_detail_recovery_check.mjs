/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import { access, chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidenceRoot = resolve(root, 'evidence/WP-P2-CSVDET-070');
const privateMarker = 'WP070_PRIVATE_PROBLEM_MARKER';
const returnQuery = new URLSearchParams({
  q: '合成 & %_\\?',
  state: 'in_use',
  kind: 'pc',
  assignment: 'mine',
  page: '2',
}).toString();
const returnPath = '/assets?' + returnQuery;
const importId = '07000000-0000-4000-8000-000000000400';
const entryPath = '/assets/imports/' + importId;
const detailPath = (from = returnPath) => entryPath + '?' + new URLSearchParams({ returnTo: from });
const expectedChecks = 23;
const faultModes = ['400', '401', '500', '503', 'network', 'body_cut', 'invalid_json'];
const errorMessages = {
  400: '取込内容を指定する情報が正しくありません。取込履歴から選び直してください。',
  401: 'ログイン状態を確認できませんでした。ログインし直してから、もう一度お試しください。',
  503: '一時的に取込内容を読み込めませんでした。時間をおいて、もう一度お試しください。',
};

/** Real Next.js/Chromium only; every backend response and cookie is synthetic. */
export async function runAssetCsvDetailRecoveryChecks({
  baseURL,
  outputDirectory,
  control,
  detailReads,
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
  assert.equal(typeof detailReads, 'function');
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
    workPackage: 'WP-P2-CSVDET-070',
    model: 'Real copied production Next.js UI with loopback synthetic API and synthetic session.',
    actualImportDetailRendererTested: true,
    actualApplyFormRendererTested: true,
    formSubmissionTested: false,
    csvInspectPreviewApplyTested: false,
    errorReportDownloaded: false,
    realDatabaseTested: false,
    realAuthorizationTested: false,
    productionAcceptance: false,
    startedAt: new Date().toISOString(),
    checks: [],
    screenshots: [],
    axe: [],
    readOnlyBoundary:
      'The owned browser blocks GET/HEAD to the same-origin fixed import errors path before forwarding. Download renderer is not tested.',
    browserRequests: {
      nonReadCount: 0,
      methods: {},
      errorReportAttempts: 0,
      errorReportBlocked: 0,
      errorReportForwarded: 0,
      downloads: 0,
    },
    cleanup: { browserClosed: false },
    success: false,
  };
  let browser, context, page;
  let mode = { detail: 'normal', view: 'preview' };
  let step = 'initial';
  let cancellation = Promise.resolve();
  const onBrowserRequest = (request) => {
    const url = new URL(request.url());
    if (url.origin === target.origin && url.pathname === entryPath + '/errors')
      report.browserRequests.errorReportAttempts++;
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
    mode = { detail: 'normal', view: 'preview', ...next };
  };
  const main = () => page.locator('main');
  const retry = () => main().getByRole('link', { name: '再取得する', exact: true });
  const back = () => main().getByRole('link', { name: '元の画面へ戻る', exact: true });
  const fallback = () => main().getByRole('link', { name: '取込履歴へ戻る', exact: true });
  async function open(path) {
    step = 'open-document';
    await live();
    await page.goto(target.origin + path, { waitUntil: 'domcontentloaded' });
    step = 'open-heading';
    await main().getByRole('heading', { level: 1 }).waitFor();
  }
  async function contextualHref(link, pathname) {
    step = 'contextual-href';
    const from = new URL(page.url()).pathname + new URL(page.url()).search;
    await page.waitForFunction(
      ({ text, expected }) =>
        [...document.querySelectorAll('main a')].some(
          (a) =>
            a.textContent === text && new URL(a.href).searchParams.get('returnTo') === expected,
        ),
      { text: await link.textContent(), expected: from },
    );
    const url = new URL(await link.getAttribute('href'), target);
    assert.equal(url.origin, target.origin);
    assert.equal(url.pathname, pathname);
    assert.equal(url.searchParams.get('returnTo'), from);
  }
  async function successful(view = 'preview') {
    step = 'normal-import-detail';
    const invalid = view === 'invalid',
      receipt = view === 'receipt';
    await main()
      .getByRole('heading', {
        name: receipt ? 'CSV取込の確定結果' : 'CSV取込プレビュー',
        exact: true,
      })
      .waitFor();
    if (view === 'preview') {
      step = 'normal-form-ready';
      await main().locator('form[aria-busy="false"]:not([inert])').waitFor();
    }
    step = 'normal-detail-summary';
    assert.equal(await retry().count(), 0);
    assert.ok(
      (await main().innerText()).includes('synthetic-detail · 2026年10月9日 10:00 · 合成作成者'),
    );
    assert.ok((await main().innerText()).includes('取込理由: 合成CSV検証理由'));
    const statuses = main().getByRole('status');
    assert.equal(await statuses.count(), receipt ? 2 : 1);
    assert.equal(
      await statuses.first().innerText(),
      invalid
        ? '追加0件 · 更新0件 · 変更なし0件 · 不正1件'
        : '追加1件 · 更新1件 · 変更なし1件 · 不正1件',
    );
    const rows = main().locator('tbody tr');
    assert.equal(await rows.count(), invalid ? 1 : 4);
    assert.deepEqual(
      await rows.locator('td:nth-child(3)').allTextContents(),
      invalid ? ['不正・隔離'] : ['追加', '更新', '変更なし', '不正・隔離'],
    );
    assert.ok((await rows.last().innerText()).includes('合成検証: 必須項目が不足しています。'));
    if (!invalid) {
      assert.ok((await rows.nth(0).innerText()).includes('新しい資産を登録'));
      assert.ok(
        (await rows.nth(1).innerText()).includes(
          '初回の資産タグ一致: この資産へ外部IDを対応付けます。（確認時の版2）',
        ),
      );
      assert.ok((await rows.nth(1).innerText()).includes('モデル: 合成旧モデル → 合成更新モデル'));
      assert.ok(
        (await rows.nth(1).innerText()).includes('ホスト名: synthetic-old-host → （空欄）'),
      );
      assert.ok((await rows.nth(2).innerText()).includes('登録済みの外部IDで一致（確認時の版3）'));
      assert.ok((await rows.nth(2).innerText()).includes('資産の内容・版を変更しません。'));
      for (const index of receipt ? [0, 1, 2] : [1, 2])
        await contextualHref(
          rows.nth(index).getByRole('link'),
          '/assets/07000000-0000-4000-8000-' + String(100 + index).padStart(12, '0'),
        );
      if (!receipt) assert.equal(await rows.first().getByRole('link').count(), 0);
    }
    await contextualHref(
      main().getByRole('link', { name: '不正行のレポートを保存する（JSON）', exact: true }),
      entryPath + '/errors',
    );
    await contextualHref(
      main().getByRole('link', { name: '別のCSVをプレビューする', exact: true }),
      '/assets/imports/new',
    );
    const applicable = view === 'preview';
    assert.equal(await main().locator('form').count(), applicable ? 1 : 0);
    assert.equal(await main().getByRole('alert').count(), invalid ? 1 : 0);
    if (applicable) {
      const check = main().locator('input[name=confirmed]');
      assert.equal(await check.isChecked(), false);
      assert.equal(await check.getAttribute('required'), '');
      assert.equal(await main().locator('input[name=planHash]').inputValue(), 'b'.repeat(64));
      assert.equal(
        await main().getByRole('button', { name: '正常3行の取込を確定する', exact: true }).count(),
        1,
      );
      assert.equal(
        await main()
          .getByRole('button', { name: '正常3行の取込を確定する', exact: true })
          .isDisabled(),
        false,
      );
    }
    if (invalid)
      assert.equal(
        await main().getByRole('alert').innerText(),
        '正常行がありません。CSVを修正し再プレビューしてください。',
      );
    if (receipt) {
      const banner = main().locator('.success-banner');
      assert.ok((await banner.innerText()).includes('確定済み · 2026年10月9日 11:00 · 合成確定者'));
      assert.ok((await banner.innerText()).includes('保存: 追加1 / 更新1 / 変更なし1 / 隔離1'));
      assert.equal(
        await banner
          .getByRole('link', { name: '保存した資産を見る', exact: true })
          .getAttribute('href'),
        '/assets',
      );
    } else assert.ok((await main().innerText()).includes('まだ資産を変更していません。'));
  }
  async function noSensitiveFields() {
    assert.equal(
      await main().locator('form, input, select, textarea, button, dl, table, details').count(),
      0,
    );
    assert.equal(await main().locator('ul.attachments').count(), 0);
    assert.equal(
      await main().getByRole('link', { name: '資産CSVを取り込む', exact: true }).count(),
      0,
    );
    assert.equal(await main().getByRole('status').count(), 0);
    assert.equal(
      await main()
        .getByRole('link', { name: '不正行のレポートを保存する（JSON）', exact: true })
        .count(),
      0,
    );
    assert.equal(
      await main().getByRole('link', { name: '別のCSVをプレビューする', exact: true }).count(),
      0,
    );
    for (const value of [
      privateMarker,
      importId,
      'synthetic-detail',
      '合成作成者',
      '合成CSV検証理由',
      '追加1件',
      'CSV SHA-256:',
      '合成確定者',
      'synthetic-ext-',
      'SYN-CSV-',
      '合成検証: 必須項目',
    ])
      assert.equal((await main().innerText()).includes(value), false);
  }
  async function rejected(status) {
    step = 'error-boundary';
    await main()
      .getByRole('heading', {
        name: '取込内容を読み込めませんでした',
        level: 1,
        exact: true,
      })
      .waitFor();
    assert.equal(await main().getByRole('alert').innerText(), errorMessages[status]);
    assert.equal(await main().getByRole('status').count(), 0);
    await noSensitiveFields();
    assert.equal(
      await main().getByRole('link', { name: 'ポータルへ戻る', exact: true }).getAttribute('href'),
      '/portal',
    );
  }
  async function notFound() {
    step = 'existing-not-found';
    await main()
      .getByRole('heading', { name: 'お探しの画面は見つかりませんでした', exact: true })
      .waitFor();
    assert.ok(
      (await main().innerText()).includes(
        'URLが変わったか、閲覧できる範囲の外にある可能性があります。',
      ),
    );
    assert.equal(await retry().count(), 0);
    await noSensitiveFields();
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
  }
  async function documentNavigation(link, path, keyboard = false) {
    step = 'native-anchor';
    assert.equal(await link.evaluate((node) => node.tagName), 'A');
    assert.equal(await link.getAttribute('href'), path);
    assert.equal(new URL(path, target).origin, target.origin);
    const navigation = page.waitForRequest(
      (request) =>
        request.isNavigationRequest() &&
        request.method() === 'GET' &&
        request.url() === target.origin + path,
    );
    await Promise.all([navigation, keyboard ? page.keyboard.press('Enter') : link.click()]);
    step = 'native-document';
    await page.waitForURL(target.origin + path, { waitUntil: 'domcontentloaded' });
    step = 'native-heading';
    await main().getByRole('heading', { level: 1 }).waitFor();
    assert.equal(page.url(), target.origin + path);
  }
  async function freshNavigation(path, keyboard = false) {
    assert.equal(new URL(path, target).pathname, entryPath);
    const before = detailReads().length;
    await documentNavigation(retry(), path, keyboard);
    await successful();
    step = 'fresh-api-get';
    const fresh = detailReads().slice(before);
    assert.ok(fresh.length > 0);
    assert.ok(fresh.every((request) => request.route === 'detail' && request.query === ''));
    assert.equal(await main().getByRole('status').count(), 1);
    return {
      apiReadsIncreased: true,
      nativeDocumentGet: true,
      sameDetailPath: true,
      returnToRetained: new URL(path, target).searchParams.get('returnTo'),
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
        name: 'solvi_session_wp070_synthetic',
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
    } catch (error) {
      report.checks.push({
        name,
        passed: false,
        step,
        failureKind:
          error?.name === 'TimeoutError'
            ? 'timeout'
            : error?.name === 'AssertionError'
              ? 'assertion'
              : 'operation',
        failureCode: signal?.aborted ? 'ASSET_UI_ABORTED' : 'ASSET_UI_ASSERTION_FAILED',
      });
    } finally {
      if (!signal?.aborted) {
        await scenario({});
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
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === target.origin && url.pathname === entryPath + '/errors') {
        if (['GET', 'HEAD'].includes(request.method())) {
          report.browserRequests.errorReportBlocked++;
          return route.abort();
        }
        report.browserRequests.errorReportForwarded++;
      }
      if (!['data:', 'blob:', 'about:'].includes(url.protocol) && url.origin !== target.origin)
        return route.abort();
      return route.continue();
    });
    await context.addCookies([
      {
        name: 'solvi_session_wp070_synthetic',
        value: 'agent',
        url: target.origin,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    page = await context.newPage();
    page.on('download', () => {
      report.browserRequests.downloads++;
    });
    page.setDefaultTimeout(12_000);
    const path = detailPath();
    for (const view of ['preview', 'readonly', 'invalid', 'receipt']) {
      await check('actual-detail-' + view, async () => {
        await scenario({ view });
        await open(path);
        await successful(view);
        await main().getByText('確認した列の対応付けと識別情報', { exact: true }).click();
        assert.ok((await main().innerText()).includes('CSV SHA-256: ' + 'a'.repeat(64)));
        assert.ok((await main().innerText()).includes('プレビューID: ' + importId));
        assert.ok((await main().innerText()).includes('対応なし'));
        await shot('detail-' + view + '-desktop');
        if (view === 'preview') await shot('preview-apply-form-readonly', main().locator('form'));
        return {
          renderer: 'real import detail and Apply form',
          view,
          applySubmitted: false,
          errorReportDownloaded: false,
          realAuthorizationTested: false,
        };
      });
    }
    for (const fault of faultModes) {
      await check('detail-' + fault + '-native-recovery', async () => {
        await scenario({ detail: fault });
        await open(
          path +
            '&q=ignored&state=applied&page=2&applied=1&saved=1&created=1&updated=1&unknown=synthetic',
        );
        const status = Object.hasOwn(errorMessages, fault) ? fault : '503';
        await rejected(status);
        assert.equal(await retry().getAttribute('href'), path);
        assert.equal(await back().getAttribute('href'), returnPath);
        await shot('error-' + fault, main().getByRole('alert'));
        await scenario({});
        return {
          ...(await freshNavigation(path)),
          expectedReaderStatus:
            fault === 'invalid_json' ? 502 : fault === '500' ? 500 : Number(status),
          readerStatusDirectlyObserved: false,
        };
      });
    }
    for (const fault of ['403', '404', '403_body_cut', '404_body_cut']) {
      await check('detail-' + fault + '-existing-not-found', async () => {
        await scenario({ detail: fault });
        await open(path);
        await notFound();
        await shot('detail-' + fault);
        return { existingNotFound: true, noExistenceDisclosure: true, noRetryAdded: true };
      });
    }
    await check('filtered-assets-back-actual-list-renderer', async () => {
      await scenario({ detail: '503' });
      await open(path);
      await rejected('503');
      const before = allReads().filter((r) => r.route === 'list').length;
      await documentNavigation(back(), returnPath);
      await main().getByRole('heading', { name: '資産台帳', exact: true }).waitFor();
      assert.equal(await main().getByLabel('状態', { exact: true }).inputValue(), 'in_use');
      assert.equal(await main().getByLabel('種別', { exact: true }).inputValue(), 'pc');
      assert.equal(await main().getByLabel('利用者の割当', { exact: true }).inputValue(), 'mine');
      const records = allReads().filter((r) => r.route === 'list');
      assert.ok(records.length > before);
      assert.equal(records.at(-1).query, returnQuery);
      await shot('return-filtered-assets');
      return { actualAssetListRenderer: true, conditionsRetained: 5, nativeDocumentGet: true };
    });
    await check('fallback-actual-fixed-history-renderer', async () => {
      await scenario({ detail: '503' });
      await open(entryPath);
      await rejected('503');
      const before = allReads().filter((r) => r.route === 'history').length;
      await documentNavigation(fallback(), '/assets/imports');
      await main().getByRole('heading', { name: 'CSV取込と履歴', exact: true }).waitFor();
      assert.equal(await main().locator('ul.attachments > li.attachment').count(), 50);
      const records = allReads().filter((r) => r.route === 'history');
      assert.ok(records.length > before);
      assert.equal(records.at(-1).query, '');
      await shot('return-fixed-history');
      return {
        actualHistoryRenderer: true,
        nativeDocumentGet: true,
        historyQueryFilteringTested: false,
      };
    });
    await check('other-allowed-return-href-only', async () => {
      await scenario({ detail: '503' });
      const from = '/requests?q=synthetic&state=submitted&page=2';
      const other = detailPath(from);
      await open(other);
      await rejected('503');
      assert.equal(await back().getAttribute('href'), from);
      assert.equal(await retry().getAttribute('href'), other);
      await scenario({});
      return { ...(await freshNavigation(other)), otherDestinationNavigated: false };
    });
    await check('missing-unsafe-and-repeated-return-fallback', async () => {
      for (const query of [
        '',
        'returnTo=https%3A%2F%2Fexample.test',
        'returnTo=%2F%2Fexample.test',
        'returnTo=%2Fassets%5Cunsafe',
        'returnTo=%2Fassets&returnTo=%2Frequests',
      ]) {
        await scenario({ detail: '503' });
        await open(entryPath + (query ? '?' + query : ''));
        await rejected('503');
        assert.equal(await retry().getAttribute('href'), entryPath);
        assert.equal(await fallback().getAttribute('href'), '/assets/imports');
        assert.equal(await back().count(), 0);
      }
      await scenario({});
      return { ...(await freshNavigation(entryPath)), fallbackCases: 5 };
    });
    await check('nested-flash-and-top-query-array-parameters-removed', async () => {
      await scenario({ detail: '503' });
      const raw =
        entryPath +
        '?' +
        new URLSearchParams({
          returnTo: returnPath + '&saved=1&created=1&updated=1',
          q: 'ignored',
          state: 'applied',
          page: '2',
          applied: '1',
          saved: '1',
          created: '1',
          updated: '1',
          unknown: 'synthetic',
        }) +
        '&q=second&page=3';
      await open(raw);
      await rejected('503');
      assert.equal(await retry().getAttribute('href'), path);
      assert.equal(await back().getAttribute('href'), returnPath);
      await scenario({});
      return await freshNavigation(path);
    });
    await check('invalid-id-fails-before-api-without-retry', async () => {
      const before = allReads().length;
      await open('/assets/imports/not-a-uuid?returnTo=%2Fassets%2Fimports');
      await rejected('400');
      assert.equal(await retry().count(), 0);
      assert.equal(await back().getAttribute('href'), '/assets/imports');
      assert.equal(allReads().length, before);
      await shot('invalid-id-400', main().getByRole('alert'));
      return { businessApiReads: 0, retryAbsent: true };
    });
    await check('keyboard-tab-visible-focus-enter-recovery', async () => {
      await scenario({ detail: '503' });
      await open(path);
      await rejected('503');
      await tabTo(retry());
      await shot('keyboard-focus', retry());
      await scenario({});
      return {
        ...(await freshNavigation(path, true)),
        keyboard: 'Tab then Enter',
        focusVisible: true,
      };
    });
    await check('mobile-existing-success-table-and-error-recovery', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await open(path);
      await successful();
      const successGeometry = await geometry();
      const table = await main()
        .locator('.table-scroll')
        .evaluate((node) => ({
          clientWidth: node.clientWidth,
          scrollWidth: node.scrollWidth,
          tableWidth: node.querySelector('table').getBoundingClientRect().width,
          firstCellWidth: node.querySelector('tbody td').getBoundingClientRect().width,
        }));
      await shot('preview-mobile-390');
      await scenario({ detail: '503' });
      await open(path);
      await rejected('503');
      const errorGeometry = await geometry();
      assert.equal(errorGeometry.pageOverflow, false);
      await shot('error-mobile-390', main().getByRole('alert'));
      await scenario({});
      const observation = await freshNavigation(path);
      await page.setViewportSize({ width: 1280, height: 720 });
      return {
        ...observation,
        successGeometry,
        existingSuccessTable: table,
        successMobileRedesignTested: false,
        errorGeometry,
      };
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
      report.browserRequests.errorReportForwarded === 0 &&
      report.browserRequests.errorReportAttempts === report.browserRequests.errorReportBlocked &&
      report.browserRequests.downloads === 0 &&
      report.cleanup.browserClosed;
    writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  }
  if (signal?.aborted) throw new Error('ASSET_UI_ABORTED');
  return report;
}
