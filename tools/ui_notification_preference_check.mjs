/* global document, window, getComputedStyle */
// Browser checks only. The caller owns the isolated real DB/API/Web and fault proxy.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { access, chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const safeRoot = resolve(root, 'evidence/WP-P2-NTFPREF-057');
const path = '/settings/notifications';

export async function runNotificationPreferenceUiCheck({
  baseURL,
  outputDirectory,
  sessions,
  control,
  preferenceReads,
  preferenceWrites,
  switchScope,
  assertOwned,
  signal,
}) {
  if (signal?.aborted) throw new Error('PREFERENCE_UI_ABORTED');
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
  for (const key of ['requester', 'agent', 'orgAdmin', 'platformAdmin', 'expiredAdmin'])
    assert.match(sessions[key], /^solvi_session[^=]*=[A-Za-z0-9_-]+$/);
  for (const fn of [control, preferenceReads, preferenceWrites, switchScope, assertOwned])
    assert.equal(typeof fn, 'function');
  await access(chromium.executablePath()); // Installed browser only; no download fallback.
  await mkdir(output, { mode: 0o700 });
  const report = {
    workPackage: 'WP-P2-NTFPREF-057',
    startedAt: new Date().toISOString(),
    success: false,
    model: 'Owned real sessions/API; method-specific controlled faults are separately identified.',
    checks: [],
    screenshots: [],
    axe: [],
    cleanup: { browserClosed: false, proxyReset: false, homeScopeRestored: false },
    productionAcceptance: false,
  };
  let browser,
    context,
    page,
    role = 'requester';
  let cancellation = Promise.resolve();
  let currentFault = { method: 'GET', mode: 'none' };
  // Assigned only from the fixed check steps below; never from thrown messages.
  let failureStep = 'PREFERENCE_UI_ASSERTION_FAILED';
  const onAbort = () => {
    cancellation = Promise.allSettled([
      Promise.resolve().then(() => context?.close()),
      Promise.resolve().then(() => browser?.close()),
    ]).then(() => undefined);
  };
  const live = async () => {
    if (signal?.aborted) throw new Error('PREFERENCE_UI_ABORTED');
    await assertOwned();
    if (signal?.aborted) throw new Error('PREFERENCE_UI_ABORTED');
  };
  const fault = async (method, mode) => {
    await live();
    await control({ method, mode });
    currentFault = { method, mode };
  };
  const resetFaults = async () => {
    await control({ method: 'GET', mode: 'none' });
    await control({ method: 'PATCH', mode: 'none' });
    currentFault = { method: 'GET', mode: 'none' };
  };
  const checkbox = () =>
    page.getByRole('checkbox', { name: 'チケットの更新をメールで受け取る', exact: true });
  const save = () => page.getByRole('button', { name: '設定を保存', exact: true });
  const form = () => page.getByRole('form', { name: 'メール通知の設定', exact: true });
  const error = () => page.locator('.notification-preference-form .error-summary');
  const ready = async () => {
    await checkbox().waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector('.notification-preference-form')?.getAttribute('aria-busy') ===
        'false',
    );
  };
  async function useRole(name) {
    await live();
    await context?.close();
    role = name;
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
      locale: 'ja-JP',
    });
    const raw = sessions[name],
      at = raw.indexOf('=');
    await context.addCookies([
      {
        name: raw.slice(0, at),
        value: raw.slice(at + 1),
        url: target.origin,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    page = await context.newPage();
    page.setDefaultTimeout(10000);
  }
  async function open() {
    await live();
    await page.goto(target.origin + path, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { level: 1, name: 'メール通知の設定', exact: true }).waitFor();
  }
  async function setAndSave(enabled) {
    await live();
    await ready();
    await checkbox().setChecked(enabled);
    if (await save().isDisabled()) return;
    await save().click();
    await page.getByText('設定を保存しました。', { exact: true }).waitFor();
    await ready();
    assert.equal(await checkbox().isChecked(), enabled);
    assert.equal(await error().count(), 0);
  }
  async function shot(name, withAxe = true) {
    await live();
    await page.screenshot({ path: resolve(output, name + '.png'), fullPage: false });
    await chmod(resolve(output, name + '.png'), 0o600);
    report.screenshots.push({
      name,
      role,
      captureType: 'viewport',
      viewport: page.viewportSize(),
      fault: { ...currentFault },
    });
    if (withAxe) {
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
    failureStep = 'PREFERENCE_UI_ASSERTION_FAILED';
    try {
      await task();
      await live();
      report.checks.push({ name, model, passed: true });
    } catch {
      report.checks.push({
        name,
        model,
        passed: false,
        failureCode: signal?.aborted ? 'PREFERENCE_UI_ABORTED' : failureStep,
      });
    } finally {
      await resetFaults();
    }
  }
  async function tabTo(locator) {
    for (let i = 0; i < 100; i++) {
      await page.keyboard.press('Tab');
      if (await locator.evaluate((element) => document.activeElement === element)) return;
    }
    throw new Error('PREFERENCE_UI_FOCUS_FAILED');
  }
  async function focus(locator) {
    const state = await locator.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        active: document.activeElement === element,
        visible: element.matches(':focus-visible'),
        outline: parseFloat(style.outlineWidth) > 0 && style.outlineStyle !== 'none',
      };
    });
    assert.ok(state.active && state.visible && state.outline);
    return state;
  }
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await live();
    browser = await chromium.launch({ headless: true });
    await live();
    await resetFaults();
    await useRole('requester');
    await test('personal-entry-default-on-save-off-reload-and-on', async () => {
      await open();
      await ready();
      assert.equal(
        await page.getByRole('link', { name: '自分の通知設定', exact: true }).count(),
        1,
      );
      assert.equal(await checkbox().isChecked(), true);
      assert.equal(await save().isDisabled(), true);
      await shot('requester-default-desktop');
      await setAndSave(false);
      await shot('requester-saved-off');
      const before = await preferenceReads();
      await page.reload({ waitUntil: 'networkidle' });
      await ready();
      assert.equal(await checkbox().isChecked(), false);
      assert.ok((await preferenceReads()) > before);
      await setAndSave(true);
    });
    await test('other-members-unchanged', async () => {
      for (const name of ['agent', 'orgAdmin']) {
        await useRole(name);
        await open();
        await ready();
        assert.equal(await checkbox().isChecked(), true);
      }
      await shot('org-admin-personal-setting');
    });
    for (const name of ['platformAdmin', 'expiredAdmin'])
      await test(name + '-denied', async () => {
        failureStep = 'PREFERENCE_UI_DENIED_OPEN_FAILED';
        await useRole(name);
        await open();
        failureStep = 'PREFERENCE_UI_DENIED_HEADING_MISSING';
        await page
          .getByRole('heading', { name: '通知設定を表示できません', exact: true })
          .waitFor();
        failureStep = 'PREFERENCE_UI_DENIED_FORM_EXPOSED';
        assert.equal(await checkbox().count(), 0);
        failureStep = 'PREFERENCE_UI_DENIED_EVIDENCE_FAILED';
        await shot(name + '-denied');
      });
    await test(
      'loading-read-has-no-speculative-default',
      async () => {
        await useRole('requester');
        await fault('GET', 'delay');
        await page.goto(target.origin + path, { waitUntil: 'commit' });
        await page.getByText('保存済みの設定を読み込んでいます…', { exact: true }).waitFor();
        assert.equal(await checkbox().count(), 0);
        await shot('loading-read', false);
        await ready();
        assert.equal(await checkbox().isChecked(), true);
      },
      'controlled bounded GET delay; real API',
    );
    for (const mode of ['401', '403', '503', 'network', 'body_cut'])
      await test(
        'get-' + mode + '-and-recovery',
        async () => {
          await useRole('requester');
          await fault('GET', mode);
          await open();
          await page.locator('main [role="alert"]').waitFor();
          assert.equal(await checkbox().count(), 0);
          if (mode === '401')
            assert.equal(
              await page
                .getByRole('link', { name: '別のタブでログインする' })
                .getAttribute('target'),
              '_blank',
            );
          await shot('get-' + mode);
          await fault('GET', 'none');
          const before = await preferenceReads();
          await page.getByRole('link', { name: '通知設定を再読み込み', exact: true }).click();
          await ready();
          assert.ok((await preferenceReads()) > before);
          assert.equal(await checkbox().isChecked(), true);
        },
        'controlled GET fault; real session and recovery',
      );
    for (const mode of ['401', '403', '503', 'network', 'body_cut'])
      await test(
        'patch-' + mode + '-retains-input-and-recovers',
        async () => {
          await useRole('requester');
          await open();
          await ready();
          await checkbox().uncheck();
          await fault('PATCH', mode);
          await save().click();
          await error().waitFor();
          assert.equal(await checkbox().isChecked(), false);
          await page.waitForFunction(
            () =>
              document.activeElement?.matches('.notification-preference-form .error-summary') ===
              true,
          );
          assert.equal(
            await error().evaluate((element) => document.activeElement === element),
            true,
          );
          assert.equal(await page.getByText('設定を保存しました。', { exact: true }).count(), 0);
          await shot('patch-' + mode);
          await fault('PATCH', 'none');
          await setAndSave(false);
          await setAndSave(true);
        },
        'controlled PATCH fault; real session and recovery',
      );
    await test(
      'pending-prevents-double-save',
      async () => {
        await useRole('requester');
        await open();
        await ready();
        const before = await preferenceWrites();
        await checkbox().uncheck();
        await fault('PATCH', 'delay');
        await save().click({ clickCount: 2 });
        await page.getByRole('button', { name: '保存しています…', exact: true }).waitFor();
        assert.equal(await checkbox().isDisabled(), true);
        assert.equal(await form().getAttribute('aria-busy'), 'true');
        await shot('saving', false);
        await page.getByText('設定を保存しました。', { exact: true }).waitFor();
        await ready();
        assert.equal((await preferenceWrites()) - before, 1);
        await fault('PATCH', 'none');
        await setAndSave(true);
      },
      'controlled bounded PATCH delay; real API',
    );
    await test('scope-switch-rejected-with-input-retained', async () => {
      await useRole('requester');
      await open();
      await ready();
      await checkbox().uncheck();
      const before = await preferenceWrites();
      await switchScope('foreign');
      try {
        await save().click();
        await error().waitFor();
        assert.equal(await checkbox().isChecked(), false);
        assert.equal(await checkbox().isDisabled(), true);
        assert.equal(
          await page.getByRole('link', { name: '現在の組織で設定を開き直す' }).count(),
          1,
        );
        assert.equal(await preferenceWrites(), before);
        await shot('scope-conflict');
      } finally {
        await switchScope('home');
      }
      await page.reload({ waitUntil: 'networkidle' });
      await ready();
      assert.equal(await checkbox().isChecked(), true);
    });
    await test('cross-origin-server-action-rejected-before-api-write', async () => {
      failureStep = 'PREFERENCE_UI_ORIGIN_OPEN_FAILED';
      await useRole('requester');
      await open();
      await ready();
      const originProof = { initialEnabled: await checkbox().isChecked(), interceptCount: 0 };
      report.originRejection = originProof;
      failureStep = 'PREFERENCE_UI_ORIGIN_INITIAL_VALUE_INVALID';
      assert.equal(originProof.initialEnabled, true);
      await checkbox().uncheck();
      const before = await preferenceWrites();
      await page.route(target.origin + path, async (route) => {
        const request = route.request();
        if (request.method() === 'POST') {
          originProof.interceptCount += 1;
          // Chromium can regenerate Origin after route.continue. Replay the same
          // owned-loopback request through APIRequestContext, then return its real response.
          const headers = {
            ...(await request.allHeaders()),
            origin: 'https://cross-origin.invalid',
          };
          originProof.serverActionHeaderPresent =
            typeof headers['next-action'] === 'string' && headers['next-action'].length > 0;
          originProof.forgedOriginRequested = headers.origin === 'https://cross-origin.invalid';
          originProof.sessionCookiePreserved =
            typeof headers.cookie === 'string' &&
            headers.cookie.split(';').some((value) => value.trim() === sessions.requester);
          const response = await route.fetch({ headers, maxRedirects: 0 });
          await route.fulfill({ response });
        } else await route.continue();
      });
      try {
        failureStep = 'PREFERENCE_UI_ORIGIN_RESPONSE_MISSING';
        const [rejected] = await Promise.all([
          page.waitForResponse(
            (response) =>
              response.url() === target.origin + path && response.request().method() === 'POST',
          ),
          save().click(),
        ]);
        originProof.responseStatus = rejected.status();
        originProof.apiWriteDelta = (await preferenceWrites()) - before;
        failureStep = 'PREFERENCE_UI_ORIGIN_INTERCEPT_MISSING';
        assert.equal(originProof.interceptCount, 1);
        failureStep = 'PREFERENCE_UI_ORIGIN_REPLAY_HEADERS_INVALID';
        assert.equal(originProof.serverActionHeaderPresent, true);
        assert.equal(originProof.forgedOriginRequested, true);
        assert.equal(originProof.sessionCookiePreserved, true);
        failureStep = 'PREFERENCE_UI_ORIGIN_HTTP_NOT_REJECTED';
        assert.ok(originProof.responseStatus >= 400);
        failureStep = 'PREFERENCE_UI_ORIGIN_API_WRITE_OBSERVED';
        assert.equal(originProof.apiWriteDelta, 0);
        failureStep = 'PREFERENCE_UI_ORIGIN_ERROR_PRESENTATION_MISSING';
        const boundary = page.getByRole('heading', {
          name: '画面を表示できませんでした',
          exact: true,
        });
        await error().or(boundary).first().waitFor();
        if (await error().count()) {
          originProof.errorPresentation = 'form-summary';
          failureStep = 'PREFERENCE_UI_ORIGIN_INPUT_NOT_RETAINED';
          assert.equal(await checkbox().isChecked(), false);
        } else {
          originProof.errorPresentation = 'application-boundary';
          failureStep = 'PREFERENCE_UI_ORIGIN_RECOVERY_CONTROL_MISSING';
          assert.equal(
            await page.getByRole('button', { name: 'もう一度読み込む', exact: true }).count(),
            1,
          );
        }
        failureStep = 'PREFERENCE_UI_ORIGIN_EVIDENCE_FAILED';
        await shot('server-action-origin-rejected');
      } finally {
        await page.unroute(target.origin + path);
      }
      failureStep = 'PREFERENCE_UI_ORIGIN_RELOAD_FAILED';
      await page.reload({ waitUntil: 'networkidle' });
      await ready();
      originProof.reloadedEnabled = await checkbox().isChecked();
      originProof.apiWriteDelta = (await preferenceWrites()) - before;
      assert.equal(originProof.reloadedEnabled, true);
      assert.equal(originProof.apiWriteDelta, 0);
    });
    await test('keyboard-and-mobile', async () => {
      failureStep = 'PREFERENCE_UI_KEYBOARD_OPEN_FAILED';
      await useRole('requester');
      await open();
      await ready();
      report.keyboard = {
        keys: ['Tab', 'Space', 'Enter'],
        initialEnabled: await checkbox().isChecked(),
      };
      failureStep = 'PREFERENCE_UI_KEYBOARD_INITIAL_VALUE_INVALID';
      assert.equal(report.keyboard.initialEnabled, true);
      failureStep = 'PREFERENCE_UI_KEYBOARD_CHECKBOX_FOCUS_FAILED';
      await tabTo(checkbox());
      const checkboxFocus = await focus(checkbox());
      report.keyboard.checkboxFocus = checkboxFocus;
      failureStep = 'PREFERENCE_UI_KEYBOARD_SPACE_VALUE_INVALID';
      await page.keyboard.press('Space');
      report.keyboard.afterSpaceEnabled = await checkbox().isChecked();
      assert.equal(report.keyboard.afterSpaceEnabled, false);
      failureStep = 'PREFERENCE_UI_KEYBOARD_SAVE_FOCUS_FAILED';
      await tabTo(save());
      const saveFocus = await focus(save());
      report.keyboard.saveFocus = saveFocus;
      failureStep = 'PREFERENCE_UI_KEYBOARD_EVIDENCE_FAILED';
      await shot('keyboard-focus');
      failureStep = 'PREFERENCE_UI_KEYBOARD_ENTER_SAVE_FAILED';
      await page.keyboard.press('Enter');
      await page.getByText('設定を保存しました。', { exact: true }).waitFor();
      await ready();
      report.keyboard.afterEnterEnabled = await checkbox().isChecked();
      assert.equal(report.keyboard.afterEnterEnabled, false);
      failureStep = 'PREFERENCE_UI_MOBILE_GEOMETRY_FAILED';
      await page.setViewportSize({ width: 390, height: 844 });
      const geometry = await page.evaluate(() => ({
        viewport: window.innerWidth,
        document: document.documentElement.scrollWidth,
      }));
      report.mobile = geometry;
      assert.ok(geometry.document <= geometry.viewport);
      failureStep = 'PREFERENCE_UI_MOBILE_EVIDENCE_FAILED';
      await shot('requester-mobile-390');
      failureStep = 'PREFERENCE_UI_KEYBOARD_RESTORE_FAILED';
      await setAndSave(true);
    });
  } catch {
    report.failureCode = signal?.aborted ? 'PREFERENCE_UI_ABORTED' : 'PREFERENCE_UI_RUN_FAILED';
  } finally {
    try {
      await resetFaults();
      report.cleanup.proxyReset = true;
    } catch {
      report.failureCode = 'PREFERENCE_UI_PROXY_RESET_FAILED';
    }
    try {
      await switchScope('home');
      report.cleanup.homeScopeRestored = true;
    } catch {
      report.failureCode = 'PREFERENCE_UI_SCOPE_RESTORE_FAILED';
    }
    await cancellation;
    try {
      await browser?.close();
      report.cleanup.browserClosed = true;
    } catch {
      report.cleanup.browserClosed = false;
    }
    signal?.removeEventListener('abort', onAbort);
    if (signal?.aborted) report.failureCode = 'PREFERENCE_UI_ABORTED';
    report.finishedAt = new Date().toISOString();
    report.success =
      !report.failureCode &&
      !signal?.aborted &&
      report.checks.length === 19 &&
      report.checks.every((check) => check.passed) &&
      Object.values(report.cleanup).every(Boolean);
    const text = JSON.stringify(report, null, 2) + '\n';
    assert.ok(Object.values(sessions).every((value) => !text.includes(value)));
    writeFileSync(resolve(output, 'report.json'), text, { flag: 'wx', mode: 0o600 });
  }
  if (signal?.aborted) throw new Error('PREFERENCE_UI_ABORTED');
  return report;
}
