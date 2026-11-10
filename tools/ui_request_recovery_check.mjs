/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import { access, chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidenceRoot = resolve(root, 'evidence/WP-P2-REQUI-061');
const privateMarker = 'WP061_PRIVATE_PROBLEM_MARKER';
const query = new URLSearchParams({
  q: '合成 & %_\\?',
  state: 'pending',
  view: 'mine',
  page: '2',
}).toString();
const filteredPath = '/requests?' + query;
const faultModes = ['400', '401', '403', '404', '503', 'network', 'body_cut', '403_body_cut'];
const expectedChecks = 20;
const errorMessages = {
  400: '申請一覧の検索条件を確認できませんでした。条件を解除して開き直してください。',
  401: 'ログインの有効期限が切れた可能性があります。再取得しても表示できない場合は、ポータルからログインし直してください。',
  403: 'この組織の申請一覧を表示する権限がありません。選択中の組織を確認するか、管理者にご相談ください。',
  404: '申請一覧を表示できません。対象や機能が現在利用できない可能性があります。ポータルへ戻ってご確認ください。',
  503: '申請一覧を取得できませんでした。時間をおいて、同じ条件で再取得してください。',
};

/** Real Next.js/Chromium only; every backend response and cookie is synthetic. */
export async function runRequestRecoveryChecks({
  baseURL,
  outputDirectory,
  control,
  requestReads,
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
  assert.equal(typeof requestReads, 'function');
  assert.equal(typeof assertOwned, 'function');
  const output = resolve(outputDirectory);
  const within = relative(evidenceRoot, output);
  assert.ok(within && !within.startsWith('..') && !isAbsolute(within));
  assert.equal(await realpath(dirname(output)), dirname(output));
  await access(chromium.executablePath()); // Never install or download a browser.
  if (signal?.aborted) throw new Error('REQUEST_UI_ABORTED');
  await mkdir(output, { mode: 0o700 });
  const report = {
    workPackage: 'WP-P2-REQUI-061',
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
    if (signal?.aborted) throw new Error('REQUEST_UI_ABORTED');
    await assertOwned();
    if (signal?.aborted) throw new Error('REQUEST_UI_ABORTED');
  };
  const scenario = async (next) => {
    await live();
    await control(next);
    mode = next;
  };
  const rows = () => page.locator('ul.attachments > li.attachment');
  const main = () => page.locator('main');
  const retry = () => main().getByRole('link', { name: '同じ条件で再取得する', exact: true });
  const update = () => main().getByRole('link', { name: '申請の状況を更新する', exact: true });
  async function open(path = '/requests') {
    step = 'open';
    await live();
    await page.goto(target.origin + path, { waitUntil: 'networkidle' });
    await main().getByRole('heading', { name: '申請の状況', level: 1, exact: true }).waitFor();
  }
  async function successful(count = 25) {
    step = 'normal-rows';
    await update().waitFor();
    await page.waitForFunction(
      (expected) => document.querySelectorAll('ul.attachments > li.attachment').length === expected,
      count,
    );
    const pageNumber = Number(new URL(page.url()).searchParams.get('page') ?? '1');
    const firstNumber = 'SYN-REQ-' + String((pageNumber - 1) * 25 + 1).padStart(3, '0');
    await page.waitForFunction(
      (expected) =>
        document
          .querySelector('ul.attachments > li.attachment h2')
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
    const before = requestReads();
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
    const fresh = requestReads().slice(before.length);
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
    assert.fail('REQUEST_UI_FOCUS');
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
        failureCode: signal?.aborted ? 'REQUEST_UI_ABORTED' : 'REQUEST_UI_ASSERTION_FAILED',
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
        name: 'solvi_session_wp061_synthetic',
        value: 'requester',
        url: target.origin,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    page = await context.newPage();
    page.setDefaultTimeout(12_000);
    const searchLabel = '受付番号・サービス名・申請者で検索';
    const emptyMessage = '表示できる申請はまだありません。カタログから申請できます。';
    const filteredMessage =
      '条件に合う申請はありません。条件を解除するか、カタログから申請できます。';
    const pageEmptyMessage = 'このページに申請はありません。最初のページへ戻ってください。';
    const notice = (text) => main().getByText(text, { exact: true });
    const pager = () => main().getByRole('navigation', { name: '申請のページ', exact: true });
    const pagePath = (number) =>
      '/requests?' +
      new URLSearchParams({
        q: '合成 & %_\\?',
        state: 'pending',
        view: 'mine',
        page: String(number),
      }).toString();
    async function role(value) {
      assert.ok(['requester', 'approver'].includes(value));
      await context.addCookies([
        {
          name: 'solvi_session_wp061_synthetic',
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
        const href = document.querySelector('ul.attachments h2 a')?.getAttribute('href');
        return href && new URL(href, document.baseURI).searchParams.get('returnTo') === expected;
      }, path);
      const href = await rows().first().getByRole('link').getAttribute('href');
      const url = new URL(href, target);
      assert.match(url.pathname, /^\/requests\/06100000-0000-4000-8000-\d{12}$/);
      assert.equal(url.searchParams.get('returnTo'), path);
      return { detailHrefPreservesReturnTo: true, detailEndpointTested: false };
    }
    async function empty(text, filtered) {
      step = 'empty-guidance';
      await notice(text).waitFor();
      assert.equal(await rows().count(), 0);
      assert.equal(await main().getByRole('alert').count(), 0);
      assert.equal(
        (await main().getByRole('status').innerText()).startsWith('絞り込み中 · '),
        filtered,
      );
    }
    await check('requester-normal-and-existing-navigation', async () => {
      await open();
      await successful();
      assert.equal(
        await page.getByLabel('処理対象').locator('option[value="approvals"]').count(),
        0,
      );
      assert.ok((await main().getByRole('status').innerText()).includes('表示対象 51件'));
      assert.ok((await main().innerText()).includes('実際の権限・外部サービスは変更しません。'));
      assert.ok((await rows().first().innerText()).includes('合成承認者の確認を待っています'));
      assert.ok((await rows().nth(4).innerText()).includes('模擬実行完了'));
      assert.ok((await rows().nth(6).innerText()).includes('承認期限切れ・再承認が必要'));
      const context = await contextLink('/requests');
      await shot('requester-desktop');
      return { ...context, ...(await geometry()), roleOptionsSynthetic: true };
    });
    await check('approver-role-option-and-context-link', async () => {
      await role('approver');
      await open('/requests?view=approvals');
      await successful();
      assert.equal(
        await page.getByLabel('処理対象').locator('option[value="approvals"]').count(),
        1,
      );
      assert.equal(await page.getByLabel('処理対象').inputValue(), 'approvals');
      const observed = await contextLink('/requests?view=approvals');
      await shot('approver-desktop');
      await role('requester');
      return { ...observed, realAuthorizationTested: false };
    });
    await check('existing-pagination-and-filter-values', async () => {
      await open(pagePath(1));
      await successful();
      await pager().getByRole('link', { name: '次のページ', exact: true }).click();
      await page.waitForURL(target.origin + filteredPath);
      await successful();
      assert.equal(await page.getByLabel(searchLabel).inputValue(), '合成 & %_\\?');
      assert.equal(await page.getByLabel('進捗').inputValue(), 'pending');
      assert.equal(await page.getByLabel('処理対象').inputValue(), 'mine');
      await contextLink(filteredPath);
      await pager().getByRole('link', { name: '次のページ', exact: true }).click();
      await page.waitForURL(target.origin + pagePath(3));
      await successful(1);
      assert.ok((await rows().first().innerText()).includes('SYN-REQ-051'));
      await shot('last-page-one-row', rows().first());
      await pager().getByRole('link', { name: '前のページ', exact: true }).click();
      await page.waitForURL(target.origin + filteredPath);
      await successful();
      await shot('filtered-page-two');
      return { pageRows: [25, 25, 1] };
    });
    await check('success-refresh-is-native-same-query-fresh-get', async () => {
      await open(filteredPath);
      await successful();
      return await freshNavigation(update(), filteredPath);
    });
    for (const fault of faultModes) {
      await check('failure-' + fault + '-and-same-query-recovery', async () => {
        await scenario(fault);
        await open(filteredPath);
        await rejected();
        const expectedStatus =
          fault === '403_body_cut' ? '403' : Object.hasOwn(errorMessages, fault) ? fault : '503';
        assert.equal(await main().getByRole('alert').innerText(), errorMessages[expectedStatus]);
        assert.equal(await retry().getAttribute('href'), filteredPath);
        const reset = main().getByRole('link', { name: '条件を解除する', exact: true });
        assert.equal(await reset.count(), fault === '400' ? 1 : 0);
        if (fault === '400') assert.equal(await reset.getAttribute('href'), '/requests');
        await shot('error-' + fault, main().getByRole('alert'));
        await scenario('normal');
        const observed = await freshNavigation(retry(), filteredPath);
        if (fault === '503') await shot('recovered-same-query');
        return { ...observed, expectedHttpStatus: Number(expectedStatus) };
      });
    }
    await check('unknown-and-repeated-query-values-are-not-forwarded', async () => {
      await scenario('503');
      const start = requestReads().length;
      await open(
        '/requests?q=one&q=two&state=pending&view=mine&page=2&organizationId=ignored&returnTo=https%3A%2F%2Fexample.test',
      );
      await rejected();
      const allowed = '/requests?state=pending&view=mine&page=2';
      assert.equal(await retry().getAttribute('href'), allowed);
      assert.ok(requestReads().slice(start).length > 0);
      assert.ok(
        requestReads()
          .slice(start)
          .every((request) => request.query === allowed.slice('/requests?'.length)),
      );
      await open('/requests?q=valid&state=pending&state=approved&view=mine&view=all&page=2&page=3');
      await rejected();
      assert.equal(await retry().getAttribute('href'), '/requests?q=valid');
      await scenario('normal');
      return await freshNavigation(retry(), '/requests?q=valid');
    });
    await check('initial-empty-distinct-from-error', async () => {
      await scenario('empty');
      await open();
      await empty(emptyMessage, false);
      await shot('initial-empty', notice(emptyMessage));
    });
    await check('each-filter-alone-empty-guidance', async () => {
      await scenario('empty');
      for (const [name, query] of [
        ['q', 'q=synthetic'],
        ['state', 'state=pending'],
        ['view', 'view=mine'],
      ]) {
        await open('/requests?' + query);
        await empty(filteredMessage, true);
        await shot('filtered-empty-' + name, notice(filteredMessage));
      }
    });
    await check('applied-filter-authoritative-over-raw-query', async () => {
      await scenario('applied_filtered');
      await open('/requests?state=all&view=all');
      await empty(filteredMessage, true);
      assert.equal(await page.getByLabel(searchLabel).inputValue(), 'API適用条件');
      assert.equal(await page.getByLabel('進捗').inputValue(), 'pending');
      assert.equal(await page.getByLabel('処理対象').inputValue(), 'mine');
      await scenario('applied_none');
      await open(filteredPath);
      await empty(emptyMessage, false);
      assert.equal(await page.getByLabel(searchLabel).inputValue(), '');
      assert.equal(await page.getByLabel('進捗').inputValue(), 'all');
      assert.equal(await page.getByLabel('処理対象').inputValue(), 'all');
    });
    await check('empty-current-page-keeps-filtered-first-page-exit', async () => {
      await open(pagePath(4));
      await empty(pageEmptyMessage, true);
      assert.ok((await main().getByRole('status').innerText()).includes('表示対象 51件'));
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
    await check('mobile-normal-error-recovery-and-empty', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await open();
      await successful();
      await geometry();
      await shot('mobile-normal-390', rows().first());
      await scenario('503');
      await open(filteredPath);
      await rejected();
      await geometry();
      await shot('mobile-error-390', main().getByRole('alert'));
      await scenario('normal');
      await freshNavigation(retry(), filteredPath);
      await scenario('empty');
      await open('/requests?view=mine');
      await empty(filteredMessage, true);
      await geometry();
      await shot('mobile-filtered-empty-390', notice(filteredMessage));
    });
  } catch {
    report.failureCode = signal?.aborted ? 'REQUEST_UI_ABORTED' : 'REQUEST_UI_RUN_FAILED';
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
    if (signal?.aborted) report.failureCode = 'REQUEST_UI_ABORTED';
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
  if (signal?.aborted) throw new Error('REQUEST_UI_ABORTED');
  return report;
}
