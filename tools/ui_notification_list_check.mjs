/* global document, window, getComputedStyle */
// WP056 browser-only evidence. The caller owns the isolated DB/API/Web and proxy.
// Cookie values are in-memory input, never CLI flags, report fields or logs.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { access, chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const safeRoot = resolve(root, 'evidence/WP-P2-NTFUI-056');
const labels = { all: 'すべて', pending: '未処理', sent: '記録済み', failed: '失敗' };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Run sequentially against the parent's owned fixture; no services or databases start here. */
export async function runNotificationUiChecks({
  baseURL,
  outputDirectory,
  sessions,
  expected,
  control,
  notificationReads,
  assertOwned = async () => {},
  signal,
}) {
  if (signal?.aborted) throw new Error('NOTIFICATION_UI_ABORTED');
  const target = new URL(baseURL);
  assert.ok(
    target.protocol === 'http:' &&
      target.hostname === '127.0.0.1' &&
      target.port &&
      !['3000', '3001'].includes(target.port) &&
      !target.username &&
      !target.password &&
      target.pathname === '/' &&
      !target.search &&
      !target.hash,
  );
  const output = resolve(outputDirectory),
    local = relative(safeRoot, output);
  assert.ok(local && !local.startsWith('..') && !isAbsolute(local));
  assert.equal(await realpath(dirname(output)), dirname(output));
  assert.ok(typeof control === 'function' && typeof notificationReads === 'function');
  assert.ok(
    Object.keys(labels).every(
      (key) => Number.isSafeInteger(expected.counts[key]) && expected.counts[key] >= 0,
    ),
  );
  assert.deepEqual(expected.counts, { all: 46, pending: 3, sent: 22, failed: 21 });
  for (const key of ['orgAdmin', 'agent', 'platformAdmin'])
    assert.match(sessions[key], /^solvi_session[^=]*=[A-Za-z0-9_-]+$/);
  if (sessions.expiredAdmin !== undefined)
    assert.match(sessions.expiredAdmin, /^solvi_session[^=]*=[A-Za-z0-9_-]+$/);
  await access(chromium.executablePath()); // No download or install fallback.
  await mkdir(output, { mode: 0o700 });
  const report = {
    workPackage: 'WP-P2-NTFUI-056',
    startedAt: new Date().toISOString(),
    success: false,
    model: 'Owned real API and sessions; controlled notification faults are identified separately.',
    checks: [],
    screenshots: [],
    axe: [],
    cleanup: { browserClosed: false },
    productionAcceptance: false,
  };
  let browser,
    context,
    page,
    currentRole = 'orgAdmin',
    fault = 'none';
  let cancellation = Promise.resolve();
  const onAbort = () => {
    // Only resources created in this invocation are closed. Observe every rejection.
    cancellation = Promise.allSettled([
      Promise.resolve().then(() => context?.close()),
      Promise.resolve().then(() => browser?.close()),
    ]).then(() => undefined);
  };
  const live = async () => {
    if (signal?.aborted) throw new Error('NOTIFICATION_UI_ABORTED');
    await assertOwned();
    if (signal?.aborted) throw new Error('NOTIFICATION_UI_ABORTED');
  };
  const setFault = async (value) => {
    await live();
    await control(value);
    fault = value;
  };
  const rows = () => page.locator('.notification-table tbody tr');
  const filters = () => page.getByRole('navigation', { name: '通知の状態で絞り込み' });
  const pages = () => page.getByRole('navigation', { name: '通知一覧のページ' });
  const total = async (n) => {
    await page
      .locator('.notification-result strong')
      .filter({ hasText: new RegExp('^' + n + '件$') })
      .waitFor();
  };
  async function useRole(name) {
    await context?.close();
    currentRole = name;
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
      locale: 'ja-JP',
    });
    const cookie = sessions[name],
      at = cookie.indexOf('=');
    await context.addCookies([
      {
        name: cookie.slice(0, at),
        value: cookie.slice(at + 1),
        url: target.origin,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    page = await context.newPage();
    page.setDefaultTimeout(10000);
  }
  async function open(query = '') {
    await live();
    await page.goto(target.origin + '/ops/notifications' + query, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { level: 1, name: '通知状況', exact: true }).waitFor();
  }
  async function filter(status) {
    await filters().getByRole('link', { name: labels[status], exact: true }).click();
    await page.waitForURL(
      (url) => url.searchParams.get('status') === status && !url.searchParams.has('cursor'),
    );
    await total(expected.counts[status]);
  }
  async function shot(name, axe = true) {
    await live();
    await page.screenshot({ path: resolve(output, name + '.png'), fullPage: false });
    await chmod(resolve(output, name + '.png'), 0o600);
    report.screenshots.push({
      name,
      role: currentRole,
      viewport: page.viewportSize(),
      captureType: 'viewport',
      fault,
    });
    if (axe) {
      const result = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
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
  }
  async function test(name, task, model = 'real API') {
    await live();
    try {
      await task();
      await live();
      report.checks.push({ name, model, passed: true });
    } catch {
      report.checks.push({
        name,
        model,
        passed: false,
        failureCode: signal?.aborted
          ? 'NOTIFICATION_UI_ABORTED'
          : 'NOTIFICATION_UI_ASSERTION_FAILED',
      });
    } finally {
      await setFault('none');
    }
  }
  async function tabTo(locator) {
    for (let i = 0; i < 100; i++) {
      await page.keyboard.press('Tab');
      if (await locator.evaluate((element) => document.activeElement === element)) return;
    }
    throw new Error('NOTIFICATION_UI_FOCUS_FAILED');
  }
  async function focus(locator) {
    const result = await locator.evaluate((element) => {
      const css = getComputedStyle(element);
      return {
        active: document.activeElement === element,
        visible: element.matches(':focus-visible'),
        outline: parseFloat(css.outlineWidth) > 0 && css.outlineStyle !== 'none',
      };
    });
    assert.ok(result.active && result.visible && result.outline);
    return result;
  }
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await live();
    browser = await chromium.launch({ headless: true });
    await live();
    await setFault('none');
    await useRole('orgAdmin');
    await test('admin-navigation-and-recording-semantics', async () => {
      await open();
      await total(46);
      assert.equal(await rows().count(), 20);
      const link = page
        .getByRole('navigation', { name: '組織の管理' })
        .getByRole('link', { name: '通知状況', exact: true });
      assert.equal(await link.getAttribute('aria-current'), 'page');
      assert.ok(
        (await page.locator('main').innerText()).includes('実際のメール配達は確認できません'),
      );
      assert.equal(await rows().locator('a').count(), 0);
      await shot('admin-desktop');
    });
    await test('status-and-bidirectional-page-controls', async () => {
      await filter('failed');
      assert.equal(await rows().count(), 20);
      await pages().getByRole('link', { name: '次の20件', exact: true }).click();
      await page.waitForURL(
        (url) => url.searchParams.get('direction') === 'next' && url.searchParams.has('cursor'),
      );
      await total(21);
      await rows().first().waitFor();
      await page.waitForFunction(
        () => document.querySelectorAll('.notification-table tbody tr').length === 1,
      );
      assert.equal(await pages().getByRole('link', { name: '次の20件', exact: true }).count(), 0);
      await pages().getByRole('link', { name: '前の20件', exact: true }).click();
      await page.waitForURL((url) => url.searchParams.get('direction') === 'previous');
      await page.waitForFunction(
        () => document.querySelectorAll('.notification-table tbody tr').length === 20,
      );
      await total(21);
      await shot('failed-list');
    });
    await test('reload-preserves-status-resets-cursor-and-reads-real-api', async () => {
      const before = await notificationReads();
      await page
        .locator('.notification-heading')
        .getByRole('link', { name: '通知状況を再読み込み', exact: true })
        .click();
      await page.waitForURL(
        (url) => url.searchParams.get('status') === 'failed' && !url.searchParams.has('cursor'),
      );
      await page.waitForLoadState('networkidle');
      await total(21);
      assert.ok((await notificationReads()) > before);
      const repeatedBefore = await notificationReads();
      await page
        .locator('.notification-heading')
        .getByRole('link', { name: '通知状況を再読み込み', exact: true })
        .click();
      await page.waitForLoadState('networkidle');
      await total(21);
      assert.ok((await notificationReads()) > repeatedBefore);
      report.reload = { statusPreserved: true, cursorReset: true, sameUrlRealReadIncreased: true };
    });
    for (const name of [
      'agent',
      'platformAdmin',
      ...(sessions.expiredAdmin ? ['expiredAdmin'] : []),
    ])
      await test(name + '-navigation-hidden-and-url-denied', async () => {
        await useRole(name);
        await open();
        await page
          .getByRole('heading', { name: '通知状況を表示する権限がありません', exact: true })
          .waitFor();
        assert.equal(await page.getByRole('link', { name: '通知状況', exact: true }).count(), 0);
        assert.equal(await rows().count(), 0);
        assert.equal(await page.locator('.notification-counts').count(), 0);
        await shot(name + '-denied');
      });
    await test(
      'controlled-empty',
      async () => {
        await useRole('orgAdmin');
        await setFault('empty');
        await open();
        await page
          .getByRole('heading', { name: '通知はまだ記録されていません', exact: true })
          .waitFor();
        await total(0);
        await shot('empty');
      },
      'controlled notifications response; real session',
    );
    for (const mode of ['401', '403', '503', 'network', 'body_cut'])
      await test(
        'controlled-' + mode + '-and-recovery',
        async () => {
          await useRole('orgAdmin');
          await setFault(mode);
          await open('?status=failed');
          const heading =
            mode === '401'
              ? 'ログイン状態を確認してください'
              : mode === '403'
                ? '通知状況を表示する権限がありません'
                : '通知状況を取得できませんでした';
          await page.getByRole('heading', { name: heading, exact: true }).waitFor();
          assert.equal(await page.locator('.notification-counts').count(), 0);
          if (mode === '401')
            assert.equal(
              await page
                .getByRole('link', { name: '別のタブでログインする' })
                .getAttribute('target'),
              '_blank',
            );
          assert.equal(new URL(page.url()).searchParams.get('status'), 'failed');
          await shot('fault-' + mode);
          await setFault('none');
          const before = await notificationReads();
          await page
            .locator('.notification-heading')
            .getByRole('link', { name: '通知状況を再読み込み', exact: true })
            .click();
          await page.waitForLoadState('networkidle');
          await total(21);
          assert.ok((await notificationReads()) > before);
        },
        'controlled notification fault; real session and real recovery',
      );
    await test(
      'loading-and-stale-navigation-response',
      async () => {
        await useRole('orgAdmin');
        await open('?status=all');
        await setFault('delay');
        await filters().getByRole('link', { name: '失敗', exact: true }).click();
        await page.getByText('通知状況を読み込んでいます', { exact: true }).waitFor();
        await shot('loading', false);
        await setFault('none');
        await filters().getByRole('link', { name: '記録済み', exact: true }).click();
        await total(22);
        await sleep(1800);
        await total(22);
        assert.equal(new URL(page.url()).searchParams.get('status'), 'sent');
        assert.equal(
          await filters()
            .getByRole('link', { name: '記録済み', exact: true })
            .getAttribute('aria-current'),
          'page',
        );
        report.staleResponse = {
          loadingObserved: true,
          newestFilterRetained: true,
          afterDelayedResponse: true,
        };
        await shot('after-cancellation');
      },
      'controlled bounded delay; real API responses',
    );
    await test('keyboard-filter-paging-and-visible-focus', async () => {
      await useRole('orgAdmin');
      await open();
      const failed = filters().getByRole('link', { name: '失敗', exact: true });
      await tabTo(failed);
      const filterFocus = await focus(failed);
      await page.keyboard.press('Enter');
      await total(21);
      const next = pages().getByRole('link', { name: '次の20件', exact: true });
      await tabTo(next);
      const pageFocus = await focus(next);
      await shot('keyboard-focus');
      await page.keyboard.press('Enter');
      await page.waitForURL((url) => url.searchParams.has('cursor'));
      await total(21);
      report.keyboard = { keys: ['Tab', 'Enter'], filterFocus, pageFocus };
    });
    await test('mobile-local-scroll-and-no-document-overflow', async () => {
      await useRole('orgAdmin');
      await page.setViewportSize({ width: 390, height: 844 });
      await open('?status=failed');
      await total(21);
      const geometry = await page.evaluate(() => {
        const region = document.querySelector('.notification-list .table-scroll');
        return {
          viewport: window.innerWidth,
          document: document.documentElement.scrollWidth,
          regionWidth: region?.clientWidth,
          tableWidth: region?.scrollWidth,
        };
      });
      assert.ok(
        geometry.document <= geometry.viewport && geometry.tableWidth > geometry.regionWidth,
      );
      const region = page.getByRole('region', { name: '通知状況の表' });
      await tabTo(region);
      await focus(region);
      await page.keyboard.press('ArrowRight');
      await shot('mobile');
      report.mobile = geometry;
    });
  } catch {
    report.failureCode = signal?.aborted ? 'NOTIFICATION_UI_ABORTED' : 'NOTIFICATION_UI_RUN_FAILED';
  } finally {
    try {
      await control('none');
    } catch {
      report.failureCode = 'NOTIFICATION_UI_PROXY_RESET_FAILED';
    }
    await cancellation;
    try {
      // Retry closing the current instance if abort raced with launch/context creation.
      await browser?.close();
      report.cleanup.browserClosed = true;
    } catch {
      report.cleanup.browserClosed = false;
    }
    signal?.removeEventListener('abort', onAbort);
    if (signal?.aborted) report.failureCode = 'NOTIFICATION_UI_ABORTED';
    report.finishedAt = new Date().toISOString();
    report.success =
      !report.failureCode &&
      !signal?.aborted &&
      report.checks.length === (sessions.expiredAdmin ? 15 : 14) &&
      report.checks.every((item) => item.passed) &&
      report.cleanup.browserClosed;
    const text = JSON.stringify(report, null, 2) + '\n';
    assert.ok(Object.values(sessions).every((value) => !text.includes(value)));
    // Final small report is written without an await between abort observation and commit.
    writeFileSync(resolve(output, 'report.json'), text, { flag: 'wx', mode: 0o600 });
  }
  if (signal?.aborted) throw new Error('NOTIFICATION_UI_ABORTED');
  return report;
}
