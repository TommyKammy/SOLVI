/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { items, longTitle } from '../evidence/WP-P2-CATLIST-087/20261010/fixture-api.mjs';

export const catalogManagementListCases = Array.from(
  { length: 30 },
  (_, i) => 'C' + String(i + 1).padStart(2, '0'),
);
const listPath = '/catalog/manage';
const createPath = listPath + '/new';
const pathFor = (values = {}) =>
  listPath + (Object.keys(values).length ? '?' + new URLSearchParams(values) : '');
export async function runCatalogManagementListChecks({
  baseURL,
  outputDirectory,
  control,
  observations,
  assertOwned,
  signal,
}) {
  const origin = new URL(baseURL).origin;
  assert.equal(new URL(baseURL).hostname, '127.0.0.1');
  assert.ok(!['', '3000', '3001'].includes(new URL(baseURL).port));
  const report = {
    workPackage: 'WP-P2-CATLIST-087',
    baselineRevision: 'ba0d7b01c0f60295912010416b33b3c8366de6b7',
    success: false,
    checks: [],
    screenshots: [],
    accessibility: [],
    navigation: [],
    network: {
      nonReadCount: 0,
      unknownReads: 0,
      foreign: 0,
      downloads: 0,
      prefetchAttempts: 0,
      prefetchBlocked: 0,
    },
    browserClosed: false,
    contextClosed: false,
  };
  await mkdir(outputDirectory, { recursive: true });
  let browser, context, page, contextClose, browserClose;
  const closeOwned = async () => {
    const results = [];
    if (context)
      results.push(
        ...(await Promise.allSettled([
          (contextClose ??= context.close().then(() => {
            report.contextClosed = true;
          })),
        ])),
      );
    if (browser)
      results.push(
        ...(await Promise.allSettled([
          (browserClose ??= browser.close().then(() => {
            report.browserClosed = true;
          })),
        ])),
      );
    return results;
  };
  const interrupt = () => {
    void closeOwned();
  };
  signal?.addEventListener('abort', interrupt, { once: true });
  const live = async () => {
    assert.ok(!signal?.aborted);
    await assertOwned();
    assert.ok(!signal?.aborted);
  };
  const main = () => page.locator('main');
  const codes = async () => main().locator('.attachment .hint').allTextContents();
  const visible = async (expected) =>
    assert.deepEqual(
      await codes(),
      expected.map((i) => '管理コード: ' + i.code),
    );
  const href = async (label) =>
    main().getByRole('link', { name: label, exact: true }).getAttribute('href');
  const current = () => new URL(page.url());
  const assertQuery = (url, values) =>
    assert.deepEqual(Object.fromEntries(url.searchParams), values);
  const returnToList = async (expected) => {
    await main().getByRole('link', { name: '元の画面へ戻る', exact: true }).click();
    await page.waitForURL(origin + expected);
    await main().getByRole('heading', { name: 'カタログ管理', exact: true }).waitFor();
    await ready();
    const url = current();
    report.navigation.push({
      case: 'C19',
      path: url.pathname,
      q: url.searchParams.get('q'),
      state: url.searchParams.get('state'),
      page: url.searchParams.get('page'),
      parentRetained: url.searchParams.has('returnTo'),
      visibleItems: await main().locator('.attachment').count(),
    });
  };
  const ready = async () => {
    await main().waitFor();
    await main().getByRole('heading', { level: 1 }).first().waitFor();
    if (await main().locator('form').count())
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll('main form')).every((f) => !f.hasAttribute('inert')),
      );
  };
  const open = async (values = {}, settings = {}, width = 1280, raw = null) => {
    await live();
    control(settings);
    if (page) await page.close();
    page = await context.newPage();
    await page.setViewportSize({ width, height: 900 });
    page.on('download', () => report.network.downloads++);
    await page.goto(origin + (raw ?? pathFor(values)), { waitUntil: 'networkidle' });
    await ready();
  };
  const capture = async (id, phase = 'after-assertions') => {
    await live();
    const filename = id + '.png';
    await page.screenshot({ path: join(outputDirectory, filename), fullPage: true });
    const bytes = await readFile(join(outputDirectory, filename));
    report.screenshots.push({
      case: id,
      path: filename,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      phase,
    });
    const a = await new AxeBuilder({ page }).analyze();
    report.accessibility.push({
      case: id,
      violations: a.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })),
      incomplete: a.incomplete.map((v) => ({ id: v.id, nodes: v.nodes.length })),
    });
    assert.equal(a.violations.length, 0);
  };
  const check = async (id, fn) => {
    try {
      await live();
      await fn();
      if (!report.screenshots.some((x) => x.case === id)) await capture(id);
      report.checks.push({ case: id, passed: true });
    } catch (error) {
      report.checks.push({
        case: id,
        passed: false,
        failure:
          error?.name === 'AssertionError'
            ? 'ASSERTION'
            : error?.name === 'TimeoutError'
              ? 'TIMEOUT'
              : 'CHECK_FAILURE',
      });
    }
  };
  const input = () => main().getByRole('searchbox', { name: 'サービスを検索', exact: true });
  const state = () => main().getByRole('combobox', { name: '公開状態', exact: true });
  const noDto = async () => {
    assert.equal(await main().locator('form').count(), 0);
    assert.ok(
      !/PRIVATE_WP087|SpecialTitle|service-0|合成説明|08700000/.test(await main().innerText()),
    );
  };
  try {
    browser = await chromium.launch({ headless: true });
    await live();
    context = await browser.newContext();
    await live();
    const role = async (value) => {
      await context.clearCookies();
      await context.addCookies([{ name: 'solvi_session_wp087_synthetic', value, url: origin }]);
    };
    await role('org_admin');
    await context.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        headers = request.headers();
      const prefetch = Boolean(headers['next-router-prefetch'] || headers.purpose === 'prefetch');
      if (!['GET', 'HEAD'].includes(request.method())) {
        report.network.nonReadCount++;
        if (prefetch) {
          report.network.prefetchAttempts++;
          report.network.prefetchBlocked++;
        }
        return route.abort();
      }
      if (url.origin !== origin) {
        report.network.foreign++;
        return route.abort();
      }
      if (prefetch) {
        report.network.prefetchAttempts++;
        report.network.prefetchBlocked++;
        return route.abort();
      }
      if (
        !url.pathname.startsWith('/_next/') &&
        ![
          listPath,
          createPath,
          '/favicon.ico',
          ...items.map((i) => listPath + '/' + i.id),
        ].includes(url.pathname)
      ) {
        report.network.unknownReads++;
        return route.abort();
      }
      return route.continue();
    });
    await check('C01', async () => {
      await open();
      await visible(items.slice(0, 20));
      assert.ok((await main().innerText()).includes('全43件'));
      for (const text of [
        '非公開 · 下書き版3',
        '公開中（版3） · 下書き版3',
        '公開中（版3） · 下書き版5 · 未公開の変更あり',
      ])
        assert.ok((await main().innerText()).includes(text));
      assert.equal(
        await main().getByRole('link', { name: 'サービスを作成する', exact: true }).count(),
        1,
      );
    });
    for (const [id, q, index] of [
      ['C02', 'specialtitle', 0],
      ['C03', 'descriptionneedle', 1],
      ['C04', 'SERVICE-003', 2],
      ['C05', '%_.*', 2],
    ])
      await check(id, async () => {
        await open({ q });
        await visible([items[index]]);
      });
    for (const [id, value] of [
      ['C06', 'published'],
      ['C07', 'unpublished'],
      ['C08', 'changed'],
    ])
      await check(id, async () => {
        await open({ state: value });
        await visible(
          items
            .filter((i) =>
              value === 'published'
                ? i.active
                : value === 'unpublished'
                  ? !i.active
                  : i.active && i.draftRevision !== i.publishedRevision,
            )
            .slice(0, 20),
        );
        assert.equal(await state().inputValue(), value);
      });
    await check('C09', async () => {
      await open({ q: 'service-003', state: 'changed' });
      await visible([items[2]]);
    });
    await check('C10', async () => {
      await open({ q: '  SpecialTitle  ' });
      assert.equal(await input().inputValue(), 'SpecialTitle');
      await visible([items[0]]);
      await open({ q: 'a'.repeat(99) + '😀' });
      assert.equal(await input().inputValue(), 'a'.repeat(99));
      const target = new URL(await href('サービスを作成する'), origin);
      assert.equal(
        new URL(target.searchParams.get('returnTo'), origin).searchParams.get('q'),
        'a'.repeat(99),
      );
    });
    await check('C11', async () => {
      await open(
        {},
        {},
        1280,
        listPath + '?q=a&q=b&state=published&state=changed&page=2&page=3&unknown=PRIVATE&saved=1',
      );
      assert.equal(await input().inputValue(), '');
      assert.equal(await state().inputValue(), 'all');
      await visible(items.slice(0, 20));
      assertQuery(new URL(await href('サービスを作成する'), origin), { returnTo: listPath });
    });
    await check('C12', async () => {
      await open({
        state: 'inactive',
        page: '-1',
        returnTo: 'https://outside.invalid',
        unknown: 'PRIVATE',
      });
      await visible(items.slice(0, 20));
      assert.equal(await state().inputValue(), 'all');
      assert.equal(await main().locator('[name="returnTo"]').count(), 0);
      assertQuery(new URL(await href('サービスを作成する'), origin), { returnTo: listPath });
    });
    await check('C13', async () => {
      await open({ q: 'service', page: '2', returnTo: '/catalog' });
      await visible(items.slice(20, 40));
      assertQuery(new URL(await href('前のページ'), origin), {
        q: 'service',
        returnTo: '/catalog',
      });
      assertQuery(new URL(await href('次のページ'), origin), {
        q: 'service',
        page: '3',
        returnTo: '/catalog',
      });
      await main().getByRole('link', { name: '次のページ', exact: true }).click();
      await ready();
      await visible(items.slice(40));
      await main().getByRole('link', { name: '前のページ', exact: true }).click();
      await ready();
      await visible(items.slice(20, 40));
    });
    await check('C14', async () => {
      await open({ page: '3' });
      await visible(items.slice(40));
      assert.equal(await main().getByRole('link', { name: '次のページ', exact: true }).count(), 0);
    });
    await check('C15', async () => {
      await open({ q: 'service', page: '100000', returnTo: '/catalog' });
      await visible([]);
      assert.ok((await main().innerText()).includes('このページにサービスがありません'));
      await capture('C15', 'empty-current-page');
      await main().getByRole('link', { name: '先頭ページへ戻る', exact: true }).click();
      await ready();
      await visible(items.slice(0, 20));
      assertQuery(current(), { q: 'service', returnTo: '/catalog' });
    });
    await check('C16', async () => {
      await open({ q: 'not-found', state: 'changed', returnTo: '/catalog' });
      await visible([]);
      assert.ok((await main().innerText()).includes('条件に一致するサービスがありません'));
      await capture('C16', 'filtered-empty');
      await main().getByRole('link', { name: '条件をクリアする', exact: true }).click();
      await ready();
      await visible(items.slice(0, 20));
      assertQuery(current(), { returnTo: '/catalog' });
    });
    await check('C17', async () => {
      await open({}, { empty: true });
      await visible([]);
      assert.ok(
        (await main().innerText()).includes(
          'まだサービスがありません。最初の下書きを作成してください。',
        ),
      );
    });
    await check('C18', async () => {
      await open({ page: '2', returnTo: '/catalog' });
      await input().fill('SpecialTitle');
      await main().getByRole('button', { name: '条件を適用する', exact: true }).click();
      await ready();
      await visible([items[0]]);
      assertQuery(current(), { q: 'SpecialTitle', state: 'all', returnTo: '/catalog' });
      assert.equal(await main().locator('[name="page"]').count(), 0);
    });
    await check('C19', async () => {
      const normal = { q: 'service', page: '2', returnTo: '/catalog' };
      await open({ ...normal, unknown: 'PRIVATE' });
      let target = main().locator('.attachment h2 a').first();
      let back = new URL(await target.getAttribute('href'), origin).searchParams.get('returnTo');
      assert.equal(back, pathFor(normal));
      await target.click();
      await ready();
      assert.equal(await href('元の画面へ戻る'), back);
      await returnToList(back);
      await visible(items.slice(20, 40));
      assertQuery(current(), normal);
      await open({ q: 'service', page: '2', returnTo: '/catalog?q=' + 'a'.repeat(1980) });
      target = main().locator('.attachment h2 a').first();
      back = new URL(await target.getAttribute('href'), origin).searchParams.get('returnTo');
      assert.equal(back, pathFor({ q: 'service', page: '2' }));
      await target.click();
      await ready();
      assert.equal(await href('元の画面へ戻る'), back);
      await returnToList(back);
      await visible(items.slice(20, 40));
      assertQuery(current(), { q: 'service', page: '2' });
    });
    await check('C20', async () => {
      await open({
        q: '合成',
        state: 'changed',
        page: '2',
        returnTo: '/catalog',
        saved: '1',
        unknown: 'PRIVATE',
      });
      const target = new URL(await href('サービスを作成する'), origin);
      assert.equal(target.pathname, createPath);
      assert.equal(
        target.searchParams.get('returnTo'),
        pathFor({ q: '合成', state: 'changed', page: '2', returnTo: '/catalog' }),
      );
      await main().getByRole('link', { name: 'サービスを作成する', exact: true }).click();
      await ready();
      assert.equal(current().pathname, createPath);
    });
    for (const [id, status] of [
      ['C21', 400],
      ['C22', 401],
      ['C23', 503],
    ])
      await check(id, async () => {
        const values = { q: '合成', state: 'changed', page: '2', returnTo: '/catalog' };
        await open({ ...values, unknown: 'PRIVATE', saved: '1' }, { status });
        await noDto();
        assert.equal(await href('再取得する'), pathFor(values));
        assert.ok(
          (await main().getByRole('alert').innerText()).includes(
            status === 400
              ? '元の画面やカタログから開き直してください'
              : status === 401
                ? 'ログインし直してから'
                : '時間をおいて',
          ),
        );
        await capture(id, 'read-failure');
        const before = observations().managementReads;
        control({});
        await main().getByRole('link', { name: '再取得する', exact: true }).click();
        await ready();
        assertQuery(current(), values);
        assert.ok(observations().managementReads > before);
        assert.equal(
          await main().getByRole('heading', { name: 'カタログ管理', exact: true }).count(),
          1,
        );
        assert.equal(
          await main().getByRole('form', { name: 'カタログの表示条件', exact: true }).count(),
          1,
        );
        assert.equal(await main().getByRole('alert').count(), 0);
        assert.ok(
          (await main().getByRole('status').innerText()).includes('条件に一致するサービス14件'),
        );
        assert.ok((await main().innerText()).includes('このページにサービスがありません'));
      });
    for (const [id, status] of [
      ['C24', 403],
      ['C25', 404],
    ])
      await check(id, async () => {
        await open({}, { status });
        await noDto();
        assert.ok((await main().innerText()).includes('見つかりません'));
      });
    for (const [id, value] of [
      ['C26', 'org_admin'],
      ['C27', 'platform_admin'],
    ])
      await check(id, async () => {
        await role(value);
        const before = observations().managementReads;
        await open();
        await visible(items.slice(0, 20));
        assert.ok(observations().managementReads > before);
        assert.equal(
          observations()
            .requests.filter((r) => r.path === '/catalog-admin')
            .at(-1).role,
          value,
        );
      });
    await check('C28', async () => {
      await open();
      await input().focus();
      await page.keyboard.press('Tab');
      assert.equal(await state().evaluate((e) => e === document.activeElement), true);
      const focus = await state().evaluate((e) => {
        const s = getComputedStyle(e);
        return { width: parseFloat(s.outlineWidth), style: s.outlineStyle, shadow: s.boxShadow };
      });
      assert.ok((focus.width > 0 && focus.style !== 'none') || focus.shadow !== 'none');
      await page.keyboard.press('Shift+Tab');
      await input().fill('SpecialTitle');
      await capture('C28', 'keyboard-focus-before-enter');
      await page.keyboard.press('Enter');
      await ready();
      await visible([items[0]]);
    });
    for (const [id, width] of [
      ['C29', 1280],
      ['C30', 390],
    ])
      await check(id, async () => {
        await open({}, { long: true }, width);
        assert.ok((await main().locator('.attachment h2').first().innerText()).includes(longTitle));
        assert.equal(await main().locator('.attachment').count(), 20);
        const sizes = await page.evaluate(() => ({
          viewport: document.documentElement.clientWidth,
          scroll: document.documentElement.scrollWidth,
        }));
        assert.ok(sizes.scroll <= sizes.viewport);
        assert.equal(
          await main().getByRole('button', { name: '条件を適用する', exact: true }).isVisible(),
          true,
        );
      });
    assert.deepEqual(
      report.checks.map((x) => x.case),
      catalogManagementListCases,
    );
    assert.equal(observations().unexpectedMutations, 0);
    assert.equal(observations().unknownReads, 0);
    assert.ok(report.network.prefetchAttempts === report.network.prefetchBlocked);
    for (const key of ['nonReadCount', 'unknownReads', 'foreign', 'downloads'])
      assert.equal(report.network[key], 0);
    report.success =
      report.checks.length === 30 &&
      report.checks.every((x) => x.passed) &&
      report.screenshots.length === 30 &&
      report.accessibility.length === 30;
  } catch {
    report.success = false;
  } finally {
    report.closeResults = (await closeOwned()).map((x) => x.status);
    signal?.removeEventListener('abort', interrupt);
    if (!report.browserClosed || !report.contextClosed || signal?.aborted) report.success = false;
    await writeFile(join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  }
  return report;
}
