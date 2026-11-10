/* global document, window, getComputedStyle */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

export const formFeedbackCases = ['asset', 'catalog', 'knowledge']
  .flatMap((form) =>
    ['default', 'hover', 'keyboard-focus', 'active', 'click-field', 'pending'].map(
      (state) => `${form}-${state}`,
    ),
  )
  .concat(['long-desktop', 'long-mobile', 'primary-hover', 'secondary-hover']);
const routes = {
  asset: '/assets/new',
  catalog: '/catalog/manage/new',
  knowledge: '/knowledge/new',
};
const names = { asset: 'assetTag', catalog: 'title', knowledge: 'title' };
const buttons = {
  asset: '資産を登録する',
  catalog: '下書きを保存してプレビューする',
  knowledge: '下書きを保存する',
};
const fields = {
  asset: {
    assetTag: 'SYN085',
    name: '合成資産',
    model: '合成モデル',
    serialNumber: 'SYN085SERIAL',
    hostname: 'synthetic085',
    vendor: '合成メーカー',
    location: '合成保管場所',
    internalNotes: '合成内部メモ',
    reason: '合成登録理由',
  },
  catalog: {
    code: 'synthetic085',
    title: '合成サービス',
    description: '合成説明',
    targetLabel: '合成対象',
    allowedDurations: '1, 7, 30',
    maxReasonLength: '2000',
  },
  knowledge: { title: '合成記事', body: '合成手順', tags: '合成タグ' },
};
export async function runFormFeedbackContrastChecks({
  baseURL,
  outputDirectory,
  control,
  observations,
  release,
  assertOwned,
  signal,
  baseline = false,
  expectedLongMessage,
}) {
  const report = {
    workPackage: 'WP-P2-FORMFB-085',
    baselineRevision: 'a4c4b50ce4b7e54be2c3183933fb1ca052134e61',
    baseline,
    success: false,
    checks: [],
    screenshots: [],
    accessibility: [],
    styles: [],
    network: {
      nonReadCount: 0,
      allowedWrites: 0,
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
    closePromise,
    permitted = null;
  const closeOwned = () => {
    if (!browser) return Promise.resolve([]);
    closePromise ??= (async () => {
      const results = [];
      if (context)
        results.push(
          ...(await Promise.allSettled([
            context.close().then(() => {
              report.contextClosed = true;
            }),
          ])),
        );
      results.push(
        ...(await Promise.allSettled([
          browser.close().then(() => {
            report.browserClosed = true;
          }),
        ])),
      );
      return results;
    })();
    return closePromise;
  };
  const interrupted = () => {
    void closeOwned();
  };
  signal?.addEventListener('abort', interrupted, { once: true });
  const live = async () => {
    assert.ok(!signal?.aborted);
    await assertOwned();
  };
  const snapshot = () =>
    page
      .locator('main form')
      .first()
      .evaluate((form) =>
        Array.from(form.querySelectorAll('input,textarea,select')).map((e) => ({
          name: e.name,
          value: e.value,
          checked: e.type === 'checkbox' ? e.checked : null,
          disabled: e.disabled,
        })),
      );
  const style = async (locator) =>
    locator.evaluate((e) => {
      const c = getComputedStyle(e);
      let bg = c.backgroundColor,
        parent = e;
      while (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') {
        parent = parent.parentElement;
        if (!parent) break;
        bg = getComputedStyle(parent).backgroundColor;
      }
      const lum = (color) => {
        const rgb = color
          .match(/[\d.]+/g)
          .slice(0, 3)
          .map((n) => Number(n) / 255)
          .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4));
        return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
      };
      const a = lum(c.color),
        b = lum(bg);
      return {
        color: c.color,
        background: c.backgroundColor,
        effectiveBackground: bg,
        contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
        underline: c.textDecorationLine,
        outlineStyle: c.outlineStyle,
        outlineWidth: c.outlineWidth,
        outlineColor: c.outlineColor,
        filter: c.filter,
        borderColor: c.borderColor,
      };
    });
  const capture = async (name, locator) => {
    await live();
    if (locator) await locator.scrollIntoViewIfNeeded();
    const filename = name + '.png',
      path = join(outputDirectory, filename);
    await page.screenshot({ path });
    report.screenshots.push({
      name,
      path: filename,
      sha256: createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
    });
    const axe = await new AxeBuilder({ page }).analyze();
    report.accessibility.push({
      name,
      violations: axe.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.length,
      })),
    });
    if (!baseline) assert.equal(axe.violations.length, 0, 'AXE');
  };
  const check = async (name, operation) => {
    try {
      await live();
      await operation();
      report.checks.push({ name, passed: true });
    } catch (error) {
      report.checks.push({
        name,
        passed: false,
        code: error?.code === 'ERR_ASSERTION' ? 'ASSERTION' : 'UI_OPERATION',
      });
    }
  };
  const open = async (form, mode = 'validation') => {
    await control({ form, mode, permit: mode !== 'validation' });
    permitted = mode === 'validation' ? null : routes[form];
    if (page) await page.close();
    page = await context.newPage();
    page.on('download', () => report.network.downloads++);
    await page.goto(baseURL + routes[form], { waitUntil: 'networkidle' });
    await page.locator('main form').first().waitFor();
    await page.waitForFunction(
      () => document.querySelector('main form')?.getAttribute('inert') === null,
    );
    for (const [name, value] of Object.entries(fields[form]))
      await page.locator('main [name="' + name + '"]').fill(value);
    if (form === 'catalog')
      await page
        .locator('[name="approverId"]')
        .selectOption('08500000-0000-4000-8000-000000000002');
  };
  const errors = async (form) => {
    await open(form);
    await page.locator('[name="' + names[form] + '"]').fill('');
    const before = await snapshot(),
      reads = observations();
    await page.getByRole('button', { name: buttons[form], exact: true }).click();
    const summary = page.locator('.error-summary');
    await summary.waitFor();
    assert.equal(await summary.evaluate((e) => e === document.activeElement), true);
    assert.deepEqual(await snapshot(), before);
    assert.equal(observations().mutations, reads.mutations);
    return { before, mutations: reads.mutations, link: page.locator('.error-link').first() };
  };
  try {
    browser = await chromium.launch({ headless: true });
    await live();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await live();
    await context.addCookies([
      { name: 'solvi_session_wp085_synthetic', value: 'org_admin', url: baseURL },
    ]);
    await context.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin !== new URL(baseURL).origin) {
        report.network.foreign++;
        return route.abort();
      }
      const header = request.headers(),
        prefetch = Boolean(header['next-router-prefetch'] || header.purpose === 'prefetch');
      if (!['GET', 'HEAD'].includes(request.method())) {
        if (
          !prefetch &&
          permitted === url.pathname &&
          request.method() === 'POST' &&
          header['next-action']
        ) {
          permitted = null;
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
        !Object.values(routes).includes(url.pathname) &&
        url.pathname !== '/favicon.ico'
      ) {
        report.network.unknownReads++;
        return route.abort();
      }
      return route.continue();
    });

    for (const form of ['asset', 'catalog', 'knowledge']) {
      for (const state of ['default', 'hover', 'keyboard-focus', 'active'])
        await check(form + '-' + state, async () => {
          const { link, before, mutations } = await errors(form);
          if (state === 'hover') await link.hover();
          if (state === 'keyboard-focus') {
            await page.keyboard.press('Tab');
            assert.equal(await link.evaluate((e) => e === document.activeElement), true);
          }
          if (state === 'active') {
            const box = await link.boundingBox();
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.down();
          }
          await page.waitForTimeout(180);
          const computed = await style(link);
          report.styles.push({ name: form + '-' + state, ...computed });
          if (!baseline || form === 'knowledge') assert.ok(computed.contrast >= 4.5, 'CONTRAST');
          assert.ok(computed.underline.includes('underline'));
          if (state === 'keyboard-focus') {
            assert.notEqual(computed.outlineStyle, 'none');
            assert.ok(parseFloat(computed.outlineWidth) >= 2);
          }
          await capture(form + '-' + state, link);
          if (state === 'active') await page.mouse.up();
          if (state === 'keyboard-focus') {
            for (const key of ['Enter', 'Space']) {
              await link.focus();
              await page.keyboard.press(key);
              assert.equal(
                await page
                  .locator('[name="' + names[form] + '"]')
                  .evaluate((e) => e === document.activeElement),
                true,
              );
            }
          }
          assert.deepEqual(await snapshot(), before);
          assert.equal(observations().mutations, mutations);
        });
      await check(form + '-click-field', async () => {
        const { link, before, mutations } = await errors(form);
        await link.click();
        assert.equal(
          await page
            .locator('[name="' + names[form] + '"]')
            .evaluate((e) => e === document.activeElement),
          true,
        );
        assert.deepEqual(await snapshot(), before);
        await capture(form + '-click-field', link);
        assert.equal(observations().mutations, mutations);
      });
      await check(form + '-pending', async () => {
        await open(form, 'pending');
        const before = await snapshot(),
          mutations = observations().mutations;
        await page.getByRole('button', { name: buttons[form], exact: true }).click();
        await page.waitForFunction(
          () => document.querySelector('main form')?.getAttribute('aria-busy') === 'true',
        );
        await page.waitForTimeout(120);
        assert.equal(observations().mutations, mutations + 1);
        assert.equal(observations().pending, true);
        const button = page.getByRole('button', { name: '保存しています…', exact: true });
        assert.equal(await button.isDisabled(), true);
        await page
          .locator('main form')
          .first()
          .evaluate((form) => form.requestSubmit());
        await page.waitForTimeout(120);
        assert.equal(observations().mutations, mutations + 1);
        const during = await snapshot();
        assert.deepEqual(
          during.map((entry) => ({ name: entry.name, value: entry.value, checked: entry.checked })),
          before.map((entry) => ({ name: entry.name, value: entry.value, checked: entry.checked })),
        );
        await capture(form + '-pending', button);
        release();
        await page.locator('.error-summary').waitFor();
        assert.deepEqual(
          (await snapshot()).map((entry) => ({
            name: entry.name,
            value: entry.value,
            checked: entry.checked,
          })),
          before.map((entry) => ({ name: entry.name, value: entry.value, checked: entry.checked })),
        );
      });
    }
    for (const [name, width] of [
      ['long-desktop', 1280],
      ['long-mobile', 390],
    ])
      await check(name, async () => {
        await open('asset', 'long');
        await page.setViewportSize({ width, height: 900 });
        const before = await snapshot(),
          previousWrites = observations().mutations;
        await page.getByRole('button', { name: buttons.asset, exact: true }).click();
        const link = page.locator('.error-link').first();
        await link.waitFor();
        assert.ok((await link.textContent()).includes(expectedLongMessage));
        assert.equal(observations().mutations, previousWrites + 1);
        assert.deepEqual(observations().writes.at(-1), {
          sequence: previousWrites + 1,
          form: 'asset',
          method: 'POST',
          path: '/assets',
          mode: 'long',
          bodyValid: true,
          status: 400,
          completed: true,
        });
        await link.hover();
        await page.waitForTimeout(180);
        const computed = await style(link);
        report.styles.push({ name, ...computed });
        if (!baseline) assert.ok(computed.contrast >= 4.5);
        assert.deepEqual(await snapshot(), before);
        await capture(name, link);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
          true,
          'DOCUMENT_OVERFLOW',
        );
      });
    for (const type of ['primary', 'secondary'])
      await check(type + '-hover', async () => {
        await open('catalog');
        const locator =
          type === 'primary'
            ? page.getByRole('button', { name: buttons.catalog, exact: true })
            : page.getByRole('button', { name: '汎用の合成例を入力する', exact: true });
        assert.equal(await locator.isEnabled(), true);
        const normal = await style(locator);
        await locator.hover();
        await page.waitForTimeout(180);
        assert.equal(await locator.evaluate((element) => element.matches(':hover')), true);
        const hover = await style(locator);
        report.styles.push({ name: type + '-hover', default: normal, hover });
        await capture(type + '-hover', locator);
      });
    const current = observations();
    assert.equal(current.unexpectedMutations, 0);
    assert.equal(current.unknownReads, 0);
    assert.deepEqual(
      current.writes.map((entry) => [
        entry.form,
        entry.mode,
        entry.method,
        entry.path,
        entry.bodyValid,
        entry.status,
        entry.completed,
      ]),
      [
        ['asset', 'pending', 'POST', '/assets', true, 400, true],
        ['catalog', 'pending', 'POST', '/catalog-admin', true, 400, true],
        ['knowledge', 'pending', 'POST', '/knowledge', true, 400, true],
        ['asset', 'long', 'POST', '/assets', true, 400, true],
        ['asset', 'long', 'POST', '/assets', true, 400, true],
      ],
    );
    assert.equal(current.mutations, 5);
    assert.equal(report.network.allowedWrites, 5);
    assert.deepEqual(
      report.checks.map((c) => c.name),
      formFeedbackCases,
    );
    assert.equal(
      report.network.nonReadCount +
        report.network.unknownReads +
        report.network.foreign +
        report.network.downloads,
      0,
    );
    report.success =
      report.checks.every((c) => c.passed) &&
      report.accessibility.every((s) => s.violations.length === 0);
  } catch {
    report.failureCode = 'UI_ACCEPTANCE';
  } finally {
    const close = await closeOwned();
    signal?.removeEventListener('abort', interrupted);
    report.closeResults = close.map((item) => item.status);
    if (close.some((item) => item.status !== 'fulfilled')) report.success = false;
    await writeFile(
      join(outputDirectory, 'ui-report.json'),
      JSON.stringify(report, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
  }
  return report;
}
