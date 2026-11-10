/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import { access, chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import {
  catalogDetailFixture,
  fields,
} from '../evidence/WP-P2-CATDET-078/20261010/fixture-api.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const evidenceRoot = resolve(root, 'evidence/WP-P2-CATDET-078');
const itemId = '07800000-0000-4000-8000-000000000010';
const expiredId = '07800000-0000-4000-8000-000000000004';
const entryPath = '/catalog/manage/' + itemId;
const returnPath = '/catalog/manage?returnTo=%2Fcatalog';
const createPath = (from = returnPath) =>
  entryPath + (from ? '?' + new URLSearchParams({ returnTo: from }) : '');
const expectedChecks = 33;
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
const errorMessage = 'カタログ項目を取得できませんでした。時間をおいて、もう一度お試しください。';
/** Production Next renderer with a synthetic API. Forms and downloads are never submitted. */
export async function runCatalogDetailRecoveryChecks({
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
  if (signal?.aborted) throw new Error('CATALOG_DETAIL_UI_ABORTED');
  await mkdir(output, { mode: 0o700 });
  const report = {
    workPackage: 'WP-P2-CATDET-078',
    model: 'Real copied production Next.js with loopback synthetic API and synthetic session.',
    actualCatalogDetailRendererTested: true,
    primaryDetailRetrievalOnly: true,
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
    if (signal?.aborted) throw new Error('CATALOG_DETAIL_UI_ABORTED');
    await assertOwned();
    if (signal?.aborted) throw new Error('CATALOG_DETAIL_UI_ABORTED');
  };
  const scenario = async (next) => {
    await live();
    await control(next);
    mode = { detail: 'normal', view: 'draft', ...next };
  };
  const main = () => page.locator('main');
  const retry = () => main().getByRole('link', { name: '再取得する', exact: true });
  const back = () => main().getByRole('link', { name: '元の画面へ戻る', exact: true });
  const fallback = () => main().getByRole('link', { name: 'カタログ管理へ戻る', exact: true });
  async function open(path = createPath()) {
    step = 'open-document';
    await live();
    await page.goto(target.origin + path, { waitUntil: 'domcontentloaded' });
    step = 'open-heading';
    await main().getByRole('heading', { level: 1 }).waitFor();
  }

  async function successful(view = 'draft', saved = false) {
    const item = catalogDetailFixture(view);
    step = 'success-heading';
    await main().getByRole('heading', { name: item.draft.title, level: 1, exact: true }).waitFor();
    const editor = main().locator('details');
    if (!(await editor.evaluate((node) => node.open)))
      await editor.getByText('下書きの項目と承認者を編集する', { exact: true }).click();
    step = 'success-form-ready';
    await page.waitForFunction(() => {
      const m = document.querySelector('main'),
        admin = m?.querySelector('details form');
      return (
        m?.querySelectorAll('form').length === 2 &&
        m.querySelectorAll('[inert]').length === 0 &&
        [...m.querySelectorAll('form')].every(
          (form) => form.getAttribute('aria-busy') === 'false',
        ) &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          admin?.querySelector('input[name="creationKey"]')?.value ?? '',
        )
      );
    });
    const admin = editor.locator('form'),
      publication = main().locator('form').first();
    for (const form of [admin, publication])
      assert.equal(
        await form.locator('input[name="expectedVersion"]').inputValue(),
        String(item.editVersion),
      );
    assert.match(
      await admin.locator('input[name="creationKey"]').inputValue(),
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    assert.deepEqual(JSON.parse(await admin.locator('input[name="fields"]').inputValue()), fields);
    for (const [name, value] of Object.entries({
      code: item.code,
      title: item.draft.title,
      description: item.draft.description,
      targetLabel: item.draft.definition.targetLabel,
      allowedDurations: item.draft.definition.allowedDurations.join(', '),
      maxReasonLength: String(item.draft.definition.maxReasonLength),
    }))
      assert.equal(await admin.locator('[name="' + name + '"]').inputValue(), value);
    assert.equal(await admin.locator('input[name="code"]').getAttribute('readonly'), '');
    const invalid = view === 'invalid-approver';
    assert.equal(
      await admin.locator('select[name="approverId"] option[value="' + expiredId + '"]').count(),
      0,
    );
    assert.equal(
      await admin.locator('select[name="approverId"]').inputValue(),
      invalid ? '' : item.draft.definition.approval.approverId,
    );
    const preview = main().locator('#preview');
    assert.ok(
      (await preview.innerText()).includes(invalid ? '未設定・現在無効' : '合成の有効承認者'),
    );
    assert.equal(
      await preview.locator('#preview-reason').getAttribute('maxlength'),
      String(item.draft.definition.maxReasonLength),
    );
    assert.deepEqual(
      await preview.locator('#preview-days option').allTextContents(),
      item.draft.definition.allowedDurations.map((n) => n + '日'),
    );
    assert.equal(
      await preview.locator('#catalog-field-department').getAttribute('maxlength'),
      '80',
    );
    assert.equal(await preview.locator('#catalog-field-purpose').getAttribute('maxlength'), '500');
    assert.deepEqual(await preview.locator('#catalog-field-location option').allTextContents(), [
      '選んでください',
      '社内',
      '社外',
    ]);
    assert.equal(await preview.locator('#catalog-field-consent').getAttribute('type'), 'checkbox');
    for (const key of ['department', 'purpose', 'location', 'consent'])
      assert.equal(await preview.locator('#catalog-field-' + key).isDisabled(), true);
    const publish = publication.getByRole('button', { name: 'この版を公開する', exact: true });
    assert.equal(
      await publish.isDisabled(),
      invalid || (item.active && item.publishedRevision === item.draft.revision),
    );
    assert.equal(
      await publication
        .getByRole('button', { name: '新規受付を非公開にする', exact: true })
        .count(),
      item.active ? 1 : 0,
    );
    assert.equal(await publication.getByRole('alert').count(), invalid ? 1 : 0);
    assert.equal(
      await main().getByRole('link', { name: '現在の公開フォームを見る', exact: true }).count(),
      item.active ? 1 : 0,
    );
    const history = await main().locator('ul li').allTextContents();
    const date = (iso) =>
      new Intl.DateTimeFormat('ja-JP', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Tokyo',
      }).format(new Date(iso));
    assert.deepEqual(
      history.map((s) => s.replace(/\s+/g, ' ').trim()),
      item.history.map(
        (h) =>
          '版' +
          h.revision +
          ' · ' +
          h.title +
          ' · ' +
          date(h.createdAt) +
          (h.revision === item.publishedRevision ? ' · 最後に公開した版' : ''),
      ),
    );
    const text = await main().innerText();
    assert.ok(
      text.includes(
        item.active
          ? '公開中: ' + item.published.title + '（版' + item.publishedRevision + '）'
          : '非公開: 新規申請を受け付けていません',
      ),
    );
    assert.equal(text.includes('カタログ設定を保存しました。'), saved);
    assert.equal(await retry().count(), 0);
    return {
      actualFormReady: true,
      creationKeyIsUuid: true,
      expectedVersion: item.editVersion,
      fieldsJsonPreserved: true,
      draftRevision: item.draft.revision,
      publishedRevision: item.publishedRevision,
      active: item.active,
      invalidApprover: invalid,
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
      itemId,
      'WP078_PRIVATE_PROBLEM_MARKER',
      '合成のカタログ定義',
      '合成の新カタログ定義',
      '合成の有効承認者',
      '合成の旧説明',
      '保存した定義の版',
      'カタログ設定を保存しました',
    ])
      assert.equal(text.includes(value), false);
  }
  async function rejected(status = '503') {
    step = 'failure-boundary';
    await main()
      .getByRole('heading', { name: 'カタログ項目を読み込めませんでした', level: 1, exact: true })
      .waitFor();
    const message =
      status === '400'
        ? 'カタログ項目を取得できませんでした。カタログ管理から項目を選び直してください。'
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
  async function freshNavigation(keyboard = false) {
    const before = detailReads().length;
    await nativeNavigation(retry(), createPath(), keyboard);
    const fields = await successful();
    const fresh = detailReads().slice(before);
    assert.ok(fresh.length > 0);
    assert.ok(fresh.every((request) => request.route === 'detail' && request.query === ''));
    return {
      nativeDocumentGet: true,
      apiReadsIncreased: true,
      sameDetailPath: true,
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
        name: 'solvi_session_wp078_synthetic',
        value: 'org_admin',
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
          name: 'solvi_session_wp078_synthetic',
          value,
          url: target.origin,
          httpOnly: true,
          sameSite: 'Lax',
        },
      ]);
    for (const actor of ['org_admin', 'platform_admin']) {
      await role(actor);
      for (const view of ['draft', 'published', 'edited', 'inactive', 'invalid-approver'])
        await check('normal-' + actor + '-' + view, async () => {
          await scenario({ detail: 'normal', view });
          const before = detailReads().length;
          await open();
          const values = await successful(view);
          assert.ok(
            detailReads()
              .slice(before)
              .some((x) => x.role === actor && x.scenario.view === view),
          );
          await shot('normal-' + actor + '-' + view);
          return values;
        });
    }
    await role('org_admin');
    await check('saved-flash-preserved', async () => {
      await scenario({ detail: 'normal', view: 'edited' });
      await open(createPath() + '&saved=1');
      const values = await successful('edited', true);
      await shot('saved-flash');
      return values;
    });
    for (const detail of faultModes)
      await check('failure-' + detail, async () => {
        await scenario({ detail });
        await open();
        await rejected(detail);
        await shot('failure-' + detail);
      });
    for (const detail of ['403', '403_body_cut', '404', '404_body_cut'])
      await check('existing-not-found-' + detail, async () => {
        await scenario({ detail });
        await open();
        await missing();
        await shot('not-found-' + detail);
      });
    await check('native-click-recovery', async () => {
      await scenario({ detail: '503' });
      await open();
      await rejected();
      await scenario({ detail: 'normal' });
      const values = await freshNavigation();
      await shot('native-recovered');
      return values;
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
        const s = getComputedStyle(node);
        return {
          visible: node.matches(':focus-visible'),
          outline: s.outlineStyle,
          width: s.outlineWidth,
          shadow: s.boxShadow,
        };
      });
      assert.ok(
        focus.visible &&
          ((focus.outline !== 'none' && parseFloat(focus.width) > 0) || focus.shadow !== 'none'),
      );
      await shot('keyboard-focus');
      await scenario({ detail: 'normal' });
      return { ...(await freshNavigation(true)), focus };
    });
    await check('context-management-return', async () => {
      await scenario({ detail: '503' });
      await open();
      await rejected();
      const before = allReads().length;
      await nativeNavigation(back(), returnPath);
      await main().getByRole('heading', { name: 'カタログ管理', level: 1, exact: true }).waitFor();
      assert.ok(
        allReads()
          .slice(before)
          .some((x) => x.route === 'management'),
      );
      await shot('context-management');
      return { nativeDocumentGet: true, apiReadsIncreased: true };
    });
    await check('fallback-management-return', async () => {
      await scenario({ detail: '503' });
      await open(entryPath);
      await noSensitiveFields();
      assert.equal(await back().count(), 0);
      const before = allReads().length;
      await nativeNavigation(fallback(), '/catalog/manage');
      await main().getByRole('heading', { name: 'カタログ管理', level: 1, exact: true }).waitFor();
      assert.ok(
        allReads()
          .slice(before)
          .some((x) => x.route === 'management'),
      );
      await shot('fallback-management');
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
        ['tickets', 'requests', 'catalog'].every((route) => fresh.some((x) => x.route === route)),
      );
      await shot('native-portal');
      return { nativeDocumentGet: true, apiReadsIncreased: true };
    });
    await check('unsafe-query-filtering', async () => {
      await scenario({ detail: '503' });
      await open(
        entryPath +
          '?' +
          new URLSearchParams({
            returnTo: 'https://example.invalid',
            saved: '1',
            created: '1',
            updated: '1',
            unknown: 'PRIVATE',
          }),
      );
      await noSensitiveFields();
      assert.equal(await retry().getAttribute('href'), entryPath);
      assert.equal(await back().count(), 0);
      await shot('unsafe-query');
    });
    await check('plural-query-filtering', async () => {
      await scenario({ detail: '503' });
      await open(entryPath + '?returnTo=%2Fcatalog&returnTo=%2Fportal&saved=1');
      await noSensitiveFields();
      assert.equal(await retry().getAttribute('href'), entryPath);
      assert.equal(await back().count(), 0);
      await shot('plural-query');
    });
    await check('invalid-id-no-api-read-or-retry', async () => {
      await scenario({ detail: 'normal' });
      const before = detailReads().length;
      await open('/catalog/manage/invalid?returnTo=%2Fcatalog%2Fmanage&saved=1');
      await main()
        .getByRole('heading', { name: 'カタログ項目を読み込めませんでした', exact: true })
        .waitFor();
      await noSensitiveFields();
      assert.equal(await retry().count(), 0);
      assert.equal(detailReads().length, before);
      await shot('invalid-id');
      return { invalidIdApiReads: 0, retryCount: 0 };
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
    await check('mobile-real-catalog-detail', async () => {
      await scenario({ detail: 'normal', view: 'edited' });
      await open();
      const values = await successful('edited');
      const layout = await geometry();
      await shot('mobile-normal-390');
      return { ...layout, ...values, successfulLayoutRedesignTested: false };
    });
  } catch {
    report.failureCode = signal?.aborted
      ? 'CATALOG_DETAIL_UI_ABORTED'
      : 'CATALOG_DETAIL_UI_RUN_FAILED';
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
    if (signal?.aborted) report.failureCode = 'CATALOG_DETAIL_UI_ABORTED';
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
  if (signal?.aborted) throw new Error('CATALOG_DETAIL_UI_ABORTED');
  return report;
}
