/* global document, window */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import {
  items,
  longName,
  creation,
  toggleId,
} from '../evidence/WP-P2-GRPLIST-089/20261010/fixture-api.mjs';

export const groupManagementListCases = Array.from(
  { length: 26 },
  (_, i) => 'C' + String(i + 1).padStart(2, '0'),
);
const listPath = '/ops/groups';
const pathFor = (values = {}) =>
  listPath + (Object.keys(values).length ? '?' + new URLSearchParams(values) : '');
export async function runGroupManagementListChecks({
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
    workPackage: 'WP-P2-GRPLIST-089',
    baselineRevision: 'f61fd26b858f382affb6fdf5a93301755c617ce7',
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
      allowedWrites: [],
    },
    browserClosed: false,
    contextClosed: false,
  };
  await mkdir(outputDirectory, { recursive: true });
  let browser, context, page, contextClose, browserClose, currentCase;
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
  const codes = () => main().locator('.group-code').allTextContents();
  const visible = async (expected) =>
    assert.deepEqual(
      await codes(),
      expected.map((i) => i.code),
    );
  const input = () => main().getByRole('searchbox', { name: 'グループを検索', exact: true });
  const state = () => main().getByRole('combobox', { name: '運用状態', exact: true });
  const href = (label) =>
    main().getByRole('link', { name: label, exact: true }).getAttribute('href');
  const current = () => new URL(page.url());
  const assertQuery = (url, values) =>
    assert.deepEqual(Object.fromEntries(url.searchParams), values);
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
  const capture = async (id) => {
    await live();
    const filename = id + '.png';
    await page.screenshot({ path: join(outputDirectory, filename), fullPage: true });
    report.screenshots.push({
      case: id,
      path: filename,
      sha256: createHash('sha256')
        .update(await readFile(join(outputDirectory, filename)))
        .digest('hex'),
    });
    const a = await new AxeBuilder({ page }).analyze();
    report.accessibility.push({
      case: id,
      violations: a.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })),
      incomplete: a.incomplete.map((v) => ({ id: v.id, nodes: v.nodes.length })),
    });
    assert.equal(a.violations.length, 0);
    assert.equal(a.incomplete.length, 0);
  };
  const check = async (id, fn) => {
    currentCase = id;
    try {
      await live();
      await fn();
      await capture(id);
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
  const noDto = async () => {
    assert.equal(await main().locator('form').count(), 0);
    assert.ok(
      !/PRIVATE_WP089|SpecialName|group-0|合成説明|08900000/.test(await main().innerText()),
    );
  };
  const retry = async (values) => {
    const before = observations().managementReads;
    assertQuery(new URL(await href('もう一度取得する'), origin), values);
    control({});
    await main().getByRole('link', { name: 'もう一度取得する', exact: true }).click();
    await main().getByRole('searchbox', { name: 'グループを検索', exact: true }).waitFor();
    await ready();
    assert.ok(observations().managementReads > before);
    assertQuery(current(), values);
  };
  try {
    browser = await chromium.launch({ headless: true });
    await live();
    context = await browser.newContext();
    await live();
    const role = async (value) => {
      await context.clearCookies();
      await context.addCookies([{ name: 'solvi_session_wp089_synthetic', value, url: origin }]);
    };
    await role('org_admin');
    await context.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        headers = request.headers();
      const prefetch = Boolean(headers['next-router-prefetch'] || headers.purpose === 'prefetch');
      if (!['GET', 'HEAD'].includes(request.method())) {
        if (
          request.method() === 'POST' &&
          currentCase === 'C23' &&
          url.origin === origin &&
          url.pathname === listPath &&
          !prefetch &&
          report.network.allowedWrites.length < 3
        ) {
          report.network.allowedWrites.push({
            index: report.network.allowedWrites.length,
            method: 'POST',
            path: url.pathname,
            query: url.search,
          });
          return route.continue();
        }
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
        ![listPath, '/favicon.ico', ...items.map((i) => listPath + '/' + i.id)].includes(
          url.pathname,
        )
      ) {
        report.network.unknownReads++;
        return route.abort();
      }
      return route.continue();
    });
    await check('C01', async () => {
      await open();
      await visible(items.slice(0, 25));
      const text = await main().innerText();
      assert.ok(
        text.includes('全53件') &&
          text.includes('1〜25件を表示') &&
          text.includes('運用から外れています') &&
          text.includes('4人'),
      );
      assert.equal(await main().getByRole('button', { name: '作成する', exact: true }).count(), 1);
      assert.equal(await main().locator('.groups form').count(), 25);
    });
    for (const [id, q, index] of [
      ['C02', 'specialname', 0],
      ['C03', 'GROUP-002', 1],
      ['C04', 'descriptionneedle', 1],
    ])
      await check(id, async () => {
        await open({ q });
        await visible([items[index]]);
        if (id === 'C04') {
          await open({ q: '%_.*' });
          await visible([items[2]]);
        }
      });
    for (const [id, value] of [
      ['C05', 'active'],
      ['C06', 'inactive'],
    ])
      await check(id, async () => {
        await open({ state: value });
        await visible(
          items.filter((i) => (value === 'active' ? i.active : !i.active)).slice(0, 25),
        );
        assert.equal(await state().inputValue(), value);
      });
    await check('C07', async () => {
      await open({ q: '  group-002  ', state: 'active' });
      await visible([items[1]]);
      assert.equal(await input().inputValue(), 'group-002');
      await open({ q: 'a'.repeat(199) + '😀' });
      assert.equal(await input().inputValue(), 'a'.repeat(199));
      await open({ q: 'a'.repeat(198) + '😀' });
      assert.equal(await input().inputValue(), 'a'.repeat(198) + '😀');
    });
    await check('C08', async () => {
      await open(
        {},
        {},
        1280,
        listPath +
          '?q=a&q=b&state=active&state=inactive&page=2&page=3&returnTo=%2Fops&returnTo=%2Fassets&unknown=PRIVATE&notice=x&error=x',
      );
      await visible(items.slice(0, 25));
      assert.equal(await input().inputValue(), '');
      assert.equal(await state().inputValue(), 'all');
      const detail = new URL(
        await main()
          .getByRole('link', { name: 'メンバーを見る', exact: true })
          .first()
          .getAttribute('href'),
        origin,
      );
      assert.equal(detail.searchParams.get('returnTo'), listPath);
      await open({ returnTo: 'https://outside.invalid', unknown: 'PRIVATE' });
      assert.equal(await main().locator('input[name="returnTo"]').count(), 0);
    });
    await check('C09', async () => {
      await open({ state: 'published', page: '01' });
      await visible(items.slice(0, 25));
      assert.equal(await state().inputValue(), 'all');
      assert.ok((await main().innerText()).includes('1ページ目'));
    });
    await check('C10', async () => {
      await open({ page: '2', returnTo: '/ops' });
      await visible(items.slice(25, 50));
      assertQuery(new URL(await href('前のページ'), origin), { returnTo: '/ops' });
      assertQuery(new URL(await href('次のページ'), origin), { page: '3', returnTo: '/ops' });
      await main().getByRole('link', { name: '次のページ', exact: true }).click();
      await page.waitForURL(origin + pathFor({ page: '3', returnTo: '/ops' }));
      await ready();
      await visible(items.slice(50));
      assert.equal(await main().getByRole('link', { name: '次のページ', exact: true }).count(), 0);
    });
    await check('C11', async () => {
      await open({ q: '合成', page: '100000', returnTo: '/ops' });
      assert.ok((await main().innerText()).includes('このページにグループがありません'));
      assertQuery(new URL(await href('先頭ページへ戻る'), origin), { q: '合成', returnTo: '/ops' });
      await main().getByRole('link', { name: '先頭ページへ戻る', exact: true }).click();
      await page.waitForURL(origin + pathFor({ q: '合成', returnTo: '/ops' }));
      await ready();
      await visible(items.slice(0, 25));
    });
    await check('C12', async () => {
      await open({ q: 'missing', state: 'active', returnTo: '/ops' });
      assert.ok((await main().innerText()).includes('条件に一致するグループがありません'));
      assertQuery(new URL(await href('条件をクリア'), origin), { returnTo: '/ops' });
      await main().getByRole('link', { name: '条件をクリア', exact: true }).click();
      await page.waitForURL(origin + pathFor({ returnTo: '/ops' }));
      await ready();
      await visible(items.slice(0, 25));
    });
    await check('C13', async () => {
      await open({}, { empty: true });
      assert.ok((await main().innerText()).includes('まだグループがありません'));
      assert.equal(await main().getByRole('button', { name: '作成する', exact: true }).count(), 1);
    });
    await check('C14', async () => {
      await open({ q: '合成', page: '2', returnTo: '/ops?q=親' });
      await input().fill('SpecialName');
      await state().selectOption('inactive');
      await main().getByRole('button', { name: '条件を適用', exact: true }).click();
      await page.waitForURL((u) => u.searchParams.get('q') === 'SpecialName');
      await ready();
      assertQuery(current(), { returnTo: '/ops?q=%E8%A6%AA', q: 'SpecialName', state: 'inactive' });
      await visible([items[0]]);
    });
    await check('C15', async () => {
      for (const parent of ['/ops?q=親', '/ops?q=' + 'a'.repeat(1950)]) {
        await open({ q: '合成', page: '2', returnTo: parent, unknown: 'PRIVATE', error: 'flash' });
        const canonicalParent = parent.startsWith('/ops?q=親') ? '/ops?q=%E8%A6%AA' : null;
        const expected = pathFor({
          q: '合成',
          page: '2',
          ...(canonicalParent ? { returnTo: canonicalParent } : {}),
        });
        const link = main().getByRole('link', { name: 'メンバーを見る', exact: true }).first();
        assert.equal(
          new URL(await link.getAttribute('href'), origin).searchParams.get('returnTo'),
          expected,
        );
        const detailUrl = await link.getAttribute('href');
        await link.click();
        await page.waitForURL(origin + detailUrl);
        await main()
          .getByRole('heading', { name: items[25].name + ' のメンバー', exact: true })
          .waitFor();
        await ready();
        await main().getByRole('link', { name: '元の画面へ戻る', exact: true }).click();
        await page.waitForURL(origin + expected);
        await main().getByRole('heading', { name: '担当グループの管理', exact: true }).waitFor();
        await ready();
        await visible(items.slice(25, 50));
        report.navigation.push({
          case: 'C15',
          query: Object.fromEntries(current().searchParams),
          visibleItems: await main().locator('.group-code').count(),
        });
      }
    });
    for (const [id, status] of [
      ['C16', 400],
      ['C17', 401],
      ['C18', 503],
    ])
      await check(id, async () => {
        const values = { q: '合成', state: 'active', page: '2', returnTo: '/ops' };
        await open({ ...values, unknown: 'PRIVATE', error: 'PRIVATE' }, { status });
        await noDto();
        assert.ok((await main().innerText()).includes('担当グループを取得できませんでした'));
        await retry(values);
        await visible(items.filter((i) => i.active).slice(25));
      });
    for (const [id, status] of [
      ['C19', 403],
      ['C20', 404],
    ])
      await check(id, async () => {
        await open({}, { status });
        await noDto();
        assert.equal(
          await main().getByRole('link', { name: 'もう一度取得する', exact: true }).count(),
          0,
        );
        assert.ok(
          (await main().innerText()).includes(
            status === 403 ? 'この画面を表示する権限がありません' : '担当グループを表示できません',
          ),
        );
      });
    await check('C21', async () => {
      await role('agent');
      const before = observations().managementReads;
      await open();
      await noDto();
      assert.ok((await main().innerText()).includes('この画面を表示する権限がありません'));
      assert.equal(observations().managementReads, before);
      await role('org_admin');
    });
    await check('C22', async () => {
      await role('platform_admin');
      await open();
      await visible(items.slice(0, 25));
      assert.equal(
        observations()
          .requests.filter((r) => r.path === '/groups')
          .at(-1).role,
        'platform_admin',
      );
      await role('org_admin');
    });
    await check('C23', async () => {
      const values = { q: '合成', page: '2', returnTo: '/ops' };
      await open(values);
      const submit = async (button, index) => {
        const before = observations().managementReads;
        await Promise.all([
          page.waitForResponse(
            (r) => r.request().method() === 'POST' && new URL(r.url()).origin === origin,
          ),
          button.click(),
        ]);
        await page.waitForLoadState('networkidle');
        await ready();
        assert.equal(observations().writes.length, index + 1);
        assert.ok(observations().managementReads > before);
        assert.equal(observations().writes[index].bodyValid, true);
        assert.equal(observations().writes[index].completed, true);
        assertQuery(current(), values);
      };
      await main().getByRole('textbox', { name: '名前', exact: true }).fill(creation.name);
      await main().getByRole('textbox', { name: '記号', exact: true }).fill(creation.code);
      await main()
        .getByRole('textbox', { name: '説明(任意)', exact: true })
        .fill(creation.description);
      await submit(main().getByRole('button', { name: '作成する', exact: true }), 0);
      const row = () =>
        main()
          .locator('li.group')
          .filter({
            has: page
              .locator('.group-code')
              .filter({ hasText: items.find((i) => i.id === toggleId).code }),
          });
      await submit(row().getByRole('button', { name: '運用から外す', exact: true }), 1);
      await row().getByRole('button', { name: '運用に戻す', exact: true }).waitFor();
      await submit(row().getByRole('button', { name: '運用に戻す', exact: true }), 2);
      await row().getByRole('button', { name: '運用から外す', exact: true }).waitFor();
      assert.deepEqual(
        observations().writes.map((w) => w.status),
        [201, 204, 204],
      );
    });
    await check('C24', async () => {
      await open({}, { long: true }, 390);
      assert.ok((await main().locator('li.group strong').first().innerText()).includes(longName));
      await input().focus();
      await page.keyboard.press('Tab');
      assert.equal(await state().evaluate((e) => e === document.activeElement), true);
      const focus = await state().evaluate((e) => {
        const s = window.getComputedStyle(e);
        return { width: parseFloat(s.outlineWidth), style: s.outlineStyle, shadow: s.boxShadow };
      });
      assert.ok((focus.width > 0 && focus.style !== 'none') || focus.shadow !== 'none');
      const sizes = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
      }));
      assert.ok(sizes.scroll <= sizes.viewport);
      await page.keyboard.press('Shift+Tab');
      await input().fill('group-002');
      await page.keyboard.press('Enter');
      await page.waitForURL((u) => u.searchParams.get('q') === 'group-002');
      await ready();
      assert.equal(await main().locator('.group-code').count(), 1);
    });
    for (const [id, settings] of [
      ['C25', { malformed: true }],
      ['C26', { get204: true }],
    ])
      await check(id, async () => {
        const values = { q: '合成', page: '2', returnTo: '/ops' };
        await open(values, settings);
        await noDto();
        assert.ok((await main().innerText()).includes('担当グループを取得できませんでした'));
        await retry(values);
        assert.equal(await main().locator('.group-code').count(), 25);
      });
    assert.deepEqual(
      report.checks.map((x) => x.case),
      groupManagementListCases,
    );
    assert.equal(observations().unexpectedMutations, 0);
    assert.equal(observations().unknownReads, 0);
    assert.equal(report.network.allowedWrites.length, 3);
    assert.equal(report.network.prefetchAttempts, report.network.prefetchBlocked);
    for (const key of ['nonReadCount', 'unknownReads', 'foreign', 'downloads'])
      assert.equal(report.network[key], 0);
    report.success =
      report.checks.length === 26 &&
      report.checks.every((x) => x.passed) &&
      report.screenshots.length === 26 &&
      report.accessibility.length === 26;
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
