/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import { access, chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidenceRoot = resolve(root, 'evidence/WP-P2-CHGNEW-075');
const ticketId = '07500000-0000-4000-8000-000000000010';
const assetId = '07500000-0000-4000-8000-000000000020';
const userId = '07500000-0000-4000-8000-000000000002';
const entryPath = '/changes/new';
const returnPath = '/changes?' + new URLSearchParams({ q: '合成', state: 'review', page: '2' });
const seeds = (shape) => ({
  ...(shape === 'ticket' || shape === 'both' ? { ticketId } : {}),
  ...(shape === 'asset' || shape === 'both' ? { assetId } : {}),
});
const createPath = (shape = 'both', from = returnPath) =>
  entryPath + '?' + new URLSearchParams({ ...seeds(shape), ...(from ? { returnTo: from } : {}) });
const candidateQuery = (shape) =>
  new URLSearchParams({
    ...(shape === 'ticket' || shape === 'both' ? { ticketId } : {}),
    ...(shape === 'asset' || shape === 'both' ? { assetIds: assetId } : {}),
  }).toString();
const expectedChecks = 40;
const faultModes = [
  '400',
  '401',
  '500',
  '503',
  'network',
  'body_cut',
  'invalid_json',
  '401_body_cut',
];
const errorMessage = '入力候補を取得できませんでした。時間をおいて、もう一度お試しください。';

/** Production Next renderer with a synthetic API. Forms and downloads are never submitted. */
export async function runChangeCreateRecoveryChecks({
  baseURL,
  outputDirectory,
  control,
  candidateReads,
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
  for (const callback of [control, candidateReads, allReads, assertOwned])
    assert.equal(typeof callback, 'function');
  const output = resolve(outputDirectory);
  const within = relative(evidenceRoot, output);
  assert.ok(within && !within.startsWith('..') && !isAbsolute(within));
  assert.equal(await realpath(dirname(output)), dirname(output));
  await access(chromium.executablePath());
  if (signal?.aborted) throw new Error('CHANGE_UI_ABORTED');
  await mkdir(output, { mode: 0o700 });
  const report = {
    workPackage: 'WP-P2-CHGNEW-075',
    model: 'Real copied production Next.js with loopback synthetic API and synthetic session.',
    actualChangeCreateRendererTested: true,
    candidateRetrievalOnly: true,
    actualFormRendererTested: true,
    realApprovalDecisionTested: false,
    realChangeCommandExecutionTested: false,
    formSubmissionTested: false,
    realAuthorizationTested: false,
    realDatabaseTested: false,
    productionAcceptance: false,
    startedAt: new Date().toISOString(),
    checks: [],
    screenshots: [],
    axe: [],
    browserRequests: { nonReadCount: 0, methods: {}, downloads: 0 },
    prefetch: { attempted: 0, blocked: 0, forwarded: 0 },
    cleanup: { browserClosed: false },
    success: false,
  };
  let browser, context, page;
  let step = 'initial';
  let mode = { detail: 'normal', view: 'draft' };
  let cancellation = Promise.resolve();
  const onBrowserRequest = (request) => {
    const method = request.method();
    if (method === 'GET' || method === 'HEAD') return;
    report.browserRequests.nonReadCount++;
    const key = ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE'].includes(method)
      ? method
      : 'OTHER';
    report.browserRequests.methods[key] = (report.browserRequests.methods[key] ?? 0) + 1;
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
    mode = { detail: 'normal', view: 'draft', ...next };
  };
  const main = () => page.locator('main');
  const retry = () => main().getByRole('link', { name: '再取得する', exact: true });
  const back = () => main().getByRole('link', { name: '元の画面へ戻る', exact: true });
  const fallback = () => main().getByRole('link', { name: '変更一覧へ戻る', exact: true });
  async function open(path = createPath()) {
    step = 'open-document';
    await live();
    await page.goto(target.origin + path, { waitUntil: 'domcontentloaded' });
    step = 'open-heading';
    await main().getByRole('heading', { level: 1 }).waitFor();
  }

  async function successful(shape = 'both', empty = false) {
    step = 'success-heading';
    await main()
      .getByRole('heading', { name: '通常変更の計画を作成する', level: 1, exact: true })
      .waitFor();
    step = 'success-form-ready';
    await page.waitForFunction(() => {
      const main = document.querySelector('main'),
        form = main?.querySelector('form');
      return (
        main?.querySelectorAll('form').length === 1 &&
        main.querySelectorAll('[inert]').length === 0 &&
        form?.getAttribute('aria-busy') === 'false' &&
        !form.hasAttribute('inert')
      );
    });
    const form = main().locator('form');
    const creationKey = await form.locator('input[name="creationKey"]').inputValue();
    const commandKey = await form.locator('input[name="commandKey"]').inputValue();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    assert.match(creationKey, uuid);
    assert.match(commandKey, uuid);
    assert.notEqual(creationKey, commandKey);
    assert.equal(await form.locator('input[name="expectedVersion"]').inputValue(), '1');
    assert.equal(await form.locator('input[name="title"]').inputValue(), '');
    assert.equal(await form.locator('input[name="reason"]').inputValue(), '初回計画');
    assert.equal(await form.locator('select[name="risk"]').inputValue(), 'low');
    assert.equal(await form.locator('select[name="approverId"]').inputValue(), '');
    assert.equal(await form.locator('select[name="ownerId"]').inputValue(), empty ? '' : userId);
    const selectedTicket = await form.locator('select[name="ticketId"]').inputValue();
    assert.equal(selectedTicket, !empty && ['ticket', 'both'].includes(shape) ? ticketId : '');
    assert.equal(
      await form.locator('select[name="ticketId"] option').count(),
      empty ? 1 : ['ticket', 'both'].includes(shape) ? 2 : 3,
    );
    const boxes = form.locator('input[name="assetIds"]');
    assert.equal(await boxes.count(), empty ? 0 : 2);
    const selectedAssets = await boxes.evaluateAll((nodes) =>
      nodes.filter((node) => node.checked).map((node) => node.value),
    );
    assert.deepEqual(selectedAssets, !empty && ['asset', 'both'].includes(shape) ? [assetId] : []);
    assert.equal(await form.locator('select[name="ownerId"] option').count(), empty ? 0 : 2);
    assert.equal(await form.locator('select[name="approverId"] option').count(), empty ? 1 : 2);
    assert.equal(
      await form.getByRole('button', { name: '変更計画を下書きで保存する', exact: true }).count(),
      1,
    );
    assert.equal(
      await form.getByRole('link', { name: 'キャンセルして戻る', exact: true }).count(),
      1,
    );
    assert.equal(await retry().count(), 0);
    return {
      actualFormReady: true,
      creationKeyIsUuid: true,
      commandKeyIsUuid: true,
      expectedVersion: '1',
      selectedTicket,
      selectedAssets,
      emptyCandidates: empty,
      formSubmitted: false,
    };
  }
  async function noSensitiveFields() {
    assert.equal(
      await main().locator('form, input, select, textarea, button, dl, table, details').count(),
      0,
    );
    const text = await main().innerText();
    for (const value of [
      ticketId,
      assetId,
      'WP075_PRIVATE_PROBLEM_MARKER',
      'TKT-075',
      'AST-075',
      '合成の目的',
      '合成担当者',
      '合成の対象資産',
      '変更と履歴を保存しました',
    ])
      assert.equal(text.includes(value), false);
  }
  async function rejected(status = '503') {
    step = 'failure-boundary';
    await main()
      .getByRole('heading', { name: '入力候補を読み込めませんでした', level: 1, exact: true })
      .waitFor();
    const message =
      status === '400'
        ? '入力候補を取得できませんでした。元の画面や変更一覧から開き直してください。'
        : status.startsWith('401')
          ? 'ログイン状態を確認できませんでした。ログインし直してから、もう一度お試しください。'
          : errorMessage;
    assert.equal(await main().getByRole('alert').innerText(), message);
    await noSensitiveFields();
    assert.equal(await retry().getAttribute('href'), createPath());
    assert.equal(await back().getAttribute('href'), returnPath);
    assert.equal(
      await main().getByRole('link', { name: 'ポータルへ戻る', exact: true }).getAttribute('href'),
      '/portal',
    );
  }
  async function missing() {
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
  }
  async function nativeNavigation(link, path, keyboard = false) {
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
    step = 'native-heading';
    await page.waitForURL(target.origin + path, { waitUntil: 'domcontentloaded' });
    await main().getByRole('heading', { level: 1 }).waitFor();
    assert.equal(page.url(), target.origin + path);
  }
  async function freshNavigation(shape = 'both', keyboard = false) {
    const before = candidateReads().length;
    await nativeNavigation(retry(), createPath(shape), keyboard);
    const fields = await successful(shape);
    const fresh = candidateReads().slice(before);
    assert.ok(fresh.length > 0);
    assert.ok(
      fresh.every(
        (request) => request.route === 'candidates' && request.query === candidateQuery(shape),
      ),
    );
    return {
      nativeDocumentGet: true,
      apiReadsIncreased: true,
      sameCreatePath: true,
      seedRetained: true,
      flashOmitted: true,
      ...fields,
    };
  }
  async function shot(name) {
    step = 'capture';
    await live();
    const filename = name + '.png';
    const image = resolve(output, filename);
    await page.screenshot({ path: image, fullPage: true });
    await chmod(image, 0o600);
    report.screenshots.push(filename);
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const violations = result.violations.map((item) => ({
      id: item.id,
      impact: item.impact,
      count: item.nodes.length,
    }));
    report.axe.push({ state: name, violations });
    await writeFile(resolve(output, name + '-axe.json'), JSON.stringify(result, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    assert.equal(violations.length, 0);
  }
  async function geometry() {
    return page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    }));
  }
  async function check(name, run) {
    await live();
    const reads = allReads().length;
    try {
      const details = await run();
      report.checks.push({
        name,
        passed: true,
        mode: { ...mode },
        details: details ?? null,
        apiReads: allReads().length - reads,
      });
    } catch {
      report.checks.push({
        name,
        passed: false,
        mode: { ...mode },
        failureCode: 'CHECK_FAILED',
        stage: step,
      });
    }
  }
  try {
    await live();
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    context.on('request', onBrowserRequest);
    await context.route('**/*', async (route) => {
      const request = route.request(),
        headers = request.headers();
      const isPrefetch =
        headers['next-router-prefetch'] === '1' ||
        /prefetch/.test(headers.purpose ?? headers['sec-purpose'] ?? '');
      if (isPrefetch) {
        report.prefetch.attempted++;
        report.prefetch.blocked++;
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    await context.addCookies([
      {
        name: 'solvi_session_wp075_synthetic',
        value: 'agent',
        url: target.origin,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('download', () => report.browserRequests.downloads++);
    signal?.addEventListener('abort', onAbort, { once: true });
    const role = async (value) =>
      context.addCookies([
        {
          name: 'solvi_session_wp075_synthetic',
          value,
          url: target.origin,
          httpOnly: true,
          sameSite: 'Lax',
        },
      ]);
    for (const actor of ['agent', 'org_admin', 'platform_admin']) {
      await role(actor);
      for (const shape of ['none', 'ticket', 'asset', 'both']) {
        await check('normal-' + actor + '-' + shape, async () => {
          await scenario({ detail: 'normal' });
          const before = candidateReads().length;
          await open(createPath(shape));
          const fields = await successful(shape);
          assert.ok(
            candidateReads()
              .slice(before)
              .some((x) => x.query === candidateQuery(shape) && x.role === actor),
          );
          await shot('normal-' + actor + '-' + shape);
          return fields;
        });
      }
      await check('empty-candidates-' + actor, async () => {
        await scenario({ detail: 'normal', view: 'empty' });
        await open(createPath('none'));
        const fields = await successful('none', true);
        await shot('empty-' + actor);
        return fields;
      });
    }
    await role('agent');
    for (const detail of faultModes)
      await check('failure-' + detail, async () => {
        await scenario({ detail });
        await open();
        await rejected(detail);
        await shot('failure-' + detail);
      });
    for (const detail of ['403', '403_body_cut', '404', '404_body_cut']) {
      await check('existing-not-found-' + detail, async () => {
        await scenario({ detail });
        await open();
        await missing();
        await shot('not-found-' + detail);
      });
    }
    for (const shape of ['none', 'ticket', 'asset', 'both']) {
      await check('native-click-recovery-' + shape, async () => {
        await scenario({ detail: '503' });
        await open(createPath(shape));
        await noSensitiveFields();
        assert.equal(await retry().getAttribute('href'), createPath(shape));
        await scenario({ detail: 'normal' });
        const details = await freshNavigation(shape);
        await shot('native-recovered-' + shape);
        return details;
      });
    }
    await check('keyboard-focus-enter-recovery', async () => {
      await scenario({ detail: '503' });
      await open();
      await rejected();
      let focused = false;
      for (let i = 0; i < 40 && !focused; i++) {
        await page.keyboard.press('Tab');
        focused = await retry().evaluate((node) => node === document.activeElement);
      }
      assert.ok(focused);
      const focus = await retry().evaluate((node) => {
        const style = getComputedStyle(node);
        return {
          outline: style.outlineStyle,
          width: style.outlineWidth,
          shadow: style.boxShadow,
          visible: node.matches(':focus-visible'),
        };
      });
      assert.ok(focus.visible);
      assert.ok(
        (focus.outline !== 'none' && parseFloat(focus.width) > 0) || focus.shadow !== 'none',
      );
      await shot('keyboard-focus');
      await scenario({ detail: 'normal' });
      return { ...(await freshNavigation('both', true)), focus };
    });
    await check('conditional-list-return', async () => {
      await scenario({ detail: '503' });
      await open();
      await rejected();
      await scenario({ detail: 'normal' });
      const before = allReads().length;
      await nativeNavigation(back(), returnPath);
      await main().getByRole('heading', { name: '変更管理', level: 1, exact: true }).waitFor();
      assert.ok(
        allReads()
          .slice(before)
          .some(
            (x) =>
              x.route === 'list' && x.query === new URL(returnPath, target).searchParams.toString(),
          ),
      );
      await shot('conditional-list');
      return { nativeDocumentGet: true, apiReadsIncreased: true, filtersRetained: true };
    });
    await check('fallback-list-return', async () => {
      await scenario({ detail: '503' });
      await open(entryPath);
      await noSensitiveFields();
      assert.equal(await retry().getAttribute('href'), entryPath);
      assert.equal(await back().count(), 0);
      const before = allReads().length;
      await nativeNavigation(fallback(), '/changes');
      await main().getByRole('heading', { name: '変更管理', level: 1, exact: true }).waitFor();
      assert.ok(
        allReads()
          .slice(before)
          .some((x) => x.route === 'list' && x.query === ''),
      );
      await shot('fallback-list');
      return { nativeDocumentGet: true, apiReadsIncreased: true };
    });
    await check('native-portal-return', async () => {
      await scenario({ detail: '503' });
      await open();
      await rejected();
      const before = allReads().length;
      await nativeNavigation(
        main().getByRole('link', { name: 'ポータルへ戻る', exact: true }),
        '/portal',
      );
      await main()
        .getByRole('heading', { name: 'あなたのITサポート', level: 1, exact: true })
        .waitFor();
      const fresh = allReads().slice(before);
      assert.ok(
        fresh.some((x) => x.route === 'tickets') &&
          fresh.some((x) => x.route === 'requests') &&
          fresh.some((x) => x.route === 'catalog'),
      );
      await shot('native-portal');
      return { nativeDocumentGet: true, apiReadsIncreased: true, portalRendererTested: true };
    });
    await check('unsafe-query-filtering', async () => {
      await scenario({ detail: '503' });
      await open(
        entryPath +
          '?' +
          new URLSearchParams({
            ticketId,
            assetId,
            returnTo: 'https://example.invalid/',
            saved: '1',
            created: '1',
            unknown: 'PRIVATE',
          }),
      );
      await noSensitiveFields();
      assert.equal(await retry().getAttribute('href'), createPath('both', null));
      assert.equal(await back().count(), 0);
      await shot('unsafe-query');
    });
    await check('plural-query-filtering', async () => {
      await scenario({ detail: '503' });
      await open(
        entryPath +
          '?ticketId=' +
          ticketId +
          '&ticketId=' +
          ticketId +
          '&assetId=' +
          assetId +
          '&assetId=' +
          assetId +
          '&returnTo=%2Fchanges&returnTo=%2Fportal&saved=1',
      );
      await noSensitiveFields();
      assert.equal(await retry().getAttribute('href'), entryPath);
      assert.equal(await back().count(), 0);
      await shot('plural-query');
    });
    await check('invalid-seed-filtering', async () => {
      await scenario({ detail: '400' });
      await open(
        entryPath +
          '?' +
          new URLSearchParams({
            ticketId: 'invalid',
            assetId: '../invalid',
            saved: '1',
            returnTo: returnPath,
          }),
      );
      await noSensitiveFields();
      assert.equal(await retry().getAttribute('href'), createPath('none'));
      assert.equal(await back().getAttribute('href'), returnPath);
      await shot('invalid-seed');
    });
    await check('mobile-failure', async () => {
      await page.setViewportSize({ width: 390, height: 812 });
      await scenario({ detail: '503' });
      await open();
      await rejected();
      const layout = await geometry();
      assert.equal(layout.pageOverflow, false);
      await shot('mobile-failure-390');
      return layout;
    });
    await check('mobile-real-create-form', async () => {
      await scenario({ detail: 'normal' });
      await open();
      const fields = await successful();
      const layout = await geometry();
      await shot('mobile-normal-390');
      return { ...layout, ...fields, successfulLayoutRedesignTested: false };
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
      report.browserRequests.downloads === 0 &&
      report.cleanup.browserClosed;
    writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  }
  if (signal?.aborted) throw new Error('CHANGE_UI_ABORTED');
  return report;
}
