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
  writeUserId,
  longName,
} from '../evidence/WP-P2-GRPCAND-090/20261010/fixture-api.mjs';

export const groupMemberSelectionCases = Array.from(
  { length: 26 },
  (_, i) => 'C' + String(i + 1).padStart(2, '0'),
);
const detailPath = '/ops/groups/' + groupId;
const pathFor = (values = {}) =>
  detailPath + (Object.keys(values).length ? '?' + new URLSearchParams(values) : '');
export async function runGroupMemberSelectionChecks({
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
    workPackage: 'WP-P2-GRPCAND-090',
    baselineRevision: '86c40ef86ed554e128b9ffc8ed584b0ecd027b56',
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
  const pending = new Map();
  const classifiedWrites = new WeakMap();
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
  const input = () =>
    main().getByRole('searchbox', { name: '名前・メールで在籍者を検索', exact: true });
  const filter = () => main().getByRole('combobox', { name: '表示する在籍者', exact: true });
  const selection = () => main().getByRole('combobox', { name: '追加する在籍者', exact: true });
  const submit = () => main().getByRole('button', { name: '選んだ在籍者を追加する', exact: true });
  const optionRows = () =>
    selection()
      .locator('option')
      .evaluateAll((options) =>
        options.map((o) => ({ value: o.value, label: o.textContent, disabled: o.disabled })),
      );
  const visible = async (expected) => {
    const rows = await optionRows();
    assert.equal(rows[0].value, '');
    assert.deepEqual(
      rows.slice(1).map((o) => o.value),
      expected.map((p) => p.userId),
    );
    assert.equal(rows.length, expected.length + 1);
  };
  const href = (label) =>
    main().getByRole('link', { name: label, exact: true }).getAttribute('href');
  const current = () => new URL(page.url());
  const assertQuery = (url, values) =>
    assert.deepEqual(Object.fromEntries(url.searchParams), values);
  const ready = async () => {
    await page.locator('h1').first().waitFor();
    if (await main().locator('form').count())
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll('main form')).every((f) => !f.hasAttribute('inert')),
      );
  };
  const open = async (values = {}, settings = {}, width = 1280, raw = null) => {
    await live();
    control(settings);
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
    assert.equal(await submit().isDisabled(), true);
  };
  const noNormalState = async () => {
    assert.ok(!/追加可能 \d|検索結果 \d|このページに在籍者/.test(await main().innerText()));
    assert.equal(await main().getByRole('navigation', { name: '在籍者候補のページ' }).count(), 0);
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
    onStage(id);
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
  try {
    browser = await chromium.launch({ headless: true });
    await live();
    context = await browser.newContext();
    await live();
    const role = async (value) => {
      await context.clearCookies();
      await context.addCookies([{ name: 'solvi_session_wp090_synthetic', value, url: origin }]);
    };
    await role('org_admin');
    context.on('response', (response) => {
      const item = pending.get(response.request());
      if (item) {
        item.status = response.status();
        const type = response.headers()['content-type'] ?? '';
        item.responseType = type.startsWith('text/x-component')
          ? 'rsc'
          : type.startsWith('text/plain')
            ? 'plain'
            : 'other';
        item.responseFinished = 'pending';
        void response.finished().then(
          (error) => {
            item.responseFinished = error ? 'failed' : 'complete';
            item.responseFinishedCase = currentCase;
          },
          () => {
            item.responseFinished = 'failed';
            item.responseFinishedCase = currentCase;
          },
        );
      }
    });
    context.on('requestfailed', (request) => {
      const item = classifiedWrites.get(request);
      if (item) {
        item.failed = true;
        item.failureCode = request.failure()?.errorText.includes('ERR_ABORTED')
          ? 'ABORTED'
          : 'FAILED';
        item.failureCase = currentCase;
      }
    });
    context.on('requestfinished', (request) => {
      const item = pending.get(request);
      if (item) {
        item.completed = true;
        pending.delete(request);
      }
    });
    await context.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        headers = request.headers();
      const prefetch = Boolean(headers['next-router-prefetch'] || headers.purpose === 'prefetch');
      if (!['GET', 'HEAD'].includes(request.method())) {
        if (
          request.method() === 'POST' &&
          currentCase === 'C24' &&
          url.origin === origin &&
          url.pathname === detailPath &&
          !prefetch &&
          typeof headers['next-action'] === 'string' &&
          headers['next-action'].length > 0 &&
          report.network.allowedWrites.length < 2
        ) {
          const item = {
            index: report.network.allowedWrites.length,
            case: currentCase,
            method: 'POST',
            path: url.pathname,
            query: url.search,
            actualNextAction: true,
            resourceType: request.resourceType(),
            status: null,
            completed: false,
          };
          report.network.allowedWrites.push(item);
          pending.set(request, item);
          classifiedWrites.set(request, item);
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
        ![detailPath, '/ops/groups', '/favicon.ico'].includes(url.pathname)
      ) {
        report.network.unknownReads++;
        return route.abort();
      }
      return route.continue();
    });
    await check('C01', async () => {
      await open();
      await visible(people.slice(0, 25));
      assert.equal(await main().locator('ul.groups > li').count(), 20);
      assert.ok((await main().innerText()).includes('person0@example.invalid'));
      assert.equal(
        await main().locator('time').first().getAttribute('datetime'),
        baseMembers[0].addedAt,
      );
      await closed();
    });
    await check('C02', async () => {
      await open({ page: '2' });
      await visible(people.slice(25, 50));
      assert.equal(await selection().isEnabled(), true);
      assert.equal(await submit().isEnabled(), true);
      assert.ok((await main().innerText()).includes('26〜50人を表示'));
    });
    await check('C03', async () => {
      await open({ page: '3' });
      await visible(people.slice(50));
      assert.ok((await main().innerText()).includes('51〜53人を表示'));
    });
    await check('C04', async () => {
      await open({ q: 'NameNeedle' });
      await visible([people[30]]);
    });
    await check('C05', async () => {
      await open({ q: 'PERSON31@EXAMPLE.INVALID' });
      await visible([people[31]]);
    });
    await check('C06', async () => {
      await open({ q: '合成同名' });
      await visible(people.slice(26, 28));
      const rows = (await optionRows()).slice(1);
      assert.notEqual(rows[0].value, rows[1].value);
      assert.ok(rows[0].label.includes('person26@'));
      assert.ok(rows[1].label.includes('person27@'));
    });
    await check('C07', async () => {
      await open({ filter: 'available' });
      await visible(people.slice(25, 50));
      assert.ok((await optionRows()).slice(1).every((p) => !p.disabled));
      assert.ok((await main().innerText()).includes('表示条件に一致 28人'));
    });
    await check('C08', async () => {
      await open();
      const rows = (await optionRows()).slice(1);
      assert.ok(rows.every((p) => p.disabled));
      assert.ok(rows[18].label.endsWith('（所属済み）'));
      assert.ok(rows[20].label.endsWith('（停止中）'));
      assert.ok((await main().innerText()).includes('追加可能 28人 · 所属済み 20人 · 停止中 7人'));
    });
    await check('C09', async () => {
      await open({ q: '  %_.*  ' });
      assert.equal(await input().inputValue(), '%_.*');
      await visible([people[28]]);
      await open({ q: '長'.repeat(198) + '😀' + 'x' });
      assert.equal((await input().inputValue()).length, 200);
      assert.equal(await input().inputValue(), '長'.repeat(198) + '😀');
      await visible([people[29]]);
    });
    await check('C10', async () => {
      await open(
        {},
        {},
        1280,
        detailPath +
          '?q=x&q=y&filter=available&filter=all&page=2&page=3&returnTo=%2Fops&returnTo=%2Fportal&unknown=PRIVATE&notice=added&error=old',
      );
      assert.equal(await input().inputValue(), '');
      assert.equal(await filter().inputValue(), 'all');
      await visible(people.slice(0, 25));
      assert.equal(await main().locator('form[method=get] input[name=returnTo]').count(), 0);
      const next = new URL(await href('次のページ'), origin);
      assertQuery(next, { page: '2' });
      assert.equal(
        await main().getByRole('link', { name: '追加可能のみを表示する' }).getAttribute('href'),
        detailPath + '?filter=available',
      );
    });
    await check('C11', async () => {
      await open({ q: '', filter: 'other', page: '01', returnTo: 'https://outside.invalid' });
      assert.equal(await filter().inputValue(), 'all');
      await visible(people.slice(0, 25));
      assertQuery(new URL(await href('次のページ'), origin), { page: '2' });
    });
    await check('C12', async () => {
      await open({ q: '合成', filter: 'available', page: '2', returnTo: '/ops' });
      assert.equal(await main().locator('form[method=get] input[name=page]').count(), 0);
      await input().fill('合成同名');
      await main().getByRole('button', { name: '検索する', exact: true }).click();
      await page.waitForURL((url) => url.searchParams.get('q') === '合成同名');
      await ready();
      assertQuery(current(), { q: '合成同名', filter: 'available', returnTo: '/ops' });
      await visible(people.slice(26, 28));
    });
    await check('C13', async () => {
      await open({ q: '合成', filter: 'available', page: '2', returnTo: '/ops' });
      assertQuery(new URL(await href('検索を解除する'), origin), { returnTo: '/ops' });
      await main().getByRole('link', { name: '検索を解除する', exact: true }).click();
      await page.waitForURL((url) => !url.searchParams.has('q'));
      await ready();
      assertQuery(current(), { returnTo: '/ops' });
      await visible(people.slice(0, 25));
    });
    await check('C14', async () => {
      await open({ q: '合成', returnTo: '/ops' });
      await closed();
      const exit = new URL(await href('追加可能のみを表示する'), origin);
      assertQuery(exit, { q: '合成', filter: 'available', returnTo: '/ops' });
      await main().getByRole('link', { name: '追加可能のみを表示する', exact: true }).click();
      await page.waitForURL((url) => url.searchParams.get('filter') === 'available');
      await ready();
      assert.equal(await selection().isEnabled(), true);
      assert.equal(await submit().isEnabled(), true);
    });
    await check('C15', async () => {
      const modes = [
        [{ q: 'absent' }, {}, '検索条件に一致する在籍者が居ません'],
        [{}, { users: 'empty' }, 'この組織の在籍者が居ません'],
        [{ filter: 'available' }, { users: 'ineligible' }, '検索結果に追加可能な在籍者が居ません'],
      ];
      for (const [values, settings, message] of modes) {
        await open(values, settings);
        await closed();
        assert.ok((await main().innerText()).includes(message));
        assert.equal((await optionRows()).length, 1);
      }
      report.details.push({
        case: 'C15',
        emptyModes: ['search', 'users', 'available'],
        allClosed: true,
      });
    });
    await check('C16', async () => {
      await open({ page: '100000', returnTo: '/ops' });
      await closed();
      assert.ok((await main().innerText()).includes('このページに在籍者が居ません'));
      assertQuery(new URL(await href('先頭ページへ戻る'), origin), { returnTo: '/ops' });
      await main().getByRole('link', { name: '先頭ページへ戻る', exact: true }).click();
      await page.waitForURL((url) => !url.searchParams.has('page'));
      await ready();
      await visible(people.slice(0, 25));
    });
    await check('C17', async () => {
      await open({ page: '2' }, { inactive: true });
      await closed();
      assert.ok((await main().innerText()).includes('既存メンバーの確認・解除はできます'));
      assert.equal(
        await main()
          .getByRole('button', { name: 'このグループから外す', exact: true })
          .first()
          .isEnabled(),
        true,
      );
    });
    await check('C18', async () => {
      await open({ page: '2' }, { memberStatus: 503 });
      await closed();
      await noNormalState();
      assert.ok(
        (await main().innerText()).includes(
          'メンバーを取得できませんでした。再読み込みしてください。',
        ),
      );
    });
    await check('C19', async () => {
      for (const peopleStatus of [503, 403]) {
        await open({ page: '2' }, { peopleStatus });
        await closed();
        await noNormalState();
        assert.ok(
          (await main().innerText()).includes(
            '在籍者候補を取得できないため追加できません。再読み込みしてください。',
          ),
        );
      }
      report.details.push({ case: 'C19', peopleStatuses: [503, 403], allClosed: true });
    });
    await check('C20', async () => {
      await role('agent');
      const before = observations();
      await open();
      assert.ok((await main().innerText()).includes('この画面を表示する権限がありません'));
      const after = observations();
      for (const key of ['managementReads', 'memberReads', 'peopleReads'])
        assert.equal(after[key], before[key]);
      assert.equal(await main().locator('form').count(), 0);
      report.details.push({ case: 'C20', role: 'agent', groups: 0, members: 0, users: 0 });
      await role('org_admin');
    });
    await check('C21', async () => {
      await role('platform_admin');
      const before = observations();
      await open({ page: '2' });
      const after = observations();
      for (const key of ['managementReads', 'memberReads', 'peopleReads'])
        assert.equal(after[key] - before[key], 1);
      await visible(people.slice(25, 50));
      await role('org_admin');
    });
    await check('C22', async () => {
      for (const setting of [{ unknown: true }, { groupStatus: 403 }, { groupStatus: 404 }]) {
        const before = observations();
        await open({}, setting);
        assert.equal(
          await main().getByRole('heading', { level: 1 }).innerText(),
          'お探しの画面は見つかりませんでした',
        );
        assert.ok(
          (await main().innerText()).includes(
            'URLが変わったか、閲覧できる範囲の外にある可能性があります。',
          ),
        );
        assert.equal(await main().locator('form').count(), 0);
        assert.equal(await selection().count(), 0);
        const after = observations();
        assert.equal(after.memberReads, before.memberReads);
        assert.equal(after.peopleReads, before.peopleReads);
        assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE_WP090'));
      }
      report.details.push({ case: 'C22', modes: ['unknown', 403, 404], memberUserReads: 0 });
    });
    await check('C23', async () => {
      const parent =
        '/ops/groups?q=' + encodeURIComponent('合成') + '&state=active&page=2&returnTo=%2Fops';
      await open({ q: '合成同名', filter: 'available', returnTo: parent });
      assert.equal(await href('元の画面へ戻る'), parent);
      await main().getByRole('link', { name: '元の画面へ戻る', exact: true }).click();
      await page.waitForURL((url) => url.pathname === '/ops/groups');
      await ready();
      assertQuery(current(), { q: '合成', state: 'active', page: '2', returnTo: '/ops' });
      assert.equal(
        await main().getByRole('searchbox', { name: 'グループを検索', exact: true }).inputValue(),
        '合成',
      );
      assert.equal(
        await main().getByRole('combobox', { name: '運用状態', exact: true }).inputValue(),
        'active',
      );
      report.navigation.push({
        case: 'C23',
        destination: current().pathname + current().search,
        complete: true,
      });
    });
    await check('C24', async () => {
      const writeWaits = [];
      const networkIdle = [];
      const writeDetail = { case: 'C24', writeWaits, networkIdle };
      report.details.push(writeDetail);
      const values = { q: '合成', filter: 'available', page: '2', returnTo: '/ops' };
      await open(values);
      assert.ok((await main().innerText()).includes('現在のメンバー · 20人'));
      await selection().selectOption(writeUserId);
      const addFinished = context
        .waitForEvent('requestfinished', {
          predicate: (request) => classifiedWrites.get(request)?.index === 0,
          timeout: 30000,
        })
        .then(
          () => true,
          () => false,
        );
      await submit().click();
      await page.waitForURL((url) => url.searchParams.get('notice') === 'added');
      await ready();
      const addComplete = await addFinished;
      onStage(addComplete ? 'C24-add-complete' : 'C24-add-timeout');
      writeWaits.push({
        index: 0,
        event: 'requestfinished',
        finished: addComplete,
        responseFinished: report.network.allowedWrites[0]?.responseFinished ?? 'no-response',
        failedAtWait: report.network.allowedWrites[0]?.failed === true,
      });
      assert.equal(addComplete, true);
      assert.equal(report.network.allowedWrites[0]?.completed, true);
      assert.equal(pending.size, 0);
      assertQuery(current(), { ...values, notice: 'added' });
      assert.ok((await main().innerText()).includes('現在のメンバー · 21人'));
      assert.ok((await main().innerText()).includes('所属済み 21人'));
      assert.equal(
        await selection()
          .locator('option[value="' + writeUserId + '"]')
          .count(),
        0,
      );
      const row = main()
        .locator('ul.groups > li')
        .filter({ has: page.locator('input[name=userId][value="' + writeUserId + '"]') });
      assert.equal(await row.count(), 1);
      onStage('C24-after-add-networkidle');
      await page.waitForLoadState('networkidle', { timeout: 30000 });
      assert.equal(report.network.allowedWrites[0]?.responseFinished, 'complete');
      assert.notEqual(report.network.allowedWrites[0]?.failed, true);
      networkIdle.push({ phase: 'after-add', complete: true });
      onStage('C24-remove-wait');
      const removeFinished = context
        .waitForEvent('requestfinished', {
          predicate: (request) => classifiedWrites.get(request)?.index === 1,
          timeout: 30000,
        })
        .then(
          () => true,
          () => false,
        );
      await row.getByRole('button', { name: 'このグループから外す', exact: true }).click();
      await page.waitForURL((url) => url.searchParams.get('notice') === 'removed');
      await ready();
      const removeComplete = await removeFinished;
      onStage(removeComplete ? 'C24-remove-complete' : 'C24-remove-timeout');
      writeWaits.push({
        index: 1,
        event: 'requestfinished',
        finished: removeComplete,
        responseFinished: report.network.allowedWrites[1]?.responseFinished ?? 'no-response',
        failedAtWait: report.network.allowedWrites[1]?.failed === true,
      });
      assert.equal(removeComplete, true);
      assert.equal(report.network.allowedWrites[1]?.completed, true);
      assert.equal(pending.size, 0);
      assertQuery(current(), { ...values, notice: 'removed' });
      assert.ok((await main().innerText()).includes('現在のメンバー · 20人'));
      assert.ok((await main().innerText()).includes('所属済み 20人'));
      assert.equal(
        await selection()
          .locator('option[value="' + writeUserId + '"]')
          .count(),
        1,
      );
      const writes = observations().writes;
      assert.equal(writes.length, 2);
      assert.ok(writes.every((w) => w.bodyValid && w.completed && w.status === 204));
      onStage('C24-after-remove-networkidle');
      await page.waitForLoadState('networkidle', { timeout: 30000 });
      assert.equal(report.network.allowedWrites[1]?.responseFinished, 'complete');
      assert.notEqual(report.network.allowedWrites[1]?.failed, true);
      networkIdle.push({ phase: 'after-remove', complete: true });
      Object.assign(writeDetail, {
        sameUser: writeUserId,
        memberCounts: [20, 21, 20],
        notices: ['added', 'removed'],
        contextKept: true,
      });
    });
    await check('C25', async () => {
      const keyboardSteps = [];
      report.details.push({ case: 'C25', keyboardSteps });
      const keyboardState = async (step) =>
        keyboardSteps.push({
          step,
          ...(await page.evaluate(() => ({
            active: document.activeElement.id,
            value: document.querySelector('#member-id').value,
            outlineStyle: window.getComputedStyle(document.activeElement).outlineStyle,
            outlineWidth: window.getComputedStyle(document.activeElement).outlineWidth,
          }))),
        });
      await open({ filter: 'available' });
      await page.locator('label[for=member-search]').click();
      await keyboardState('label-search');
      assert.equal(await input().evaluate((el) => el === document.activeElement), true);
      await page.keyboard.press('Tab');
      await keyboardState('tab-filter');
      assert.equal(await filter().evaluate((el) => el === document.activeElement), true);
      assert.equal(
        await filter().evaluate((el) => {
          const s = window.getComputedStyle(el);
          return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0;
        }),
        true,
      );
      await page.locator('label[for=member-id]').click();
      await keyboardState('label-member');
      assert.equal(await selection().evaluate((el) => el === document.activeElement), true);
      await page.keyboard.press('Escape');
      await keyboardState('escape-popup');
      assert.equal(await selection().evaluate((el) => el === document.activeElement), true);
      await page.keyboard.press('a');
      await keyboardState('native-typeahead');
      assert.equal(await selection().inputValue(), people[25].userId);
      await page.keyboard.press('Tab');
      await keyboardState('tab-submit');
      assert.equal(await submit().evaluate((el) => el === document.activeElement), true);
    });
    await check('C26', async () => {
      await open({ page: '2' }, { long: true }, 390);
      assert.equal(
        await main().getByRole('heading', { level: 1 }).innerText(),
        longName + ' のメンバー',
      );
      const first = (await optionRows())[1];
      assert.equal(first.label, longName + people[25].email + ' · ' + people[25].email);
      assert.equal(
        await page.evaluate(
          () =>
            Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <=
            window.innerWidth,
        ),
        true,
      );
      await visible(people.slice(25, 50));
      report.details.push({ case: 'C26', width: 390, overflow: 0, longConfirmed: true });
    });
    assert.deepEqual(
      report.checks.map((c) => c.case),
      groupMemberSelectionCases,
    );
    assert.ok(report.checks.every((c) => c.passed));
    assert.equal(report.screenshots.length, 26);
    assert.equal(report.accessibility.length, 26);
    for (const key of ['nonReadCount', 'unknownReads', 'foreign', 'downloads'])
      assert.equal(report.network[key], 0);
    assert.equal(report.network.allowedWrites.length, 2);
    assert.ok(
      report.network.allowedWrites.every(
        (w) => w.completed && w.actualNextAction && w.status >= 200 && w.status < 400,
      ),
    );
    assert.equal(pending.size, 0);
    assert.equal(report.network.prefetchAttempts, report.network.prefetchBlocked);
    assert.equal(observations().unexpectedMutations, 0);
    assert.equal(observations().unknownReads, 0);
    report.success = true;
  } catch {
    report.success = false;
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
