/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import { access, chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
const root = fileURLToPath(new URL('../', import.meta.url));
const evidenceRoot = resolve(root, 'evidence/WP-P6-ASTEDIT-082');
const id = '08200000-0000-4000-8000-000000000100';
const userId = '08200000-0000-4000-8000-000000000002';
const detailPath = '/assets/' + id;
const editPath = detailPath + '/edit';
const listPath =
  '/assets?' +
  new URLSearchParams({ q: '合成', state: 'in_use', kind: 'pc', assignment: 'mine', page: '2' });
const entry = (from = listPath) =>
  editPath + (from ? '?' + new URLSearchParams({ returnTo: from }) : '');
const primaryMessage = '一時的に資産を取得できませんでした。時間をおいて、もう一度お試しください。';
const expectedChecks = 36;
export async function runAssetEditDetailRecoveryChecks({
  baseURL,
  outputDirectory,
  control,
  candidateReads,
  allReads,
  assertOwned,
  signal,
}) {
  const target = new URL(baseURL),
    output = resolve(outputDirectory),
    inside = relative(evidenceRoot, output);
  assert.ok(
    target.protocol === 'http:' &&
      target.hostname === '127.0.0.1' &&
      target.port &&
      !['3000', '3001'].includes(target.port) &&
      target.pathname === '/' &&
      !target.search &&
      !target.hash &&
      !target.username &&
      !target.password,
  );
  assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside));
  assert.equal(await realpath(dirname(output)), dirname(output));
  for (const fn of [control, candidateReads, allReads, assertOwned])
    assert.equal(typeof fn, 'function');
  await access(chromium.executablePath());
  await mkdir(output, { mode: 0o700 });
  const report = {
    workPackage: 'WP-P6-ASTEDIT-082',
    model:
      'Actual copied production Next with synthetic API and role fixtures; no real authorization/DB/RLS proof.',
    actualFormRendererTested: true,
    formSubmissionTested: false,
    realAuthorizationTested: false,
    checks: [],
    screenshots: [],
    accessibility: [],
    browserRequests: { nonReadCount: 0, methods: {}, unknownReads: 0, downloads: 0 },
    prefetch: { attempted: 0, blocked: 0, forwarded: 0, pathnames: {}, headerKinds: {} },
    browserClosed: false,
    success: false,
  };
  let browser,
    context,
    page,
    step = 'setup',
    aborted = false,
    failure,
    cancellation = Promise.resolve();
  const live = async () => {
    assert.ok(!signal?.aborted);
    await assertOwned();
    assert.ok(!signal?.aborted);
  };
  const onAbort = () => {
    aborted = true;
    cancellation = Promise.allSettled([
      Promise.resolve().then(() => context?.close()),
      Promise.resolve().then(() => browser?.close()),
    ]).then(() => undefined);
  };
  const main = () => page.locator('main');
  const retry = () => main().getByRole('link', { name: '再取得する', exact: true });
  const scenario = async (s = {}) => {
    await live();
    await control(s);
  };
  const role = async (value) => {
    assert.ok(['agent', 'org_admin', 'auditor', 'requester'].includes(value));
    await context.clearCookies();
    await context.addCookies([
      { name: 'solvi_session_wp082_synthetic', value, url: target.origin },
    ]);
  };
  const open = async (path) => {
    step = 'open';
    await live();
    await page.goto(target.origin + path, { waitUntil: 'domcontentloaded' });
    await main().getByRole('heading', { level: 1 }).waitFor();
  };
  const noFields = async () => {
    assert.equal(await main().locator('form').count(), 0);
    const t = await main().innerText();
    for (const text of [
      'WP082_PRIVATE_PROBLEM_MARKER',
      'SYN-AST-001',
      '合成内部メモ',
      '合成候補専用利用者',
      id,
    ])
      assert.ok(!t.includes(text));
  };
  const denied = async () => {
    step = 'not-found';
    await main()
      .getByRole('heading', { name: 'お探しの画面は見つかりませんでした', exact: true })
      .waitFor();
    await noFields();
    assert.equal(await retry().count(), 0);
  };
  const rejected = async (
    from = listPath,
    message = primaryMessage,
    heading = '編集画面を表示できません',
  ) => {
    step = 'fixed-error';
    await main().getByRole('heading', { name: heading, exact: true }).waitFor();
    assert.equal(await main().getByRole('alert').innerText(), message);
    await noFields();
    assert.equal(await retry().getAttribute('href'), entry(from));
    assert.equal(
      await main()
        .getByRole('link', { name: from ? '元の画面へ戻る' : '資産の詳細へ戻る', exact: true })
        .getAttribute('href'),
      from ?? detailPath,
    );
  };
  async function successful(state = 'in_use') {
    step = 'normal-form';
    await main().getByRole('heading', { name: '資産を編集する', exact: true }).waitFor();
    await main().locator('form:not([aria-busy=true])').waitFor();
    assert.equal(await main().locator('form').count(), 1);
    assert.equal(await main().getByRole('alert').count(), 0);
    for (const [name, value] of Object.entries({
      assetTag: 'SYN-AST-001',
      name: '合成検証資産 001',
      model: '合成モデル',
      serialNumber: 'SYN-0',
      hostname: 'synthetic-0',
      vendor: 'Synthetic vendor',
      location: '合成保管場所',
      notes: '合成内部メモ',
      reason: '',
    }))
      assert.equal(
        await main()
          .locator('#asset-' + name)
          .inputValue(),
        value,
      );
    assert.equal(await main().locator('[name=expectedVersion]').inputValue(), '2');
    assert.equal(await main().locator('#asset-kind').inputValue(), 'pc');
    assert.equal(await main().locator('#asset-kind').isDisabled(), true);
    assert.equal(await main().locator('input[name=kind]').inputValue(), 'pc');
    assert.equal(await main().locator('#asset-state').inputValue(), state);
    if (state === 'retired')
      assert.deepEqual(await main().locator('#asset-state option').allTextContents(), ['廃止']);
    const assignable = state === 'in_use' || state === 'repair';
    assert.equal(await main().locator('#asset-assigned').isDisabled(), !assignable);
    assert.equal(
      await main().locator('#asset-assigned').getAttribute('required'),
      state === 'in_use' ? '' : null,
    );
    assert.equal(await main().locator('#asset-assigned').inputValue(), assignable ? userId : '');
    if (!assignable)
      assert.equal(await main().locator('input[name=assignedUserId]').inputValue(), '');
    for (const name of ['assetTag', 'name', 'model', 'serialNumber', 'hostname'])
      assert.equal(
        await main()
          .locator('#asset-' + name)
          .getAttribute('required'),
        '',
      );
    assert.equal(
      await main().getByRole('button', { name: '変更と履歴を保存する', exact: true }).count(),
      1,
    );
    assert.ok((await main().innerText()).includes('入力は保持されます。'));
  }
  async function native(link, path, keyboard = false) {
    step = 'native-GET';
    assert.equal(await link.evaluate((e) => e.tagName), 'A');
    assert.equal(await link.getAttribute('href'), path);
    const request = page.waitForRequest(
      (r) => r.isNavigationRequest() && r.method() === 'GET' && r.url() === target.origin + path,
    );
    if (keyboard) await page.keyboard.press('Enter');
    else await link.click();
    await request;
    await page.waitForURL(target.origin + path, { waitUntil: 'domcontentloaded' });
    await main().getByRole('heading', { level: 1 }).waitFor();
  }
  async function capture(name) {
    step = 'evidence';
    await page.screenshot({ path: resolve(output, name + '.png'), fullPage: true });
    await chmod(resolve(output, name + '.png'), 0o600);
    report.screenshots.push({
      name,
      path: name + '.png',
      kind: 'full-page',
      viewport: page.viewportSize(),
    });
    const axe = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const result = {
      name,
      violations: axe.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.length,
      })),
    };
    report.accessibility.push(result);
    assert.equal(result.violations.length, 0);
  }
  async function check(name, fn) {
    step = 'check';
    await live();
    try {
      const details = await fn();
      report.checks.push({ name, passed: true, ...details });
    } catch {
      report.checks.push({ name, passed: false, step });
    }
  }
  try {
    await live();
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    const allowed = new Set([
      '/assets',
      detailPath,
      editPath,
      '/assets/not-a-uuid/edit',
      '/portal',
      '/api/draft-scope',
      '/favicon.ico',
    ]);
    context.on('request', (req) => {
      if (!['GET', 'HEAD'].includes(req.method())) {
        report.browserRequests.nonReadCount++;
        const k = ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method())
          ? req.method()
          : 'OTHER';
        report.browserRequests.methods[k] = (report.browserRequests.methods[k] ?? 0) + 1;
      }
    });
    await context.route('**/*', async (route) => {
      const req = route.request(),
        u = new URL(req.url());
      if (!['GET', 'HEAD'].includes(req.method())) return route.abort();
      if (u.origin !== target.origin) {
        report.browserRequests.unknownReads++;
        return route.abort();
      }
      const headers = req.headers(),
        kinds = [];
      if (headers['next-router-prefetch'] === '1') kinds.push('next-router-prefetch');
      for (const k of ['purpose', 'sec-purpose'])
        if (/prefetch/i.test(headers[k] ?? '')) kinds.push(k);
      if (kinds.length) {
        report.prefetch.attempted++;
        report.prefetch.blocked++;
        const p = allowed.has(u.pathname) ? u.pathname : 'other';
        report.prefetch.pathnames[p] = (report.prefetch.pathnames[p] ?? 0) + 1;
        for (const k of kinds)
          report.prefetch.headerKinds[k] = (report.prefetch.headerKinds[k] ?? 0) + 1;
        return route.abort();
      }
      if (!allowed.has(u.pathname) && !u.pathname.startsWith('/_next/')) {
        report.browserRequests.unknownReads++;
        return route.abort();
      }
      return route.continue();
    });
    page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('download', () => report.browserRequests.downloads++);
    signal?.addEventListener('abort', onAbort, { once: true });
    await role('agent');
    for (const state of ['in_use', 'repair', 'stocked', 'retired'])
      await check('normal-agent-' + state, async () => {
        await scenario({ state });
        await open(entry());
        await successful(state);
        await capture('normal-agent-' + state);
        return { actualForm: true, submitted: false };
      });
    await check('normal-org-admin', async () => {
      await role('org_admin');
      await scenario();
      await open(entry());
      await successful();
      await capture('normal-org-admin');
    });
    await role('agent');
    for (const mode of ['500', '503', 'network', 'body_cut', 'invalid_json'])
      await check('primary-' + mode + '-recover', async () => {
        await scenario({ asset: mode });
        await open(entry());
        await rejected();
        await capture('primary-' + mode);
        await scenario();
        const before = candidateReads().length;
        await native(retry(), entry());
        await successful();
        assert.ok(candidateReads().length > before);
        assert.ok(
          candidateReads()
            .slice(before)
            .every((x) => x.query === ''),
        );
        return { nativeDocumentGet: true, primaryReadsIncreased: true };
      });
    for (const mode of ['400', '401', '403', '404', '403_body_cut', '404_body_cut'])
      await check('primary-' + mode + '-denied', async () => {
        await scenario({ asset: mode });
        await open(entry());
        await denied();
        await capture('primary-' + mode + '-denied');
      });
    await check('can-manage-false', async () => {
      await scenario({ canManage: false, options: '503' });
      await open(entry());
      await denied();
      await capture('can-manage-false');
    });
    for (const actor of ['requester', 'auditor'])
      await check(actor + '-denied', async () => {
        await role(actor);
        await scenario();
        await open(entry());
        await denied();
        await capture(actor + '-denied');
        return { syntheticRoleOnly: true };
      });
    await role('agent');
    await check('both-503-primary-guidance', async () => {
      await scenario({ asset: '503', options: '503' });
      await open(entry());
      await rejected();
      await capture('both-503');
    });
    for (const [asset, options] of [
      ['503', '403'],
      ['403', '503'],
    ])
      await check('priority-' + asset + '-' + options, async () => {
        await scenario({ asset, options });
        await open(entry());
        await denied();
        await capture('priority-' + asset + '-' + options);
      });
    for (const [mode, message] of [
      ['400', '画面を開くための情報が正しくありません。元の画面から開き直してください。'],
      ['401', 'ログイン状態を確認できませんでした。ログインし直してから、もう一度お試しください。'],
      ['404', '登録・編集に必要な候補を取得できませんでした。元の画面から開き直してください。'],
      ['503', '一時的に入力候補を取得できませんでした。時間をおいて、もう一度お試しください。'],
    ])
      await check('candidate-unchanged-' + mode, async () => {
        await scenario({ options: mode });
        await open(entry());
        await rejected(listPath, message, '編集画面を読み込めませんでした');
        await capture('candidate-' + mode);
      });
    await check('raw-japanese-nested-query', async () => {
      const raw =
        detailPath +
        '?returnTo=' +
        encodeURIComponent('/assets?q=合成&state=in_use&kind=pc&assignment=mine&page=2') +
        '&saved=1';
      const canonical = detailPath + '?' + new URLSearchParams({ returnTo: listPath });
      await scenario({ asset: '503' });
      await open(entry(raw) + '&saved=1&unknown=PRIVATE');
      await rejected(canonical);
      const retryURL = new URL(await retry().getAttribute('href'), target);
      assert.deepEqual([...retryURL.searchParams], [['returnTo', canonical]]);
      const parent = new URL(
        new URL(retryURL.searchParams.get('returnTo'), target).searchParams.get('returnTo'),
        target,
      );
      assert.equal(parent.pathname, '/assets');
      assert.deepEqual(
        [...parent.searchParams],
        [
          ['q', '合成'],
          ['state', 'in_use'],
          ['kind', 'pc'],
          ['assignment', 'mine'],
          ['page', '2'],
        ],
      );
      await capture('raw-japanese-nested-query');
      await scenario();
      const before = candidateReads().length;
      await native(retry(), entry(canonical));
      await successful();
      assert.ok(candidateReads().length > before);
    });
    for (const [name, from, label, path, heading] of [
      ['filtered-assets', listPath, '元の画面へ戻る', listPath, '資産台帳'],
      ['detail-fallback', null, '資産の詳細へ戻る', detailPath, 'SYN-AST-001 · 合成検証資産 001'],
      ['portal', null, 'ポータルへ戻る', '/portal', 'あなたのITサポート'],
    ])
      await check('native-' + name, async () => {
        await scenario({ asset: '503' });
        await open(entry(from));
        await rejected(from);
        await scenario();
        const before = allReads().length;
        await native(main().getByRole('link', { name: label, exact: true }), path);
        await main().getByRole('heading', { level: 1, name: heading, exact: true }).waitFor();
        assert.ok(allReads().length > before);
        if (name === 'filtered-assets') {
          const last = allReads()
            .filter((x) => x.route === 'list')
            .at(-1);
          assert.deepEqual(
            [...new URLSearchParams(last.query)],
            [...new URLSearchParams(listPath.split('?')[1])],
          );
        }
        await capture('native-' + name);
        return { actualExitRenderer: true, nativeDocumentGet: true };
      });
    for (const [name, query] of [
      ['unsafe', 'returnTo=https%3A%2F%2Fexample.invalid&saved=1'],
      ['plural', 'returnTo=%2Fassets&returnTo=%2Fportal'],
    ])
      await check('return-' + name, async () => {
        await scenario({ asset: '503' });
        await open(editPath + '?' + query);
        await rejected(null);
        await capture('return-' + name);
      });
    await check('invalid-id-refusal-no-asset-read', async () => {
      await scenario();
      const before = candidateReads().length;
      await open('/assets/not-a-uuid/edit');
      await denied();
      assert.equal(candidateReads().length, before);
      await capture('invalid-id');
    });
    await check('keyboard-native-recovery', async () => {
      await scenario({ asset: '503' });
      await open(entry());
      await rejected();
      for (let i = 0; i < 50; i++) {
        if (await retry().evaluate((e) => document.activeElement === e)) break;
        await page.keyboard.press('Tab');
      }
      assert.equal(await retry().evaluate((e) => document.activeElement === e), true);
      assert.equal(
        await retry().evaluate(
          (e) =>
            e.matches(':focus-visible') &&
            (getComputedStyle(e).outlineStyle !== 'none' ||
              getComputedStyle(e).boxShadow !== 'none'),
        ),
        true,
      );
      await capture('keyboard-focus');
      await scenario();
      const before = candidateReads().length;
      await native(retry(), entry(), true);
      await successful();
      assert.ok(candidateReads().length > before);
      return { tab: true, enter: true, visibleFocus: true, nativeDocumentGet: true };
    });
    await page.setViewportSize({ width: 390, height: 844 });
    for (const [name, s] of [
      ['error', { asset: '503' }],
      ['form', {}],
    ])
      await check('mobile-' + name, async () => {
        await scenario(s);
        await open(entry());
        if (name === 'error') await rejected();
        else await successful();
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
          true,
        );
        await capture('mobile-' + name);
      });
  } catch {
    failure = 'ASSET_EDIT_UI_INCOMPLETE';
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await cancellation;
    try {
      await browser?.close();
      report.browserClosed = true;
    } catch {
      report.browserClosed = false;
    }
  }
  report.success =
    !signal?.aborted &&
    !aborted &&
    !failure &&
    report.checks.length === expectedChecks &&
    report.checks.every((c) => c.passed) &&
    report.browserRequests.nonReadCount === 0 &&
    report.browserRequests.downloads === 0 &&
    report.browserRequests.unknownReads === 0 &&
    report.browserClosed;
  if (failure) report.failureCode = failure;
  report.expectedChecks = expectedChecks;
  report.passedChecks = report.checks.filter((c) => c.passed).length;
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  if (signal?.aborted) throw new Error('ASSET_EDIT_UI_ABORTED');
  return report;
}
