/* global document, window */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import {
  assetId,
  createdId,
  memberId,
  businessKeys,
  scenarioInput,
} from '../evidence/WP-P6-ASTPEND-088/20261010/fixture-api.mjs';
export const assetPendingCases = Array.from(
  { length: 24 },
  (_, i) => 'C' + String(i + 1).padStart(2, '0'),
);
const rawParent = '/assets?q=合成&state=repair&page=2';
const parent = '/assets?' + new URLSearchParams({ q: '合成', state: 'repair', page: '2' });
const createPath = '/assets/new';
const editPath = `/assets/${assetId}/edit`;
const detailPaths = [`/assets/${assetId}`, `/assets/${createdId}`];
const routeWithContext = (path) => path + '?returnTo=' + encodeURIComponent(rawParent);
const domNames = [
  'returnTo',
  'expectedVersion',
  'assetTag',
  'name',
  'kind',
  'model',
  'serialNumber',
  'hostname',
  'vendor',
  'state',
  'assignedUserId',
  'location',
  'internalNotes',
  'reason',
];
const statuses = [201, 400, 409, 503, 200, 400, 409, 503];
export async function runAssetPendingChecks({
  baseURL,
  outputDirectory,
  control,
  observations,
  release,
  assertOwned,
  signal,
}) {
  const report = {
    workPackage: 'WP-P6-ASTPEND-088',
    baselineRevision: '151d1f5e4ca671b74d5dd3b98f3303412a53286c',
    success: false,
    checks: [],
    screenshots: [],
    accessibility: [],
    snapshots: [],
    payloads: [],
    network: {
      allowedWrites: 0,
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
  let browser,
    context,
    page,
    permit = null,
    contextClose,
    browserClose;
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
  const interrupted = () => {
    void closeOwned();
  };
  signal?.addEventListener('abort', interrupted, { once: true });
  const live = async () => {
    assert.ok(!signal?.aborted);
    await assertOwned();
  };
  const form = () => page.locator('main form');
  const field = (name) => form().locator(`[name="${name}"]:not([type="hidden"])`);
  const visibleValues = async () =>
    Object.fromEntries(
      await form().evaluate((f) =>
        Array.from(f.querySelectorAll('input:not([type="hidden"]),select,textarea')).map((e) => [
          e.name,
          e.value,
        ]),
      ),
    );
  const ready = async () => {
    await page.waitForFunction(() => {
      const f = document.querySelector('main form');
      return f && !f.hasAttribute('inert');
    });
    await form().locator('[name="returnTo"]').waitFor({ state: 'attached' });
    assert.equal(await form().locator('[name="returnTo"]').inputValue(), parent);
  };
  const open = async (setting = {}, route = editPath, width = 1280) => {
    await live();
    control(setting);
    permit = null;
    if (page) await page.close();
    page = await context.newPage();
    await live();
    await page.setViewportSize({ width, height: 900 });
    page.on('download', () => report.network.downloads++);
    await page.addInitScript(() => {
      window.__assetPendingSnapshots = [];
      document.addEventListener(
        'submit',
        (event) => {
          if (!event.target.matches('main form')) return;
          const data = new FormData(event.target, event.submitter);
          window.__assetPendingSnapshots.push(
            Array.from(data.entries()).filter(([key]) => !key.startsWith('$ACTION_')),
          );
        },
        true,
      );
    });
    await page.goto(baseURL + routeWithContext(route), { waitUntil: 'networkidle' });
    await ready();
  };
  const capture = async (name, phase) => {
    const filename = name + '.png';
    await page.screenshot({ path: join(outputDirectory, filename), fullPage: true });
    const bytes = await readFile(join(outputDirectory, filename));
    assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
    report.screenshots.push({
      name,
      phase,
      path: filename,
      pngMagic: true,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    const axe = await new AxeBuilder({ page })
      .include('main')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    report.accessibility.push({
      name,
      phase,
      violations: axe.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.map((n) => ({ target: n.target, failureSummary: n.failureSummary })),
      })),
      incomplete: axe.incomplete.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })),
    });
    assert.equal(axe.violations.length, 0, 'AXE_' + name);
  };
  const check = async (name, phase, operation) => {
    try {
      await live();
      await operation();
      await capture(name, phase);
      report.checks.push({ name, passed: true });
    } catch (error) {
      report.checks.push({
        name,
        passed: false,
        code: error?.code === 'ERR_ASSERTION' ? 'ASSERTION' : 'UI_OPERATION',
        detail: String(error?.message ?? '')
          .replace(/https?:\/\/\S+/g, '[url]')
          .slice(0, 240),
      });
      throw error;
    }
  };
  const fill = async (input) => {
    await field('state').selectOption(input.state);
    if (await field('kind').isEnabled()) await field('kind').selectOption(input.kind);
    for (const key of businessKeys.filter((k) => !['kind', 'state', 'assignedUserId'].includes(k)))
      await field(key).fill(input[key]);
    if (await field('assignedUserId').isEnabled())
      await field('assignedUserId').selectOption(input.assignedUserId);
    assert.deepEqual(await visibleValues(), input);
  };
  const assertDisabled = async (pending, input, edit) => {
    for (const key of businessKeys)
      assert.equal(
        await field(key).isDisabled(),
        pending ||
          (key === 'kind' && edit) ||
          (key === 'assignedUserId' && !['in_use', 'repair'].includes(input.state)),
        'CONTROL_' + key,
      );
    assert.equal(
      await form()
        .getByRole('button', {
          name: pending ? '保存しています…' : edit ? '変更と履歴を保存する' : '資産を登録する',
          exact: true,
        })
        .isDisabled(),
      pending,
    );
  };
  const snapshot = async (index, input) => {
    const captured = await page.evaluate(() => window.__assetPendingSnapshots);
    assert.equal(captured.length, 1, 'NATIVE_SUBMIT_COUNT');
    const entries = captured[0];
    assert.deepEqual(
      entries.map(([key]) => key),
      domNames,
      'NATIVE_KEY_ORDER',
    );
    const expected = { returnTo: parent, expectedVersion: index < 4 ? '1' : '17', ...input };
    assert.deepEqual(Object.fromEntries(entries), expected, 'NATIVE_ALL_VALUES');
    report.snapshots.push({
      index,
      receivedBeforePending: true,
      nativeFormDataValid: true,
      businessValues: 12,
      hiddenVersion: index < 4 ? 1 : 17,
      order: [...domNames],
      textareaNativeLF: true,
      textareaWireCRLF: true,
    });
  };
  const submitPending = async (index) => {
    const input = scenarioInput(index),
      edit = index >= 4;
    await open({ index }, edit ? editPath : createPath, [3, 7].includes(index) ? 390 : 1280);
    await fill(input);
    permit = routeWithContext(edit ? editPath : createPath);
    if (index === 0) await field('assetTag').press('Enter');
    else
      await form()
        .getByRole('button', {
          name: edit ? '変更と履歴を保存する' : '資産を登録する',
          exact: true,
        })
        .click();
    const deadline = Date.now() + 10000;
    while (!observations().writes.some((w) => w.index === index)) {
      await live();
      assert.ok(Date.now() < deadline, 'FIXTURE_RECEIVED_TIMEOUT');
      await new Promise((done) => setTimeout(done, 50));
    }
    const received = observations().writes.find((w) => w.index === index);
    assert.equal(received.received, true);
    assert.equal(received.bodyValid, true);
    assert.equal(received.completed, false);
    assert.equal(observations().pending, true);
    await page.waitForFunction(() =>
      Array.from(
        document.querySelectorAll(
          'main form input:not([type="hidden"]),main form select,main form textarea',
        ),
      ).every((e) => e.disabled),
    );
    await assertDisabled(true, input, edit);
    await snapshot(index, input);
    assert.deepEqual(await visibleValues(), input);
    if ([0, 4].includes(index)) {
      const before = observations().writes.length;
      await page.mouse.click(
        ...(await form()
          .getByRole('button', { name: '保存しています…', exact: true })
          .evaluate((e) => {
            const r = e.getBoundingClientRect();
            return [r.x + r.width / 2, r.y + r.height / 2];
          })),
      );
      await page.keyboard.press('Enter');
      await form().evaluate((f) => f.requestSubmit());
      await page.waitForTimeout(120);
      assert.equal(observations().writes.length, before, 'DUPLICATE_API_WRITE');
      assert.deepEqual(await visibleValues(), input);
      // The duplicate submit event is stopped by FeedbackForm before dispatch; only the first snapshot is business evidence.
      const duplicate = await page.evaluate(() => window.__assetPendingSnapshots);
      assert.ok(duplicate.length >= 1);
    }
  };
  const released = async (index) => {
    const input = scenarioInput(index),
      edit = index >= 4;
    release();
    if (statuses[index] < 300) {
      await page.waitForURL(
        (url) =>
          url.pathname === (edit ? detailPaths[0] : detailPaths[1]) &&
          url.searchParams.get('saved') === '1' &&
          url.searchParams.get('returnTo') === parent,
      );
      await page
        .getByRole('heading', { name: `${input.assetTag} · ${input.name}`, exact: true })
        .waitFor();
      assert.equal(
        await page.getByRole('status').filter({ hasText: '資産と履歴を保存しました。' }).count(),
        1,
      );
      assert.equal(
        new URL(
          'http://synthetic.invalid' + new URL(page.url()).searchParams.get('returnTo'),
        ).searchParams.get('q'),
        '合成',
      );
      assert.equal(await page.locator('main form').count(), 0);
    } else {
      await form()
        .getByRole('heading', { name: '保存・送信できませんでした', exact: true })
        .waitFor();
      await page.waitForFunction(() => {
        const f = document.querySelector('main form');
        return f && !f.querySelector('button:disabled');
      });
      await assertDisabled(false, input, edit);
      assert.deepEqual(await visibleValues(), input, 'FAILURE_PRESERVED_VALUES');
      assert.equal(
        await form().locator('[name="expectedVersion"]').inputValue(),
        edit ? '17' : '1',
      );
      if (statuses[index] === 400) {
        await form().locator('.error-link').click();
        assert.equal(await page.evaluate(() => document.activeElement.id), 'asset-name');
      }
      const before = observations().writes.length;
      await page.waitForTimeout(120);
      assert.equal(observations().writes.length, before, 'AUTO_POST');
      if ([3, 7].includes(index))
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          true,
        );
    }
    const write = observations().writes.find((w) => w.index === index);
    assert.equal(write.completed, true);
    assert.equal(write.bodyValid, true);
    assert.equal(write.manualRelease, true);
    assert.equal(write.status, statuses[index]);
  };
  try {
    await live();
    browser = await chromium.launch({ headless: true });
    await live();
    context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
    });
    await live();
    await context.addCookies([
      { name: 'solvi_session_wp088_synthetic', value: 'org_admin', url: baseURL },
    ]);
    await context.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        headers = request.headers();
      if (url.origin !== new URL(baseURL).origin) {
        report.network.foreign++;
        return route.abort();
      }
      const prefetch = Boolean(headers['next-router-prefetch'] || headers.purpose === 'prefetch');
      if (!['GET', 'HEAD'].includes(request.method())) {
        if (
          !prefetch &&
          request.method() === 'POST' &&
          headers['next-action'] &&
          permit === url.pathname + url.search
        ) {
          permit = null;
          report.network.allowedWrites++;
          return route.continue();
        }
        report.network.nonReadCount++;
        if (prefetch) {
          report.network.prefetchAttempts++;
          report.network.prefetchBlocked++;
        }
        return route.abort();
      }
      if (prefetch) {
        report.network.prefetchAttempts++;
        report.network.prefetchBlocked++;
        return route.abort();
      }
      const known = [createPath, editPath, ...detailPaths, '/favicon.ico'].includes(url.pathname);
      const query = [...url.searchParams.keys()];
      const queryValid =
        query.every((key) => ['returnTo', 'saved', '_rsc'].includes(key)) &&
        ['returnTo', 'saved', '_rsc'].every((key) => url.searchParams.getAll(key).length <= 1) &&
        (!url.searchParams.has('returnTo') ||
          [rawParent, parent].includes(url.searchParams.get('returnTo'))) &&
        (!url.searchParams.has('saved') || url.searchParams.get('saved') === '1');
      if (!url.pathname.startsWith('/_next/') && !(known && queryValid)) {
        report.network.unknownReads++;
        return route.abort();
      }
      return route.continue();
    });
    await check('C01', 'ready-create', async () => {
      await open({}, createPath);
      assert.equal(await field('kind').isEnabled(), true);
      assert.equal(await field('assignedUserId').isDisabled(), true);
      assert.equal(await form().locator('[name="expectedVersion"]').inputValue(), '1');
      assert.equal(Object.keys(await visibleValues()).length, 12);
    });
    for (const [index, pendingCase, releasedCase] of [
      [0, 'C02', 'C03'],
      [1, 'C04', 'C05'],
      [2, 'C06', 'C07'],
      [3, 'C08', 'C09'],
    ]) {
      await check(pendingCase, 'received-pending', () => submitPending(index));
      await check(releasedCase, 'after-manual-release', () => released(index));
    }
    await check('C10', 'ready-edit', async () => {
      await open();
      assert.equal(await field('kind').isDisabled(), true);
      assert.equal(await form().locator('input[type="hidden"][name="kind"]').inputValue(), 'pc');
      assert.equal(await form().locator('[name="expectedVersion"]').inputValue(), '17');
      assert.equal(Object.keys(await visibleValues()).length, 12);
    });
    for (const [index, pendingCase, releasedCase] of [
      [4, 'C11', 'C12'],
      [5, 'C13', 'C14'],
      [6, 'C15', 'C16'],
      [7, 'C17', 'C18'],
    ]) {
      await check(pendingCase, 'received-pending', () => submitPending(index));
      await check(releasedCase, 'after-manual-release', () => released(index));
    }
    await check('C19', 'normal-assignment', async () => {
      await open({}, createPath);
      for (const state of ['in_use', 'repair']) {
        await field('state').selectOption(state);
        assert.equal(await field('assignedUserId').isEnabled(), true);
        await field('assignedUserId').selectOption(memberId);
      }
      for (const state of ['stocked', 'retired']) {
        await field('state').selectOption('in_use');
        await field('assignedUserId').selectOption(memberId);
        await field('state').selectOption(state);
        assert.equal(await field('assignedUserId').inputValue(), '');
        assert.equal(await field('assignedUserId').isDisabled(), true);
        assert.equal(
          await form().locator('input[type="hidden"][name="assignedUserId"]').inputValue(),
          '',
        );
      }
    });
    await check('C20', 'retired-edit', async () => {
      await open({ readState: 'retired' });
      assert.equal(await field('kind').isDisabled(), true);
      assert.deepEqual(
        await field('state')
          .locator('option')
          .evaluateAll((xs) => xs.map((x) => x.value)),
        ['retired'],
      );
      assert.equal(await field('assignedUserId').isDisabled(), true);
    });
    await check('C21', 'keyboard-focus', async () => {
      await open({}, createPath);
      await field('assetTag').focus();
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'asset-name');
      assert.equal(
        await field('name').evaluate((e) => {
          const s = window.getComputedStyle(e);
          return s.outlineStyle !== 'none' || s.boxShadow !== 'none';
        }),
        true,
      );
      await page.keyboard.type('SYN-KEYBOARD');
      assert.equal(await field('name').inputValue(), 'SYN-KEYBOARD');
      for (const key of businessKeys)
        assert.equal(await field(key).evaluate((e) => e.labels.length > 0), true, 'LABEL_' + key);
    });
    const long = {
      ...scenarioInput(7),
      name: '長い日本語の資産名称と確認事項'.repeat(8),
      model: '長い日本語のモデル説明'.repeat(8),
      vendor: '長い日本語のベンダー名'.repeat(8),
      location: '長い日本語の設置場所'.repeat(8),
      internalNotes: '確認すべき長い日本語のメモです。'.repeat(24) + '\n次の行も保持します。',
      reason: '合成の変更理由を日本語で確認します。'.repeat(12),
    };
    await check('C22', 'long-japanese-desktop', async () => {
      await open();
      await fill(long);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
      );
    });
    await check('C23', 'long-japanese-create-mobile', async () => {
      await open({}, createPath, 390);
      await fill(long);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
      );
    });
    await check('C24', 'long-japanese-edit-mobile', async () => {
      await open({}, editPath, 390);
      await fill(long);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
      );
    });
    for (const collection of ['checks', 'screenshots', 'accessibility'])
      assert.deepEqual(
        report[collection].map((x) => x.name),
        assetPendingCases,
      );
    const observed = observations();
    assert.equal(report.network.allowedWrites, 8);
    assert.equal(observed.writes.length, 8);
    assert.equal(observed.releases, 8);
    assert.equal(observed.automaticReleases, 0);
    assert.equal(observed.pending, false);
    assert.deepEqual(
      observed.writes.map((x) => [x.index, x.operation, x.path, x.status]),
      statuses.map((status, index) => [
        index,
        index < 4 ? 'create' : 'edit',
        index < 4 ? '/assets' : `/assets/${assetId}/edit`,
        status,
      ]),
    );
    assert.ok(
      observed.writes.every((x) => x.bodyValid && x.received && x.completed && x.manualRelease),
    );
    assert.equal(report.snapshots.length, 8);
    assert.equal(observed.unexpectedMutations + observed.unknownReads, 0);
    assert.ok(
      observed.requests.every(
        (x, i) =>
          x.sequence === i + 1 &&
          x.completed &&
          (i === 0
            ? x.path === '/auth/organizations' &&
              x.query === '' &&
              x.role === 'missing' &&
              x.status === 401
            : x.role === 'org_admin'),
      ),
    );
    assert.equal(
      report.network.nonReadCount +
        report.network.unknownReads +
        report.network.foreign +
        report.network.downloads,
      0,
    );
    assert.equal(report.network.prefetchAttempts, report.network.prefetchBlocked);
    report.payloads = observed.writes;
    report.success =
      report.checks.every((x) => x.passed) &&
      report.accessibility.every((x) => x.violations.length === 0);
  } catch {
    report.failureCode = 'UI_ACCEPTANCE';
  } finally {
    const results = await closeOwned();
    signal?.removeEventListener('abort', interrupted);
    report.closeResults = results.map((x) => x.status);
    if (
      results.some((x) => x.status !== 'fulfilled') ||
      !report.browserClosed ||
      !report.contextClosed
    )
      report.success = false;
    await writeFile(
      join(outputDirectory, 'ui-report.json'),
      JSON.stringify(report, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
  }
  return report;
}
