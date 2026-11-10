/* global document, window */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import {
  itemId,
  approverB,
  fullSaveContent,
  initialDetail,
  longTitle,
} from '../evidence/WP-P2-CATEDIT-086/20261010/fixture-api.mjs';

export const catalogEditCases = Array.from(
  { length: 40 },
  (_, i) => 'C' + String(i + 1).padStart(2, '0'),
);
const detailPath = '/catalog/manage/' + itemId;
const createPath = '/catalog/manage/new';
const isUUID = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

export async function runCatalogEditChecks({
  baseURL,
  outputDirectory,
  control,
  observations,
  release,
  assertOwned,
  signal,
}) {
  const report = {
    workPackage: 'WP-P2-CATEDIT-086',
    baselineRevision: '9e8f45309a0303b70d8f5fe38c62bdacf3b0cdc2',
    success: false,
    checks: [],
    screenshots: [],
    accessibility: [],
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
  const editor = () => page.locator('details form');
  const publication = () => page.locator('section[aria-label="カタログの編集と公開"] > form');
  const status = () => page.locator('section[aria-label="カタログの編集と公開"] > [role="status"]');
  const dirty = async (expected = true) =>
    assert.equal((await status().textContent()).includes('未保存の入力があります'), expected);
  const snapshot = async () =>
    editor().evaluate((form) =>
      Array.from(form.querySelectorAll('input,select,textarea')).map((e) => ({
        name: e.name,
        value: e.value,
        checked: e.type === 'checkbox' ? e.checked : null,
      })),
    );
  const ready = async () => {
    await page.locator('main').waitFor();
    if (await page.locator('main form').count())
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll('main form')).every((f) => !f.hasAttribute('inert')),
      );
  };
  const open = async (setting = {}, route = detailPath, width = 1280) => {
    await live();
    control(setting);
    permit = null;
    if (page) await page.close();
    page = await context.newPage();
    await page.setViewportSize({ width, height: 900 });
    page.on('download', () => report.network.downloads++);
    await page.goto(baseURL + route, { waitUntil: 'networkidle' });
    await ready();
    if (await page.locator('details').count())
      await page.locator('summary').filter({ hasText: '下書きの項目と承認者を編集する' }).click();
  };
  const capture = async (caseId, phase = 'after-assertions') => {
    const filename = caseId + '.png';
    await page.screenshot({ path: join(outputDirectory, filename), fullPage: true });
    const bytes = await readFile(join(outputDirectory, filename));
    report.screenshots.push({
      name: caseId,
      phase,
      path: filename,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    const axe = await new AxeBuilder({ page })
      .include('main')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    report.accessibility.push({
      name: caseId,
      phase,
      violations: axe.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.map((n) => ({ target: n.target, failureSummary: n.failureSummary })),
      })),
      incomplete: axe.incomplete.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })),
    });
    assert.equal(axe.violations.length, 0, 'AXE_' + caseId);
  };
  const check = async (name, operation) => {
    try {
      await live();
      await operation();
      if (!report.screenshots.some((p) => p.name === name)) await capture(name);
      report.checks.push({ name, passed: true });
    } catch (error) {
      report.checks.push({
        name,
        passed: false,
        code: error?.code === 'ERR_ASSERTION' ? 'ASSERTION' : 'UI_OPERATION',
        detail: String(error?.message ?? '')
          .replace(/https?:\/\/\S+/g, '[url]')
          .slice(0, 300),
      });
    }
  };
  const blockBoth = async () => {
    const writes = report.network.allowedWrites,
      apiWrites = observations().mutations;
    assert.equal(
      await publication().locator('[name="state"][value="published"]').isDisabled(),
      true,
    );
    assert.equal(
      await publication().locator('[name="state"][value="unpublished"]').isDisabled(),
      true,
    );
    await publication().evaluate((f) => {
      f.requestSubmit(f.querySelector('[value="published"]'));
      f.requestSubmit(f.querySelector('[value="unpublished"]'));
      f.requestSubmit();
    });
    await page.waitForTimeout(120);
    assert.equal(report.network.allowedWrites, writes);
    assert.equal(observations().mutations, apiWrites);
  };
  const allDisabled = async () =>
    assert.equal(
      await editor().evaluate((f) =>
        Array.from(f.querySelectorAll('input:not([type="hidden"]),textarea,select,button')).every(
          (e) => e.matches(':disabled'),
        ),
      ),
      true,
    );
  const fillFull = async () => {
    const d = fullSaveContent.definition;
    for (const [id, value] of Object.entries({
      'catalog-title': fullSaveContent.title,
      'catalog-description': fullSaveContent.description,
      'catalog-target': d.targetLabel,
      'catalog-days': d.allowedDurations.join(', '),
      'catalog-reason-limit': String(d.maxReasonLength),
    }))
      await page.locator('#' + id).fill(value);
    await page.locator('#catalog-approver').selectOption(approverB);
    for (const [i, field] of d.fields.entries()) {
      await page.locator('#field-key-' + i).fill(field.key);
      await page.locator('#field-label-' + i).fill(field.label);
      const required = editor()
        .locator('.catalog-editor-field')
        .nth(i)
        .locator('input[type="checkbox"]');
      await required.setChecked(field.required);
      if (field.type === 'select')
        await page.locator('#field-options-' + i).fill(field.options.join('\n'));
      else if (field.type !== 'checkbox')
        await page.locator('#field-limit-' + i).fill(String(field.maxLength));
    }
    await dirty();
  };
  const allowAction = () => {
    assert.equal(permit, null);
    permit = detailPath;
  };
  const save = async () => {
    allowAction();
    await editor()
      .getByRole('button', { name: '下書きを保存してプレビューする', exact: true })
      .click();
  };
  const publish = async (state = 'published') => {
    allowAction();
    await publication()
      .locator('[name="state"][value="' + state + '"]')
      .click();
  };
  const failed = async () => {
    await page.locator('.error-summary').waitFor();
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('main form')).every(
        (f) => f.getAttribute('aria-busy') === 'false',
      ),
    );
    assert.equal(
      await editor().evaluate((f) =>
        Array.from(f.querySelectorAll('input:not([type="hidden"]),textarea,select,button')).every(
          (e) => !e.matches(':disabled'),
        ),
      ),
      true,
    );
    assert.equal(
      await editor()
        .getByRole('button', { name: '下書きを保存してプレビューする', exact: true })
        .isEnabled(),
      true,
    );
    if (!(await status().textContent()).includes('未保存の入力があります')) {
      assert.equal(await publication().locator('[value="published"]').isEnabled(), true);
      assert.equal(await publication().locator('[value="unpublished"]').isEnabled(), true);
    }
    assert.equal(
      await page.locator('main').getByText('カタログ設定を保存しました。', { exact: true }).count(),
      0,
    );
  };
  const waitForPendingAPI = async () => {
    const until = Date.now() + 10000;
    while (!observations().pending && Date.now() < until) {
      await live();
      await page.waitForTimeout(40);
    }
    assert.equal(observations().pending, true);
  };
  const versions = (editVersion, draftRevision, publishedRevision, active = true) =>
    assert.deepEqual(observations().current, {
      editVersion,
      draftRevision,
      publishedRevision,
      active,
    });
  try {
    browser = await chromium.launch({ headless: true });
    await live();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await live();
    await context.addCookies([
      { name: 'solvi_session_wp086_synthetic', value: 'org_admin', url: baseURL },
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
          permit === url.pathname
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
      if (
        !url.pathname.startsWith('/_next/') &&
        ![detailPath, createPath, '/favicon.ico'].includes(url.pathname)
      ) {
        report.network.unknownReads++;
        return route.abort();
      }
      return route.continue();
    });
    await check('C01', async () => {
      await open();
      await dirty(false);
      versions(7, 5, 3);
      assert.equal(
        await page.getByRole('heading', { name: '保存済みの下書き版5', exact: true }).count(),
        1,
      );
      assert.equal(
        await publication()
          .getByRole('button', { name: '公開版3の新規受付を停止する', exact: true })
          .isEnabled(),
        true,
      );
      assert.equal(await page.locator('#preview h3').textContent(), initialDetail().draft.title);
    });
    const basic = [
      ['catalog-title', '未保存の合成サービス'],
      ['catalog-description', '別の説明'],
      ['catalog-target', '別の対象'],
      ['catalog-days', '2, 7, 30'],
      ['catalog-reason-limit', '1900'],
      ['catalog-approver', approverB],
    ];
    for (const [index, [id, next]] of basic.entries())
      await check(catalogEditCases[index + 1], async () => {
        await open();
        const control = page.locator('#' + id),
          before = await control.inputValue();
        if (id === 'catalog-approver') await control.selectOption(next);
        else await control.fill(next);
        await dirty();
        await blockBoth();
        assert.equal(await page.locator('#preview h3').textContent(), initialDetail().draft.title);
        if (id === 'catalog-approver') await control.selectOption(before);
        else await control.fill(before);
        await dirty(false);
      });
    const fieldChanges = [
      ['field-key-0', 'team_b'],
      ['field-label-0', '別の部署'],
      ['field-type-0', 'checkbox'],
      ['required', false],
      ['field-options-2', '別候補\n追加候補'],
      ['field-limit-0', '81'],
      ['field-limit-1', '501'],
      ['add', null],
      ['delete', null],
    ];
    for (const [index, [id, next]] of fieldChanges.entries())
      await check(catalogEditCases[index + 7], async () => {
        await open();
        if (id === 'required') {
          const c = editor()
            .locator('.catalog-editor-field')
            .first()
            .locator('input[type="checkbox"]');
          await c.uncheck();
          await dirty();
          await c.check();
        } else if (id === 'add') {
          await editor().getByRole('button', { name: '申請項目を追加する', exact: true }).click();
          await dirty();
          await editor()
            .getByRole('button', { name: '項目5を下書きから外す', exact: true })
            .click();
        } else if (id === 'delete') {
          await editor()
            .getByRole('button', { name: '項目4を下書きから外す', exact: true })
            .click();
          await dirty();
          await editor().getByRole('button', { name: '申請項目を追加する', exact: true }).click();
          await page.locator('#field-key-3').fill('confirm');
          await page.locator('#field-label-3').fill('申請条件を確認しました');
          await page.locator('#field-type-3').selectOption('checkbox');
          await editor()
            .locator('.catalog-editor-field')
            .nth(3)
            .locator('input[type="checkbox"]')
            .check();
        } else {
          const c = page.locator('#' + id),
            before = await c.inputValue();
          if (id === 'field-type-0') await c.selectOption(next);
          else await c.fill(next);
          await dirty();
          if (id === 'field-type-0') {
            await c.selectOption(before);
            await page.locator('#field-limit-0').fill('80');
          } else await c.fill(before);
        }
        await dirty(false);
      });
    await check('C17', async () => {
      await open();
      await page.locator('#catalog-days').fill('1,7,30');
      await dirty();
      await page.locator('#catalog-days').fill('30, 7, 1');
      await dirty();
      await page.locator('#catalog-days').fill('1, 7, 30');
      await dirty(false);
    });
    await check('C18', async () => {
      await open();
      const original = initialDetail().draft.description;
      await page.locator('#catalog-description').fill(original.replace(/\r\n?/g, '\r'));
      await dirty(false);
      await page.locator('#catalog-description').fill(original.replace(/\r\n?/g, '\n') + ' ');
      await dirty();
      await page.locator('#catalog-description').fill(original);
      await dirty(false);
    });
    await check('C19', async () => {
      await open();
      await page.locator('#catalog-title').fill('');
      await editor()
        .getByRole('button', { name: '下書きを保存してプレビューする', exact: true })
        .click();
      await page.locator('.error-summary').waitFor();
      assert.equal(await editor().getAttribute('aria-busy'), 'false');
      await page.locator('#catalog-title').fill('未保存の合成サービス');
      await dirty();
      await blockBoth();
    });
    await check('C20', async () => {
      await open({ operation: 'save', status: 400, pending: true, permit: true });
      await fillFull();
      const before = await snapshot();
      await save();
      await page.waitForFunction(
        () => document.querySelector('details form')?.getAttribute('aria-busy') === 'true',
      );
      await waitForPendingAPI();
      await allDisabled();
      await blockBoth();
      assert.deepEqual(await snapshot(), before);
      await capture('C20', 'pending-before-release');
      release();
      await failed();
      await dirty();
      assert.deepEqual(await snapshot(), before);
      versions(7, 5, 3);
    });
    await check('C21', async () => {
      await open({ operation: 'publication', status: 503, pending: true, permit: true });
      const before = await snapshot();
      await publish();
      await page.waitForFunction(
        () =>
          document
            .querySelector('section[aria-label="カタログの編集と公開"] > form')
            ?.getAttribute('aria-busy') === 'true',
      );
      await allDisabled();
      await waitForPendingAPI();
      await blockBoth();
      const writes = report.network.allowedWrites;
      await editor().evaluate((f) => f.requestSubmit());
      await page.waitForTimeout(100);
      assert.equal(report.network.allowedWrites, writes);
      assert.deepEqual(await snapshot(), before);
      await capture('C21', 'pending-before-release');
      release();
      await failed();
      await dirty(false);
      assert.deepEqual(await snapshot(), before);
      versions(7, 5, 3);
    });
    for (const [index, code] of [400, 409, 503].entries())
      await check(catalogEditCases[index + 21], async () => {
        await open({ operation: 'save', status: code, permit: true });
        await fillFull();
        const before = await snapshot();
        await save();
        await failed();
        assert.deepEqual(await snapshot(), before);
        await dirty();
        versions(7, 5, 3);
      });
    for (const [index, code] of [400, 409, 503].entries())
      await check(catalogEditCases[index + 24], async () => {
        await open({ operation: 'publication', status: code, permit: true });
        const before = await snapshot();
        await publish();
        await failed();
        assert.deepEqual(await snapshot(), before);
        await dirty(false);
        versions(7, 5, 3);
      });
    await check('C28', async () => {
      await open({ operation: 'save', status: 200, permit: true });
      await fillFull();
      await save();
      await page.waitForURL(
        (url) => url.pathname === detailPath && url.searchParams.get('saved') === '1',
      );
      await ready();
      versions(8, 6, 3);
      await dirty(false);
      assert.equal(await page.locator('#preview h3').textContent(), fullSaveContent.title);
      assert.equal(
        await page.getByRole('heading', { name: '保存済みの下書き版6', exact: true }).count(),
        1,
      );
      assert.equal(observations().writes.at(-1).bodyValid, true);
      const destination = new URL(page.url());
      report.saveNavigation = {
        pathname: destination.pathname,
        saved: destination.searchParams.get('saved'),
        hash: destination.hash,
      };
    });
    await check('C29', async () => {
      control({ reset: false, operation: 'publication', status: 200, permit: true });
      await publish();
      await page.waitForFunction(() =>
        document.querySelector('main > .notice')?.textContent?.includes('（版6）'),
      );
      await ready();
      versions(9, 6, 6);
      await dirty(false);
      assert.equal(await publication().locator('[value="published"]').isDisabled(), true);
    });
    await check('C30', async () => {
      control({
        reset: false,
        operation: 'publication',
        state: 'unpublished',
        status: 200,
        permit: true,
      });
      await publish('unpublished');
      await page.waitForFunction(() =>
        document.querySelector('main > .notice')?.textContent?.includes('非公開:'),
      );
      await ready();
      versions(10, 6, 6, false);
      assert.equal(await publication().locator('[value="unpublished"]').count(), 0);
      assert.ok((await page.locator('main').textContent()).includes('最後に公開した版'));
    });
    await check('C31', async () => {
      await open({}, createPath);
      const key = await page.locator('[name="creationKey"]').inputValue();
      assert.ok(isUUID(key));
      const before = await page.locator('#catalog-title').inputValue();
      const value = await page.locator('#catalog-template option').nth(1).getAttribute('value');
      await page.locator('#catalog-template').selectOption(value);
      assert.equal(await page.locator('#catalog-title').inputValue(), before);
      await page.getByRole('button', { name: '選んだテンプレートを入力する', exact: true }).click();
      assert.notEqual(await page.locator('#catalog-title').inputValue(), before);
      assert.equal(await page.locator('[name="creationKey"]').inputValue(), key);
      assert.equal(await page.locator('[name="state"]').count(), 0);
    });
    await check('C32', async () => {
      await open({}, createPath);
      const key = await page.locator('[name="creationKey"]').inputValue();
      await page.getByRole('button', { name: '汎用の合成例を入力する', exact: true }).click();
      assert.equal(await page.locator('#catalog-title').inputValue(), '合成アクセス利用申請');
      assert.deepEqual(
        await page.locator('[id^="field-type-"]').evaluateAll((es) => es.map((e) => e.value)),
        ['text', 'select', 'textarea', 'checkbox'],
      );
      await page.getByRole('button', { name: '申請項目を追加する', exact: true }).click();
      await page.getByRole('button', { name: '項目5を下書きから外す', exact: true }).click();
      assert.equal(await page.locator('[name="creationKey"]').inputValue(), key);
    });
    await check('C33', async () => {
      await open({ emptyApprovers: true }, createPath);
      assert.equal(
        await page.getByRole('alert').filter({ hasText: '有効な承認者がいません' }).count(),
        1,
      );
      assert.equal(
        await page
          .getByRole('button', { name: '下書きを保存してプレビューする', exact: true })
          .isDisabled(),
        true,
      );
    });
    await check('C34', async () => {
      await open();
      await page.locator('#catalog-title').fill('消える古い未保存値');
      await dirty();
      control({ rebased: true });
      await page.reload({ waitUntil: 'networkidle' });
      await ready();
      await page.getByText('下書きの項目と承認者を編集する', { exact: true }).click();
      await dirty(false);
      assert.equal(await page.locator('#catalog-title').inputValue(), '新GETの確認済み下書き');
      assert.equal(await editor().locator('[name="expectedVersion"]').inputValue(), '12');
    });
    for (const [id, width] of [
      ['C35', 1280],
      ['C36', 390],
    ])
      await check(id, async () => {
        await open({ long: true }, detailPath, width);
        assert.equal(await page.locator('#preview h3').textContent(), longTitle);
        await page.locator('#catalog-title').fill('未保存の長文' + longTitle);
        await dirty();
        await page.locator('#catalog-title').focus();
        await page.keyboard.press('Tab');
        assert.equal(
          await page.locator('#catalog-description').evaluate((e) => e === document.activeElement),
          true,
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          true,
        );
        await blockBoth();
      });
    for (const [id, code] of [
      ['C37', 401],
      ['C38', 403],
      ['C39', 404],
      ['C40', 503],
    ])
      await check(id, async () => {
        await open(
          { readStatus: code },
          detailPath + '?returnTo=' + encodeURIComponent('/catalog/manage'),
        );
        assert.equal(await page.locator('main form').count(), 0);
        if ([401, 503].includes(code)) {
          assert.equal(
            await page.getByRole('link', { name: '再取得する', exact: true }).getAttribute('href'),
            detailPath + '?returnTo=%2Fcatalog%2Fmanage',
          );
          assert.equal(
            await page
              .getByRole('heading', { name: 'カタログ項目を読み込めませんでした', exact: true })
              .count(),
            1,
          );
        } else assert.ok((await page.locator('main').textContent()).includes('見つかりません'));
      });
    assert.deepEqual(
      report.checks.map((c) => c.name),
      catalogEditCases,
    );
    assert.deepEqual(
      report.screenshots.map((c) => c.name),
      catalogEditCases,
    );
    assert.deepEqual(
      report.accessibility.map((c) => c.name),
      catalogEditCases,
    );
    assert.equal(report.network.allowedWrites, 11);
    assert.equal(observations().mutations, 11);
    assert.ok(observations().writes.every((w) => w.bodyValid && w.completed));
    assert.deepEqual(
      observations().writes.map((w) => [w.sequence, w.operation, w.method, w.path, w.status]),
      [
        ['save', 400],
        ['publication', 503],
        ['save', 400],
        ['save', 409],
        ['save', 503],
        ['publication', 400],
        ['publication', 409],
        ['publication', 503],
        ['save', 200],
        ['publication', 200],
        ['publication', 200],
      ].map(([operation, code], i) => [
        i + 1,
        operation,
        'POST',
        `/catalog-admin/${itemId}/${operation}`,
        code,
      ]),
    );
    assert.equal(observations().releases, 2);
    assert.equal(observations().pending, false);
    assert.equal(
      report.network.nonReadCount +
        report.network.unknownReads +
        report.network.foreign +
        report.network.downloads,
      0,
    );
    report.payloads = observations().writes;
    report.success =
      report.checks.every((c) => c.passed) &&
      report.accessibility.every((a) => a.violations.length === 0);
  } catch {
    report.failureCode = 'UI_ACCEPTANCE';
  } finally {
    const results = await closeOwned();
    signal?.removeEventListener('abort', interrupted);
    report.closeResults = results.map((r) => r.status);
    if (
      results.some((r) => r.status !== 'fulfilled') ||
      !report.contextClosed ||
      !report.browserClosed
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
