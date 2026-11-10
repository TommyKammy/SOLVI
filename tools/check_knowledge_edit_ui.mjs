/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import { access, chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { articleId, savedValues, editedValues } from './knowledge_edit_fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidenceRoot = resolve(root, 'evidence/WP-P3-KNWEDIT-083');
const detailPath = '/knowledge/' + articleId;
const returnPath = '/knowledge?' + new URLSearchParams({ manage: '1', q: '合成' });
const entry = detailPath + '?' + new URLSearchParams({ manage: '1', returnTo: returnPath });
const expectedChecks = 23;

export async function runKnowledgeEditChecks({
  baseURL,
  outputDirectory,
  control,
  candidateReads,
  allReads,
  observations,
  assertOwned,
  signal,
  nativeKeyboard,
}) {
  const target = new URL(baseURL),
    output = resolve(outputDirectory),
    within = relative(evidenceRoot, output);
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
  assert.ok(within && !within.startsWith('..') && !isAbsolute(within));
  assert.equal(await realpath(dirname(output)), dirname(output));
  for (const cb of [control, candidateReads, allReads, observations, assertOwned, nativeKeyboard])
    assert.equal(typeof cb, 'function');
  await access(chromium.executablePath());
  await mkdir(output, { mode: 0o700 });
  const report = {
    workPackage: 'WP-P3-KNWEDIT-083',
    model:
      'Production Next and real server actions with explicitly permitted synthetic API writes; no database or real authorization.',
    realAuthorizationTested: false,
    realDatabaseTested: false,
    productionAcceptance: false,
    checks: [],
    submissionGuards: [],
    screenshots: [],
    accessibility: [],
    browserRequests: {
      allowedActions: 0,
      unexpectedWrites: 0,
      unknownReads: 0,
      foreignOrigin: 0,
      downloads: 0,
    },
    prefetch: { attempted: 0, blocked: 0, forwarded: 0 },
    browserClosed: false,
    success: false,
  };
  let browser,
    browserServer,
    context,
    page,
    step = 'initial',
    permitPosts = 0,
    failure,
    aborted = false;
  let cancellation = Promise.resolve();
  const onAbort = () => {
    aborted = true;
    cancellation = Promise.allSettled([
      Promise.resolve().then(() => context?.close()),
      Promise.resolve().then(() => browser?.close()),
      Promise.resolve().then(() => browserServer?.close()),
    ]).then(() => undefined);
  };
  const live = async () => {
    assert.ok(!signal?.aborted);
    await assertOwned();
    assert.ok(!signal?.aborted);
  };
  const main = () => page.locator('main');
  const editor = () =>
    main()
      .locator('form')
      .filter({ has: page.locator('#article-title') });
  const actions = () =>
    main()
      .locator('form')
      .filter({ has: page.locator('#restore-version') });
  const save = () => editor().getByRole('button', { name: '下書きを保存する', exact: true });
  const stateText = () =>
    main().locator('section[aria-labelledby="knowledge-edit-heading"]').getByRole('status');
  const writes = () => observations().allowedWrites;
  const pendingWrite = async (previous) => {
    step = 'pending-request-arrived';
    for (let attempt = 0; attempt < 100 && writes() === previous; attempt++) {
      await live();
      await pause(20);
    }
    assert.equal(writes(), previous + 1);
    assert.equal(observations().writes.at(-1).completed, false);
  };
  const open = async (path = entry) => {
    step = 'document';
    await live();
    await page.goto(target.origin + path, { waitUntil: 'domcontentloaded' });
    await main().getByRole('heading', { level: 1 }).waitFor();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('main form')].every(
        (form) => !form.hasAttribute('inert') && form.getAttribute('aria-busy') !== 'true',
      ),
    );
  };
  const role = async (actor) => {
    await context.clearCookies();
    await context.addCookies([
      {
        name: 'solvi_session_wp083_synthetic',
        value: actor,
        url: target.origin,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
  };
  const scenario = async (next = {}) => {
    await live();
    assert.equal(permitPosts, 0);
    await control(next);
  };
  const values = async () =>
    Object.fromEntries(
      await Promise.all(
        Object.keys(savedValues).map(async (key) => [
          key,
          await main().locator(`[name="${key}"]`).inputValue(),
        ]),
      ),
    );
  const fill = async () => {
    for (const [name, value] of Object.entries(editedValues)) {
      if (name === 'audience') await main().locator('#article-audience').selectOption(value);
      else
        await main()
          .locator('#article-' + name)
          .fill(value);
    }
  };
  const guarded = async (form) => {
    step = 'capture-submission-guard';
    const before = writes(),
      browserBefore = report.browserRequests.allowedActions;
    const prevented = await form.evaluate(
      (element) => !element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    report.submissionGuards.push({
      prevented,
      apiBefore: before,
      apiAfter: writes(),
      browserBefore,
      browserAfter: report.browserRequests.allowedActions,
    });
    assert.equal(prevented, true);
    assert.equal(writes(), before);
    assert.equal(report.browserRequests.allowedActions, browserBefore);
  };
  const capture = async (name, anchor) => {
    step = 'capture';
    await live();
    if (anchor) await anchor.scrollIntoViewIfNeeded();
    if (name === 'save-failure-400') {
      const errorLink = editor().locator('.error-link');
      await errorLink.hover();
      assert.equal(
        await errorLink.evaluate((element) => getComputedStyle(element).backgroundColor),
        'rgba(0, 0, 0, 0)',
      );
    }
    const result = await new AxeBuilder({ page }).analyze();
    const violations = [];
    for (const violation of result.violations) {
      const nodes = [];
      for (const node of violation.nodes) {
        if (typeof node.target[0] !== 'string') continue;
        nodes.push(
          await page
            .locator(node.target[0])
            .first()
            .evaluate((element) => {
              const style = getComputedStyle(element),
                form = element.closest('form');
              return {
                tag: element.tagName.toLowerCase(),
                region: form?.querySelector('#article-title')
                  ? 'editor'
                  : form?.querySelector('#restore-version')
                    ? 'actions'
                    : 'other',
                category: element.closest('.error-summary')
                  ? element.tagName === 'A'
                    ? 'error-link'
                    : 'error-summary'
                  : element.matches(':disabled')
                    ? 'disabled-control'
                    : 'other',
                color: style.color,
                background: style.backgroundColor,
                fontSize: style.fontSize,
                opacity: style.opacity,
              };
            }),
        );
      }
      violations.push({
        id: violation.id,
        impact: violation.impact,
        nodes: violation.nodes.length,
        computed: nodes,
      });
    }
    report.accessibility.push({ name, violations });
    const path = resolve(output, name + '.png');
    await page.screenshot({ path, fullPage: false });
    await chmod(path, 0o600);
    report.screenshots.push({
      name,
      path: name + '.png',
      type: 'viewport',
      width: page.viewportSize().width,
    });
    assert.equal(result.violations.length, 0);
  };
  const noOverflow = async () =>
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
      true,
    );
  const submit = async (button, keyboard = false) => {
    step = 'server-action';
    permitPosts = 1;
    if (keyboard) await page.keyboard.press('Enter');
    else await button.click();
  };
  async function check(name, fn) {
    step = 'check';
    await live();
    try {
      const detail = await fn();
      report.checks.push({ name, passed: true, ...detail });
    } catch {
      report.checks.push({ name, passed: false, step });
      permitPosts = 0;
    }
  }
  try {
    await live();
    browserServer = await chromium.launchServer({ headless: false });
    browser = await chromium.connect(browserServer.wsEndpoint());
    report.ownedBrowserPid = browserServer.process().pid;
    context = await browser.newContext({
      viewport: { width: 1280, height: 850 },
      deviceScaleFactor: 1,
    });
    const paths = new Set([
      detailPath,
      '/knowledge',
      '/knowledge/new',
      '/api/draft-scope',
      '/favicon.ico',
    ]);
    await context.route('**/*', async (route) => {
      const req = route.request(),
        url = new URL(req.url());
      if (url.origin !== target.origin) {
        report.browserRequests.foreignOrigin++;
        return route.abort();
      }
      if (!['GET', 'HEAD'].includes(req.method())) {
        if (
          req.method() === 'POST' &&
          [detailPath, '/knowledge/new'].includes(url.pathname) &&
          req.headers()['next-action'] &&
          permitPosts === 1
        ) {
          permitPosts = 0;
          report.browserRequests.allowedActions++;
          return route.continue();
        }
        report.browserRequests.unexpectedWrites++;
        return route.abort();
      }
      const headers = req.headers();
      if (
        headers['next-router-prefetch'] === '1' ||
        /prefetch/i.test(headers.purpose ?? '') ||
        /prefetch/i.test(headers['sec-purpose'] ?? '')
      ) {
        report.prefetch.attempted++;
        report.prefetch.blocked++;
        return route.abort();
      }
      if (!paths.has(url.pathname) && !url.pathname.startsWith('/_next/')) {
        report.browserRequests.unknownReads++;
        return route.abort();
      }
      return route.continue();
    });
    page = await context.newPage();
    page.setDefaultTimeout(10000);
    context.on('page', (p) => p.on('download', () => report.browserRequests.downloads++));
    page.on('download', () => report.browserRequests.downloads++);
    signal?.addEventListener('abort', onAbort, { once: true });
    for (const actor of ['agent', 'org_admin'])
      for (const state of ['draft', 'review', 'published', 'retired']) {
        await check(actor + '-' + state, async () => {
          await role(actor);
          await scenario({ state });
          await open();
          assert.equal(await editor().count(), ['draft', 'published'].includes(state) ? 1 : 0);
          assert.equal(
            await actions().getByRole('button', { name: '確認した内容を公開する' }).count(),
            actor === 'org_admin' && state === 'review' ? 1 : 0,
          );
          assert.equal(
            await actions().getByRole('button', { name: '公開を取り下げる' }).count(),
            actor === 'org_admin' && state !== 'retired' ? 1 : 0,
          );
          assert.ok((await main().innerText()).includes('操作対象: 保存済みの版 9'));
          await actions().getByText('過去の版から下書きを作る', { exact: true }).click();
          assert.deepEqual(
            await page
              .locator('#restore-version option')
              .evaluateAll((options) => options.map((option) => option.value)),
            ['9', '7', '6', '2'],
          );
          assert.ok(
            (await page.locator('#restore-version').innerText()).includes('2026年10月10日 10:00'),
          );
          await capture(actor + '-' + state, actions());
        });
      }
    await role('org_admin');
    for (const name of Object.keys(savedValues))
      await check('dirty-' + name + '-and-revert', async () => {
        await scenario({ state: 'published' });
        await open();
        if (name === 'audience') await main().locator('#article-audience').selectOption('staff');
        else
          await main()
            .locator('#article-' + name)
            .fill(savedValues[name] + ' ');
        await stateText().filter({ hasText: '未保存の変更' }).waitFor();
        assert.equal(
          await actions().getByRole('button', { name: '公開を取り下げる' }).isDisabled(),
          true,
        );
        await guarded(actions());
        await capture('dirty-' + name, stateText());
        if (name === 'audience')
          await main().locator('#article-audience').selectOption(savedValues[name]);
        else
          await main()
            .locator('#article-' + name)
            .fill(savedValues[name]);
        await stateText().filter({ hasText: '保存済みの内容と一致' }).waitFor();
        assert.equal(
          await actions().getByRole('button', { name: '公開を取り下げる' }).isEnabled(),
          true,
        );
        return { completeRevertReenabled: true, blockedSubmit: true, writes: 0 };
      });
    for (const status of ['400', '409', '503'])
      await check('save-failure-' + status, async () => {
        await scenario({ mode: status, permit: 'save' });
        await open();
        await fill();
        await submit(save());
        await main().getByRole('heading', { name: '保存・送信できませんでした' }).waitFor();
        assert.deepEqual(await values(), editedValues);
        assert.ok((await stateText().innerText()).includes('未保存の変更'));
        assert.equal(await save().isEnabled(), true);
        await guarded(actions());
        await capture('save-failure-' + status, editor());
        return {
          retainedFields: 4,
          lifecycleStillBlocked: true,
          receivedStatus: observations().writes.at(-1).status,
        };
      });
    await check('save-pending-success-new-baseline', async () => {
      await scenario({ mode: 'delay_success', permit: 'save' });
      await open();
      await fill();
      const previous = writes();
      await submit(save());
      step = 'save-pending-input-disabled';
      await editor().locator('[name="title"]:disabled').waitFor();
      await pendingWrite(previous);
      await guarded(actions());
      await guarded(editor());
      assert.equal(
        await actions().getByRole('button', { name: 'レビューへ送る' }).isDisabled(),
        true,
      );
      await capture('save-pending', stateText());
      await control({ release: true });
      await page.waitForURL((url) => url.searchParams.get('saved') === '1');
      await stateText().filter({ hasText: '保存済みの内容と一致' }).waitFor();
      assert.deepEqual(await values(), editedValues);
      assert.equal(await editor().locator('[name="expectedVersion"]').inputValue(), '10');
      assert.equal(new URL(page.url()).searchParams.get('returnTo'), returnPath);
      assert.ok((await main().innerText()).includes('操作対象: 保存済みの版 10'));
      assert.equal(
        await actions().getByRole('button', { name: 'レビューへ送る' }).isEnabled(),
        true,
      );
      await main()
        .locator('#article-tags')
        .fill(editedValues.tags + ' ');
      await stateText().filter({ hasText: '未保存の変更' }).waitFor();
      await main().locator('#article-tags').fill(editedValues.tags);
      await stateText().filter({ hasText: '保存済みの内容と一致' }).waitFor();
      assert.equal(observations().writes.at(-1).storedBodyUsesTransportCRLF, true);
      await main()
        .locator('#article-body')
        .fill(editedValues.body + ' ');
      await stateText().filter({ hasText: '未保存の変更' }).waitFor();
      assert.equal(
        await actions().getByRole('button', { name: 'レビューへ送る' }).isDisabled(),
        true,
      );
      await main().locator('#article-body').fill(editedValues.body);
      await stateText().filter({ hasText: '保存済みの内容と一致' }).waitFor();
      assert.equal(
        await actions().getByRole('button', { name: 'レビューへ送る' }).isEnabled(),
        true,
      );
      await capture('save-success', stateText());
      return {
        newVersion: 10,
        newContentVersion: 10,
        preservedReturnTo: true,
        allFourFieldsSent: observations().writes.at(-1).allFourFields,
        storedCRLFBodyEditRevert: true,
      };
    });
    await check('lifecycle-pending-failure-unlocks-editor', async () => {
      await scenario({ mode: 'delay_failure', permit: 'review' });
      await open();
      const previous = writes();
      await submit(actions().getByRole('button', { name: 'レビューへ送る' }));
      step = 'lifecycle-pending-input-disabled';
      await editor().locator('[name="title"]:disabled').waitFor();
      await pendingWrite(previous);
      await guarded(editor());
      assert.equal(await save().isDisabled(), true);
      await capture('lifecycle-pending', stateText());
      await control({ release: true });
      await main().getByRole('heading', { name: '保存・送信できませんでした' }).waitFor();
      assert.equal(await save().isEnabled(), true);
      assert.deepEqual(await values(), savedValues);
      await capture('lifecycle-failed', actions());
      return { saveBlockedDuringLifecycle: true, inputsRetained: true, failureReenabled: true };
    });
    await check('explicit-review-targets-saved-version', async () => {
      await scenario({ permit: 'review' });
      await open();
      await submit(actions().getByRole('button', { name: 'レビューへ送る' }));
      await page.waitForURL((url) => url.searchParams.get('saved') === '1');
      await main().getByText('操作対象: 保存済みの版 10 · レビュー待ち', { exact: true }).waitFor();
      assert.equal(await editor().count(), 0);
      await capture('review-succeeded', actions());
    });
    await check('standalone-new-editor', async () => {
      await scenario({ permit: 'create' });
      await open('/knowledge/new?' + new URLSearchParams({ returnTo: returnPath }));
      assert.equal(await actions().count(), 0);
      await fill();
      await submit(save());
      await page.waitForURL(
        (url) => url.pathname === detailPath && url.searchParams.get('saved') === '1',
      );
      await stateText().filter({ hasText: '保存済みの内容と一致' }).waitFor();
      assert.deepEqual(await values(), editedValues);
      await capture('created-article', stateText());
    });
    await check('public-published-projection', async () => {
      await role('requester');
      await scenario();
      await open(detailPath);
      await main().getByRole('heading', { name: '公開中の版2の記事' }).waitFor();
      assert.ok((await main().innerText()).includes('版 2'));
      assert.equal(await main().locator('form').count(), 0);
      assert.equal((await main().innerText()).includes('保存済みの版を操作'), false);
      assert.equal((await main().innerText()).includes(savedValues.body), false);
      await capture('public-published');
    });
    await check('keyboard-save-and-restore-selection', async () => {
      await role('agent');
      await scenario({ permit: 'save' });
      await open();
      await fill();
      await main().locator('#article-audience').focus();
      for (let i = 0; i < 8 && !(await save().evaluate((e) => e === document.activeElement)); i++)
        await page.keyboard.press('Tab');
      assert.equal(
        await save().evaluate(
          (e) =>
            e === document.activeElement &&
            (getComputedStyle(e).outlineStyle !== 'none' ||
              getComputedStyle(e).boxShadow !== 'none'),
        ),
        true,
      );
      await capture('keyboard-save-focus', save());
      await submit(save(), true);
      step = 'keyboard-save-redirect';
      await page.waitForURL((url) => url.searchParams.get('saved') === '1');
      await stateText().filter({ hasText: '保存済みの内容と一致' }).waitFor();
      step = 'keyboard-restore-select';
      await page.waitForFunction(() =>
        [...document.querySelectorAll('main form')].every(
          (form) => !form.hasAttribute('inert') && form.getAttribute('aria-busy') !== 'true',
        ),
      );
      await actions().getByText('過去の版から下書きを作る', { exact: true }).click();
      assert.deepEqual(
        await page
          .locator('#restore-version option')
          .evaluateAll((options) => options.map((option) => option.value)),
        ['10', '9', '7', '6', '2'],
      );
      assert.equal(await page.locator('#restore-version').inputValue(), '10');
      await page.locator('#restore-version').focus();
      assert.equal(new URL(page.url()).origin, target.origin);
      assert.equal(new URL(page.url()).pathname, detailPath);
      assert.equal(await page.locator('#restore-version').isEnabled(), true);
      assert.equal(
        await page
          .locator('#restore-version')
          .evaluate((element) => element === document.activeElement),
        true,
      );
      const nativeBefore = {
        api: writes(),
        browser: report.browserRequests.allowedActions,
        unexpected: report.browserRequests.unexpectedWrites,
      };
      report.keyboardSelection = {
        before: Number(await page.locator('#restore-version').inputValue()),
        method: 'macOS native popup Down Down Return, then CDP Enter Tab',
        ownedOriginAndPath: true,
        focusedBefore: true,
      };
      await page.bringToFront();
      await nativeKeyboard({
        ownedBrowserPid: report.ownedBrowserPid,
        executable: chromium.executablePath(),
        windowTitle: await page.title(),
        origin: target.origin,
        initialValue: 10,
        requiredValue: 9,
      });
      await live();
      report.keyboardSelection.afterNative = Number(
        await page.locator('#restore-version').inputValue(),
      );
      report.keyboardSelection.nativeWritesUnchanged =
        JSON.stringify(nativeBefore) ===
        JSON.stringify({
          api: writes(),
          browser: report.browserRequests.allowedActions,
          unexpected: report.browserRequests.unexpectedWrites,
        });
      assert.equal(report.keyboardSelection.nativeWritesUnchanged, true);
      assert.equal(report.keyboardSelection.afterNative, 9);
      assert.equal(
        await page
          .locator('#restore-version')
          .evaluate((element) => element === document.activeElement),
        true,
      );
      const beforeEnter = {
        api: writes(),
        browser: report.browserRequests.allowedActions,
        unexpected: report.browserRequests.unexpectedWrites,
      };
      await page.keyboard.press('Enter');
      assert.deepEqual(
        {
          api: writes(),
          browser: report.browserRequests.allowedActions,
          unexpected: report.browserRequests.unexpectedWrites,
        },
        beforeEnter,
      );
      report.keyboardSelection.afterEnter = Number(
        await page.locator('#restore-version').inputValue(),
      );
      await page.keyboard.press('Tab');
      report.keyboardSelection.afterBlur = Number(
        await page.locator('#restore-version').inputValue(),
      );
      assert.equal(await page.locator('#restore-version').inputValue(), '9');
      assert.equal(report.keyboardSelection.afterEnter, 9);
      return { tab: true, enter: true, restoreKeyboardSelection: true, restored: false };
    });
    await page.setViewportSize({ width: 390, height: 844 });
    for (const dirty of [false, true])
      await check('mobile-' + (dirty ? 'dirty' : 'saved'), async () => {
        await scenario();
        await open();
        if (dirty) await main().locator('#article-title').fill(editedValues.title);
        await actions().getByText('過去の版から下書きを作る', { exact: true }).click();
        await noOverflow();
        await capture('mobile-' + (dirty ? 'dirty' : 'saved'), dirty ? stateText() : actions());
        return { width: 390, documentOverflow: false };
      });
  } catch {
    failure = 'KNOWLEDGE_EDIT_UI_INCOMPLETE';
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await cancellation;
    const closing = await Promise.allSettled([
      Promise.resolve().then(() => browser?.close()),
      Promise.resolve().then(() => browserServer?.close()),
    ]);
    report.browserClosed = closing.every((result) => result.status === 'fulfilled');
  }
  report.api = observations();
  report.expectedChecks = expectedChecks;
  report.success =
    !signal?.aborted &&
    !aborted &&
    !failure &&
    report.checks.length === expectedChecks &&
    report.checks.every((x) => x.passed) &&
    report.accessibility.every((x) => x.violations.length === 0) &&
    report.browserClosed &&
    report.browserRequests.unknownReads === 0 &&
    report.browserRequests.unexpectedWrites === 0 &&
    report.browserRequests.foreignOrigin === 0 &&
    report.browserRequests.downloads === 0 &&
    report.api.unexpectedMutations === 0 &&
    report.api.unknownReads === 0 &&
    report.api.allowedWrites === 8 &&
    report.browserRequests.allowedActions === 8 &&
    report.api.writes.every((x) => x.bodyValid && x.completed) &&
    report.api.writes.filter((x) => x.status === 200).length === 3 &&
    report.api.writes.filter((x) => x.route === 'create' && x.status === 201).length === 1 &&
    report.api.writes.filter((x) => x.releaseControlled === true).length === 2;
  if (failure) report.failureCode = failure;
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  if (signal?.aborted) throw new Error('KNOWLEDGE_EDIT_UI_ABORTED');
  return report;
}
