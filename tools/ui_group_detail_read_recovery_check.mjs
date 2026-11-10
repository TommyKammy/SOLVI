/* global document, window */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import {
  people,
  baseMembers,
  groupId,
  longName,
} from '../evidence/WP-P2-GRPREAD-091/20261010/fixture-api.mjs';

export const groupDetailReadRecoveryCases = Array.from(
  { length: 20 },
  (_, i) => 'C' + String(i + 1).padStart(2, '0'),
);
const detailPath = '/ops/groups/' + groupId;
const pathFor = (values = {}) =>
  detailPath + (Object.keys(values).length ? '?' + new URLSearchParams(values) : '');
const memberLabel = 'メンバーを再取得する';
const peopleLabel = '在籍者候補を再取得する';
const memberAlert = 'メンバーを取得できませんでした。再読み込みしてください。';
const peopleAlert = '在籍者候補を取得できないため追加できません。再読み込みしてください。';
const parent = '/ops/groups?q=group&state=active&page=2';
const conditions = { q: '合成', filter: 'available', page: '2', returnTo: parent };

export async function runGroupDetailReadRecoveryChecks({
  baseURL,
  outputDirectory,
  control,
  observations,
  assertOwned,
  signal,
  onStage = () => {},
}) {
  const origin = new URL(baseURL).origin;
  assert.equal(new URL(baseURL).hostname, '127.0.0.1');
  assert.ok(!['', '3000', '3001'].includes(new URL(baseURL).port));
  const report = {
    workPackage: 'WP-P2-GRPREAD-091',
    baselineRevision: '619d3d1af6e9cf7f84163ba6066fce333694412c',
    success: false,
    checks: [],
    screenshots: [],
    accessibility: [],
    navigation: [],
    details: [],
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
    onStage('browser-context-close');
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
  const link = (label) => main().getByRole('link', { name: label, exact: true });
  const selection = () => main().getByRole('combobox', { name: '追加する在籍者', exact: true });
  const ready = async () => {
    await page.locator('h1').first().waitFor();
    if (await main().locator('form').count())
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll('main form')).every((f) => !f.hasAttribute('inert')),
      );
  };
  const open = async (values = {}, settings = {}, width = 1280, role = 'org_admin', raw = null) => {
    await live();
    control(settings);
    await context.clearCookies();
    await context.addCookies([{ name: 'solvi_session_wp091_synthetic', value: role, url: origin }]);
    if (page) {
      onStage(currentCase + '-page-close');
      await page.close();
      onStage(currentCase);
    }
    page = await context.newPage();
    await page.setViewportSize({ width, height: 900 });
    page.on('download', () => report.network.downloads++);
    await page.goto(origin + (raw ?? pathFor(values)), { waitUntil: 'networkidle' });
    await ready();
  };
  const closed = async () => {
    assert.equal(await selection().isDisabled(), true);
    assert.equal(
      await main()
        .getByRole('button', { name: '選んだ在籍者を追加する', exact: true })
        .isDisabled(),
      true,
    );
    const text = await main().innerText();
    assert.ok(!/追加可能 \d|検索結果 \d|このページに在籍者|この組織の在籍者が居ません/.test(text));
    assert.equal(await main().getByRole('navigation', { name: '在籍者候補のページ' }).count(), 0);
    assert.ok(!text.includes('PRIVATE_WP091_PROBLEM') && !text.includes('PRIVATE_WP091_DETAIL'));
  };
  const alert = async (label) =>
    assert.equal(await main().getByRole('alert').filter({ hasText: label }).innerText(), label);
  const memberFailure = async () => {
    assert.equal(
      await main().getByRole('heading', { name: '現在のメンバー', exact: true }).count(),
      1,
    );
    assert.ok(!(await main().innerText()).includes('現在のメンバー ·'));
    assert.ok(!(await main().innerText()).includes('メンバーが居ません'));
    await alert(memberAlert);
    await closed();
  };
  const candidateFailure = async () => {
    assert.equal(
      await main().getByRole('heading', { name: '現在のメンバー · 20人', exact: true }).count(),
      1,
    );
    assert.equal(await main().locator('ul.groups > li').count(), baseMembers.length);
    assert.equal(
      await main().getByRole('button', { name: 'このグループから外す', exact: true }).count(),
      baseMembers.length,
    );
    assert.ok((await main().innerText()).includes('在籍状態を取得できません'));
    assert.equal(
      await main().locator('time[datetime="2026-10-10T00:00:00Z"]').count(),
      baseMembers.length,
    );
    await alert(peopleAlert);
    await closed();
  };
  const retryHref = async (label, expected) => {
    assert.equal(await link(label).getAttribute('href'), expected);
    assert.ok(
      (await link(label).locator('..').innerText()).includes(
        '検索条件を保ったまま、もう一度読み込めます。',
      ),
    );
  };
  const capture = async (id) => {
    await live();
    const filename = id + '.png';
    await page.screenshot({ path: join(outputDirectory, filename), fullPage: true });
    const pixels = await readFile(join(outputDirectory, filename));
    assert.deepEqual([...pixels.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    report.screenshots.push({
      case: id,
      path: filename,
      sha256: createHash('sha256').update(pixels).digest('hex'),
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
    onStage(id);
    const entry = { case: id, passed: false };
    report.checks.push(entry);
    await live();
    await fn();
    await capture(id);
    entry.passed = true;
  };
  const retry = async (label, values, keyboard = false) => {
    const before = observations();
    control();
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().isNavigationRequest() &&
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === detailPath,
      { timeout: 30000 },
    );
    if (keyboard) await page.keyboard.press('Enter');
    else await link(label).click();
    const response = await responsePromise;
    assert.equal(response.status(), 200);
    assert.equal(await response.finished(), null);
    await page.waitForLoadState('networkidle', { timeout: 30000 });
    await ready();
    assert.equal(new URL(page.url()).pathname, detailPath);
    assert.deepEqual(Object.fromEntries(new URL(page.url()).searchParams), values);
    const after = observations();
    const delta = {
      groups: after.managementReads - before.managementReads,
      members: after.memberReads - before.memberReads,
      people: after.peopleReads - before.peopleReads,
    };
    assert.deepEqual(delta, { groups: 1, members: 1, people: 1 });
    assert.equal(after.writes.length, 0);
    assert.equal(
      await main().getByRole('heading', { name: '現在のメンバー · 20人', exact: true }).count(),
      1,
    );
    assert.equal((await link(memberLabel).count()) + (await link(peopleLabel).count()), 0);
    assert.equal(await selection().isDisabled(), false);
    report.details.push({
      case: currentCase,
      nativeGetComplete: true,
      status: 200,
      preserved: values,
      delta,
    });
  };
  const keyboardRetry = async (label) => {
    let tabs = 0;
    while (!(await link(label).evaluate((el) => el === document.activeElement)) && tabs < 80) {
      await page.keyboard.press('Tab');
      tabs++;
    }
    assert.ok(tabs > 0 && tabs < 80);
    const visible = await link(label).evaluate((el) => {
      const s = window.getComputedStyle(el);
      return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0;
    });
    assert.equal(visible, true);
    report.details.push({ case: currentCase, keyboard: true, tabs, focusVisible: visible });
    await retry(label, conditions, true);
  };
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      const headers = request.headers();
      if (
        headers['next-router-prefetch'] ||
        headers['purpose'] === 'prefetch' ||
        headers['sec-purpose']?.includes('prefetch')
      ) {
        report.network.prefetchAttempts++;
        report.network.prefetchBlocked++;
        return route.abort();
      }
      if (url.origin !== origin) {
        report.network.foreign++;
        return route.abort();
      }
      if (request.method() !== 'GET') {
        report.network.nonReadCount++;
        return route.abort();
      }
      if (!(
        url.pathname === detailPath ||
        url.pathname.startsWith('/_next/static/') ||
        url.pathname === '/favicon.ico'
      )) {
        report.network.unknownReads++;
        return route.abort();
      }
      return route.continue();
    });
    context.on('request', (request) => {
      if (request.isNavigationRequest() && request.method() === 'GET') {
        const url = new URL(request.url());
        report.navigation.push({
          case: currentCase,
          method: request.method(),
          path: url.pathname,
          query: url.search,
        });
      }
    });
    await check('C01', async () => {
      await open({}, { memberStatus: 503 });
      await memberFailure();
      await retryHref(memberLabel, detailPath);
    });
    await check('C02', async () => {
      await open({}, { peopleStatus: 503 });
      await candidateFailure();
      await retryHref(peopleLabel, detailPath);
    });
    await check('C03', async () => {
      await open({}, { memberStatus: 503, peopleStatus: 503 });
      await memberFailure();
      await alert(peopleAlert);
      await retryHref(memberLabel, detailPath);
      await retryHref(peopleLabel, detailPath);
    });
    await check('C04', async () => {
      await open({}, { memberStatus: 403 });
      await memberFailure();
      await retryHref(memberLabel, detailPath);
    });
    await check('C05', async () => {
      await open({}, { peopleStatus: 403 });
      await candidateFailure();
      await retryHref(peopleLabel, detailPath);
    });
    await check('C06', async () => {
      await open(
        { ...conditions, notice: 'added', error: 'flash', unknown: 'private' },
        { memberStatus: 503 },
      );
      await retryHref(memberLabel, pathFor(conditions));
    });
    await check('C07', async () => {
      await open(
        {},
        { memberStatus: 503 },
        1280,
        'org_admin',
        detailPath +
          '?q=a&q=b&filter=available&filter=all&page=2&page=3&returnTo=%2Fops&returnTo=%2Fops%2Fgroups',
      );
      await retryHref(memberLabel, detailPath);
    });
    await check('C08', async () => {
      await open(
        { q: '%_.*', filter: 'active', page: '01', returnTo: 'https://outside.invalid' },
        { memberStatus: 503 },
      );
      await retryHref(memberLabel, pathFor({ q: '%_.*' }));
      await open({ page: '100000' }, { memberStatus: 503 });
      await retryHref(memberLabel, pathFor({ page: '100000' }));
    });
    await check('C09', async () => {
      await open();
      assert.equal(await main().locator('ul.groups > li').count(), 20);
      const rows = await selection()
        .locator('option')
        .evaluateAll((opts) => opts.map((o) => o.value));
      assert.deepEqual(rows, ['', ...people.slice(0, 25).map((p) => p.userId)]);
      assert.ok((await main().innerText()).includes('person0@example.invalid'));
      assert.ok((await main().innerText()).includes('現在この組織に在籍'));
      assert.equal((await link(memberLabel).count()) + (await link(peopleLabel).count()), 0);
    });
    await check('C10', async () => {
      await open({}, { emptyMembers: true });
      assert.ok((await main().innerText()).includes('現在のメンバー · 0人'));
      assert.ok((await main().innerText()).includes('メンバーが居ません'));
      assert.equal((await link(memberLabel).count()) + (await link(peopleLabel).count()), 0);
    });
    await check('C11', async () => {
      await open({}, { inactive: true });
      assert.ok((await main().innerText()).includes('このグループは無効です。'));
      assert.equal(await selection().isDisabled(), true);
      assert.equal(
        await main().getByRole('button', { name: 'このグループから外す', exact: true }).count(),
        20,
      );
    });
    await check('C12', async () => {
      const b = observations();
      await open({}, {}, 1280, 'agent');
      const a = observations();
      assert.ok((await main().innerText()).includes('この画面を表示する権限がありません。'));
      for (const k of ['managementReads', 'memberReads', 'peopleReads'])
        assert.equal(a[k] - b[k], 0);
      assert.equal(
        await main()
          .getByRole('link', { name: '対応待ちの一覧へ戻る', exact: true })
          .getAttribute('href'),
        '/ops',
      );
      report.details.push({ case: 'C12', agentManagementReads: 0 });
    });
    await check('C13', async () => {
      const b = observations();
      await open({}, {}, 1280, 'platform_admin');
      const a = observations();
      for (const k of ['managementReads', 'memberReads', 'peopleReads'])
        assert.equal(a[k] - b[k], 1);
      assert.equal(await main().locator('ul.groups > li').count(), 20);
    });
    await check('C14', async () => {
      for (const status of [403, 404]) {
        const b = observations();
        await open({}, { groupStatus: status });
        const a = observations();
        assert.ok((await page.locator('body').innerText()).includes('見つかりません'));
        assert.equal(a.memberReads - b.memberReads, 0);
        assert.equal(a.peopleReads - b.peopleReads, 0);
        report.details.push({ case: 'C14', primaryStatus: status, dependentReads: 0 });
        if (status === 403) await capture('C14-403');
      }
    });
    await check('C15', async () => {
      const b = observations();
      await open({}, { unknown: true });
      const a = observations();
      assert.ok((await page.locator('body').innerText()).includes('見つかりません'));
      assert.equal(a.memberReads - b.memberReads, 0);
      assert.equal(a.peopleReads - b.peopleReads, 0);
    });
    await check('C16', async () => {
      await open(conditions, { memberStatus: 503 });
      await retry(memberLabel, conditions);
    });
    await check('C17', async () => {
      await open(conditions, { peopleStatus: 503 });
      await retry(peopleLabel, conditions);
    });
    await check('C18', async () => {
      await open(conditions, { memberStatus: 503 });
      await keyboardRetry(memberLabel);
    });
    await check('C19', async () => {
      await open(conditions, { peopleStatus: 503 });
      await keyboardRetry(peopleLabel);
    });
    await check('C20', async () => {
      await open(conditions, { memberStatus: 503, peopleStatus: 503, long: true }, 390);
      assert.equal(
        await main().getByRole('heading', { level: 1 }).innerText(),
        longName + ' のメンバー',
      );
      await retryHref(memberLabel, pathFor(conditions));
      await retryHref(peopleLabel, pathFor(conditions));
      assert.equal(
        await page.evaluate(
          () =>
            Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <=
            window.innerWidth,
        ),
        true,
      );
      report.details.push({ case: 'C20', width: 390, overflow: 0, longConfirmed: true });
    });
    assert.deepEqual(
      report.checks.map((c) => c.case),
      groupDetailReadRecoveryCases,
    );
    assert.ok(report.checks.every((c) => c.passed));
    assert.equal(report.screenshots.length, 21);
    assert.equal(report.accessibility.length, 21);
    for (const key of ['nonReadCount', 'unknownReads', 'foreign', 'downloads'])
      assert.equal(report.network[key], 0);
    assert.equal(report.network.allowedWrites.length, 0);
    assert.equal(report.network.prefetchAttempts, report.network.prefetchBlocked);
    assert.equal(observations().unexpectedMutations, 0);
    assert.equal(observations().unknownReads, 0);
    assert.equal(observations().writes.length, 0);
    report.success = true;
  } catch (error) {
    report.success = false;
    report.failureCase = currentCase;
    report.failureType = error?.name ?? 'Error';
  } finally {
    signal?.removeEventListener('abort', interrupt);
    const closed = await closeOwned();
    report.closeResults = closed.map((r) => r.status);
    if (
      closed.some((r) => r.status === 'rejected') ||
      !report.contextClosed ||
      !report.browserClosed
    )
      report.success = false;
    await writeFile(join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  }
  return report;
}
