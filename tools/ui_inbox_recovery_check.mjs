/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import { access, chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidenceRoot = resolve(root, 'evidence/WP-P2-INBOXUI-060');
const privateMarker = 'WP060_PRIVATE_PROBLEM_MARKER';
const query = new URLSearchParams({
  kind: 'ticket',
  q: '合成 & %_\\?',
  unread: '1',
  unassigned: '1',
  page: '2',
}).toString();
const filteredPath = '/inbox?' + query;
const faultModes = ['400', '401', '403', '404', '503', 'network', 'body_cut', '403_body_cut'];
const expectedChecks = 18;
const errorMessages = {
  400: '受信箱の検索条件を確認できませんでした。条件を解除して開き直してください。',
  401: 'ログインの有効期限が切れた可能性があります。再取得しても表示できない場合は、ポータルからログインし直してください。',
  403: 'この組織の受信箱を表示する権限がありません。選択中の組織を確認するか、管理者にご相談ください。',
  404: '受信箱を表示できません。対象や機能が現在利用できない可能性があります。ポータルへ戻ってご確認ください。',
  503: '受信箱を取得できませんでした。時間をおいて、同じ条件で再取得してください。',
};

/** Real Next.js/Chromium only; every backend response and cookie is synthetic. */
export async function runInboxRecoveryChecks({
  baseURL,
  outputDirectory,
  control,
  inboxReads,
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
  assert.equal(typeof inboxReads, 'function');
  assert.equal(typeof assertOwned, 'function');
  const output = resolve(outputDirectory);
  const within = relative(evidenceRoot, output);
  assert.ok(within && !within.startsWith('..') && !isAbsolute(within));
  assert.equal(await realpath(dirname(output)), dirname(output));
  await access(chromium.executablePath()); // Never install or download a browser.
  if (signal?.aborted) throw new Error('INBOX_UI_ABORTED');
  await mkdir(output, { mode: 0o700 });
  const report = {
    workPackage: 'WP-P2-INBOXUI-060',
    model: 'Real copied production Next.js UI with loopback synthetic API and synthetic session.',
    realDatabaseTested: false,
    realAuthorizationTested: false,
    productionAcceptance: false,
    startedAt: new Date().toISOString(),
    checks: [],
    screenshots: [],
    axe: [],
    cleanup: { browserClosed: false },
    success: false,
  };
  let browser, context, page;
  let mode = 'normal';
  let step = 'initial';
  let cancellation = Promise.resolve();
  const onAbort = () => {
    cancellation = Promise.allSettled([
      Promise.resolve().then(() => context?.close()),
      Promise.resolve().then(() => browser?.close()),
    ]).then(() => undefined);
  };
  const live = async () => {
    if (signal?.aborted) throw new Error('INBOX_UI_ABORTED');
    await assertOwned();
    if (signal?.aborted) throw new Error('INBOX_UI_ABORTED');
  };
  const scenario = async (next) => {
    await live();
    await control(next);
    mode = next;
  };
  const rows = () => page.locator('.inbox-table tbody tr');
  const main = () => page.locator('main');
  const retry = () => main().getByRole('link', { name: '同じ条件で再取得する', exact: true });
  const update = () => main().getByRole('link', { name: '受信箱を更新する', exact: true });
  async function open(path = '/inbox') {
    step = 'open';
    await live();
    await page.goto(target.origin + path, { waitUntil: 'networkidle' });
    await main().getByRole('heading', { name: '業務受信箱', level: 1, exact: true }).waitFor();
  }
  async function successful(count = 25) {
    step = 'normal-rows';
    await update().waitFor();
    await page.waitForFunction(
      (expected) => document.querySelectorAll('.inbox-table tbody tr').length === expected,
      count,
    );
    assert.equal(await rows().count(), count);
    assert.equal(await main().getByRole('alert').count(), 0);
  }
  async function rejected() {
    step = 'error-boundary';
    await main().getByRole('alert').waitFor();
    assert.ok((await main().getByRole('alert').innerText()).trim().length > 0);
    assert.equal(await rows().count(), 0);
    assert.equal(await main().getByRole('group', { name: '現在の業務件数' }).count(), 0);
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
    const before = inboxReads();
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
    const fresh = inboxReads().slice(before.length);
    assert.ok(fresh.length > 0);
    assert.ok(
      fresh.some((request) => request.query === new URL(path, target).searchParams.toString()),
    );
    assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, path);
    return { apiReadsIncreased: true, nativeDocumentGet: true, sameQuery: true };
  }
  async function shot(name) {
    step = 'capture';
    await live();
    const file = resolve(output, name + '.png');
    await page.screenshot({ path: file, fullPage: false });
    await chmod(file, 0o600);
    report.screenshots.push({
      name,
      captureType: 'viewport',
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
    assert.fail('INBOX_UI_FOCUS');
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
        failureCode: signal?.aborted ? 'INBOX_UI_ABORTED' : 'INBOX_UI_ASSERTION_FAILED',
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
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (!['data:', 'blob:', 'about:'].includes(url.protocol) && url.origin !== target.origin)
        return route.abort();
      return route.continue();
    });
    await context.addCookies([
      {
        name: 'solvi_session_wp060_synthetic',
        value: 'agent',
        url: target.origin,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    page = await context.newPage();
    page.setDefaultTimeout(12_000);
    await check('desktop-normal-and-existing-navigation', async () => {
      await open();
      await successful();
      assert.ok((await page.getByRole('navigation').count()) > 0);
      assert.ok((await main().getByRole('status').innerText()).includes('表示対象 51件'));
      await shot('desktop-normal');
      return await geometry();
    });
    await check('existing-pagination-and-filter-values', async () => {
      await open('/inbox?' + query.replace('&page=2', '&page=1'));
      await successful();
      await main()
        .getByRole('navigation', { name: '受信箱のページ' })
        .getByRole('link', { name: '次のページ' })
        .click();
      await page.waitForURL(target.origin + filteredPath);
      await successful();
      assert.equal(await page.getByLabel('番号・タイトルで検索').inputValue(), '合成 & %_\\?');
      assert.equal(await page.getByLabel('業務の種類').inputValue(), 'ticket');
      assert.equal(await page.getByLabel('更新の確認').inputValue(), '1');
      assert.equal(await page.getByLabel('担当未定のチケットも表示する').isChecked(), true);
      await main().getByRole('link', { name: '次のページ', exact: true }).click();
      await page.waitForURL((url) => url.searchParams.get('page') === '3');
      await successful(1);
      await main().getByRole('link', { name: '前のページ', exact: true }).click();
      await page.waitForURL(target.origin + filteredPath);
      await successful();
      await shot('desktop-filtered-page-two');
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
        if (fault === '403' || fault === '403_body_cut')
          assert.match(await main().getByRole('alert').innerText(), /権限/);
        if (fault === 'body_cut')
          assert.doesNotMatch(await main().getByRole('alert').innerText(), /権限/);
        assert.equal(await retry().getAttribute('href'), filteredPath);
        if (fault === '400')
          assert.equal(
            await main()
              .getByRole('link', { name: '条件を解除する', exact: true })
              .getAttribute('href'),
            '/inbox',
          );
        await shot('error-' + fault);
        await scenario('normal');
        const observed = await freshNavigation(retry(), filteredPath);
        if (fault === '503') await shot('recovered-same-query');
        return observed;
      });
    }
    await check('unknown-and-repeated-query-values-are-not-forwarded', async () => {
      await scenario('503');
      const start = inboxReads().length;
      await open(
        '/inbox?kind=ticket&kind=change&q=one&q=two&unread=1&unassigned=1&page=2&organizationId=ignored&returnTo=https%3A%2F%2Fexample.test',
      );
      await rejected();
      const allowed = '/inbox?unread=1&unassigned=1&page=2';
      assert.equal(await retry().getAttribute('href'), allowed);
      assert.ok(
        inboxReads()
          .slice(start)
          .every((request) => request.query === allowed.slice('/inbox?'.length)),
      );
      await scenario('normal');
      return await freshNavigation(retry(), allowed);
    });
    await check('initial-empty-distinct-from-error', async () => {
      await scenario('empty');
      await open();
      await main()
        .getByRole('heading', { name: 'いま対応・確認する業務はありません', exact: true })
        .waitFor();
      assert.equal(await main().getByRole('alert').count(), 0);
      assert.equal(await rows().count(), 0);
      assert.equal((await main().getByRole('status').innerText()).includes('絞り込み中'), false);
      await shot('initial-empty');
    });
    await check('unassigned-only-empty-is-filtered', async () => {
      await scenario('empty');
      await open('/inbox?unassigned=1');
      await main()
        .getByRole('heading', { name: '条件に合う業務はありません', exact: true })
        .waitFor();
      assert.ok((await main().getByRole('status').innerText()).includes('絞り込み中'));
      assert.ok((await main().locator('.inbox-empty').innerText()).includes('未割当'));
      await shot('unassigned-filtered-empty');
    });
    await check('applied-filter-authoritative-over-raw-query', async () => {
      await scenario('applied_unassigned');
      await open('/inbox?unassigned=0');
      await main()
        .getByRole('heading', { name: '条件に合う業務はありません', exact: true })
        .waitFor();
      assert.equal(await page.getByLabel('担当未定のチケットも表示する').isChecked(), true);
      await scenario('applied_none');
      await open('/inbox?unassigned=1');
      await main()
        .getByRole('heading', { name: 'いま対応・確認する業務はありません', exact: true })
        .waitFor();
      assert.equal(await page.getByLabel('担当未定のチケットも表示する').isChecked(), false);
      assert.equal((await main().getByRole('status').innerText()).includes('絞り込み中'), false);
    });
    await check('empty-current-page-retains-total-and-previous-link', async () => {
      await open('/inbox?page=4');
      await main()
        .getByRole('heading', { name: 'このページに業務はありません', exact: true })
        .waitFor();
      assert.ok((await main().getByRole('status').innerText()).includes('表示対象 51件'));
      await main().getByRole('link', { name: '前のページ', exact: true }).click();
      await page.waitForURL((url) => url.searchParams.get('page') === '3');
      await successful(1);
      await shot('last-page-one-row');
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
      await shot('mobile-normal-390');
      await scenario('503');
      await open(filteredPath);
      await rejected();
      await geometry();
      await shot('mobile-error-390');
      await scenario('normal');
      await freshNavigation(retry(), filteredPath);
      await scenario('empty');
      await open('/inbox?unassigned=1');
      await main()
        .getByRole('heading', { name: '条件に合う業務はありません', exact: true })
        .waitFor();
      await geometry();
      await shot('mobile-unassigned-empty-390');
    });
  } catch {
    report.failureCode = signal?.aborted ? 'INBOX_UI_ABORTED' : 'INBOX_UI_RUN_FAILED';
  } finally {
    await cancellation;
    try {
      await browser?.close();
      report.cleanup.browserClosed = true;
    } catch {
      report.cleanup.browserClosed = false;
    }
    signal?.removeEventListener('abort', onAbort);
    if (signal?.aborted) report.failureCode = 'INBOX_UI_ABORTED';
    report.finishedAt = new Date().toISOString();
    report.success =
      !signal?.aborted &&
      !report.failureCode &&
      report.checks.length === expectedChecks &&
      report.checks.every((item) => item.passed) &&
      report.cleanup.browserClosed;
    writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  }
  if (signal?.aborted) throw new Error('INBOX_UI_ABORTED');
  return report;
}
