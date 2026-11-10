/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import { access, chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidenceRoot = resolve(root, 'evidence/WP-P2-ASTUI-064');
const privateMarker = 'WP064_PRIVATE_PROBLEM_MARKER';
const query = new URLSearchParams({
  q: '合成 & %_\\?',
  state: 'in_use',
  kind: 'pc',
  assignment: 'mine',
  page: '2',
}).toString();
const filteredPath = '/assets?' + query;
const faultModes = [
  '400',
  '401',
  '403',
  '404',
  '503',
  'network',
  'body_cut',
  '403_body_cut',
  'invalid_json',
];
const expectedChecks = 26;
const errorMessages = {
  400: '資産一覧の検索条件を確認できませんでした。条件を解除して開き直してください。',
  401: 'ログインの有効期限が切れた可能性があります。再取得しても表示できない場合は、ポータルからログインし直してください。',
  403: 'この組織の資産一覧を表示する権限がありません。選択中の組織を確認するか、管理者にご相談ください。',
  404: '資産一覧を表示できません。対象や機能が現在利用できない可能性があります。ポータルへ戻ってご確認ください。',
  503: '資産一覧を取得できませんでした。時間をおいて、同じ条件で再取得してください。',
};

/** Real Next.js/Chromium only; every backend response and cookie is synthetic. */
export async function runAssetRecoveryChecks({
  baseURL,
  outputDirectory,
  control,
  assetReads,
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
  assert.equal(typeof assertOwned, 'function');
  const output = resolve(outputDirectory);
  const within = relative(evidenceRoot, output);
  assert.ok(within && !within.startsWith('..') && !isAbsolute(within));
  assert.equal(await realpath(dirname(output)), dirname(output));
  await access(chromium.executablePath()); // Never install or download a browser.
  if (signal?.aborted) throw new Error('ASSET_UI_ABORTED');
  await mkdir(output, { mode: 0o700 });
  const report = {
    workPackage: 'WP-P2-ASTUI-064',
    model: 'Real copied production Next.js UI with loopback synthetic API and synthetic session.',
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
  const rows = () => page.locator('table.tickets tbody tr');
  const main = () => page.locator('main');
  const retry = () => main().getByRole('link', { name: '同じ条件で再取得する', exact: true });
  const update = () => main().getByRole('link', { name: '資産一覧を更新する', exact: true });
  async function open(path = '/assets') {
    step = 'open';
    await live();
    await page.goto(target.origin + path, { waitUntil: 'networkidle' });
    await main()
      .getByRole('heading', { name: /^(資産|資産台帳|自分の資産)$/, level: 1 })
      .waitFor();
  }
  async function successful(count = 25) {
    step = 'normal-rows';
    await update().waitFor();
    await page.waitForFunction(
      (expected) => document.querySelectorAll('table.tickets tbody tr').length === expected,
      count,
    );
    const pageNumber = Number(new URL(page.url()).searchParams.get('page') ?? '1');
    const firstNumber = 'SYN-AST-' + String((pageNumber - 1) * 25 + 1).padStart(3, '0');
    await page.waitForFunction(
      (expected) =>
        document
          .querySelector('table.tickets tbody tr td:first-child')
          ?.textContent?.includes(expected),
      firstNumber,
    );
    assert.equal(await rows().count(), count);
    assert.equal(await main().getByRole('alert').count(), 0);
  }
  async function rejected() {
    step = 'error-boundary';
    await main().getByRole('alert').waitFor();
    assert.ok((await main().getByRole('alert').innerText()).trim().length > 0);
    assert.equal(await rows().count(), 0);
    assert.equal(await main().getByRole('status').count(), 0);
    assert.equal(await main().locator('form').count(), 0);
    assert.equal(
      await main()
        .innerText()
        .then((text) => text.includes(privateMarker)),
      false,
    );
    assert.equal(
      await main().getByRole('link', { name: 'ポータルへ戻る', exact: true }).getAttribute('href'),
      '/portal',
    );
  }
  async function freshNavigation(link, path, keyboard = false) {
    step = 'native-anchor';
    assert.equal(await link.evaluate((node) => node.tagName), 'A');
    assert.equal(await link.getAttribute('href'), path);
    const before = assetReads();
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
    const fresh = assetReads().slice(before.length);
    assert.ok(fresh.length > 0);
    assert.ok(
      fresh.some((request) => request.query === new URL(path, target).searchParams.toString()),
    );
    assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, path);
    return { apiReadsIncreased: true, nativeDocumentGet: true, sameQuery: true };
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
        name: 'solvi_session_wp064_synthetic',
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
        name: 'solvi_session_wp064_synthetic',
        value: 'agent',
        url: target.origin,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    page = await context.newPage();
    page.setDefaultTimeout(12_000);
    const searchLabel = 'タグ・名前・モデル・シリアル・ホスト名・利用者で検索';
    const emptyMessage = '表示できる資産はまだありません。';
    const filteredMessage =
      '条件に合う資産はありません。条件を解除するか、検索条件を見直してください。';
    const pageEmptyMessage = 'このページに資産はありません。最初のページへ戻ってください。';
    const notice = (text) => main().getByText(text, { exact: true });
    const summary = () =>
      main()
        .getByRole('status')
        .filter({ hasText: /全[0-9]+件/ });
    const pager = () => main().getByRole('navigation', { name: '資産のページ', exact: true });
    const createLink = () =>
      main().getByRole('link', { name: '新しい資産を登録する', exact: true });
    const importsLink = () => main().getByRole('link', { name: 'CSV取込と履歴', exact: true });
    const assignment = () => main().getByLabel('利用者の割当', { exact: true });
    const pagePath = (number) => {
      const params = new URLSearchParams(query);
      params.set('page', String(number));
      return '/assets?' + params.toString();
    };
    async function contextLink(path) {
      step = 'context-link';
      await page.waitForFunction((expected) => {
        const href = document.querySelector('table.tickets tbody a')?.getAttribute('href');
        return href && new URL(href, document.baseURI).searchParams.get('returnTo') === expected;
      }, path);
      const href = await rows().first().getByRole('link').getAttribute('href');
      const url = new URL(href, target);
      assert.equal(url.origin, target.origin);
      assert.match(url.pathname, /^\/assets\/06400000-0000-4000-8000-\d{12}$/);
      assert.equal(url.searchParams.get('returnTo'), path);
      return {
        detailHrefPreservesReturnTo: true,
        detailEndpointTested: false,
        detailRendererTested: false,
        detailNavigationPerformed: false,
      };
    }
    async function empty(text, filtered) {
      step = 'empty-guidance';
      await notice(text).waitFor();
      assert.equal(await rows().count(), 0);
      assert.equal(await main().getByRole('alert').count(), 0);
      assert.equal((await summary().innerText()).startsWith('絞り込み中 · '), filtered);
    }
    await check('management-normal-controls-summary-and-context-link', async () => {
      await open();
      await successful();
      assert.equal(await createLink().count(), 1);
      assert.equal(await importsLink().count(), 1);
      assert.equal(await assignment().count(), 1);
      assert.equal((await summary().innerText()).trim(), '全51件 · 1ページ目（1ページ25件）');
      await main().getByRole('heading', { name: '資産台帳', exact: true }).waitFor();
      const first = await rows().first().innerText();
      for (const value of ['SYN-AST-001', '合成検証資産 001', 'PC', '在庫', '合成利用者'])
        assert.ok(first.includes(value));
      assert.ok((await rows().nth(1).innerText()).includes('割当なし'));
      const observed = await contextLink('/assets');
      for (const [link, pathname] of [
        [createLink(), '/assets/new'],
        [importsLink(), '/assets/imports'],
      ]) {
        await page.waitForFunction((expected) => {
          const node = [...document.querySelectorAll('main a')].find(
            (a) => new URL(a.href).pathname === expected,
          );
          return node && new URL(node.href).searchParams.get('returnTo') === '/assets';
        }, pathname);
        const url = new URL(await link.getAttribute('href'), target);
        assert.equal(url.origin, target.origin);
        assert.equal(url.pathname, pathname);
        assert.equal(url.searchParams.get('returnTo'), '/assets');
      }
      await shot('management-desktop');
      return {
        ...observed,
        ...(await geometry()),
        canManage: true,
        canReadAll: true,
        writesPerformed: false,
      };
    });
    await check('auditor-read-controls-without-registration', async () => {
      await role('auditor');
      await open();
      await successful();
      assert.equal(await createLink().count(), 0);
      assert.equal(await importsLink().count(), 1);
      assert.equal(await assignment().count(), 1);
      await main().getByRole('heading', { name: '資産台帳', exact: true }).waitFor();
      await shot('auditor-desktop');
      return { realAuthorizationTested: false, canManage: false, canReadAll: true };
    });
    await check('requester-own-display-without-management-controls', async () => {
      await role('requester');
      await open();
      await successful();
      assert.equal(await createLink().count(), 0);
      assert.equal(await importsLink().count(), 0);
      assert.equal(await assignment().count(), 0);
      await main().getByRole('heading', { name: '自分の資産', exact: true }).waitFor();
      await shot('requester-desktop');
      return {
        realAuthorizationTested: false,
        actualAssignedPopulationTested: false,
        canManage: false,
        canReadAll: false,
      };
    });
    await check('api-can-manage-flag-authoritative', async () => {
      await scenario('no_manage');
      await open();
      await successful();
      assert.equal(await createLink().count(), 0);
      assert.equal(await importsLink().count(), 1);
    });
    await check('pagination-and-five-condition-values', async () => {
      await open(pagePath(1));
      await successful();
      await pager().getByRole('link', { name: '次のページへ', exact: true }).click();
      await page.waitForURL(target.origin + filteredPath);
      await successful();
      assert.equal(await main().getByLabel(searchLabel).inputValue(), '合成 & %_\\?');
      assert.equal(await main().getByLabel('状態', { exact: true }).inputValue(), 'in_use');
      assert.equal(await main().getByLabel('種別', { exact: true }).inputValue(), 'pc');
      assert.equal(await assignment().inputValue(), 'mine');
      await contextLink(filteredPath);
      await pager().getByRole('link', { name: '次のページへ', exact: true }).click();
      await page.waitForURL(target.origin + pagePath(3));
      await successful(1);
      assert.ok((await rows().first().innerText()).includes('SYN-AST-051'));
      await shot('last-page-one-row', rows().first());
      await pager().getByRole('link', { name: '前のページへ', exact: true }).click();
      await page.waitForURL(target.origin + filteredPath);
      await successful();
      await shot('filtered-page-two');
      return { pageRows: [25, 25, 1], canonicalConditions: 5 };
    });
    await check('search-form-native-get-and-page-reset', async () => {
      await open(filteredPath);
      await successful();
      const count = assetReads().length;
      const navigation = page.waitForRequest(
        (request) =>
          request.isNavigationRequest() &&
          request.method() === 'GET' &&
          new URL(request.url()).origin === target.origin &&
          new URL(request.url()).pathname === '/assets',
      );
      await main()
        .getByRole('form', { name: '資産の検索' })
        .getByRole('button', { name: '検索する', exact: true })
        .click();
      await navigation;
      await page.waitForLoadState('networkidle');
      await successful();
      const expected = new URLSearchParams(query);
      expected.delete('page');
      const read = assetReads()
        .slice(count)
        .find((entry) => entry.scenario === 'normal');
      assert.ok(read);
      assert.deepEqual([...new URLSearchParams(read.query)].sort(), [...expected].sort());
      assert.equal(new URL(page.url()).searchParams.has('page'), false);
      return { nativeFilterGet: true, pageReset: true, retainedFilters: 4 };
    });
    await check('success-refresh-is-native-same-query-fresh-get', async () => {
      await open(filteredPath);
      await successful();
      return await freshNavigation(update(), filteredPath);
    });
    await check('invalid-single-values-retained-for-api-400', async () => {
      await scenario('400');
      const params = new URLSearchParams({
        q: 'invalid synthetic',
        state: 'invalid-state',
        kind: 'invalid-kind',
        assignment: 'invalid-assignment',
        page: 'invalid-page',
      });
      const path = '/assets?' + params;
      const count = assetReads().length;
      await open(path);
      await rejected();
      assert.equal(await retry().getAttribute('href'), path);
      assert.equal(await main().getByRole('alert').innerText(), errorMessages['400']);
      assert.ok(
        assetReads()
          .slice(count)
          .some((entry) => entry.query === params.toString()),
      );
      assert.equal(
        await main()
          .getByRole('link', { name: '条件を解除する', exact: true })
          .getAttribute('href'),
        '/assets',
      );
      await shot('invalid-scalar-400', main().getByRole('alert'));
      return { invalidScalarsPreserved: 5, apiRejectionSynthetic: true };
    });
    await check('unknown-and-repeated-query-values-not-forwarded', async () => {
      await scenario('503');
      const repeated = new URLSearchParams();
      for (const key of ['q', 'state', 'kind', 'assignment', 'page']) {
        repeated.append(key, 'one');
        repeated.append(key, 'two');
      }
      repeated.set('organizationId', 'ignored');
      repeated.set('returnTo', 'https://example.test');
      const count = assetReads().length;
      await open('/assets?' + repeated);
      await rejected();
      assert.equal(await retry().getAttribute('href'), '/assets');
      const reads = assetReads().slice(count);
      assert.ok(reads.length > 0);
      assert.ok(reads.every((entry) => entry.query === ''));
      await scenario('normal');
      return { ...(await freshNavigation(retry(), '/assets')), repeatedKeysExcluded: 5 };
    });
    for (const fault of faultModes) {
      await check('failure-' + fault + '-same-query-recovery', async () => {
        await scenario(fault);
        await open(filteredPath);
        await rejected();
        const expectedStatus =
          fault === '403_body_cut' ? '403' : Object.hasOwn(errorMessages, fault) ? fault : '503';
        assert.equal(await main().getByRole('alert').innerText(), errorMessages[expectedStatus]);
        assert.equal(await createLink().count(), 0);
        assert.equal(await importsLink().count(), 0);
        assert.equal(await retry().getAttribute('href'), filteredPath);
        const reset = main().getByRole('link', { name: '条件を解除する', exact: true });
        assert.equal(await reset.count(), fault === '400' ? 1 : 0);
        if (fault === '400') assert.equal(await reset.getAttribute('href'), '/assets');
        await shot('error-' + fault, main().getByRole('alert'));
        await scenario('normal');
        return {
          ...(await freshNavigation(retry(), filteredPath)),
          expectedReaderStatus: fault === 'invalid_json' ? 502 : Number(expectedStatus),
          readerStatusMeasuredInUi: false,
          fixedUiMessageVerified: true,
        };
      });
    }
    await check('initial-empty-distinct-from-error', async () => {
      await scenario('empty');
      await open();
      await empty(emptyMessage, false);
      await shot('initial-empty', notice(emptyMessage));
    });
    await check('each-canonical-filter-alone-is-filtered-empty', async () => {
      await scenario('empty');
      const entries = [
        ['q', 'synthetic'],
        ['state', 'repair'],
        ['kind', 'pc'],
        ['assignment', 'mine'],
        ['assignment', 'unassigned'],
      ];
      for (const [key, value] of entries) {
        await open('/assets?' + new URLSearchParams({ [key]: value }));
        await empty(filteredMessage, true);
      }
      await shot('filtered-empty', notice(filteredMessage));
      return { independentFilterValues: 5 };
    });
    await check('assignment-all-page-and-blank-query-are-not-filters', async () => {
      await scenario('empty');
      for (const path of [
        '/assets?assignment=all',
        '/assets?page=2',
        '/assets?q=%20%20',
        '/assets?assignment=all&page=2&q=%20%20',
      ]) {
        await open(path);
        await empty(emptyMessage, false);
      }
      await shot('unfiltered-zero-defaults', notice(emptyMessage));
    });
    await check('requester-hidden-assignment-still-filtered-and-retained', async () => {
      await role('requester');
      await scenario('empty');
      const path = '/assets?assignment=unassigned';
      await open(path);
      await empty(filteredMessage, true);
      assert.equal(await assignment().count(), 0);
      assert.equal(await update().getAttribute('href'), path);
      assert.ok(
        assetReads().some(
          (entry) =>
            entry.role === 'requester' &&
            entry.query === 'assignment=unassigned' &&
            entry.scenario === 'empty',
        ),
      );
      await shot('requester-hidden-assignment-empty', notice(filteredMessage));
      await scenario('normal');
      return {
        ...(await freshNavigation(update(), path)),
        hiddenFilterRetained: true,
        realAuthorizationTested: false,
      };
    });
    await check('empty-current-page-keeps-filtered-first-page-exit', async () => {
      await open(pagePath(4));
      await empty(pageEmptyMessage, true);
      assert.ok((await summary().innerText()).includes('全51件'));
      const first = pager().getByRole('link', { name: '最初のページへ', exact: true });
      assert.equal(await first.getAttribute('href'), pagePath(1));
      await shot('current-page-empty', notice(pageEmptyMessage));
      return await freshNavigation(first, pagePath(1));
    });
    await check('empty-first-page-positive-total-keeps-first-exit', async () => {
      await scenario('page_empty');
      await open(pagePath(1));
      await empty(pageEmptyMessage, true);
      const first = pager().getByRole('link', { name: '最初のページへ', exact: true });
      assert.equal(await first.count(), 1);
      assert.equal(await first.getAttribute('href'), pagePath(1));
      await shot('first-page-empty-positive-total', notice(pageEmptyMessage));
      await scenario('normal');
      return await freshNavigation(first, pagePath(1));
    });
    await check('keyboard-retry-visible-focus-and-enter', async () => {
      await scenario('503');
      await open(filteredPath);
      await rejected();
      await tabTo(retry());
      await shot('keyboard-retry-focus', retry());
      await scenario('normal');
      return {
        ...(await freshNavigation(retry(), filteredPath, true)),
        focusVisible: true,
        keyboard: 'Tab then Enter',
      };
    });
    await check('mobile-normal-error-recovery-and-visible-empty-guidance', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await open();
      await successful();
      const normalGeometry = await geometry();
      const region = main().getByRole('region', { name: '資産一覧', exact: true });
      const tableGeometry = await region.evaluate((node) => ({
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
        localOverflow: node.scrollWidth > node.clientWidth,
        titleCellWidth: node.querySelector('tbody td')?.getBoundingClientRect().width ?? null,
      }));
      await shot('mobile-normal-390', rows().first());
      await scenario('503');
      await open(filteredPath);
      await rejected();
      assert.equal((await geometry()).pageOverflow, false);
      await shot('mobile-error-390', main().getByRole('alert'));
      await scenario('normal');
      await freshNavigation(retry(), filteredPath);
      await scenario('empty');
      await open('/assets?assignment=unassigned');
      await empty(filteredMessage, true);
      assert.equal((await geometry()).pageOverflow, false);
      await shot('mobile-filtered-empty-390', notice(filteredMessage));
      return {
        normalGeometry,
        tableGeometry,
        unchangedTableLayoutIsObservationOnly: true,
        emptyGuidanceVisibleInViewport: true,
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
      report.cleanup.browserClosed;
    writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  }
  if (signal?.aborted) throw new Error('ASSET_UI_ABORTED');
  return report;
}
