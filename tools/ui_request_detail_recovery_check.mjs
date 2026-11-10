/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import { access, chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidenceRoot = resolve(root, 'evidence/WP-P2-REQDET-073');
const requestId = '07300000-0000-4000-8000-000000000004';
const entryPath = '/requests/' + requestId;
const returnPath =
  '/requests?' + new URLSearchParams({ q: '合成', state: 'pending', view: 'mine', page: '2' });
const detailPath = (from = returnPath) => entryPath + '?' + new URLSearchParams({ returnTo: from });
const expectedChecks = 29;
const faultModes = [
  '400',
  '401',
  '403',
  '500',
  '503',
  'network',
  'body_cut',
  'invalid_json',
  '401_body_cut',
  '403_body_cut',
];
const errorMessage = '一時的に申請を読み込めませんでした。時間をおいて、もう一度お試しください。';

/** Production Next renderer with a synthetic API. Forms and downloads are never submitted. */
export async function runRequestDetailRecoveryChecks({
  baseURL,
  outputDirectory,
  control,
  detailReads,
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
  for (const callback of [control, detailReads, allReads, assertOwned])
    assert.equal(typeof callback, 'function');
  const output = resolve(outputDirectory);
  const within = relative(evidenceRoot, output);
  assert.ok(within && !within.startsWith('..') && !isAbsolute(within));
  assert.equal(await realpath(dirname(output)), dirname(output));
  await access(chromium.executablePath());
  if (signal?.aborted) throw new Error('REQUEST_UI_ABORTED');
  await mkdir(output, { mode: 0o700 });
  const report = {
    workPackage: 'WP-P2-REQDET-073',
    model: 'Real copied production Next.js with loopback synthetic API and synthetic session.',
    actualRequestRendererTested: true,
    actualFormRendererTested: true,
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
  let mode = { detail: 'normal', view: 'pending' };
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
    if (signal?.aborted) throw new Error('REQUEST_UI_ABORTED');
    await assertOwned();
    if (signal?.aborted) throw new Error('REQUEST_UI_ABORTED');
  };
  const scenario = async (next) => {
    await live();
    await control(next);
    mode = { detail: 'normal', view: 'pending', ...next };
  };
  const main = () => page.locator('main');
  const retry = () => main().getByRole('link', { name: '再取得する', exact: true });
  const back = () => main().getByRole('link', { name: '元の画面へ戻る', exact: true });
  const fallback = () => main().getByRole('link', { name: '申請一覧へ戻る', exact: true });
  async function open(path = detailPath()) {
    step = 'open-document';
    await live();
    await page.goto(target.origin + path, { waitUntil: 'domcontentloaded' });
    step = 'open-heading';
    await main().getByRole('heading', { level: 1 }).waitFor();
  }
  async function successful(view = 'pending', role = 'requester') {
    step = 'success-heading';
    await main()
      .getByRole('heading', { name: '合成のアクセス申請', level: 1, exact: true })
      .waitFor();
    await page.waitForFunction(
      () => document.querySelector('main')?.querySelectorAll('[inert]').length === 0,
    );
    const text = await main().innerText();
    for (const value of [
      '合成申請者',
      '合成承認者',
      '合成申請の理由',
      '合成用途',
      'カタログ定義版: 3',
      '申請内容版: 1',
      '承認の記録',
    ])
      assert.ok(text.includes(value), 'Missing request content: ' + value);
    assert.equal(await retry().count(), 0);
    const edit = main()
      .locator('summary')
      .filter({ hasText: '申請内容を変更して再承認を依頼する' });
    const ownerEditing = role === 'requester' && view !== 'completed';
    assert.equal(await edit.count(), ownerEditing ? 1 : 0);
    if (ownerEditing) {
      await edit.click();
      step = 'success-owner-form-ready';
      await main().getByLabel('利用する理由', { exact: true }).waitFor();
      await page.waitForFunction(() => {
        const form = document.querySelector('#request-reason')?.closest('form');
        return (
          form &&
          form.getAttribute('aria-busy') !== 'true' &&
          !form.hasAttribute('inert') &&
          !form.querySelector('[inert]')
        );
      });
      assert.equal(
        await main().getByLabel('利用する理由', { exact: true }).inputValue(),
        '合成申請の理由',
      );
      assert.equal(await main().getByLabel('希望する利用日数', { exact: true }).inputValue(), '7');
      assert.equal(
        await main().getByLabel('承認を依頼する相手', { exact: true }).inputValue(),
        '07300000-0000-4000-8000-000000000003',
      );
      assert.equal(await main().locator('input[name="expectedVersion"]').inputValue(), '2');
      assert.equal(await main().locator('input[name="itemVersion"]').inputValue(), '3');
      assert.equal(
        await main().getByRole('button', { name: '変更して再承認を依頼する', exact: true }).count(),
        1,
      );
    }
    const approve = role === 'approver' && view === 'pending';
    const simulate = ['agent', 'org_admin'].includes(role) && view === 'approved';
    const revoke = role === 'org_admin' && ['approved', 'expired_approved'].includes(view);
    if (approve || simulate || revoke)
      assert.equal(await main().locator('input[name="expectedVersion"]').inputValue(), '2');
    assert.equal(
      await main().getByRole('button', { name: '承認する', exact: true }).count(),
      approve ? 1 : 0,
    );
    assert.equal(
      await main().getByRole('button', { name: '理由を添えて却下する', exact: true }).count(),
      approve ? 1 : 0,
    );
    assert.equal(
      await main().getByRole('button', { name: 'ローカルで模擬実行する', exact: true }).count(),
      simulate ? 1 : 0,
    );
    assert.equal(
      await main().getByRole('button', { name: '承認を取り消す', exact: true }).count(),
      revoke ? 1 : 0,
    );
    if (view.startsWith('expired')) assert.ok(text.includes('期限切れ。変更・再承認が必要です'));
    if (view === 'completed') {
      for (const value of ['合成の模擬実行結果', '合成アクセス対象', '外部変更', '0件', '証跡 ID'])
        assert.ok(text.includes(value));
      await main().locator('summary').filter({ hasText: '保存した証跡を確認する' }).click();
      for (const value of ['synthetic-receipt-key', 'synthetic-receipt-hash'])
        assert.ok((await main().innerText()).includes(value));
    }
    assert.equal(await main().locator('[inert]').count(), 0);
  }
  async function noSensitiveFields() {
    assert.equal(
      await main().locator('form, input, select, textarea, button, dl, table, details').count(),
      0,
    );
    const text = await main().innerText();
    for (const value of [
      requestId,
      'WP073_PRIVATE_PROBLEM_MARKER',
      '合成申請者',
      '合成のアクセス申請',
      '合成申請の理由',
      '合成用途',
      '申請の状態を保存しました',
    ])
      assert.equal(text.includes(value), false);
  }
  async function rejected(status = '503') {
    step = 'failure-boundary';
    await main()
      .getByRole('heading', { name: '申請を読み込めませんでした', level: 1, exact: true })
      .waitFor();
    const message =
      status === '400'
        ? '申請を指定する情報が正しくありません。申請一覧から選び直してください。'
        : status.startsWith('401')
          ? 'ログイン状態を確認できませんでした。ログインし直してから、もう一度お試しください。'
          : status.startsWith('403')
            ? 'この申請を表示する権限がありません。選択中の組織を確認するか、管理者にご相談ください。'
            : errorMessage;
    assert.equal(await main().getByRole('alert').innerText(), message);
    await noSensitiveFields();
    assert.equal(await retry().getAttribute('href'), detailPath());
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
  async function freshNavigation(keyboard = false) {
    const before = detailReads().length;
    await nativeNavigation(retry(), detailPath(), keyboard);
    await successful();
    const fresh = detailReads().slice(before);
    assert.ok(fresh.length > 0);
    assert.ok(fresh.every((request) => request.route === 'detail' && request.query === ''));
    return {
      nativeDocumentGet: true,
      apiReadsIncreased: true,
      sameTicket: true,
      flashOmitted: true,
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
        name: 'solvi_session_wp073_synthetic',
        value: 'requester',
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
          name: 'solvi_session_wp073_synthetic',
          value,
          url: target.origin,
          httpOnly: true,
          sameSite: 'Lax',
        },
      ]);
    const profiles = [
      ['owner-pending', 'pending', 'requester'],
      ['approver-pending', 'pending', 'approver'],
      ['agent-approved', 'approved', 'agent'],
      ['admin-approved', 'approved', 'org_admin'],
      ['expired-pending', 'expired_pending', 'approver'],
      ['expired-approved', 'expired_approved', 'agent'],
      ['completed-receipt', 'completed', 'requester'],
    ];
    for (const [name, view, actor] of profiles)
      await check('normal-' + name, async () => {
        await role(actor);
        await scenario({ detail: 'normal', view });
        await open();
        await successful(view, actor);
        await shot(name);
      });
    await role('requester');
    for (const detail of faultModes)
      await check('failure-' + detail, async () => {
        await scenario({ detail, view: 'pending' });
        await open();
        await rejected(detail);
        await shot('failure-' + detail);
      });
    for (const detail of ['404', '404_body_cut'])
      await check('existing-not-found-' + detail, async () => {
        await scenario({ detail, view: 'pending' });
        await open();
        await missing();
        await shot('not-found-' + detail);
      });
    await check('native-click-recovery', async () => {
      await scenario({ detail: '503' });
      await open();
      await rejected();
      await scenario({ detail: 'normal' });
      const result = await freshNavigation();
      await shot('native-recovered');
      return result;
    });
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
      return { ...(await freshNavigation(true)), focus };
    });
    await check('conditional-list-return', async () => {
      await scenario({ detail: '503' });
      await open();
      await rejected();
      await scenario({ detail: 'normal' });
      const before = allReads().length;
      await nativeNavigation(back(), returnPath);
      await main().getByRole('heading', { name: '申請の状況', level: 1, exact: true }).waitFor();
      const fresh = allReads().slice(before);
      assert.ok(
        fresh.some(
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
      assert.equal(await fallback().getAttribute('href'), '/requests');
      await scenario({ detail: 'normal' });
      const before = allReads().length;
      await nativeNavigation(fallback(), '/requests');
      await main().getByRole('heading', { name: '申請の状況', level: 1, exact: true }).waitFor();
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
      await scenario({ detail: 'normal' });
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
          fresh.some((x) => x.route === 'list') &&
          fresh.some((x) => x.route === 'catalog'),
      );
      await shot('native-portal');
      return { nativeDocumentGet: true, portalRendererTested: true, apiReadsIncreased: true };
    });
    await check('unsafe-query-filtering', async () => {
      await scenario({ detail: '503' });
      await open(
        entryPath + '?returnTo=https%3A%2F%2Fexample.invalid%2F&created=1&saved=1&unknown=secret',
      );
      await noSensitiveFields();
      assert.equal(await retry().getAttribute('href'), entryPath);
      assert.equal(await fallback().getAttribute('href'), '/requests');
      await shot('unsafe-query');
    });
    await check('plural-query-filtering', async () => {
      await scenario({ detail: '503' });
      await open(entryPath + '?returnTo=%2Frequests&returnTo=%2Finbox&saved=1');
      await noSensitiveFields();
      assert.equal(await retry().getAttribute('href'), entryPath);
      assert.equal(await fallback().getAttribute('href'), '/requests');
      await shot('plural-query');
    });
    await check('invalid-id-no-read-no-retry', async () => {
      await scenario({ detail: 'normal' });
      const before = detailReads().length;
      await open('/requests/invalid');
      await noSensitiveFields();
      assert.equal(await retry().count(), 0);
      assert.equal(await fallback().getAttribute('href'), '/requests');
      assert.equal(detailReads().length, before);
      await shot('invalid-id');
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
    await check('mobile-completed-renderer', async () => {
      await scenario({ detail: 'normal', view: 'completed' });
      await open();
      await successful('completed', 'requester');
      const layout = await geometry();
      await shot('mobile-completed-390');
      return { ...layout, successfulLayoutRedesignTested: false };
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
      report.browserRequests.downloads === 0 &&
      report.cleanup.browserClosed;
    writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  }
  if (signal?.aborted) throw new Error('REQUEST_UI_ABORTED');
  return report;
}
