/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import { access, chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidenceRoot = resolve(root, 'evidence/WP-P2-CSVUI-068');
const privateMarker = 'WP068_PRIVATE_PROBLEM_MARKER';
const assetId = '06800000-0000-4000-8000-000000000100';
const basePath = '/assets/' + assetId;
const returnQuery = new URLSearchParams({
  q: '合成 & %_\\?',
  state: 'in_use',
  kind: 'pc',
  assignment: 'mine',
  page: '2',
}).toString();
const returnPath = '/assets?' + returnQuery;
const formPaths = { new: '/assets/new', edit: basePath + '/edit' };
const entryPath = '/assets/imports/new';
const csvPath = (from = returnPath) => entryPath + '?' + new URLSearchParams({ returnTo: from });
const expectedChecks = 24;
const faultModes = [
  '400',
  '401',
  '404',
  '500',
  '503',
  'network',
  'body_cut',
  '404_body_cut',
  'invalid_json',
];
const errorMessages = {
  400: '画面を開くための情報が正しくありません。元の画面から開き直してください。',
  401: 'ログイン状態を確認できませんでした。ログインし直してから、もう一度お試しください。',
  404: '取込に必要な情報を取得できませんでした。元の画面から開き直してください。',
  503: '一時的に取込画面を読み込めませんでした。時間をおいて、もう一度お試しください。',
};

/** Real Next.js/Chromium only; every backend response and cookie is synthetic. */
export async function runAssetCsvEntryRecoveryChecks({
  baseURL,
  outputDirectory,
  control,
  optionReads,
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
  assert.equal(typeof optionReads, 'function');
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
    workPackage: 'WP-P2-CSVUI-068',
    model: 'Real copied production Next.js UI with loopback synthetic API and synthetic session.',
    actualAssetFormRendererTested: true,
    actualCsvRendererTested: true,
    formSubmissionTested: false,
    csvInspectPreviewApplyTested: false,
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
  let mode = { options: 'normal', asset: 'normal', canManage: true };
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
    mode = { options: 'normal', asset: 'normal', canManage: true, ...next };
  };
  const main = () => page.locator('main');
  const retry = () => main().getByRole('link', { name: '再取得する', exact: true });
  const back = () => main().getByRole('link', { name: '元の画面へ戻る', exact: true });
  const fallback = () => main().getByRole('link', { name: '取込履歴へ戻る', exact: true });
  async function open(path) {
    step = 'open';
    await live();
    await page.goto(target.origin + path, { waitUntil: 'networkidle' });
    await main().getByRole('heading', { level: 1 }).waitFor();
  }
  async function successfulAsset(kind) {
    step = 'normal-form';
    const editing = kind === 'edit';
    await main()
      .getByRole('heading', {
        name: editing ? '資産を編集する' : '新しい資産を登録する',
        level: 1,
        exact: true,
      })
      .waitFor();
    assert.equal(await main().locator('form').count(), 1);
    assert.equal(await main().getByRole('alert').count(), 0);
    assert.equal(await retry().count(), 0);
    const expected = editing
      ? {
          assetTag: 'SYN-AST-001',
          name: '合成検証資産 001',
          model: '合成モデル',
          serialNumber: 'SYN-0',
          hostname: 'synthetic-0',
          vendor: 'Synthetic vendor',
          location: '合成保管場所',
          notes: '合成内部メモ',
          reason: '',
        }
      : {
          assetTag: '',
          name: '',
          model: '',
          serialNumber: '',
          hostname: '',
          vendor: '',
          location: '',
          notes: '',
          reason: '初回登録',
        };
    for (const [id, value] of Object.entries(expected))
      assert.equal(
        await main()
          .locator('#asset-' + id)
          .inputValue(),
        value,
      );
    assert.equal(await main().locator('[name=expectedVersion]').inputValue(), editing ? '2' : '1');
    assert.equal(await main().locator('#asset-kind').inputValue(), 'pc');
    assert.equal(await main().locator('#asset-kind').isDisabled(), editing);
    assert.equal(await main().locator('#asset-state').inputValue(), editing ? 'in_use' : 'stocked');
    assert.equal(await main().locator('#asset-assigned').isDisabled(), !editing);
    assert.equal(
      await main().locator('#asset-assigned').inputValue(),
      editing ? '06800000-0000-4000-8000-000000000002' : '',
    );
    assert.deepEqual(await main().locator('#asset-assigned option').allTextContents(), [
      '割当なし',
      '合成利用者',
      '合成候補専用利用者',
    ]);
    assert.equal(await main().locator('#asset-assetTag').getAttribute('maxlength'), '64');
    assert.equal(await main().locator('#asset-name').getAttribute('maxlength'), '160');
    for (const id of ['assetTag', 'name', 'model', 'serialNumber', 'hostname'])
      assert.equal(
        await main()
          .locator('#asset-' + id)
          .getAttribute('required'),
        '',
      );
    assert.equal(
      await main()
        .getByRole('button', {
          name: editing ? '変更と履歴を保存する' : '資産を登録する',
          exact: true,
        })
        .count(),
      1,
    );
    assert.equal(
      await main().getByRole('link', { name: 'キャンセルして戻る', exact: true }).count(),
      1,
    );
  }
  async function successful() {
    step = 'normal-csv-form';
    await main().getByRole('heading', { name: '資産CSVを取り込む', exact: true }).waitFor();
    assert.equal(await main().locator('form').count(), 1);
    assert.equal(await main().getByRole('alert').count(), 0);
    assert.equal(await retry().count(), 0);
    assert.equal(await main().locator('#csv-source').inputValue(), 'synthetic-demo');
    assert.equal(await main().locator('#csv-reason').inputValue(), '合成データでCSV取込を試す');
    assert.equal(await main().locator('#csv-text').inputValue(), '');
    for (const id of ['source', 'reason', 'text'])
      assert.equal(
        await main()
          .locator('#csv-' + id)
          .getAttribute('required'),
        '',
      );
    assert.equal(await main().locator('#csv-source').getAttribute('maxlength'), '64');
    assert.equal(await main().locator('#csv-text').getAttribute('maxlength'), '24576');
    assert.equal(
      await main().getByRole('button', { name: '列を確認する', exact: true }).count(),
      1,
    );
    assert.equal(
      await main().getByRole('button', { name: '合成例を入力する', exact: true }).count(),
      1,
    );
    assert.equal(
      await main().getByRole('button', { name: '取込プレビューを作成する', exact: true }).count(),
      0,
    );
    assert.equal(await main().locator('table').count(), 0);
    assert.equal(
      await main().getByRole('link', { name: 'キャンセルして戻る', exact: true }).count(),
      1,
    );
  }
  async function noSensitiveFields() {
    assert.equal(
      await main().locator('form, input, select, textarea, button, dl, table, details').count(),
      0,
    );
    const text = await main().innerText();
    for (const value of [
      privateMarker,
      'SYN-AST-001',
      '合成モデル',
      '合成内部メモ',
      '合成保管場所',
      '合成候補専用利用者',
      '合成変更理由',
    ])
      assert.equal(text.includes(value), false);
  }
  async function rejected(status) {
    step = 'error-boundary';
    await main()
      .getByRole('heading', {
        name: 'CSV取込画面を読み込めませんでした',
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
    if (keyboard) await page.keyboard.press('Enter');
    else await link.click();
    await navigation;
    await page.waitForLoadState('networkidle');
    assert.equal(page.url(), target.origin + path);
  }
  async function freshNavigation(path, keyboard = false) {
    assert.equal(new URL(path, target).pathname, entryPath);
    const before = optionReads().length;
    await documentNavigation(retry(), path, keyboard);
    await successful();
    step = 'fresh-api-get';
    const fresh = optionReads().slice(before);
    assert.ok(fresh.length > 0);
    assert.ok(fresh.every((request) => request.route === 'options' && request.query === ''));
    assert.equal(await main().getByRole('status').count(), 0);
    return {
      apiReadsIncreased: true,
      nativeDocumentGet: true,
      sameEntryPath: true,
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
        name: 'solvi_session_wp068_synthetic',
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
      const url = new URL(route.request().url());
      if (!['data:', 'blob:', 'about:'].includes(url.protocol) && url.origin !== target.origin)
        return route.abort();
      return route.continue();
    });
    await context.addCookies([
      {
        name: 'solvi_session_wp068_synthetic',
        value: 'agent',
        url: target.origin,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    page = await context.newPage();
    page.setDefaultTimeout(12_000);
    const path = csvPath();
    for (const mode of ['normal', '204']) {
      await check('csv-' + mode + '-real-form-initial-values-required', async () => {
        await scenario({ options: mode });
        const before = optionReads().length;
        await open(path);
        await successful();
        assert.ok(optionReads().length > before);
        await shot('csv-' + mode + '-desktop');
        return {
          renderer: 'real AssetCsvForm',
          successfulStatus: mode === '204' ? 204 : 200,
          submitted: false,
          candidateDtoConsumed: false,
        };
      });
    }
    for (const fault of faultModes) {
      await check('candidate-' + fault + '-native-entry-recovery', async () => {
        await scenario({ options: fault });
        await open(path + '&saved=1&created=1&updated=1&unknown=synthetic');
        const status =
          fault === '404_body_cut' ? '404' : Object.hasOwn(errorMessages, fault) ? fault : '503';
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
          realAuthenticationTested: false,
        };
      });
    }
    for (const fault of ['403', '403_body_cut']) {
      await check('candidate-' + fault + '-existing-not-found', async () => {
        await scenario({ options: fault });
        await open(path);
        await notFound();
        await shot('candidate-' + fault);
        return { existingNotFound: true, noExistenceDisclosure: true, noRetryAdded: true };
      });
    }
    await check('filtered-assets-back-actual-list-renderer', async () => {
      await scenario({ options: '503' });
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
      await shot('return-filtered-list');
      return { actualAssetListRenderer: true, conditionsRetained: 5, nativeDocumentGet: true };
    });
    await check('fallback-actual-fixed-import-history-renderer', async () => {
      await scenario({ options: '503' });
      await open(entryPath);
      await rejected('503');
      const before = allReads().filter((r) => r.route === 'imports').length;
      await documentNavigation(fallback(), '/assets/imports');
      await main().getByRole('heading', { name: 'CSV取込と履歴', exact: true }).waitFor();
      assert.ok((await main().innerText()).includes('synthetic-history'));
      assert.ok((await main().innerText()).includes('未確定 · 追加1 / 更新2 / 変更なし3 / 不正0'));
      const records = allReads().filter((r) => r.route === 'imports');
      assert.ok(records.length > before);
      assert.equal(records.at(-1).query, '');
      assert.equal(await main().locator('form').count(), 0);
      await shot('return-fixed-import-history');
      return {
        actualHistoryRenderer: true,
        nativeDocumentGet: true,
        historyQueryFilteringTested: false,
      };
    });
    await check('other-allowed-return-href-only', async () => {
      await scenario({ options: '503' });
      const from = '/requests?q=synthetic&state=submitted&page=2';
      const other = csvPath(from);
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
        await scenario({ options: '503' });
        await open(entryPath + (query ? '?' + query : ''));
        await rejected('503');
        assert.equal(await retry().getAttribute('href'), entryPath);
        assert.equal(await fallback().getAttribute('href'), '/assets/imports');
        assert.equal(await back().count(), 0);
      }
      await scenario({});
      return { ...(await freshNavigation(entryPath)), fallbackCases: 5 };
    });
    await check('nested-flash-and-top-unknown-parameters-removed', async () => {
      await scenario({ options: '503' });
      const raw =
        entryPath +
        '?' +
        new URLSearchParams({
          returnTo: returnPath + '&saved=1&created=1&updated=1',
          saved: '1',
          created: '1',
          updated: '1',
          unknown: 'synthetic',
        });
      await open(raw);
      await rejected('503');
      assert.equal(await retry().getAttribute('href'), path);
      assert.equal(await back().getAttribute('href'), returnPath);
      await scenario({});
      return await freshNavigation(path);
    });
    await check('keyboard-tab-visible-focus-enter-recovery', async () => {
      await scenario({ options: '503' });
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
    await check('mobile-real-csv-form-error-and-recovery', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await open(path);
      await successful();
      assert.equal((await geometry()).pageOverflow, false);
      await shot('csv-mobile-390');
      await scenario({ options: '503' });
      await open(path);
      await rejected('503');
      assert.equal((await geometry()).pageOverflow, false);
      await shot('error-mobile-390', main().getByRole('alert'));
      await scenario({});
      const observation = await freshNavigation(path);
      await page.setViewportSize({ width: 1280, height: 720 });
      return { ...observation, pageOverflow: false };
    });
    for (const kind of ['new', 'edit']) {
      await check(kind + '-existing-reader-consumer-actual-form-success', async () => {
        const before = optionReads().length;
        await open(formPaths[kind]);
        await successfulAsset(kind);
        assert.ok(optionReads().length > before);
        await shot(kind + '-existing-form');
        return {
          actualAssetFormRenderer: true,
          submitted: false,
          candidateRoute: '/assets/options',
        };
      });
      await check(kind + '-existing-reader-consumer-403-not-found', async () => {
        await scenario({ options: '403' });
        await open(formPaths[kind]);
        await notFound();
        await shot(kind + '-existing-403');
        return { existingNotFound: true, submitted: false };
      });
    }
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
