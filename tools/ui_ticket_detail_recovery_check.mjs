/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import { access, chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidenceRoot = resolve(root, 'evidence/WP-P2-TKTDET-071');
const ticketId = '07100000-0000-4000-8000-000000000004';
const entryPath = '/tickets/' + ticketId;
const returnPath = '/portal?' + new URLSearchParams({ q: '合成', state: 'pending', page: '2' });
const detailPath = (from = returnPath) => entryPath + '?' + new URLSearchParams({ returnTo: from });
const expectedChecks = 23;
const faultModes = ['400', '500', '503', 'network', 'body_cut', 'invalid_json'];
const errorMessage =
  '一時的に問い合わせを読み込めませんでした。時間をおいて、もう一度お試しください。';

/** Production Next renderer with a synthetic API. Forms and downloads are never submitted. */
export async function runTicketDetailRecoveryChecks({
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
  if (signal?.aborted) throw new Error('TICKET_UI_ABORTED');
  await mkdir(output, { mode: 0o700 });
  const report = {
    workPackage: 'WP-P2-TKTDET-071',
    model: 'Real copied production Next.js with loopback synthetic API and synthetic session.',
    actualTicketRendererTested: true,
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
    cleanup: { browserClosed: false },
    success: false,
  };
  let browser, context, page;
  let step = 'initial';
  let mode = { detail: 'normal', view: 'new' };
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
    if (signal?.aborted) throw new Error('TICKET_UI_ABORTED');
    await assertOwned();
    if (signal?.aborted) throw new Error('TICKET_UI_ABORTED');
  };
  const scenario = async (next) => {
    await live();
    await control(next);
    mode = { detail: 'normal', view: 'new', ...next };
  };
  const main = () => page.locator('main');
  const retry = () => main().getByRole('link', { name: '再取得する', exact: true });
  const back = () => main().getByRole('link', { name: '元の画面へ戻る', exact: true });
  const fallback = () => main().getByRole('link', { name: '問い合わせ一覧へ戻る', exact: true });
  async function open(path = detailPath()) {
    step = 'open-document';
    await live();
    await page.goto(target.origin + path, { waitUntil: 'domcontentloaded' });
    step = 'open-heading';
    await main().getByRole('heading', { level: 1 }).waitFor();
  }
  async function successful(view = 'new', created = false) {
    step = 'success-heading';
    await main()
      .getByRole('heading', { name: '合成の問い合わせ', level: 1, exact: true })
      .waitFor();
    step = 'success-attachment-disclosure';
    const attachmentSummary = main().locator('summary').filter({ hasText: '添付ファイル' });
    assert.equal(await attachmentSummary.count(), 1);
    await attachmentSummary.click();
    await main().getByText('合成添付.txt', { exact: true }).waitFor({ state: 'visible' });
    step = 'success-form-ready';
    await page.waitForFunction(
      () => document.querySelector('main')?.querySelectorAll('[inert]').length === 0,
    );
    step = 'success-content';
    const text = await main().innerText();
    for (const value of ['TKT-071', '合成の問い合わせ本文', '合成の公開コメント', '合成添付.txt'])
      assert.ok(text.includes(value), 'Missing successful ticket content: ' + value);
    step = 'success-existing-sections';
    assert.equal(await retry().count(), 0);
    assert.ok(await main().getByRole('heading', { name: 'やり取り', exact: true }).count());
    assert.ok(
      await main().getByRole('heading', { name: '追加でお知らせする', exact: true }).count(),
    );
    step = 'success-state';
    if (view === 'pending') assert.ok(text.includes('あなたの返答を待っています'));
    if (view === 'resolved') {
      assert.ok(
        await main().getByRole('heading', { name: '解決していない場合', exact: true }).count(),
      );
      assert.ok((await main().locator('form').count()) > 0);
    }
    step = 'success-creation-flash';
    assert.equal(
      await main().getByRole('heading', { name: '受け付けました', exact: true }).count(),
      created ? 1 : 0,
    );
    assert.equal(await main().locator('[inert]').count(), 0);
  }
  async function noSensitiveFields() {
    assert.equal(
      await main().locator('form, input, select, textarea, button, dl, table, details').count(),
      0,
    );
    const text = await main().innerText();
    for (const value of [
      ticketId,
      'TKT-071',
      '合成の問い合わせ本文',
      '合成の公開コメント',
      '合成添付.txt',
      'WP071_PRIVATE_PROBLEM_MARKER',
    ])
      assert.equal(text.includes(value), false);
    assert.equal(await main().getByRole('status').count(), 0);
  }
  async function rejected(status = '503') {
    step = 'failure-boundary';
    await main()
      .getByRole('heading', { name: '問い合わせを読み込めませんでした', level: 1, exact: true })
      .waitFor();
    assert.equal(
      await main().getByRole('alert').innerText(),
      status === '400'
        ? '問い合わせを指定する情報が正しくありません。一覧から選び直してください。'
        : errorMessage,
    );
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
    await context.addCookies([
      {
        name: 'solvi_session_wp071_synthetic',
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
    await check('normal-new-ticket', async () => {
      await scenario({ detail: 'normal', view: 'new' });
      await open();
      await successful();
      await shot('normal-new');
    });
    await check('normal-created-confirmation', async () => {
      await scenario({ detail: 'normal', view: 'new' });
      await open(detailPath() + '&created=1');
      await successful('new', true);
      await shot('normal-created');
    });
    for (const view of ['pending', 'resolved']) {
      await check('normal-' + view, async () => {
        await scenario({ detail: 'normal', view });
        await open();
        await successful(view);
        await shot('normal-' + view);
      });
    }
    for (const detail of faultModes) {
      await check('failure-' + detail, async () => {
        await scenario({ detail, view: 'new' });
        await open();
        await rejected(detail === '400' ? '400' : '503');
        await shot('failure-' + detail);
      });
    }
    for (const detail of ['401', '401_body_cut']) {
      await check('existing-login-' + detail, async () => {
        await scenario({ detail, view: 'new' });
        await open();
        await page.waitForURL(target.origin + '/login', { waitUntil: 'domcontentloaded' });
        await main().getByRole('heading', { name: 'ログイン', level: 1, exact: true }).waitFor();
        assert.equal(await retry().count(), 0);
        assert.equal((await main().innerText()).includes('WP071_PRIVATE_PROBLEM_MARKER'), false);
        await shot('login-' + detail);
      });
    }
    for (const detail of ['403', '403_body_cut', '404', '404_body_cut']) {
      await check('existing-concealment-' + detail, async () => {
        await scenario({ detail, view: 'new' });
        await open();
        await missing();
        await shot('concealment-' + detail);
      });
    }
    await check('native-click-recovery', async () => {
      await scenario({ detail: '503', view: 'new' });
      await open();
      await rejected();
      await scenario({ detail: 'normal', view: 'new' });
      const result = await freshNavigation();
      await shot('native-recovered');
      return result;
    });
    await check('keyboard-focus-enter-recovery', async () => {
      await scenario({ detail: '503', view: 'new' });
      await open();
      await rejected();
      let focused = false;
      for (let index = 0; index < 40 && !focused; index++) {
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
      await shot('retry-keyboard-focus');
      await scenario({ detail: 'normal', view: 'new' });
      return { ...(await freshNavigation(true)), focus };
    });
    await check('conditional-list-return', async () => {
      await scenario({ detail: '503', view: 'new' });
      await open();
      await rejected();
      await scenario({ detail: 'normal', view: 'new' });
      await nativeNavigation(back(), returnPath);
      await main()
        .getByRole('heading', { name: 'あなたのITサポート', level: 1, exact: true })
        .waitFor();
      await shot('conditional-list');
    });
    await check('fallback-list-return', async () => {
      await scenario({ detail: '503', view: 'new' });
      await open(entryPath);
      await main()
        .getByRole('heading', { name: '問い合わせを読み込めませんでした', level: 1, exact: true })
        .waitFor();
      await noSensitiveFields();
      assert.equal(await retry().getAttribute('href'), entryPath);
      assert.equal(await fallback().getAttribute('href'), '/portal');
      await scenario({ detail: 'normal', view: 'new' });
      await nativeNavigation(fallback(), '/portal');
      await main()
        .getByRole('heading', { name: 'あなたのITサポート', level: 1, exact: true })
        .waitFor();
      await shot('fallback-list');
    });
    await check('unsafe-query-filtering', async () => {
      await scenario({ detail: '503', view: 'new' });
      await open(
        entryPath + '?returnTo=https%3A%2F%2Fexample.invalid%2F&created=1&saved=1&unknown=secret',
      );
      await main()
        .getByRole('heading', { name: '問い合わせを読み込めませんでした', level: 1, exact: true })
        .waitFor();
      await noSensitiveFields();
      assert.equal(await retry().getAttribute('href'), entryPath);
      assert.equal(await fallback().getAttribute('href'), '/portal');
      assert.equal((await main().innerText()).includes('secret'), false);
      await shot('unsafe-query');
    });
    await check('mobile-failure', async () => {
      await page.setViewportSize({ width: 375, height: 812 });
      await scenario({ detail: '503', view: 'new' });
      await open();
      await rejected();
      const layout = await geometry();
      assert.equal(layout.pageOverflow, false);
      await shot('mobile-failure-375');
      return layout;
    });
    await check('mobile-success-renderer', async () => {
      await scenario({ detail: 'normal', view: 'resolved' });
      await open();
      await successful('resolved');
      const layout = await geometry();
      await shot('mobile-success-375');
      return { ...layout, successfulLayoutRedesignTested: false };
    });
  } catch {
    report.failureCode = signal?.aborted ? 'TICKET_UI_ABORTED' : 'TICKET_UI_RUN_FAILED';
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
    if (signal?.aborted) report.failureCode = 'TICKET_UI_ABORTED';
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
  if (signal?.aborted) throw new Error('TICKET_UI_ABORTED');
  return report;
}
