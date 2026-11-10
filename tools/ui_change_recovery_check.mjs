/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import { access, chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidenceRoot = resolve(root, 'evidence/WP-P2-CHGUI-062');
const privateMarker = 'WP062_PRIVATE_PROBLEM_MARKER';
const assetId = '06200000-0000-4000-8000-000000000004';
const ticketId = '06200000-0000-4000-8000-000000000003';
const query = new URLSearchParams({
  q: '合成 & %_\\?',
  state: 'failed',
  assetId,
  ticketId,
  needsPir: '1',
  page: '2',
  from: '2026-10-08T00:00:00.000Z',
  to: '2026-10-08T01:30:00.000Z',
}).toString();
const filteredPath = '/changes?' + query;
const faultModes = [
  '400',
  '401',
  '403',
  '404',
  '500',
  '503',
  'network',
  'body_cut',
  '403_body_cut',
];
const expectedChecks = 24;
const errorMessages = {
  400: '変更一覧の検索条件を確認できませんでした。条件を解除して開き直してください。',
  401: 'ログインの有効期限が切れた可能性があります。再取得しても表示できない場合は、ポータルからログインし直してください。',
  403: 'この組織の変更一覧を表示する権限がありません。選択中の組織を確認するか、管理者にご相談ください。',
  404: '変更一覧を表示できません。対象や機能が現在利用できない可能性があります。ポータルへ戻ってご確認ください。',
  503: '変更一覧を取得できませんでした。時間をおいて、同じ条件で再取得してください。',
};

/** Real Next.js/Chromium only; every backend response and cookie is synthetic. */
export async function runChangeRecoveryChecks({
  baseURL,
  outputDirectory,
  control,
  changeReads,
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
  assert.equal(typeof changeReads, 'function');
  assert.equal(typeof assertOwned, 'function');
  const output = resolve(outputDirectory);
  const within = relative(evidenceRoot, output);
  assert.ok(within && !within.startsWith('..') && !isAbsolute(within));
  assert.equal(await realpath(dirname(output)), dirname(output));
  await access(chromium.executablePath()); // Never install or download a browser.
  if (signal?.aborted) throw new Error('CHANGE_UI_ABORTED');
  await mkdir(output, { mode: 0o700 });
  const report = {
    workPackage: 'WP-P2-CHGUI-062',
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
    if (signal?.aborted) throw new Error('CHANGE_UI_ABORTED');
    await assertOwned();
    if (signal?.aborted) throw new Error('CHANGE_UI_ABORTED');
  };
  const scenario = async (next) => {
    await live();
    await control(next);
    mode = next;
  };
  const rows = () => page.locator('table.tickets tbody tr');
  const main = () => page.locator('main');
  const retry = () => main().getByRole('link', { name: '同じ条件で再取得する', exact: true });
  const update = () => main().getByRole('link', { name: '変更一覧を更新する', exact: true });
  async function open(path = '/changes') {
    step = 'open';
    await live();
    await page.goto(target.origin + path, { waitUntil: 'networkidle' });
    await main().getByRole('heading', { name: '変更管理', level: 1, exact: true }).waitFor();
  }
  async function successful(count = 25) {
    step = 'normal-rows';
    await update().waitFor();
    await page.waitForFunction(
      (expected) => document.querySelectorAll('table.tickets tbody tr').length === expected,
      count,
    );
    const pageNumber = Number(new URL(page.url()).searchParams.get('page') ?? '1');
    const firstNumber = 'SYN-CHG-' + String((pageNumber - 1) * 25 + 1).padStart(3, '0');
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
    const before = changeReads();
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
    const fresh = changeReads().slice(before.length);
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
    assert.fail('CHANGE_UI_FOCUS');
  }
  async function geometry() {
    step = 'viewport-width';
    const widths = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }));
    assert.ok(widths.document <= widths.viewport + 1);
    return { pageOverflow: false };
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
        failureCode: signal?.aborted ? 'CHANGE_UI_ABORTED' : 'CHANGE_UI_ASSERTION_FAILED',
      });
    } finally {
      if (!signal?.aborted) await scenario('normal');
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
        name: 'solvi_session_wp062_synthetic',
        value: 'agent',
        url: target.origin,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    page = await context.newPage();
    page.setDefaultTimeout(12_000);
    const searchLabel = '番号・タイトル・元チケットで検索';
    const emptyMessage = '表示できる変更はまだありません。';
    const filteredMessage =
      '条件に合う変更はありません。条件を解除するか、検索条件を見直してください。';
    const pageEmptyMessage = 'このページに変更はありません。最初のページへ戻ってください。';
    const notice = (text) => main().getByText(text, { exact: true });
    const summary = () =>
      main()
        .getByRole('status')
        .filter({ hasText: /全[0-9]+件/ });
    const pager = () => main().getByRole('navigation', { name: '変更一覧のページ', exact: true });
    const createLink = () =>
      main().getByRole('link', { name: '通常変更の計画を作成する', exact: true });
    const pagePath = (number) => {
      const params = new URLSearchParams(query);
      params.set('page', String(number));
      return '/changes?' + params.toString();
    };
    async function role(value) {
      assert.ok(['agent', 'auditor'].includes(value));
      await context.addCookies([
        {
          name: 'solvi_session_wp062_synthetic',
          value,
          url: target.origin,
          httpOnly: true,
          sameSite: 'Lax',
        },
      ]);
    }
    async function contextLink(path) {
      step = 'context-link';
      await page.waitForFunction((expected) => {
        const href = document.querySelector('table.tickets tbody a')?.getAttribute('href');
        return href && new URL(href, document.baseURI).searchParams.get('returnTo') === expected;
      }, path);
      const href = await rows().first().getByRole('link').getAttribute('href');
      const url = new URL(href, target);
      assert.match(url.pathname, /^\/changes\/06200000-0000-4000-8000-\d{12}$/);
      assert.equal(url.searchParams.get('returnTo'), path);
      return { detailHrefPreservesReturnTo: true, detailEndpointTested: false };
    }
    async function empty(text, filtered) {
      step = 'empty-guidance';
      await notice(text).waitFor();
      assert.equal(await rows().count(), 0);
      assert.equal(await main().getByRole('alert').count(), 0);
      assert.equal((await summary().innerText()).startsWith('絞り込み中 · '), filtered);
    }
    await check('agent-normal-state-date-summary-and-context-link', async () => {
      await open();
      await successful();
      assert.equal(await createLink().count(), 1);
      assert.equal((await summary().innerText()).trim(), '全51件 · 1ページ目');
      assert.ok((await main().innerText()).includes('合成の実施結果'));
      const first = await rows().first().innerText();
      for (const value of [
        '下書き',
        '2026年10月8日',
        '09:00',
        '10:30',
        '合成担当者',
        'SYN-TKT-001',
        'SYN-AST-001',
      ])
        assert.ok(first.includes(value));
      assert.ok((await rows().nth(1).innerText()).includes('開始未定'));
      assert.ok((await rows().nth(6).innerText()).includes('成功（合成記録）'));
      const observed = await contextLink('/changes');
      await page.waitForFunction(() =>
        document
          .querySelector('main a[href^="/changes/new"]')
          ?.getAttribute('href')
          ?.includes('returnTo='),
      );
      assert.equal(
        new URL(await createLink().getAttribute('href'), target).searchParams.get('returnTo'),
        '/changes',
      );
      await shot('agent-desktop');
      return { ...observed, ...(await geometry()), canCreate: true };
    });
    await check('auditor-cannot-create-but-can-read', async () => {
      await role('auditor');
      await open();
      await successful();
      assert.equal(await createLink().count(), 0);
      await shot('auditor-desktop');
      await role('agent');
      return { realAuthorizationTested: false, syntheticCanCreate: false };
    });
    await check('api-can-create-flag-authoritative', async () => {
      await scenario('no_create');
      await open();
      await successful();
      assert.equal(await createLink().count(), 0);
    });
    await check('existing-pagination-and-eight-condition-values', async () => {
      await open(pagePath(1));
      await successful();
      await pager().getByRole('link', { name: '次のページへ', exact: true }).click();
      await page.waitForURL(target.origin + filteredPath);
      await successful();
      assert.equal(await page.getByLabel(searchLabel).inputValue(), '合成 & %_\\?');
      assert.equal(await page.getByLabel('現在の状態').inputValue(), 'failed');
      assert.equal(await page.getByLabel('実施後レビュー').inputValue(), '1');
      assert.equal(await page.getByLabel('予定の検索開始（JST）').inputValue(), '2026-10-08T09:00');
      assert.equal(await page.getByLabel('予定の検索終了（JST）').inputValue(), '2026-10-08T10:30');
      assert.equal(await main().locator('input[name="assetId"]').inputValue(), assetId);
      assert.equal(await main().locator('input[name="ticketId"]').inputValue(), ticketId);
      assert.ok((await main().innerText()).includes('資産から開いた関連変更'));
      await contextLink(filteredPath);
      await pager().getByRole('link', { name: '次のページへ', exact: true }).click();
      await page.waitForURL(target.origin + pagePath(3));
      await successful(1);
      assert.ok((await rows().first().innerText()).includes('SYN-CHG-051'));
      await shot('last-page-one-row', rows().first());
      await pager().getByRole('link', { name: '前のページへ', exact: true }).click();
      await page.waitForURL(target.origin + filteredPath);
      await successful();
      await shot('filtered-page-two');
      return { pageRows: [25, 25, 1], canonicalConditions: 8 };
    });
    await check('success-refresh-is-native-same-query-fresh-get', async () => {
      await open(filteredPath);
      await successful();
      return await freshNavigation(update(), filteredPath);
    });
    await check('jst-precedence-and-form-get-preserve-related-filters', async () => {
      const raw = new URLSearchParams(query);
      raw.set('from', '1999-01-01T00:00:00.000Z');
      raw.set('to', '1999-01-02T00:00:00.000Z');
      raw.set('fromJst', '2026-10-08T09:00');
      raw.set('toJst', '2026-10-08T10:30');
      const before = changeReads().length;
      await open('/changes?' + raw.toString());
      await successful();
      assert.equal(await update().getAttribute('href'), filteredPath);
      assert.ok(
        changeReads()
          .slice(before)
          .some((entry) => entry.query === query),
      );
      await freshNavigation(update(), filteredPath);
      const form = main().getByRole('form', { name: '変更の検索' });
      const navigation = page.waitForRequest(
        (request) => request.isNavigationRequest() && request.method() === 'GET',
      );
      const count = changeReads().length;
      await form.getByRole('button', { name: '絞り込む', exact: true }).click();
      await navigation;
      await page.waitForLoadState('networkidle');
      await successful();
      const expected = new URLSearchParams(query);
      expected.delete('page');
      const read = changeReads()
        .slice(count)
        .find((entry) => entry.scenario === 'normal');
      assert.ok(read);
      assert.deepEqual([...new URLSearchParams(read.query)].sort(), [...expected].sort());
      assert.equal(new URL(page.url()).searchParams.has('page'), false);
      return {
        jstOverridesRawUtc: true,
        jstToUtc: true,
        nativeFilterGet: true,
        hiddenRelatedIdsRetained: true,
        pageReset: true,
      };
    });
    await check('invalid-jst-remains-recoverable-with-400', async () => {
      await scenario('400');
      await open(
        '/changes?from=2026-01-01&fromJst=invalid-synthetic-time&toJst=invalid-synthetic-end',
      );
      await rejected();
      const expected =
        '/changes?' +
        new URLSearchParams({
          from: 'invalid-synthetic-time',
          to: 'invalid-synthetic-end',
        }).toString();
      assert.equal(await retry().getAttribute('href'), expected);
      assert.equal(await main().getByRole('alert').innerText(), errorMessages['400']);
      assert.equal(
        await main()
          .getByRole('link', { name: '条件を解除する', exact: true })
          .getAttribute('href'),
        '/changes',
      );
      await shot('invalid-jst-400');
    });
    await check('unknown-and-repeated-query-values-are-not-forwarded', async () => {
      await scenario('503');
      const repeated = new URLSearchParams();
      for (const key of [
        'q',
        'state',
        'assetId',
        'ticketId',
        'needsPir',
        'page',
        'from',
        'to',
        'fromJst',
        'toJst',
      ]) {
        repeated.append(key, 'one');
        repeated.append(key, 'two');
      }
      repeated.set('organizationId', 'ignored');
      repeated.set('returnTo', 'https://example.test');
      const start = changeReads().length;
      await open('/changes?' + repeated);
      await rejected();
      assert.equal(await retry().getAttribute('href'), '/changes');
      assert.ok(changeReads().slice(start).length > 0);
      assert.ok(
        changeReads()
          .slice(start)
          .every((entry) => entry.query === ''),
      );
      await scenario('normal');
      return await freshNavigation(retry(), '/changes');
    });
    for (const fault of faultModes) {
      await check('failure-' + fault + '-and-same-query-recovery', async () => {
        await scenario(fault);
        await open(filteredPath);
        await rejected();
        const expectedStatus =
          fault === '403_body_cut' ? '403' : Object.hasOwn(errorMessages, fault) ? fault : '503';
        assert.equal(await main().getByRole('alert').innerText(), errorMessages[expectedStatus]);
        assert.equal(await createLink().count(), 0);
        assert.equal(await retry().getAttribute('href'), filteredPath);
        const reset = main().getByRole('link', { name: '条件を解除する', exact: true });
        assert.equal(await reset.count(), fault === '400' ? 1 : 0);
        if (fault === '400') assert.equal(await reset.getAttribute('href'), '/changes');
        await shot('error-' + fault, main().getByRole('alert'));
        await scenario('normal');
        const observed = await freshNavigation(retry(), filteredPath);
        return {
          ...observed,
          expectedMessageCategory: expectedStatus === '503' ? 'unavailable' : expectedStatus,
        };
      });
    }
    await check('initial-empty-distinct-from-error', async () => {
      await scenario('empty');
      await open();
      await empty(emptyMessage, false);
      await shot('initial-empty', notice(emptyMessage));
    });
    await check('each-canonical-condition-alone-is-filtered-empty', async () => {
      await scenario('empty');
      const entries = [
        ['q', 'synthetic'],
        ['state', 'failed'],
        ['assetId', assetId],
        ['ticketId', ticketId],
        ['needsPir', '1'],
        ['from', '2026-10-08T00:00:00.000Z'],
        ['to', '2026-10-08T01:30:00.000Z'],
      ];
      for (const [key, value] of entries) {
        await open('/changes?' + new URLSearchParams({ [key]: value }));
        await empty(filteredMessage, true);
        if (key === 'ticketId')
          assert.ok((await main().innerText()).includes('チケットから開いた関連変更'));
      }
      await shot('filtered-empty', notice(filteredMessage));
      return { independentFilterConditions: 7 };
    });
    await check('needs-pir-zero-and-page-alone-are-not-filters', async () => {
      await scenario('empty');
      for (const path of [
        '/changes?needsPir=0',
        '/changes?page=2',
        '/changes?needsPir=0&page=2&q=%20%20',
      ]) {
        await open(path);
        await empty(emptyMessage, false);
      }
      await shot('unfiltered-zero-defaults', notice(emptyMessage));
    });
    await check('empty-current-page-keeps-filtered-first-page-exit', async () => {
      await open(pagePath(4));
      await empty(pageEmptyMessage, true);
      assert.ok((await summary().innerText()).includes('全51件'));
      const first = pager().getByRole('link', { name: '最初のページへ', exact: true });
      assert.equal(await first.getAttribute('href'), pagePath(1));
      await shot('current-page-empty', notice(pageEmptyMessage));
      await first.click();
      await page.waitForURL(target.origin + pagePath(1));
      await successful();
    });
    await check('empty-first-page-with-positive-total-keeps-exit', async () => {
      await scenario('page_empty');
      await open(pagePath(1));
      await empty(pageEmptyMessage, true);
      assert.equal(
        await pager()
          .getByRole('link', { name: '最初のページへ', exact: true })
          .getAttribute('href'),
        pagePath(1),
      );
      await shot('first-page-empty-positive-total', notice(pageEmptyMessage));
      await scenario('normal');
      return await freshNavigation(update(), pagePath(1));
    });
    await check('keyboard-retry-visible-focus-and-enter', async () => {
      await scenario('503');
      await open(filteredPath);
      await rejected();
      await tabTo(retry());
      await shot('keyboard-retry-focus');
      await scenario('normal');
      return {
        ...(await freshNavigation(retry(), filteredPath, true)),
        focusVisible: true,
        keyboard: 'Tab then Enter',
      };
    });
    await check('mobile-normal-local-table-error-recovery-and-empty', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await open();
      await successful();
      await geometry();
      const region = main().getByRole('region', { name: '変更計画一覧' });
      const scroll = await region.evaluate((node) => {
        const before = node.scrollLeft;
        node.scrollLeft = node.scrollWidth;
        return { available: node.scrollWidth > node.clientWidth, moved: node.scrollLeft > before };
      });
      assert.ok(scroll.available && scroll.moved);
      await region.evaluate((node) => {
        node.scrollLeft = 0;
      });
      await shot('mobile-normal-390', rows().first());
      await scenario('503');
      await open(filteredPath);
      await rejected();
      await geometry();
      await shot('mobile-error-390', main().getByRole('alert'));
      await scenario('normal');
      await freshNavigation(retry(), filteredPath);
      await scenario('empty');
      await open('/changes?needsPir=1');
      await empty(filteredMessage, true);
      await geometry();
      await shot('mobile-filtered-empty-390', notice(filteredMessage));
      return { localTableScroll: true, pageOverflow: false };
    });
  } catch {
    report.failureCode = signal?.aborted ? 'CHANGE_UI_ABORTED' : 'CHANGE_UI_RUN_FAILED';
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
    if (signal?.aborted) report.failureCode = 'CHANGE_UI_ABORTED';
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
  if (signal?.aborted) throw new Error('CHANGE_UI_ABORTED');
  return report;
}
