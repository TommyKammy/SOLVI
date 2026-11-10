/* global document, getComputedStyle */
// Browser-only WP058 checks. All services, sessions and faults belong to the caller.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { access, chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const safeRoot = resolve(root, 'evidence/WP-P2-NTFRETRY-058');
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
export async function runNotificationRetryUiChecks({
  baseURL,
  outputDirectory,
  sessions,
  expected,
  control,
  notificationReads,
  notificationWrites,
  switchScope,
  assertOwned,
  signal,
}) {
  const live = async () => {
    if (signal?.aborted) throw new Error('RETRY_UI_ABORTED');
    await assertOwned();
    if (signal?.aborted) throw new Error('RETRY_UI_ABORTED');
  };
  await live();
  const target = new URL(baseURL),
    output = resolve(outputDirectory),
    local = relative(safeRoot, output);
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
  assert.ok(local && !local.startsWith('..') && !isAbsolute(local));
  assert.equal(await realpath(dirname(output)), dirname(output));
  for (const name of ['orgAdmin', 'agent', 'platformAdmin', 'expiredAdmin'])
    assert.match(sessions[name], /^solvi_session[^=]*=[A-Za-z0-9_-]+$/);
  for (const name of ['normal', 'double', 'lost', 'unused', 'internal', 'automatic'])
    assert.match(expected[name], /^2026-10-08T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  await access(chromium.executablePath());
  await mkdir(output, { mode: 0o700 });
  const report = {
    workPackage: 'WP-P2-NTFRETRY-058',
    startedAt: new Date().toISOString(),
    success: false,
    model:
      'Owned real API, sessions and recording worker; controlled faults and state DTOs are identified separately.',
    checks: [],
    screenshots: [],
    axe: [],
    cleanup: { browserClosed: false },
    productionAcceptance: false,
  };
  let browser,
    context,
    page,
    role = 'orgAdmin',
    fault = 'none',
    step = 'start';
  let cancellation = Promise.resolve();
  const onAbort = () => {
    cancellation = Promise.allSettled([
      Promise.resolve().then(() => context?.close()),
      Promise.resolve().then(() => browser?.close()),
    ]).then(() => undefined);
  };
  async function setFault(method = 'GET', mode = 'none') {
    await live();
    await control({ method, mode });
    fault = method + ':' + mode;
  }
  async function useRole(name) {
    await context?.close();
    role = name;
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
  const row = (name) =>
    page
      .locator('.notification-table tbody tr')
      .filter({ has: page.locator('time[datetime="' + expected[name] + '"]') })
      .first();
  const panel = () => page.getByRole('region', { name: '通知の手動再試行' });
  async function open() {
    await live();
    await page.goto(target.origin + '/ops/notifications?status=all', { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '通知状況', exact: true }).waitFor();
  }
  async function inspect(name) {
    step = 'open-row';
    await actionResponse(() =>
      row(name)
        .getByRole('button', { name: /^(再試行を確認|予約状態を確認)$/ })
        .click(),
    );
    await panel().locator('.notification-retry-result').waitFor();
    await page.waitForFunction(
      () => document.querySelector('.notification-retry')?.getAttribute('aria-busy') === 'false',
    );
  }
  async function reserve() {
    step = 'reserve';
    await actionResponse(() =>
      panel().getByRole('button', { name: '再試行を予約', exact: true }).click(),
    );
    await panel().locator('.notification-retry-result').waitFor();
  }
  async function reread() {
    await actionResponse(() =>
      panel().getByRole('button', { name: '予約状態を再確認', exact: true }).click(),
    );
    await panel().locator('.notification-retry-result').waitFor();
  }
  async function actionResponse(trigger) {
    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          typeof response.request().headers()['next-action'] === 'string',
      ),
      trigger(),
    ]);
    await page.waitForFunction(
      () => document.querySelector('.notification-retry')?.getAttribute('aria-busy') === 'false',
    );
  }
  async function completed() {
    for (let i = 0; i < 30; i++) {
      if (await panel().getByRole('heading', { name: '再試行の記録が完了', exact: true }).count())
        return;
      await pause(500);
      await reread();
    }
    throw new Error('RETRY_UI_COMPLETION');
  }
  async function shot(name) {
    await live();
    if (await panel().count()) await panel().scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(output, name + '.png'), fullPage: false });
    await chmod(resolve(output, name + '.png'), 0o600);
    report.screenshots.push({
      name,
      role,
      viewport: page.viewportSize(),
      captureType: 'viewport',
      fault,
    });
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
  async function check(name, task, model = 'real API') {
    await live();
    step = 'start';
    try {
      const detail = await task();
      await live();
      report.checks.push({
        name,
        model,
        passed: true,
        ...(detail ? { observations: detail } : {}),
      });
    } catch {
      report.checks.push({
        name,
        model,
        passed: false,
        failureCode: signal?.aborted ? 'RETRY_UI_ABORTED' : 'RETRY_UI_ASSERTION_FAILED',
        step,
      });
    } finally {
      await control({ method: 'GET', mode: 'none' });
      fault = 'none';
    }
  }
  async function tabTo(locator) {
    for (let i = 0; i < 150; i++) {
      await page.keyboard.press('Tab');
      if (await locator.evaluate((el) => document.activeElement === el)) return;
    }
    throw new Error('RETRY_UI_KEYBOARD');
  }
  async function focus(locator) {
    const result = await locator.evaluate((el) => ({
      active: document.activeElement === el,
      visible: el.matches(':focus-visible'),
      outline: parseFloat(getComputedStyle(el).outlineWidth) > 0,
    }));
    assert.ok(result.active && result.visible && result.outline);
    return result;
  }
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    browser = await chromium.launch({ headless: true });
    await live();
    await useRole('orgAdmin');
    await check('confirm-before-reservation', async () => {
      await open();
      const before = await notificationWrites();
      await inspect('normal');
      assert.ok((await panel().innerText()).includes('15分'));
      assert.ok((await panel().innerText()).includes('OFF'));
      assert.ok((await panel().innerText()).includes('配達完了を意味しません'));
      assert.equal(await notificationWrites(), before);
      await shot('confirmation-desktop');
      await panel().getByRole('button', { name: '閉じる', exact: true }).click();
      assert.equal(await panel().count(), 0);
    });
    await check('reserve-and-recording-worker-completion', async () => {
      await open();
      await inspect('normal');
      const before = await notificationWrites();
      await reserve();
      assert.equal(await notificationWrites(), before + 1);
      assert.equal(
        await panel().getByRole('button', { name: '再試行を予約', exact: true }).count(),
        0,
      );
      await shot('reservation');
      await completed();
      await shot('recording-complete');
      const reads = await notificationReads();
      await reread();
      assert.ok((await notificationReads()) > reads);
      assert.equal(await notificationWrites(), before + 1);
    });
    await check('explicit-list-refresh-updates-row-and-counts', async () => {
      const writes = await notificationWrites();
      const [response] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().isNavigationRequest() &&
            response.request().method() === 'GET' &&
            new URL(response.url()).pathname === '/ops/notifications',
        ),
        panel().getByRole('link', { name: '一覧を最新にする', exact: true }).click(),
      ]);
      assert.equal(response.status(), 200);
      assert.equal(new URL(page.url()).search, '?status=all');
      await row('normal')
        .locator('.notification-status')
        .filter({ hasText: /^記録済み$/ })
        .waitFor();
      assert.equal((await row('normal').locator('td').nth(3).innerText()).trim(), '2');
      assert.equal((await page.locator('.notification-result strong').innerText()).trim(), '8件');
      const counts = page.locator('.notification-counts > div');
      assert.equal(
        (
          await counts
            .filter({ has: page.locator('dt', { hasText: /^記録済み$/ }) })
            .locator('dd')
            .innerText()
        ).trim(),
        '2件',
      );
      assert.equal(
        (
          await counts
            .filter({ has: page.locator('dt', { hasText: /^失敗$/ }) })
            .locator('dd')
            .innerText()
        ).trim(),
        '5件',
      );
      assert.equal(await notificationWrites(), writes);
      await shot('refreshed-recorded-row');
      return {
        nativeDocumentReload: true,
        sameStatusFirstPage: true,
        recordedRowAttempts: 2,
        recordedCount: 2,
        failedCount: 5,
      };
    });
    await check(
      'double-click-does-not-repeat-post',
      async () => {
        await open();
        await inspect('double');
        const before = await notificationWrites();
        await setFault('POST', 'delay');
        const button = panel().getByRole('button', { name: '再試行を予約', exact: true });
        await button.click({ clickCount: 2 });
        await panel().getByText('予約状態を確認しています…', { exact: true }).waitFor();
        assert.equal(await panel().locator('form button').isDisabled(), true);
        await panel().locator('.notification-retry-result').waitFor();
        assert.equal(await notificationWrites(), before + 1);
        await completed();
      },
      'real API with controlled POST delay',
    );
    await check(
      'lost-committed-response-rereads-without-reposting',
      async () => {
        await open();
        await inspect('lost');
        const before = await notificationWrites(),
          reads = await notificationReads();
        await setFault('POST', 'commit_body_cut');
        await reserve();
        assert.equal(await notificationWrites(), before + 1);
        assert.ok((await notificationReads()) > reads);
        assert.equal(
          await panel().getByRole('button', { name: '再試行を予約', exact: true }).count(),
          0,
        );
        await completed();
        await shot('lost-response-recovered');
      },
      'real committed POST; controlled response body loss',
    );
    await check('ineligible-and-automatic-retry-closed', async () => {
      await open();
      assert.equal(await row('automatic').getByRole('button').count(), 0);
      assert.ok((await row('automatic').innerText()).includes('対象外'));
      await inspect('internal');
      assert.equal(
        await panel().getByRole('button', { name: '再試行を予約', exact: true }).count(),
        0,
      );
      assert.ok((await panel().innerText()).includes('整合性'));
      await shot('ineligible');
    });
    for (const mode of ['401', '403', '503', 'network', 'body_cut'])
      await check(
        'get-failure-' + mode,
        async () => {
          await open();
          const before = await notificationWrites();
          await setFault('GET', mode);
          await inspect('unused');
          await panel().getByRole('alert').waitFor();
          assert.equal(
            await panel().getByRole('button', { name: '再試行を予約', exact: true }).count(),
            0,
          );
          assert.equal(await notificationWrites(), before);
          if (mode === '401')
            await panel().getByRole('link', { name: '別のタブでログインする' }).waitFor();
          await shot('get-' + mode);
          await setFault();
          await reread();
          await panel().getByRole('button', { name: '再試行を予約', exact: true }).waitFor();
        },
        'controlled GET fault; real session',
      );
    for (const mode of ['409', '503', 'network', 'body_cut'])
      await check(
        'post-failure-' + mode,
        async () => {
          await open();
          await inspect('unused');
          const before = await notificationWrites();
          await setFault('POST', mode);
          await reserve();
          await panel().getByRole('alert').waitFor();
          assert.equal(
            await panel().getByRole('button', { name: '再試行を予約', exact: true }).count(),
            0,
          );
          assert.equal(await notificationWrites(), before);
          await shot('post-' + mode);
          await setFault();
          await reread();
          await panel().getByRole('button', { name: '再試行を予約', exact: true }).waitFor();
        },
        'controlled POST rejection/loss before forwarding; real GET recovery',
      );
    await check('changed-organization-closes-old-confirmation', async () => {
      await open();
      await inspect('unused');
      const before = await notificationWrites();
      await switchScope('foreign');
      try {
        await reserve();
        await panel().getByRole('link', { name: '現在の組織で一覧を開き直す' }).waitFor();
        assert.equal(await notificationWrites(), before);
        await shot('scope-changed');
      } finally {
        await switchScope('home');
      }
    });
    for (const name of ['agent', 'platformAdmin', 'expiredAdmin'])
      await check('role-denied-' + name, async () => {
        await useRole(name);
        await open();
        await page
          .getByRole('heading', { name: '通知状況を表示する権限がありません', exact: true })
          .waitFor();
        assert.equal(await page.locator('.notification-table').count(), 0);
        await shot('denied-' + name);
      });
    await check(
      'finite-terminal-and-processing-states',
      async () => {
        await useRole('orgAdmin');
        for (const state of ['processing', 'failed', 'rejected', 'expired', 'unknown']) {
          await open();
          await setFault('GET', 'state_' + state);
          await inspect('unused');
          assert.equal(
            await panel().getByRole('button', { name: '再試行を予約', exact: true }).count(),
            0,
          );
          await shot('state-' + state);
          await setFault();
        }
      },
      'controlled safe status DTO; real session',
    );
    await check('cross-origin-action-rejected-without-api-write', async () => {
      await open();
      await inspect('unused');
      const before = await notificationWrites();
      let intercepted = 0,
        nextAction = false;
      await page.route(target.origin + '/ops/notifications**', async (route) => {
        const request = route.request();
        if (request.method() !== 'POST') return route.continue();
        intercepted++;
        const headers = await request.allHeaders();
        nextAction = typeof headers['next-action'] === 'string';
        const response = await route.fetch({
          headers: { ...headers, origin: 'https://cross-origin.invalid' },
          maxRedirects: 0,
        });
        await route.fulfill({ response });
      });
      try {
        const [response] = await Promise.all([
          page.waitForResponse((response) => response.request().method() === 'POST'),
          panel().getByRole('button', { name: '再試行を予約', exact: true }).click(),
        ]);
        step = 'origin-rejection';
        assert.ok(response.status() >= 400);
        assert.equal(intercepted, 1);
        assert.equal(nextAction, true);
        assert.equal(await notificationWrites(), before);
      } finally {
        await page.unrouteAll({ behavior: 'wait' });
      }
      await open();
      await inspect('unused');
      await panel().getByRole('button', { name: '再試行を予約', exact: true }).waitFor();
    });
    await check('keyboard-mobile-focus-and-local-scroll', async () => {
      await open();
      step = 'keyboard-entry';
      const button = row('unused').getByRole('button', { name: '再試行を確認', exact: true });
      await tabTo(button);
      const entryFocus = await focus(button);
      await page.keyboard.press('Enter');
      await panel().locator('.notification-retry-result').waitFor();
      step = 'keyboard-confirm';
      const reserveButton = panel().getByRole('button', { name: '再試行を予約', exact: true });
      await tabTo(reserveButton);
      const confirmFocus = await focus(reserveButton);
      step = 'mobile';
      await page.setViewportSize({ width: 390, height: 844 });
      await panel().locator('.notification-retry-result').focus();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390));
      await shot('confirmation-mobile-390');
      const close = panel().getByRole('button', { name: '閉じる', exact: true });
      await tabTo(close);
      await page.keyboard.press('Enter');
      assert.equal(await panel().count(), 0);
      assert.equal(await button.evaluate((el) => document.activeElement === el), true);
      await page.setViewportSize({ width: 1280, height: 720 });
      return { entryFocus, confirmFocus, tabEnter: true };
    });
    await live();
    report.success = report.checks.length === 22 && report.checks.every((check) => check.passed);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await cancellation;
    try {
      await context?.close();
      await browser?.close();
      report.cleanup.browserClosed = true;
    } catch {
      report.success = false;
    }
    await control({ method: 'GET', mode: 'none' });
    if (signal?.aborted) report.success = false;
    report.finishedAt = new Date().toISOString();
    writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  }
  if (signal?.aborted) throw new Error('RETRY_UI_ABORTED');
  return report;
}
