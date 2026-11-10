/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import { access, chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidenceRoot = resolve(root, 'evidence/WP-P2-CHGMOB-063');
const privateMarker = 'WP063_PRIVATE_PROBLEM_MARKER';
const assetId = '06300000-0000-4000-8000-000000000004';
const ticketId = '06300000-0000-4000-8000-000000000003';
const query = new URLSearchParams({
  q: '合成 & %_\\?',
  state: 'failed',
  assetId,
  ticketId,
  needsPir: '1',
  page: '2',
  from: '2026-10-08T00:00:00.000Z',
  to: '2026-10-08T01:30:00.000Z',
}).toString();
const filteredPath = '/changes?' + query;
const errorMessages = {
  400: '変更一覧の検索条件を確認できませんでした。条件を解除して開き直してください。',
  401: 'ログインの有効期限が切れた可能性があります。再取得しても表示できない場合は、ポータルからログインし直してください。',
  403: 'この組織の変更一覧を表示する権限がありません。選択中の組織を確認するか、管理者にご相談ください。',
  404: '変更一覧を表示できません。対象や機能が現在利用できない可能性があります。ポータルへ戻ってご確認ください。',
  503: '変更一覧を取得できませんでした。時間をおいて、同じ条件で再取得してください。',
};

/** Real Next.js/Chromium only; every backend response and cookie is synthetic. */
export async function runChangeTableChecks({
  variant,
  baseURL,
  outputDirectory,
  control,
  changeReads,
  assertOwned,
  signal,
}) {
  assert.ok(['baseline', 'improved'].includes(variant));
  const expectedChecks = variant === 'baseline' ? 2 : 13;
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
  assert.equal(typeof control, 'function');
  assert.equal(typeof changeReads, 'function');
  assert.equal(typeof assertOwned, 'function');
  const output = resolve(outputDirectory);
  const within = relative(evidenceRoot, output);
  assert.ok(within && !within.startsWith('..') && !isAbsolute(within));
  assert.equal(await realpath(dirname(output)), dirname(output));
  await access(chromium.executablePath()); // Never install or download a browser.
  if (signal?.aborted) throw new Error('CHANGE_UI_ABORTED');
  await mkdir(output, { mode: 0o700 });
  const report = {
    workPackage: 'WP-P2-CHGMOB-063',
    variant,
    improvedAcceptanceTested: variant === 'improved',
    actualBrowserZoomTested: false,
    detailRendererTested: false,
    metrics: [],
    model: 'Real copied production Next.js UI with loopback synthetic API and synthetic session.',
    realDatabaseTested: false,
    realAuthorizationTested: false,
    productionAcceptance: false,
    startedAt: new Date().toISOString(),
    checks: [],
    screenshots: [],
    axe: [],
    browserRequests: { nonReadCount: 0, methods: {} },
    cleanup: { browserClosed: false, navigationProbeRemoved: false },
    success: false,
  };
  let browser, context, page;
  let navigationProbe, navigationProbeMatcher;
  let mode = 'normal';
  let step = 'initial';
  let cancellation = Promise.resolve();
  const onBrowserRequest = (request) => {
    const method = request.method();
    if (method === 'GET' || method === 'HEAD') return;
    const safeMethod = ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE'].includes(
      method,
    )
      ? method
      : 'OTHER';
    report.browserRequests.nonReadCount++;
    report.browserRequests.methods[safeMethod] =
      (report.browserRequests.methods[safeMethod] ?? 0) + 1;
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
    mode = next;
  };
  const rows = () => page.locator('table.tickets tbody tr');
  const main = () => page.locator('main');
  const retry = () => main().getByRole('link', { name: '同じ条件で再取得する', exact: true });
  const update = () => main().getByRole('link', { name: '変更一覧を更新する', exact: true });
  async function open(path = '/changes') {
    step = 'open';
    await live();
    await page.goto(target.origin + path, { waitUntil: 'networkidle' });
    await main().getByRole('heading', { name: '変更管理', level: 1, exact: true }).waitFor();
  }
  async function successful(count = 25) {
    step = 'normal-rows';
    await update().waitFor();
    await page.waitForFunction(
      (expected) => document.querySelectorAll('table.tickets tbody tr').length === expected,
      count,
    );
    const pageNumber = Number(new URL(page.url()).searchParams.get('page') ?? '1');
    const firstNumber = 'SYN-CHG-' + String((pageNumber - 1) * 25 + 1).padStart(3, '0');
    await page.waitForFunction(
      (expected) =>
        document
          .querySelector('table.tickets tbody tr td:first-child')
          ?.textContent?.includes(expected),
      firstNumber,
    );
    assert.equal(await rows().count(), count);
    assert.equal(await main().getByRole('alert').count(), 0);
  }
  async function rejected() {
    step = 'error-boundary';
    await main().getByRole('alert').waitFor();
    assert.ok((await main().getByRole('alert').innerText()).trim().length > 0);
    assert.equal(await rows().count(), 0);
    assert.equal(await main().getByRole('status').count(), 0);
    assert.equal(await main().locator('form').count(), 0);
    assert.equal(
      await main()
        .innerText()
        .then((text) => text.includes(privateMarker)),
      false,
    );
    assert.equal(
      await main().getByRole('link', { name: 'ポータルへ戻る', exact: true }).getAttribute('href'),
      '/portal',
    );
  }
  async function freshNavigation(link, path, keyboard = false) {
    step = 'native-anchor';
    assert.equal(await link.evaluate((node) => node.tagName), 'A');
    assert.equal(await link.getAttribute('href'), path);
    const before = changeReads();
    const navigation = page.waitForRequest(
      (request) =>
        request.isNavigationRequest() &&
        request.method() === 'GET' &&
        request.url() === target.origin + path,
    );
    if (keyboard) await page.keyboard.press('Enter');
    else await link.click();
    await navigation;
    await page.waitForLoadState('networkidle');
    await successful();
    step = 'fresh-api-get';
    const fresh = changeReads().slice(before.length);
    assert.ok(fresh.length > 0);
    assert.ok(
      fresh.some((request) => request.query === new URL(path, target).searchParams.toString()),
    );
    assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, path);
    return { apiReadsIncreased: true, nativeDocumentGet: true, sameQuery: true };
  }
  async function shot(name, captureTarget = null) {
    step = 'capture';
    await live();
    if (captureTarget) {
      await captureTarget.scrollIntoViewIfNeeded();
      const box = await captureTarget.boundingBox();
      assert.ok(box && box.y >= 0 && box.y + box.height <= page.viewportSize().height + 1);
    } else {
      await page.evaluate(() => globalThis.scrollTo(0, 0));
    }
    const file = resolve(output, name + '.png');
    await page.screenshot({ path: file, fullPage: false });
    await chmod(file, 0o600);
    report.screenshots.push({
      name,
      captureType: 'viewport',
      captureTarget: captureTarget ? 'asserted-visible-guidance-or-first-item' : 'page-top',
      viewport: page.viewportSize(),
      model: 'synthetic API',
      scenario: mode,
    });
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
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
  async function tabTo(locator) {
    step = 'keyboard-focus';
    for (let i = 0; i < 100; i++) {
      await page.keyboard.press('Tab');
      if (await locator.evaluate((node) => document.activeElement === node)) {
        const focused = await locator.evaluate((node) => {
          const style = getComputedStyle(node);
          return (
            node.matches(':focus-visible') &&
            parseFloat(style.outlineWidth) > 0 &&
            style.outlineStyle !== 'none'
          );
        });
        assert.ok(focused);
        return;
      }
    }
    assert.fail('CHANGE_UI_FOCUS');
  }
  async function check(name, operation) {
    await live();
    step = 'start';
    try {
      const observations = await operation();
      await live();
      report.checks.push({ name, passed: true, observations: observations ?? {} });
    } catch {
      report.checks.push({
        name,
        passed: false,
        step,
        failureCode: signal?.aborted ? 'CHANGE_UI_ABORTED' : 'CHANGE_UI_ASSERTION_FAILED',
      });
    } finally {
      if (!signal?.aborted) await scenario('normal');
    }
  }
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await live();
    browser = await chromium.launch({ headless: true });
    await live();
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
      locale: 'ja-JP',
    });
    context.on('request', onBrowserRequest);
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (!['data:', 'blob:', 'about:'].includes(url.protocol) && url.origin !== target.origin)
        return route.abort();
      return route.continue();
    });
    await context.addCookies([
      {
        name: 'solvi_session_wp063_synthetic',
        value: 'agent',
        url: target.origin,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    page = await context.newPage();
    page.setDefaultTimeout(12_000);
    const region = () => main().getByRole('region', { name: '変更計画一覧', exact: true });
    const firstLink = () => rows().first().getByRole('link');
    const pager = () => main().getByRole('navigation', { name: '変更一覧のページ', exact: true });
    async function measure(label, required) {
      step = 'measure-table';
      const result = await page.evaluate((longTitles) => {
        const table = document.querySelector('table.tickets');
        const region = table.closest('[role="region"]');
        const allRows = [...table.querySelectorAll('tbody tr')].slice(0, 3);
        const expectedTitles = longTitles
          ? ['合成検証の変更 001', '変更計画'.repeat(40), 'A'.repeat(160)]
          : ['合成検証の変更 001', '合成検証の変更 002', '合成検証の変更 003'];
        const measuredRows = allRows.map((row, index) => {
          const cells = [...row.querySelectorAll('td')],
            cell = cells[0],
            link = cell.querySelector('a');
          const rect = cell.getBoundingClientRect(),
            linkRect = link.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(link);
          const boxes = [...range.getClientRects()];
          const style = getComputedStyle(link),
            cellStyle = getComputedStyle(cell);
          const expectedText =
            'SYN-CHG-' + String(index + 1).padStart(3, '0') + ' · ' + expectedTitles[index];
          const contentPreserved = link.textContent === expectedText;
          const titleContained = boxes.every(
            (box) =>
              box.left >= rect.left - 1 &&
              box.right <= rect.right + 1 &&
              box.top >= rect.top - 1 &&
              box.bottom <= rect.bottom + 1,
          );
          const cellsContained = cells.every((td) => {
            const bounds = td.getBoundingClientRect(),
              content = document.createRange();
            content.selectNodeContents(td);
            return (
              [...content.getClientRects()].every(
                (box) =>
                  box.left >= bounds.left - 1 &&
                  box.right <= bounds.right + 1 &&
                  box.top >= bounds.top - 1 &&
                  box.bottom <= bounds.bottom + 1,
              ) && td.scrollWidth <= td.clientWidth + 1
            );
          });
          const noClipping = [style, cellStyle].every(
            (value) =>
              !['hidden', 'clip'].includes(value.overflowX) &&
              !['hidden', 'clip'].includes(value.overflowY) &&
              value.textOverflow !== 'ellipsis' &&
              ['none', '0', ''].includes(value.webkitLineClamp),
          );
          const badge = cells[1].querySelector('.state'),
            badgeRect = badge.getBoundingClientRect(),
            stateRect = cells[1].getBoundingClientRect();
          return {
            index,
            titleCellWidth: rect.width,
            titleContentWidth:
              rect.width - parseFloat(cellStyle.paddingLeft) - parseFloat(cellStyle.paddingRight),
            titleLinkHeight: linkRect.height,
            titleLineBoxes: boxes.length,
            textCharacters: link.textContent.length,
            contentPreserved,
            titleContained,
            cellsContained,
            noClipping,
            stateCellWidth: stateRect.width,
            stateBadgeWidth: badgeRect.width,
            stateBadgeContained:
              badgeRect.left >= stateRect.left - 1 && badgeRect.right <= stateRect.right + 1,
          };
        });
        return {
          viewport: { width: document.documentElement.clientWidth, height: globalThis.innerHeight },
          rootFontPixels: parseFloat(getComputedStyle(document.documentElement).fontSize),
          documentWidth: document.documentElement.scrollWidth,
          tableWidth: table.getBoundingClientRect().width,
          regionWidth: region.clientWidth,
          regionScrollWidth: region.scrollWidth,
          regionOverflowX: getComputedStyle(region).overflowX,
          rows: measuredRows,
        };
      }, mode === 'long');
      report.metrics.push({ label, ...result });
      if (label === 'baseline-390' || label === 'improved-390') {
        report.readability = {
          variant,
          viewportWidth: 390,
          titleCellWidth: result.rows[0].titleCellWidth,
          representativeLinkHeight: result.rows[0].titleLinkHeight,
          representativeTitle: 'SYN-CHG-001 · 合成検証の変更 001',
        };
      }
      assert.equal(result.rows.length, 3);
      assert.ok(result.rows.every((row) => row.contentPreserved));
      assert.ok(result.documentWidth <= result.viewport.width + 1);
      if (required) {
        assert.ok(result.rows.every((row) => row.titleCellWidth >= 220));
        assert.ok(
          result.rows.every(
            (row) =>
              row.titleContained && row.cellsContained && row.noClipping && row.stateBadgeContained,
          ),
        );
      }
      return result;
    }
    if (variant === 'baseline') {
      await check('baseline-390-measure-known-readability-deficit', async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        await open();
        await successful();
        const metrics = await measure('baseline-390', false);
        report.baselineReadabilityDeficitObserved = metrics.rows[0].titleCellWidth < 220;
        assert.equal(report.baselineReadabilityDeficitObserved, true);
        await shot('baseline-table-390', rows().first());
        return { negativeReadabilityExpected: true, acceptanceGateTested: false };
      });
      await check('baseline-native-get-and-existing-pagination', async () => {
        await open(filteredPath);
        await successful();
        return await freshNavigation(update(), filteredPath);
      });
    } else {
      const scrollHint =
        '表が画面に収まらない場合は、横にスクロールするとすべての列を確認できます。キーボードでは表にフォーカスして左右矢印キーで移動します。';
      for (const width of [320, 390, 768, 1088, 1280]) {
        await check('readable-table-at-' + width, async () => {
          await page.setViewportSize({ width, height: width >= 768 ? 900 : 844 });
          await open();
          await successful();
          const metrics = await measure('improved-' + width, true);
          assert.equal(await main().getByText(scrollHint, { exact: true }).isVisible(), true);
          assert.ok((await rows().nth(2).innerText()).includes('承認済み・予定未確定'));
          const allText = await rows().first().innerText();
          for (const value of ['09:00', '10:30', '合成担当者', 'SYN-TKT-001', 'SYN-AST-001'])
            assert.ok(allText.includes(value));
          await shot('table-' + width, rows().first());
          return {
            titleCellWidth: metrics.rows[0].titleCellWidth,
            titleLinkHeight: metrics.rows[0].titleLinkHeight,
          };
        });
      }
      await check('long-japanese-and-unbroken-160-full-content', async () => {
        await scenario('long');
        await page.setViewportSize({ width: 390, height: 844 });
        await open();
        await successful();
        await measure('long-text-390', true);
        assert.equal(
          (await rows().nth(1).getByRole('link').innerText()).endsWith('変更計画'.repeat(40)),
          true,
        );
        assert.equal(
          (await rows().nth(2).getByRole('link').innerText()).endsWith('A'.repeat(160)),
          true,
        );
        await shot('long-japanese-390', rows().nth(1));
        await shot('long-unbroken-390', rows().nth(2));
        return { maximumTitleCharacters: 160, fullTextPreserved: true, stateOverlap: false };
      });
      await check('keyboard-local-scroll-right-left-and-visible-focus', async () => {
        await open();
        await successful();
        await tabTo(region());
        assert.equal(await region().getAttribute('tabindex'), '0');
        const max = await region().evaluate((node) => node.scrollWidth - node.clientWidth);
        assert.ok(max > 0);
        step = 'keyboard-scroll-right';
        for (let i = 0; i < 50; i++) {
          const before = await region().evaluate((node) => node.scrollLeft);
          if (before >= max - 1) break;
          await page.keyboard.press('ArrowRight');
          await page.waitForFunction(
            (old) =>
              document.querySelector('[role="region"][aria-label="変更計画一覧"]').scrollLeft > old,
            before,
          );
        }
        await page.waitForFunction(
          (end) =>
            document.querySelector('[role="region"][aria-label="変更計画一覧"]').scrollLeft >=
            end - 1,
          max,
        );
        const relatedVisible = await rows()
          .first()
          .locator('td')
          .nth(3)
          .evaluate((node) => {
            const a = node.getBoundingClientRect(),
              b = node.closest('[role="region"]').getBoundingClientRect();
            return a.left >= b.left - 1 && a.right <= b.right + 1;
          });
        assert.ok(relatedVisible);
        await shot('keyboard-right-related-columns', rows().first().locator('td').nth(3));
        step = 'keyboard-scroll-left';
        for (let i = 0; i < 50; i++) {
          const before = await region().evaluate((node) => node.scrollLeft);
          if (before <= 1) break;
          await page.keyboard.press('ArrowLeft');
          await page.waitForFunction(
            (old) =>
              document.querySelector('[role="region"][aria-label="変更計画一覧"]').scrollLeft < old,
            before,
          );
        }
        await page.waitForFunction(
          () =>
            document.querySelector('[role="region"][aria-label="変更計画一覧"]').scrollLeft <= 1,
        );
        await shot('keyboard-left-title-columns', rows().first().locator('td').first());
        return {
          tabFocusedRegion: true,
          focusVisible: true,
          arrowRightReachedRelatedColumn: true,
          arrowLeftRestoredTitle: true,
          noDocumentOverflow: true,
        };
      });
      await check('detail-link-tab-enter-fixed-readonly-navigation-probe', async () => {
        await open(filteredPath);
        await successful();
        await page.waitForFunction((expected) => {
          const href = document.querySelector('table.tickets tbody a')?.getAttribute('href');
          return href && new URL(href, document.baseURI).searchParams.get('returnTo') === expected;
        }, filteredPath);
        const href = await firstLink().getAttribute('href');
        const url = new URL(href, target);
        assert.equal(url.origin, target.origin);
        assert.match(url.pathname, /^\/changes\/06300000-0000-4000-8000-\d{12}$/);
        assert.equal(url.searchParams.get('returnTo'), filteredPath);
        navigationProbe = async (route) => {
          assert.equal(route.request().method(), 'GET');
          await route.fulfill({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            body: '<!doctype html><html lang="ja"><title>合成ナビゲーション確認</title><main><h1>合成ナビゲーション確認</h1></main></html>',
          });
        };
        // Only this owned context and exact existing detail URL are intercepted; no real detail renderer is exercised.
        navigationProbeMatcher = (candidate) =>
          candidate.origin === url.origin &&
          candidate.pathname === url.pathname &&
          candidate.searchParams.get('returnTo') === filteredPath &&
          [...candidate.searchParams.keys()].every((key) => ['returnTo', '_rsc'].includes(key));
        await context.route(navigationProbeMatcher, navigationProbe);
        await tabTo(firstLink());
        const request = page.waitForRequest(
          (item) => navigationProbeMatcher(new URL(item.url())) && item.method() === 'GET',
        );
        await page.keyboard.press('Enter');
        await request;
        await page.getByRole('heading', { name: '合成ナビゲーション確認', exact: true }).waitFor();
        await context.unroute(navigationProbeMatcher, navigationProbe);
        navigationProbe = null;
        navigationProbeMatcher = null;
        await page.goto(target.origin + filteredPath, { waitUntil: 'networkidle' });
        await successful();
        return {
          keyboard: 'Tab then Enter',
          exactDetailGetObserved: true,
          returnToPreserved: true,
          targetModel: 'readonly browser navigation probe',
          realDetailRendererTested: false,
        };
      });
      await check('canonical-get-pagination-and-jst-regression', async () => {
        await page.setViewportSize({ width: 1280, height: 900 });
        await open(filteredPath);
        await successful();
        assert.equal(
          await page.getByLabel('予定の検索開始（JST）').inputValue(),
          '2026-10-08T09:00',
        );
        assert.equal(
          await page.getByLabel('予定の検索終了（JST）').inputValue(),
          '2026-10-08T10:30',
        );
        const native = await freshNavigation(update(), filteredPath);
        await pager().getByRole('link', { name: '次のページへ', exact: true }).click();
        await page.waitForURL((url) => url.searchParams.get('page') === '3');
        await successful(1);
        await pager().getByRole('link', { name: '前のページへ', exact: true }).click();
        await page.waitForURL(target.origin + filteredPath);
        await successful();
        return { ...native, pages: [25, 1, 25] };
      });
      await check('three-empty-states-retained', async () => {
        for (const [name, mode, path, message] of [
          ['initial', 'empty', '/changes', '表示できる変更はまだありません。'],
          [
            'filtered',
            'empty',
            '/changes?needsPir=1',
            '条件に合う変更はありません。条件を解除するか、検索条件を見直してください。',
          ],
          [
            'current-page',
            'page_empty',
            filteredPath,
            'このページに変更はありません。最初のページへ戻ってください。',
          ],
        ]) {
          await scenario(mode);
          await open(path);
          const notice = main().getByText(message, { exact: true });
          await notice.waitFor();
          assert.equal(await rows().count(), 0);
          await shot('empty-' + name, notice);
          if (name === 'current-page')
            assert.ok(
              await pager().getByRole('link', { name: '最初のページへ', exact: true }).count(),
            );
        }
      });
      await check('css-reflow-half-viewport-observation', async () => {
        await page.setViewportSize({ width: 640, height: 450 });
        await open();
        await successful();
        await measure('css-reflow-640-not-browser-zoom', true);
        await shot('css-reflow-640', rows().first());
        return {
          cssViewport: '640x450 from 1280x900',
          browserZoomTested: false,
          deviceScaleFactor: 1,
        };
      });
      await check('root-font-200-percent-separate-observation', async () => {
        await page.setViewportSize({ width: 1280, height: 900 });
        await open();
        await successful();
        const before = await page.evaluate(() =>
          parseFloat(getComputedStyle(document.documentElement).fontSize),
        );
        await page.evaluate(() => {
          document.documentElement.style.fontSize = '200%';
        });
        const metrics = await measure('root-font-200-percent', true);
        assert.equal(await main().getByText(scrollHint, { exact: true }).isVisible(), true);
        assert.ok(Math.abs(metrics.rootFontPixels - before * 2) < 0.1);
        await shot('root-font-200-percent', rows().first());
        await page.evaluate(() => {
          document.documentElement.style.fontSize = '';
        });
        return {
          baseFontPixels: before,
          enlargedFontPixels: metrics.rootFontPixels,
          browserZoomTested: false,
        };
      });
      await check('failure-and-native-recovery-unchanged', async () => {
        await scenario('503');
        await open(filteredPath);
        await rejected();
        assert.equal(await main().getByRole('alert').innerText(), errorMessages['503']);
        await shot('error-503');
        await scenario('normal');
        return await freshNavigation(retry(), filteredPath);
      });
    }
  } catch {
    report.failureCode = signal?.aborted ? 'CHANGE_UI_ABORTED' : 'CHANGE_UI_RUN_FAILED';
  } finally {
    await cancellation;
    try {
      if (navigationProbe) await context?.unrouteAll({ behavior: 'wait' });
      report.cleanup.navigationProbeRemoved = true;
    } catch {
      report.cleanup.navigationProbeRemoved = false;
    }
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
      report.cleanup.browserClosed &&
      report.cleanup.navigationProbeRemoved;
    writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  }
  if (signal?.aborted) throw new Error('CHANGE_UI_ABORTED');
  return report;
}
