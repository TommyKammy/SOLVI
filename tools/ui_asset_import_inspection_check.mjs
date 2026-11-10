/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import { access, chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
const root = fileURLToPath(new URL('../', import.meta.url));
const evidenceRoot = resolve(root, 'evidence/WP-P6-CSVVIEW-084');
const id = '08400000-0000-4000-8000-000000000100';
const originalAsset = '08400000-0000-4000-8000-000000000200';
const savedAsset = '08400000-0000-4000-8000-000000000300';
const sentinels = ['WP084_UNDISPLAYED_INPUT_SENTINEL', 'wp084-undisplayed@example.invalid'];
const path = '/assets/imports/' + id;
const entry = path + '?' + new URLSearchParams({ returnTo: '/assets/imports' });
const expectedChecks = 24;
export async function runAssetImportInspectionChecks({
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
    workPackage: 'WP-P6-CSVVIEW-084',
    model:
      'Actual copied production Next and synthetic readonly API; no real authorization, database, parser or CSV write proof.',
    actualInspectionRendererTested: true,
    actualApplyRendererTested: true,
    formSubmissionTested: false,
    realAuthorizationTested: false,
    checks: [],
    screenshots: [],
    accessibility: [],
    browserRequests: {
      nonReadCount: 0,
      methods: {},
      unknownReads: 0,
      downloads: 0,
      errorReportAttempts: 0,
      errorReportBlocked: 0,
      errorReportPrefetchAttempts: 0,
      errorReportOrdinaryAttempts: 0,
    },
    prefetch: { attempted: 0, blocked: 0, forwarded: 0, pathnames: {}, headerKinds: {} },
    browserClosed: false,
    success: false,
  };
  let browser,
    context,
    page,
    documentReads,
    expectedChecked = false,
    aborted = false,
    step = 'setup',
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
  const main = () => page.locator('main'),
    inspection = () => main().locator('section[aria-labelledby=import-inspection-title]');
  const search = () => inspection().getByRole('searchbox', { name: '外部ID・資産タグで探す' });
  const clear = () => inspection().getByRole('button', { name: '表示条件を解除する', exact: true });
  const group = () => inspection().getByRole('group', { name: '判定で表示を絞り込む' });
  const button = (name, count = 25) =>
    group().getByRole('button', { name: name + '（' + count + '）', exact: true });
  const rowIds = () =>
    inspection()
      .locator('tbody tr')
      .evaluateAll((rows) =>
        rows
          .map((row) => row.querySelector('td')?.textContent)
          .filter((value) => /^\d+$/.test(value ?? ''))
          .map(Number),
      );
  const expected = (operation) =>
    Array.from({ length: 100 }, (_, i) => i + 2).filter(
      (_, i) => operation === 'all' || i % 4 === operation,
    );
  const applied = async (count = 75) => {
    const form = main().locator('form');
    await form.locator('[name=confirmed]').waitFor();
    await page.waitForFunction(() => !document.querySelector('main form')?.hasAttribute('inert'));
    assert.equal(await form.count(), 1);
    assert.equal(await form.locator('[name=planHash]').inputValue(), 'b'.repeat(64));
    assert.equal(await form.locator('[name=confirmed]').evaluate((e) => e.required), true);
    assert.equal(await form.locator('[name=confirmed]').isChecked(), expectedChecked);
    assert.ok((await form.innerText()).includes('正常' + count + '行を確定し'));
    assert.equal(
      await form
        .getByRole('button', { name: '正常' + count + '行の取込を確定する', exact: true })
        .count(),
      1,
    );
  };
  const noApply = async () => assert.equal(await main().locator('form').count(), 0);
  const noPrivate = async () => {
    const html = await page.content();
    for (const sentinel of sentinels) assert.ok(!html.includes(sentinel));
  };
  const role = async (value) => {
    assert.ok(['agent', 'org_admin', 'auditor', 'requester'].includes(value));
    await context.clearCookies();
    await context.addCookies([
      { name: 'solvi_session_wp084_synthetic', value, url: target.origin },
    ]);
  };
  const open = async (mode = 'mixed') => {
    await live();
    control({ mode });
    step = 'open';
    await page.goto(target.origin + entry, { waitUntil: 'domcontentloaded' });
    await main().getByRole('heading', { level: 1 }).waitFor();
    await page.waitForLoadState('networkidle');
    expectedChecked = false;
    documentReads = { detail: candidateReads().length, all: allReads().length };
  };
  const count = async (n) => {
    await inspection()
      .getByRole('status')
      .filter({ hasText: '表示' + n + '行 / 全100行' })
      .waitFor();
    assert.equal(await group().locator('[aria-pressed=true]').count(), 1);
  };
  const displayOnly = async (action, checkPrivate = true) => {
    const before = { url: page.url(), detail: candidateReads().length, all: allReads().length };
    await action();
    if (checkPrivate) await noPrivate();
    assert.equal(page.url(), before.url);
    assert.equal(candidateReads().length, before.detail);
    assert.equal(allReads().length, before.all);
    return { URLUnchanged: true, additionalAPIReads: 0 };
  };
  const capture = async (name) => {
    step = 'capture';
    if (await inspection().count()) await inspection().scrollIntoViewIfNeeded();
    const result = await new AxeBuilder({ page }).analyze();
    report.accessibility.push({
      name,
      violations: result.violations.map((item) => ({
        id: item.id,
        impact: item.impact,
        nodes: item.nodes.length,
        contrast:
          item.id === 'color-contrast'
            ? item.nodes.map((node) => ({
                category: node.target.some((target) => String(target).includes('filters'))
                  ? 'filter'
                  : 'other',
                colors: node.any
                  .filter((check) => check.id === 'color-contrast')
                  .map((check) => ({
                    foreground: check.data?.fgColor,
                    background: check.data?.bgColor,
                    ratio: check.data?.contrastRatio,
                  })),
              }))
            : undefined,
      })),
    });
    const image = resolve(output, name + '.png');
    await page.screenshot({ path: image, fullPage: false });
    await chmod(image, 0o600);
    report.screenshots.push({
      name,
      path: name + '.png',
      sha256: createHash('sha256')
        .update(await readFile(image))
        .digest('hex'),
      type: 'viewport',
      width: page.viewportSize().width,
    });
    assert.equal(result.violations.length, 0);
  };
  async function check(name, fn) {
    await live();
    step = 'check';
    try {
      const proof = await fn();
      await capture(name);
      assert.equal(candidateReads().length, documentReads.detail);
      assert.equal(allReads().length, documentReads.all);
      report.checks.push({ name, passed: true, ...(proof ?? {}) });
    } catch {
      report.checks.push({ name, passed: false, step });
    }
  }
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      serviceWorkers: 'block',
    });
    context.on('request', (req) => {
      if (!['GET', 'HEAD'].includes(req.method())) {
        report.browserRequests.nonReadCount++;
        report.browserRequests.methods[req.method()] =
          (report.browserRequests.methods[req.method()] ?? 0) + 1;
      }
    });
    const allowed = new Set([path, '/favicon.ico']);
    await context.route('**/*', async (route) => {
      const req = route.request(),
        url = new URL(req.url());
      if (!['GET', 'HEAD'].includes(req.method())) return route.abort();
      if (url.origin !== target.origin) {
        report.browserRequests.unknownReads++;
        return route.abort();
      }
      const headers = req.headers(),
        kinds = [];
      if (headers['next-router-prefetch'] === '1') kinds.push('next-router-prefetch');
      for (const key of ['purpose', 'sec-purpose'])
        if (/prefetch/i.test(headers[key] ?? '')) kinds.push(key);
      if (url.pathname === path + '/errors') {
        report.browserRequests.errorReportAttempts++;
        report.browserRequests.errorReportBlocked++;
        report.browserRequests[
          kinds.length ? 'errorReportPrefetchAttempts' : 'errorReportOrdinaryAttempts'
        ]++;
        return route.abort();
      }
      if (kinds.length) {
        report.prefetch.attempted++;
        report.prefetch.blocked++;
        const known = allowed.has(url.pathname) ? url.pathname : 'other';
        report.prefetch.pathnames[known] = (report.prefetch.pathnames[known] ?? 0) + 1;
        for (const key of kinds)
          report.prefetch.headerKinds[key] = (report.prefetch.headerKinds[key] ?? 0) + 1;
        return route.abort();
      }
      if (!allowed.has(url.pathname) && !url.pathname.startsWith('/_next/')) {
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
    await open();
    await check('normal-agent-100', async () => {
      await count(100);
      assert.deepEqual(await rowIds(), expected('all'));
      await applied();
      await main().locator('[name=confirmed]').check();
      expectedChecked = true;
      await applied();
      await noPrivate();
      return { rows: 100, normalCount: 75, privateHTMLAndRSCAbsent: true };
    });
    for (const [label, operation] of [
      ['追加', 0],
      ['更新', 1],
      ['変更なし', 2],
      ['不正', 3],
    ])
      await check('operation-' + operation, async () => {
        await displayOnly(async () => {
          await button(label).click();
          await count(25);
        });
        await count(25);
        assert.deepEqual(await rowIds(), expected(operation));
        await applied();
        return { displayed: 25, normalCount: 75 };
      });
    for (const [name, query, ids] of [
      ['external-case', 'syn-002', [3]],
      ['tag-case', 'ast-001', [2]],
      ['literal-bracket', '[', [2]],
      ['no-trim', ' AST-001', []],
    ])
      await check('search-' + name, async () => {
        if (await clear().isEnabled()) await clear().click();
        await displayOnly(async () => {
          await search().fill(query);
          await count(ids.length);
        });
        await count(ids.length);
        assert.deepEqual(await rowIds(), ids);
        await applied();
      });
    await check('combined-condition', async () => {
      await clear().click();
      await displayOnly(async () => {
        await button('更新').click();
        await search().fill('SYN-002');
        await count(1);
      });
      await count(1);
      assert.deepEqual(await rowIds(), [3]);
      await applied();
    });
    await check('empty-and-clear', async () => {
      await displayOnly(async () => {
        await search().fill('no-identifier-match');
        await count(0);
      });
      await count(0);
      assert.ok((await inspection().innerText()).includes('条件に一致する行がありません'));
      await applied();
      await displayOnly(async () => {
        await clear().click();
        await count(100);
      });
      await count(100);
      assert.deepEqual(await rowIds(), expected('all'));
    });
    await check('private-values-not-searchable', async () => {
      await noPrivate();
      for (const sentinel of sentinels) {
        await displayOnly(async () => {
          await search().fill(sentinel);
          await count(0);
        }, false);
        await count(0);
        assert.ok(!(await inspection().locator('table').innerText()).includes(sentinel));
        for (const script of await page.locator('script').allTextContents())
          assert.ok(!script.includes(sentinel));
      }
      await applied();
      await clear().click();
      await noPrivate();
      return {
        documentAndInitialRSCPrivateValuesAbsent: true,
        enteredQueryExcludedFromHTMLClaim: true,
      };
    });
    await check('semantic-before-after', async () => {
      await button('更新').click();
      const row = inspection().locator('tbody tr').first();
      assert.equal(await row.locator('details').getAttribute('open'), '');
      assert.ok((await row.innerText()).includes('（確認時の版7）'));
      const change = (label) => row.getByText(label, { exact: true }).locator('..').locator('dl');
      assert.deepEqual(await change('保管場所').locator('dd').allTextContents(), [
        '（空欄）',
        '（なし）',
      ]);
      assert.deepEqual(await change('モデル').locator('dd').allTextContents(), [
        '（なし）',
        '（空欄）',
      ]);
      assert.deepEqual(await change('内部メモ').locator('dd').allTextContents(), [
        '一行\n二行',
        '<script>合成</script>',
      ]);
      assert.equal(
        await change('内部メモ')
          .locator('dd')
          .first()
          .evaluate((e) => getComputedStyle(e).whiteSpace),
        'pre-wrap',
      );
      assert.equal(await change('名前').locator('dd').nth(1).textContent(), '長'.repeat(160));
      assert.equal(await change('ホスト名').locator('dd').first().textContent(), '0');
      assert.equal(await row.locator('script').count(), 0);
    });
    await check('existing-match-and-link', async () => {
      const row = inspection().locator('tbody tr').first();
      assert.ok((await row.innerText()).includes('初回の資産タグ一致'));
      const href = new URL(
        await row.getByRole('link', { name: 'AST-002', exact: true }).getAttribute('href'),
        target.origin,
      );
      assert.equal(href.pathname, '/assets/' + originalAsset);
      assert.equal(href.searchParams.get('returnTo'), entry);
      await main().locator('[name=confirmed]').uncheck();
      expectedChecked = false;
      await applied();
      return { hrefOnly: true, assetNavigationTested: false };
    });
    await check('normal-org-admin', async () => {
      await role('org_admin');
      await open();
      await count(100);
      await applied();
    });
    await check('auditor-inspection-without-apply', async () => {
      await role('auditor');
      await open();
      await count(100);
      await noApply();
      await displayOnly(async () => {
        await button('不正').click();
        await count(25);
      });
      await count(25);
      await noApply();
    });
    await check('requester-denied', async () => {
      await role('requester');
      await open();
      await main()
        .getByRole('heading', { name: 'お探しの画面は見つかりませんでした', exact: true })
        .waitFor();
      assert.equal(await inspection().count(), 0);
      await noApply();
      await noPrivate();
      return { syntheticRoleOnly: true };
    });
    await check('capability-readonly-agent', async () => {
      await role('agent');
      await open('readonly');
      await count(100);
      await noApply();
      await button('追加').click();
      await count(25);
      await noApply();
    });
    await check('all-invalid', async () => {
      await open('all_invalid');
      await count(100);
      await noApply();
      assert.ok((await main().innerText()).includes('正常行がありません'));
      await button('不正', 100).click();
      await count(100);
      assert.equal(await button('追加', 0).count(), 1);
    });
    await check('receipt-preserves-saved-link', async () => {
      await open('receipt');
      await count(100);
      await noApply();
      assert.ok((await main().innerText()).includes('確定済み'));
      const href = new URL(
        await inspection().getByRole('link', { name: 'AST-001', exact: true }).getAttribute('href'),
        target.origin,
      );
      assert.equal(href.pathname, '/assets/' + savedAsset);
      assert.equal(href.searchParams.get('returnTo'), entry);
      await search().fill('no-match');
      await count(0);
      await noApply();
      return { savedIdentityPreferred: true, receiptWriteTested: false };
    });
    await check('keyboard-filter-search-clear', async () => {
      await open();
      await button('更新').focus();
      assert.equal(
        await button('更新').evaluate(
          (e) => e === document.activeElement && getComputedStyle(e).outlineStyle !== 'none',
        ),
        true,
      );
      await displayOnly(async () => {
        await page.keyboard.press('Enter');
        await count(25);
      });
      await count(25);
      await search().focus();
      await search().fill('syn-002');
      await count(1);
      await page.keyboard.press('Tab');
      assert.equal(await clear().evaluate((e) => e === document.activeElement), true);
      await displayOnly(async () => {
        await page.keyboard.press('Space');
        await count(100);
      });
      await count(100);
      await applied();
      return { realKeyboard: true, visibleFocus: true, EnterFilter: true, SpaceClear: true };
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await check('mobile-normal-and-local-scroll', async () => {
      await open();
      await count(100);
      await applied();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        true,
      );
      const region = inspection().getByRole('region');
      await region.focus();
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(
        () =>
          document.querySelector('section[aria-labelledby=import-inspection-title] [role=region]')
            .scrollLeft > 0,
      );
      assert.equal(await region.evaluate((e) => e.scrollWidth > e.clientWidth), true);
      return { localScroll: true, viewport: 390 };
    });
    await check('mobile-empty-and-clear', async () => {
      await search().fill('no-match');
      await count(0);
      await applied();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        true,
      );
      await clear().click();
      await count(100);
    });
    await check('retained-read-failure', async () => {
      await open('503');
      assert.equal(await inspection().count(), 0);
      await noApply();
      assert.equal(
        await main().getByRole('link', { name: '再取得する', exact: true }).getAttribute('href'),
        entry,
      );
      assert.ok(!(await page.content()).includes('WP084_PRIVATE_PROBLEM'));
    });
  } catch {
    report.failure = { phase: step };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await cancellation;
    const closed = [];
    for (const owned of [context, browser])
      closed.push(...(await Promise.allSettled([Promise.resolve().then(() => owned?.close())])));
    report.browserClosed = Boolean(browser) && closed.every((item) => item.status === 'fulfilled');
    report.browserCloseResults = { context: closed[0]?.status, browser: closed[1]?.status };
    report.aborted = aborted || Boolean(signal?.aborted);
    report.success =
      !report.failure &&
      !report.aborted &&
      report.browserClosed &&
      report.checks.length === expectedChecks &&
      report.checks.every((check) => check.passed) &&
      report.screenshots.length === expectedChecks &&
      report.accessibility.length === expectedChecks &&
      report.accessibility.every((state) => state.violations.length === 0) &&
      report.browserRequests.nonReadCount === 0 &&
      report.browserRequests.unknownReads === 0 &&
      report.browserRequests.downloads === 0 &&
      report.prefetch.forwarded === 0;
    await writeFile(resolve(output, 'ui-report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  }
  return report;
}
