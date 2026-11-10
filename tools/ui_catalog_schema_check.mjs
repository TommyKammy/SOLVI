/* global document, window, innerWidth, getComputedStyle, HTMLElement */
// WP-P2-UIX-040: local synthetic authoring, publication and requester walkthrough.
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

const base = new URL(process.env.SOLVI_UI_BASE ?? 'http://127.0.0.1:3000');
const apiBase = new URL(process.env.SOLVI_API_BASE ?? 'http://127.0.0.1:3001');
for (const url of [base, apiBase])
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname));
const password = process.env.SOLVI_SMOKE_PASSWORD;
assert.ok(password, 'SOLVI_SMOKE_PASSWORD is required');
const browserName = process.env.SOLVI_UI_BROWSER ?? 'chromium';
assert.ok(['chromium', 'webkit'].includes(browserName));
const output = resolve(process.env.SOLVI_UI_OUT ?? `evidence/WP-P2-UIX-040/browser/${browserName}`);
const resumePublished = process.env.SOLVI_UI_RESUME_PUBLISHED === '1';
let previous;
// Never repeat a possibly completed write after a failed or interrupted walkthrough.
try {
  previous = JSON.parse(await readFile(resolve(output, 'summary.json'), 'utf8'));
  if (resumePublished) {
    assert.equal(previous.network.saves, 1);
    assert.equal(previous.network.publications, 1);
    assert.equal(previous.network.requests, 0);
    assert.equal(
      previous.checks.slice(0, 6).every((result) => result.passed),
      true,
    );
    assert.match(previous.createdDraftId, /^[0-9a-f-]{36}$/i);
    assert.match(previous.marker, /^UI040-SYN-\d+-(chromium|webkit)$/);
    assert.equal(previous.browser, browserName);
  } else {
    assert.equal(
      (previous.network?.saves ?? 0) +
        (previous.network?.publications ?? 0) +
        (previous.network?.requests ?? 0),
      0,
      'Prior synthetic writes require read-only reconciliation before another run; keep the existing evidence',
    );
  }
} catch (error) {
  if (error.code !== 'ENOENT' || resumePublished) throw error;
}
const marker = resumePublished ? previous.marker : `UI040-SYN-${Date.now()}-${browserName}`;
const category = resumePublished ? previous.category : `UI040合成機器-${browserName}`;
const trialOnly = 'UI040-PREVIEW-ONLY';
const report = {
  ...(resumePublished ? previous : {}),
  workPackage: 'WP-P2-UIX-040',
  browser: browserName,
  marker,
  category,
  success: false,
  checks: resumePublished ? previous.checks.slice(0, 6) : [],
  accessibility: resumePublished
    ? previous.accessibility.filter((scan) => scan.name.startsWith('authoring-'))
    : [],
  screenshots: resumePublished
    ? previous.screenshots.filter((name) => name.startsWith('authoring-'))
    : [],
  network: resumePublished
    ? { ...previous.network }
    : { authWrites: 0, saves: 0, publications: 0, requests: 0, blocked: [] },
};
let browser, adminContext, requesterContext, adminPage, requesterPage, activePage;
let armed;

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: timeout`)), 20000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function check(name, run) {
  report.currentStep = name;
  await writeReport();
  try {
    await run();
    report.checks.push({ name, passed: true });
  } catch (error) {
    report.checks.push({ name, passed: false });
    throw error;
  }
}
async function writeReport() {
  await writeFile(resolve(output, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
}
async function guard(context) {
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === base.origin && ['GET', 'HEAD'].includes(request.method()))
      return route.continue();
    if (
      url.origin === base.origin &&
      request.method() === 'POST' &&
      ['/login', '/select-organization'].includes(url.pathname)
    ) {
      report.network.authWrites++;
      return route.continue();
    }
    if (
      url.origin === base.origin &&
      request.method() === 'POST' &&
      armed &&
      url.pathname === armed.path &&
      !armed.arrived
    ) {
      const current = armed;
      current.arrived = true;
      try {
        const wire = await new Request(request.url(), {
          method: 'POST',
          headers: { 'content-type': request.headers()['content-type'] },
          body: request.postDataBuffer(),
        }).formData();
        current.entries = [...wire.entries()]
          .filter(([, value]) => typeof value === 'string')
          .map(([key, value]) => [key.replace(/^_?\d+_/, ''), value]);
        current.onWire(current.entries);
      } catch (error) {
        current.error = error;
      }
      current.arrival.resolve();
      await current.release.promise;
      if (current.approved && !current.error) {
        report.network[current.counter]++;
        await writeReport();
        return route.continue();
      }
      return route.abort();
    }
    report.network.blocked.push({ method: request.method(), path: url.pathname });
    return route.abort();
  });
}
function arm(path, counter, onWire) {
  assert.equal(armed, undefined);
  assert.equal(report.network[counter], 0, 'Only one write of each kind is allowed');
  armed = { path, counter, onWire, arrival: deferred(), release: deferred(), approved: false };
  return armed;
}
async function release(current, validate) {
  try {
    await bounded(current.arrival.promise, 'Synthetic action arrival');
    if (current.error) throw current.error;
    await validate();
    current.approved = true;
  } finally {
    current.release.resolve();
    armed = undefined;
  }
}
async function login(context, email) {
  const page = await context.newPage();
  activePage = page;
  page.setDefaultTimeout(20000);
  await page.goto(new URL('/login', base).href);
  await page.getByLabel('メールアドレス', { exact: true }).fill(email);
  await page.getByLabel('パスワード', { exact: true }).fill(password);
  await Promise.all([
    page.waitForURL((url) => url.pathname !== '/login'),
    page.getByRole('button', { name: 'ログイン', exact: true }).click(),
  ]);
  if (new URL(page.url()).pathname === '/select-organization') {
    await page.getByLabel('サンプル株式会社', { exact: true }).check();
    await Promise.all([
      page.waitForURL((url) => url.pathname !== '/select-organization'),
      page.getByRole('button', { name: 'この組織で続ける', exact: true }).click(),
    ]);
  }
  await page.waitForLoadState('networkidle');
  return page;
}
async function readApi(context, path) {
  const response = await context.request.get(new URL(path, apiBase).href);
  assert.equal(response.status(), 200, `Read-only API ${path}`);
  return response.json();
}
async function screenshot(page, name, top = false) {
  if (top)
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      window.scrollTo(0, 0);
      const preview = document.getElementById('catalog-live-preview');
      if (preview) preview.scrollTop = 0;
    });
  await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: false });
  report.screenshots.push(`${name}.png`);
}
async function axe(page, name) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const violations = result.violations.map(({ id, impact, nodes }) => ({
    id,
    impact,
    targets: nodes.map((node) => node.target),
  }));
  report.accessibility.push({ name, violations });
  assert.deepEqual(violations, [], `axe ${name}`);
}
async function uniqueIds(page) {
  const duplicates = await page.evaluate(() => {
    const ids = [...document.querySelectorAll('[id]')].map((node) => node.id);
    return [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  });
  assert.deepEqual(duplicates, []);
}
async function width(page) {
  const dimensions = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }));
  assert.ok(dimensions.document <= dimensions.viewport, 'No horizontal page overflow');
  return dimensions;
}
const editor = () => adminPage.locator('form:has(#catalog-title)');
const trial = () => adminPage.getByRole('form', { name: '編集中フォームの入力試験', exact: true });
const feedback = () => trial().getByRole('status');
const trialControl = (label) => trial().getByLabel(label, { exact: true });
async function editorData() {
  return editor().evaluate((form) =>
    [...new FormData(form).entries()].filter(
      ([key, value]) => !key.startsWith('$ACTION') && typeof value === 'string',
    ),
  );
}
async function testTrial() {
  await trial().getByRole('button', { name: '入力を試す', exact: true }).click();
  await feedback().waitFor();
}
async function noPreviewWrites(run) {
  const before = JSON.stringify(report.network);
  await run();
  await adminPage.waitForTimeout(150);
  assert.equal(JSON.stringify(report.network), before, 'Preview must not send business writes');
}
async function fillTrial() {
  await trialControl('利用する理由（必須）').fill(trialOnly);
  await trialControl('利用部署（必須）').fill(trialOnly);
  await trialControl('貸与区分（必須）').selectOption('標準貸与');
  await trialControl('希望する端末（必須）').selectOption('WindowsノートPC');
  await trialControl('受取方法（必須）').selectOption('社内窓口');
  await trialControl('貸与開始希望日（必須）').fill('2026-12-01');
  await trialControl('希望台数（必須）').fill('0');
  await trial().getByLabel('モニター', { exact: true }).check();
  await trial().getByLabel('マウス', { exact: true }).check();
  await trial()
    .getByRole('checkbox', { name: /合成情報での模擬申請/ })
    .check();
}

async function main() {
  await mkdir(output, { recursive: true });
  browser = await (browserName === 'webkit' ? webkit : chromium).launch(
    browserName === 'chromium' ? { channel: process.env.SOLVI_UI_BROWSER_CHANNEL ?? 'chrome' } : {},
  );
  report.browserVersion = browser.version();
  adminContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await guard(adminContext);
  adminPage = await login(adminContext, 'org_admin@acme.example.test');
  let expectedFields, expectedSections, code, draftId, published;

  if (!resumePublished) {
    await check(
      'Operator creates category, sections, help and all new question types from the PC template',
      async () => {
        await adminPage.goto(new URL('/catalog/manage/new', base).href);
        await adminPage.getByLabel('申請の種類', { exact: true }).selectOption('local-pc-loan');
        await adminPage
          .getByRole('button', { name: '選んだテンプレートを入力する', exact: true })
          .click();
        await adminPage.locator('#catalog-title').fill(marker);
        await adminPage
          .locator('#catalog-description')
          .fill('合成PC貸与の入力型・条件表示・公開・申請確認です。実際の貸出は行いません。');
        await adminPage.getByLabel('業務カテゴリ', { exact: true }).fill(category);
        await adminPage
          .locator('#catalog-approver')
          .selectOption({ label: 'サンプル株式会社 approver' });
        await adminPage.locator('#field-help-0').fill('合成の部署名を入力してください。');
        await adminPage.locator('#field-min-number-6').fill('0');
        await adminPage.locator('#field-min-date-4').fill('2026-11-01');
        await adminPage.locator('#field-max-date-4').fill('2027-12-31');
        await adminPage.locator('#field-min-date-5').fill('2026-11-01');
        await adminPage.locator('#field-max-date-5').fill('2027-12-31');
        await adminPage.getByRole('button', { name: 'セクション2を上へ', exact: true }).click();
        await adminPage.getByRole('button', { name: 'セクション1を下へ', exact: true }).click();
        expectedFields = JSON.parse(await editor().locator('[name="fields"]').inputValue());
        expectedSections = JSON.parse(await editor().locator('[name="sections"]').inputValue());
        code = await editor().locator('[name="code"]').inputValue();
        report.managementCode = code;
        assert.match(code, /^service-[0-9a-f-]{36}$/i);
        assert.equal(expectedFields.length, 9);
        assert.deepEqual(
          expectedSections.map((section) => section.key),
          ['loan', 'delivery'],
        );
        assert.equal(expectedFields.find((field) => field.key === 'quantity').min, 0);
        assert.deepEqual(expectedFields.find((field) => field.key === 'return_date').visibleWhen, {
          field: 'loan_kind',
          equals: '一時貸出',
        });
        for (const type of ['date', 'number', 'multiselect'])
          assert.ok(expectedFields.some((field) => field.type === type));
        assert.equal(
          await trial().getByRole('heading', { name: '貸与内容', exact: true }).count(),
          1,
        );
        await screenshot(adminPage, 'authoring-desktop-1440', true);
      },
    );

    await check(
      'Preview validates date and number bounds, accepts zero and keeps multiple selections without sending',
      async () =>
        noPreviewWrites(async () => {
          await fillTrial();
          assert.equal(await trialControl('返却希望日（必須）').count(), 0);
          await testTrial();
          assert.match(await feedback().innerText(), /入力を確認しました/);
          await trialControl('貸与開始希望日（必須）').fill('2025-12-31');
          await testTrial();
          assert.match(await feedback().innerText(), /貸与開始希望日/);
          await trialControl('貸与開始希望日（必須）').fill('2026-12-01');
          await trialControl('希望台数（必須）').fill('11');
          await testTrial();
          assert.match(await feedback().innerText(), /希望台数/);
          await trialControl('希望台数（必須）').fill('0');
          await testTrial();
          assert.match(await feedback().innerText(), /入力を確認しました/);
          assert.equal(await trial().getByLabel('マウス', { exact: true }).isChecked(), true);
          assert.equal(await trial().getByLabel('モニター', { exact: true }).isChecked(), true);
          assert.equal(
            await trial().getByText('必要なものをすべて選んでください。', { exact: true }).count(),
            1,
          );
          await trialControl('希望台数（必須）').press('Enter');
          await feedback().waitFor();
          report.previewBusinessWrites = 0;
        }),
    );

    await check(
      'Changing the controlling answer prunes hidden required dates and never restores old samples',
      async () =>
        noPreviewWrites(async () => {
          await trialControl('貸与区分（必須）').selectOption('一時貸出');
          await trialControl('返却希望日（必須）').waitFor();
          await testTrial();
          assert.match(await feedback().innerText(), /返却希望日/);
          await trialControl('返却希望日（必須）').fill('2026-12-20');
          await testTrial();
          assert.match(await feedback().innerText(), /入力を確認しました/);
          await trialControl('貸与区分（必須）').selectOption('標準貸与');
          assert.equal(await trialControl('返却希望日（必須）').count(), 0);
          await trialControl('貸与区分（必須）').selectOption('一時貸出');
          assert.equal(await trialControl('返却希望日（必須）').inputValue(), '');
          await trialControl('貸与区分（必須）').selectOption('標準貸与');
          await testTrial();
          assert.match(await feedback().innerText(), /入力を確認しました/);
          const data = await editorData();
          assert.equal(
            data.some(([key]) => /^(value|number|checkbox|multiselect):/.test(key)),
            false,
          );
          assert.equal(
            data.some(([, value]) => value.includes(trialOnly)),
            false,
          );
        }),
    );

    await check(
      'Desktop and 375px authoring have unique IDs, keyboard access and no axe violations',
      async () => {
        await uniqueIds(adminPage);
        await axe(adminPage, 'authoring-desktop');
        await adminPage.getByRole('link', { name: '利用者フォームを試す', exact: true }).focus();
        const key = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
        await adminPage.keyboard.press(key);
        const focused = await adminPage.evaluate(() => ({
          tag: document.activeElement?.tagName,
          visible: Boolean(document.activeElement?.getClientRects().length),
          ring: document.activeElement ? getComputedStyle(document.activeElement).boxShadow : '',
        }));
        assert.equal(focused.visible, true);
        report.keyboard = { key, ...focused };
        await adminPage.setViewportSize({ width: 375, height: 900 });
        report.authoringMobileWidth = await width(adminPage);
        await axe(adminPage, 'authoring-mobile-375');
        await screenshot(adminPage, 'authoring-mobile-375', true);
        await adminPage.setViewportSize({ width: 1440, height: 900 });
      },
    );

    await check(
      'Exactly one synthetic draft save retains metadata and excludes preview answers while pending is locked',
      async () => {
        const expected = new Map(await editorData());
        const current = arm('/catalog/manage/new', 'saves', (entries) => {
          const wire = new Map(entries);
          for (const [key, value] of expected)
            assert.equal(
              wire.get(key)?.replaceAll('\r\n', '\n'),
              value.replaceAll('\r\n', '\n'),
              `Wire field ${key}`,
            );
          assert.equal(
            entries.some(([key]) => /^(value|number|checkbox|multiselect):/.test(key)),
            false,
          );
          assert.equal(
            entries.some(([, value]) => value.includes(trialOnly)),
            false,
          );
          assert.equal(wire.get('code'), code);
          assert.deepEqual(JSON.parse(wire.get('fields')), expectedFields);
          assert.deepEqual(JSON.parse(wire.get('sections')), expectedSections);
          assert.equal(wire.get('category'), category);
        });
        const navigation = adminPage.waitForURL((url) =>
          /^\/catalog\/manage\/[0-9a-f-]{36}$/.test(url.pathname),
        );
        void navigation.catch(() => undefined);
        await adminPage
          .getByRole('button', { name: '下書きを保存してプレビューする', exact: true })
          .click({ noWaitAfter: true });
        await release(current, async () => {
          await trial().locator('fieldset[disabled]').first().waitFor();
          assert.equal(
            await trial().getByRole('button', { name: '入力を試す', exact: true }).isDisabled(),
            true,
          );
        });
        await navigation;
        await adminPage.getByRole('heading', { level: 1, name: marker, exact: true }).waitFor();
        draftId = new URL(adminPage.url()).pathname.split('/').at(-1);
        report.createdDraftId = draftId;
        const saved = await readApi(adminContext, `/catalog-admin/${draftId}`);
        assert.equal(saved.code, code);
        assert.equal(saved.draft.definition.category, category);
        assert.deepEqual(saved.draft.definition.sections, expectedSections);
        assert.deepEqual(saved.draft.definition.fields, expectedFields);
        assert.equal(saved.active, false);
        report.savedPayload = {
          fields: expectedFields.length,
          sections: expectedSections.length,
          categoryPreserved: true,
          fieldKeysPreserved: true,
          previewSamplesExcluded: true,
        };
        await writeReport();
      },
    );

    await check(
      'Own synthetic saved version publishes once and is listed under its business category',
      async () => {
        const current = arm(`/catalog/manage/${draftId}`, 'publications', (entries) => {
          assert.equal(new Map(entries).get('state'), 'published');
        });
        await adminPage
          .getByRole('button', { name: /^保存済みの下書き版\d+を公開する$/ })
          .click({ noWaitAfter: true });
        await release(current, async () => {
          await adminPage.locator('button[name="state"]:disabled').first().waitFor();
          assert.equal(
            await adminPage
              .getByRole('button', { name: /^保存済みの下書き版\d+を公開する$/ })
              .isDisabled(),
            true,
          );
        });
        await adminPage.locator('main > p.notice').filter({ hasText: '公開中:' }).waitFor();
        const saved = await readApi(adminContext, `/catalog-admin/${draftId}`);
        assert.equal(saved.active, true);
        assert.equal(saved.publishedRevision, 1);
        published = saved.published;
        report.publishedRevision = saved.publishedRevision;
      },
    );
  } else {
    draftId = previous.createdDraftId;
    const saved = await readApi(adminContext, `/catalog-admin/${draftId}`);
    assert.equal(saved.code, previous.managementCode);
    assert.equal(saved.draft.title, marker);
    assert.equal(saved.active, true);
    assert.equal(saved.publishedRevision, 1);
    assert.equal(saved.published.definition.category, category);
    assert.equal(saved.published.definition.fields.length, 9);
    expectedFields = saved.published.definition.fields;
    expectedSections = saved.published.definition.sections;
    published = saved.published;
    report.recovery = {
      reusedPublishedDraft: draftId,
      additionalDraftCreates: 0,
      additionalPublications: 0,
      priorRequestReachedServer: false,
      reason: 'Requester controls now wait for the hydrated form before the first fill',
    };
  }

  requesterContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await guard(requesterContext);
  requesterPage = await login(requesterContext, 'requester@acme.example.test');
  activePage = requesterPage;
  await check(
    'Requester filters by the new category independently of the legacy target parameter',
    async () => {
      await requesterPage.goto(
        new URL(`/catalog?category=${encodeURIComponent(category)}`, base).href,
      );
      const card = requesterPage.locator('.fs-catalog-card').filter({ hasText: marker });
      await card.waitFor();
      assert.equal(await requesterPage.locator('.fs-catalog-card').count(), 1);
      const href = await card.getAttribute('href');
      assert.equal(new URL(href, base).pathname, `/catalog/${draftId}`);
      await screenshot(requesterPage, 'category-desktop-1440', true);
      await requesterPage.goto(
        new URL(`/catalog?target=${encodeURIComponent(category)}`, base).href,
      );
      assert.equal(
        await requesterPage.locator('.fs-catalog-card').filter({ hasText: marker }).count(),
        0,
      );
      const target = expectedFields.length && published.definition.targetLabel;
      await requesterPage.goto(new URL(`/catalog?target=${encodeURIComponent(target)}`, base).href);
      await requesterPage.locator('.fs-catalog-card').filter({ hasText: marker }).waitFor();
      await requesterPage.goto(new URL(`/catalog/${draftId}`, base).href);
      await requesterPage.getByRole('heading', { level: 1, name: marker, exact: true }).waitFor();
      await requesterPage
        .locator('input[name="idempotencyKey"]:not([value=""])')
        .waitFor({ state: 'attached' });
      await requesterPage
        .locator('form button:enabled')
        .filter({ hasText: '申請する（模擬）' })
        .waitFor();
      await requesterPage.waitForLoadState('networkidle');
    },
  );

  await check(
    'Requester sees sections and help and can clear a previously entered conditional date',
    async () => {
      const p = requesterPage;
      await p.getByLabel('利用する理由', { exact: true }).fill('UI040合成申請の確認');
      await p.getByLabel('利用部署（必須）', { exact: true }).fill('UI040合成部署');
      await p.getByLabel('貸与区分（必須）', { exact: true }).selectOption('一時貸出');
      await p.getByLabel('希望する端末（必須）', { exact: true }).selectOption('WindowsノートPC');
      await p.getByLabel('受取方法（必須）', { exact: true }).selectOption('社内窓口');
      await p.getByLabel('貸与開始希望日（必須）', { exact: true }).fill('2026-12-01');
      await p.getByLabel('返却希望日（必須）', { exact: true }).fill('2026-12-20');
      await p.getByLabel('希望台数（必須）', { exact: true }).fill('0');
      await p.getByLabel('モニター', { exact: true }).check();
      await p.getByLabel('マウス', { exact: true }).check();
      await p.getByRole('checkbox', { name: /合成情報での模擬申請/ }).check();
      assert.equal(await p.getByRole('heading', { name: '貸与内容', exact: true }).count(), 1);
      assert.equal(
        await p.getByText('合成の部署名を入力してください。', { exact: true }).count(),
        1,
      );
      await screenshot(p, 'request-form-desktop-1440', true);
      await p.getByLabel('貸与区分（必須）', { exact: true }).selectOption('標準貸与');
      assert.equal(await p.getByLabel('返却希望日（必須）', { exact: true }).count(), 0);
      await p.getByLabel('貸与区分（必須）', { exact: true }).selectOption('一時貸出');
      assert.equal(await p.getByLabel('返却希望日（必須）', { exact: true }).inputValue(), '');
      await p.getByLabel('貸与区分（必須）', { exact: true }).selectOption('標準貸与');
      await uniqueIds(p);
      await axe(p, 'request-form-desktop');
      await p.setViewportSize({ width: 375, height: 900 });
      report.requestMobileWidth = await width(p);
      await axe(p, 'request-form-mobile-375');
      await screenshot(p, 'request-form-mobile-375', true);
      await p.getByRole('heading', { name: '貸与内容', exact: true }).scrollIntoViewIfNeeded();
      await screenshot(p, 'request-fields-mobile-375');
      await p.setViewportSize({ width: 1440, height: 900 });
    },
  );

  await check(
    'Requester submits exactly once with numeric zero, multiple choices and no hidden date',
    async () => {
      const current = arm(`/catalog/${draftId}`, 'requests', (entries) => {
        const wire = new Map(entries);
        assert.equal(wire.get('value:quantity'), '0');
        assert.equal(wire.has('value:return_date'), false);
        assert.deepEqual(
          entries.filter(([key]) => key === 'value:peripherals').map(([, value]) => value),
          ['マウス', 'モニター'],
        );
      });
      const navigation = requesterPage.waitForURL((url) =>
        /^\/requests\/[0-9a-f-]{36}$/.test(url.pathname),
      );
      void navigation.catch(() => undefined);
      await requesterPage
        .getByRole('button', { name: '申請する（模擬）', exact: true })
        .click({ noWaitAfter: true });
      await release(current, async () => {
        await requesterPage.getByRole('button', { name: '保存しています…', exact: true }).waitFor();
        assert.equal(
          await requesterPage
            .getByRole('button', { name: '保存しています…', exact: true })
            .isDisabled(),
          true,
        );
      });
      await navigation;
      await requesterPage
        .getByRole('heading', { level: 2, name: '承認待ち', exact: true })
        .waitFor();
      const requestId = new URL(requesterPage.url()).pathname.split('/').at(-1);
      report.createdRequestId = requestId;
      const detail = await readApi(requesterContext, `/service-requests/${requestId}`);
      const snapshot = detail.request.snapshot;
      assert.equal(snapshot.item.id, draftId);
      assert.equal(snapshot.item.version, 1);
      assert.equal(snapshot.item.definition.category, category);
      assert.deepEqual(snapshot.item.definition.sections, expectedSections);
      assert.deepEqual(snapshot.item.definition.fields, expectedFields);
      assert.equal(snapshot.inputs.values.quantity, 0);
      assert.deepEqual(snapshot.inputs.values.peripherals, ['マウス', 'モニター']);
      assert.equal(Object.hasOwn(snapshot.inputs.values, 'return_date'), false);
      report.snapshot = {
        version: snapshot.item.version,
        category,
        sections: expectedSections.length,
        numericZero: true,
        multiselect: snapshot.inputs.values.peripherals,
        hiddenDateExcluded: true,
      };
      const numberRow = requesterPage
        .locator('dt')
        .filter({ hasText: /^希望台数$/ })
        .locator('..');
      assert.equal(await numberRow.locator('dd').first().innerText(), '0');
      await uniqueIds(requesterPage);
      await axe(requesterPage, 'request-confirmation-desktop');
      await screenshot(requesterPage, 'request-confirmation-desktop-1440', true);
      await requesterPage.reload();
      await requesterPage
        .getByRole('heading', { level: 2, name: '承認待ち', exact: true })
        .waitFor();
      assert.equal(await numberRow.locator('dd').first().innerText(), '0');
    },
  );
  assert.equal(report.network.saves, 1);
  assert.equal(report.network.publications, 1);
  assert.equal(report.network.requests, 1);
  assert.deepEqual(report.network.blocked, []);
  report.success = true;
  report.currentStep = 'complete';
  delete report.failure;
  await rm(resolve(output, 'failure.png'), { force: true });
}

try {
  await main();
} catch (error) {
  report.failure = String(error?.message ?? error)
    .replaceAll(password, '<redacted>')
    .slice(0, 2000);
  if (activePage) {
    try {
      await activePage.screenshot({ path: resolve(output, 'failure.png'), fullPage: false });
    } catch {
      /* Keep the structured failure even when the page disappeared. */
    }
  }
  process.exitCode = 1;
} finally {
  if (armed) {
    armed.approved = false;
    armed.release.resolve();
  }
  await writeReport();
  await requesterContext?.close();
  await adminContext?.close();
  await browser?.close();
  await writeReport();
  console.log(
    `Catalog schema ${browserName}: ${report.success ? 'PASS' : 'FAIL'}; ${report.checks.length} checks; ${report.accessibility.length} axe scans; saves=${report.network.saves}, publications=${report.network.publications}, requests=${report.network.requests}`,
  );
}
