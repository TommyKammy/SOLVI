/* global document, innerWidth */
// WP-P2-UIX-042: loopback-only synthetic authoring and requester walkthrough.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

const base = new URL(process.env.SOLVI_UI_BASE ?? 'http://127.0.0.1:3000');
const apiBase = new URL(process.env.SOLVI_API_BASE ?? 'http://127.0.0.1:3001');
for (const url of [base, apiBase])
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname));
const password = process.env.SOLVI_SMOKE_PASSWORD;
assert.ok(password, 'SOLVI_SMOKE_PASSWORD is required');
const engine = process.env.SOLVI_UI_BROWSER ?? 'chromium';
assert.ok(['chromium', 'webkit'].includes(engine));
const output = resolve(process.env.SOLVI_UI_OUT ?? `evidence/WP-P2-UIX-042/browser/${engine}`);
const resume = process.env.SOLVI_UI_RESUME === '1';
let previous;
try {
  previous = JSON.parse(await readFile(resolve(output, 'summary.json'), 'utf8'));
  if (Object.values(previous.writes ?? {}).some((count) => count > 0))
    assert.ok(resume, 'Recorded writes require SOLVI_UI_RESUME=1 and read-only reconciliation');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (resume) {
  assert.equal(previous?.browser, engine);
  assert.match(previous.marker, /^UI042-SYN-\d+-(chromium|webkit)$/);
}
const marker = resume ? previous.marker : `UI042-SYN-${Date.now()}-${engine}`;
const report = resume
  ? { ...previous, success: false }
  : {
      workPackage: 'WP-P2-UIX-042',
      browser: engine,
      marker,
      success: false,
      checks: [],
      accessibility: [],
      screenshots: [],
      writes: { save: 0, publication: 0, request: 0, edit: 0 },
      ids: {},
      blocked: [],
    };
let browser, activePage, armed;
const contexts = new Map();
const pages = new Map();
const flush = () =>
  writeFile(resolve(output, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
const editor = (page) => page.locator('form:has(#catalog-title)');
const trial = (page) => page.getByRole('form', { name: '編集中フォームの入力試験', exact: true });
const reasonToggle = (page) => page.locator('#catalog-show-reason');
const durationToggle = (page) => page.locator('#catalog-show-duration');
const field = (page, key) => page.locator(`#request-field-${key}`);
const confirmLabel = /合成情報での模擬申請であり/;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
const snapshotHash = (snapshot) => createHash('sha256').update(canonical(snapshot)).digest('hex');

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => (resolvePromise = resolve));
  return { promise, resolve: resolvePromise };
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Synthetic action arrival timed out')), 20000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function check(name, run) {
  report.currentStep = name;
  await flush();
  await run();
  report.checks = report.checks.filter((entry) => entry.name !== name);
  report.checks.push({ name, passed: true });
  await flush();
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
    )
      return route.continue();
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
        const form = await new Request(request.url(), {
          method: 'POST',
          headers: { 'content-type': request.headers()['content-type'] },
          body: request.postDataBuffer(),
        }).formData();
        const entries = [...form.entries()]
          .filter(([, value]) => typeof value === 'string')
          .map(([key, value]) => [key.replace(/^_?\d+_/, ''), value]);
        current.validate(entries);
      } catch (error) {
        current.error = error;
      }
      current.arrival.resolve();
      await current.release.promise;
      if (current.approved && !current.error) {
        report.writes[current.kind]++;
        await flush();
        return route.continue();
      }
      return route.abort();
    }
    report.blocked.push({ method: request.method(), path: url.pathname });
    return route.abort();
  });
}
async function actor(name) {
  if (pages.has(name)) return pages.get(name);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  contexts.set(name, context);
  await guard(context);
  const page = await context.newPage();
  activePage = page;
  page.setDefaultTimeout(20000);
  await page.goto(new URL('/login', base).href);
  await page.getByLabel('メールアドレス', { exact: true }).fill(`${name}@acme.example.test`);
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
  pages.set(name, page);
  return page;
}
async function readApi(name, path) {
  const response = await contexts.get(name).request.get(new URL(path, apiBase).href);
  assert.equal(response.status(), 200, `Read-only API ${path}`);
  return response.json();
}
async function mutate(page, button, path, kind, validate) {
  assert.equal(armed, undefined);
  assert.equal(report.writes[kind], 0, 'Only one attempt per synthetic mutation is allowed');
  const invalid = await button.evaluate((node) =>
    [...node.form.elements]
      .filter((element) => element.willValidate && !element.validity.valid)
      .map((element) => element.id || element.name),
  );
  assert.deepEqual(invalid, [], 'The hydrated form must be valid before submitting');
  const current = { path, kind, validate, arrival: deferred(), release: deferred() };
  armed = current;
  await button.click({ noWaitAfter: true });
  try {
    await bounded(current.arrival.promise);
    if (current.error) throw current.error;
    current.approved = true;
  } finally {
    current.release.resolve();
    armed = undefined;
  }
}
async function shot(page, name, target) {
  if (target) await target.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: false });
  if (!report.screenshots.includes(`${name}.png`)) report.screenshots.push(`${name}.png`);
}
async function accessible(page, name) {
  const dimensions = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: innerWidth,
    duplicateIds: [...document.querySelectorAll('[id]')]
      .map((node) => node.id)
      .filter((id, index, ids) => ids.indexOf(id) !== index),
  }));
  assert.ok(dimensions.document <= dimensions.viewport, 'No horizontal overflow');
  assert.deepEqual(dimensions.duplicateIds, [], 'Every control ID must be unique');
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const violations = result.violations.map(({ id, impact, nodes }) => ({
    id,
    impact,
    targets: nodes.map((node) => node.target),
  }));
  report.accessibility = report.accessibility.filter((scan) => scan.name !== name);
  report.accessibility.push({ name, dimensions, violations });
  assert.deepEqual(violations, [], `axe ${name}`);
}
async function mobile(page, name, target) {
  await mobileViewport(page);
  await accessible(page, `${name}-mobile-375`);
  await shot(page, `${name}-mobile-375`, target);
  await page.setViewportSize({ width: 1440, height: 900 });
}
async function mobileViewport(page) {
  await page.setViewportSize({ width: 375, height: 900 });
  await page.keyboard.press('Escape');
  // Wait for the responsive rail transition before measuring or photographing the form.
  await page.waitForFunction(() => {
    const rail = document.querySelector('.fs-rail');
    return !rail || rail.getBoundingClientRect().right <= 1;
  });
}
async function applyTemplate(page, code) {
  await page.locator('#catalog-template').selectOption(code);
  await page.getByRole('button', { name: '選んだテンプレートを入力する', exact: true }).click();
}
async function requestValues(page, edited = false) {
  const form = page.locator('form:has([name="idempotencyKey"])');
  assert.equal(await form.locator('[name="reason"], [name="durationDays"]').count(), 0);
  await form.getByLabel('ノートPC', { exact: true }).check();
  await form.getByLabel('モニター', { exact: true }).check();
  await field(page, 'pc_type').selectOption('Windows');
  await field(page, 'monitor_size').selectOption('大画面');
  // A removed answer must not reappear when its parent option is selected again.
  await form.getByLabel('モニター', { exact: true }).uncheck();
  await field(page, 'monitor_size').waitFor({ state: 'detached' });
  await form.getByLabel('モニター', { exact: true }).check();
  assert.equal(await field(page, 'monitor_size').inputValue(), '');
  await field(page, 'monitor_size').selectOption(edited ? '標準サイズ' : '大画面');
  await field(page, 'employee_name').fill('合成 利用者');
  await field(page, 'department').fill(edited ? '合成検証部（変更）' : '合成検証部');
  await field(page, 'start_date').fill('2026-12-01');
  await field(page, 'delivery_date').fill('2026-12-01');
  await field(page, 'delivery_method').selectOption('配送');
  await field(page, 'delivery_address').fill('合成配送先。実住所ではありません。');
  await field(page, 'delivery_method').selectOption('社内窓口');
  await field(page, 'delivery_address').waitFor({ state: 'detached' });
  if (!edited) {
    await field(page, 'delivery_method').selectOption('配送');
    assert.equal(await field(page, 'delivery_address').inputValue(), '');
    await field(page, 'delivery_address').fill('合成配送先。実住所ではありません。');
  }
  await form.getByLabel(confirmLabel).check();
  return form;
}
function validateWire(entries, edited = false) {
  const wire = new Map(entries);
  assert.ok(!wire.has('reason') && !wire.has('durationDays'), 'Hidden common inputs are absent');
  assert.deepEqual(
    entries.filter(([key]) => key === 'value:hardware_items').map(([, value]) => value),
    ['ノートPC', 'モニター'],
  );
  assert.equal(wire.get('value:department'), edited ? '合成検証部（変更）' : '合成検証部');
  if (edited) assert.ok(!wire.has('value:delivery_address'), 'Hidden stale address is absent');
}
async function reconcile() {
  if (!resume) return;
  const evidence = [];
  if (report.writes.save) {
    if (!report.ids.catalog) {
      const list = await readApi('org_admin', '/catalog-admin');
      const matches = list.items.filter((item) => item.code === report.code);
      assert.equal(matches.length, 1, 'An uncertain save must resolve to exactly one catalog');
      report.ids.catalog = matches[0].id;
    }
    const item = await readApi('org_admin', `/catalog-admin/${report.ids.catalog}`);
    assert.equal(item.code, report.code);
    assert.equal(item.draft.title, marker);
    assert.deepEqual(item.draft.definition.requestFields, { reason: false, duration: false });
    evidence.push({ mutation: 'save', id: item.id, confirmed: true });
    if (report.writes.publication) {
      assert.equal(item.active, true, 'An uncertain publication must already be visible');
      report.publishedVersion = item.published.version ?? item.publishedRevision;
      evidence.push({ mutation: 'publication', revision: item.publishedRevision, confirmed: true });
    }
  }
  if (report.writes.request) {
    if (!report.ids.request) {
      const list = await readApi('requester', `/service-requests?q=${encodeURIComponent(marker)}`);
      const matches = list.items.filter((item) => item.title === marker && item.own);
      assert.equal(
        matches.length,
        1,
        'An uncertain submission must resolve to exactly one request',
      );
      report.ids.request = matches[0].id;
    }
    const detail = await readApi('requester', `/service-requests/${report.ids.request}`);
    assert.equal(detail.request.snapshot.item.id, report.ids.catalog);
    assert.equal(detail.request.revision, report.writes.edit ? 2 : 1);
    if (!report.initialSnapshot) {
      const original = detail.history.find((approval) => approval.revision === 1);
      assert.ok(original, 'The original request must remain available for reconciliation');
      report.initialSnapshot = {
        item: original.item,
        inputs: original.inputs,
        requesterId: detail.request.snapshot.requesterId,
      };
      report.initialHash = snapshotHash(report.initialSnapshot);
    }
    evidence.push({ mutation: 'request', id: detail.request.id, confirmed: true });
    if (report.writes.edit) evidence.push({ mutation: 'edit', revision: 2, confirmed: true });
  }
  report.reconciliation = [...(report.reconciliation ?? []), ...evidence];
  await flush();
}

async function main() {
  await mkdir(output, { recursive: true });
  browser = await (engine === 'webkit' ? webkit : chromium).launch(
    engine === 'chromium' ? { channel: 'chrome', headless: true } : { headless: true },
  );
  report.browserVersion = browser.version();
  const admin = await actor('org_admin');
  const requester = await actor('requester');
  await reconcile();
  if (resume && process.env.SOLVI_UI_RECAPTURE === '1') {
    assert.ok(Object.values(report.writes).every((count) => count === 1));
    const before = JSON.stringify(report.writes);
    activePage = admin;
    await admin.goto(new URL(`/catalog/manage/${report.ids.catalog}`, base).href);
    await admin.waitForLoadState('networkidle');
    await admin.getByText('下書きの項目と承認者を編集する', { exact: true }).click();
    const preview = trial(admin);
    await preview.getByLabel('ノートPC', { exact: true }).check();
    await preview.getByLabel('モニター', { exact: true }).check();
    await preview.getByLabel('ノートPCの種類（必須）', { exact: true }).selectOption('Mac');
    await preview.getByLabel('モニターの希望（必須）', { exact: true }).selectOption('大画面');
    await accessible(admin, 'hardware-editor-desktop-1440');
    await shot(admin, 'hardware-editor-desktop-1440', reasonToggle(admin));
    await shot(
      admin,
      'hardware-preview-desktop-1440',
      preview.getByLabel('ノートPC', { exact: true }),
    );
    await mobile(admin, 'hardware-editor', reasonToggle(admin));
    await mobileViewport(admin);
    await shot(
      admin,
      'hardware-preview-mobile-375',
      preview.getByLabel('ノートPC', { exact: true }),
    );
    await admin.setViewportSize({ width: 1440, height: 900 });
    await admin.goto(new URL('/catalog/manage/new', base).href);
    await admin.locator('input[name="creationKey"]:not([value=""])').waitFor({ state: 'attached' });
    await admin.waitForLoadState('networkidle');
    await applyTemplate(admin, 'local-hardware-bundle');
    await admin.locator('#catalog-approver').selectOption({ label: 'サンプル株式会社 approver' });
    const cleanPreview = trial(admin);
    await cleanPreview.getByLabel('ノートPC', { exact: true }).check();
    await cleanPreview.getByLabel('モニター', { exact: true }).check();
    await cleanPreview
      .getByLabel('ノートPCの種類（必須）', { exact: true })
      .selectOption('Windows');
    await cleanPreview
      .getByLabel('モニターの希望（必須）', { exact: true })
      .selectOption('標準サイズ');
    await accessible(admin, 'flexible-form-desktop-1440');
    await shot(admin, 'flexible-form-desktop-1440', reasonToggle(admin));
    await mobile(admin, 'flexible-form', reasonToggle(admin));
    await mobileViewport(admin);
    await shot(
      admin,
      'flexible-preview-mobile-375',
      cleanPreview.getByLabel('ノートPC', { exact: true }),
    );
    await admin.setViewportSize({ width: 1440, height: 900 });
    assert.equal(JSON.stringify(report.writes), before);
    report.readonlyRecapture = {
      responsiveRailTransitionSettled: true,
      existingCatalogReused: report.ids.catalog,
      additionalBusinessWrites: 0,
    };
    await flush();
  }
  if (!report.writes.save) {
    activePage = admin;
    await admin.goto(new URL('/catalog/manage/new', base).href);
    await admin.locator('input[name="creationKey"]:not([value=""])').waitFor({ state: 'attached' });
    await admin.waitForLoadState('networkidle');
    await check(
      'Security template switches later questions without saving or submitting',
      async () => {
        await applyTemplate(admin, 'local-security-exception');
        const preview = trial(admin);
        await preview
          .getByLabel('申請の種類（必須）', { exact: true })
          .selectOption('Webサイトのブロック解除');
        await preview
          .getByLabel('ブロックされたURL（合成情報）（必須）', { exact: true })
          .fill('https://example.invalid/synthetic');
        await preview.getByLabel('ブロックされた日（必須）', { exact: true }).fill('2026-11-11');
        await preview
          .getByLabel('申請の種類（必須）', { exact: true })
          .selectOption('USB機器の利用');
        assert.equal(
          await preview.getByLabel('ブロックされた日（必須）', { exact: true }).count(),
          0,
        );
        await preview
          .getByLabel('利用するUSB機器（合成情報）（必須）', { exact: true })
          .fill('合成USB機器');
        await accessible(admin, 'security-preview-desktop-1440');
        await shot(admin, 'security-preview-desktop-1440', preview);
        assert.ok(Object.values(report.writes).every((count) => count === 0));
      },
    );
    await applyTemplate(admin, 'local-hardware-bundle');
    await admin.locator('#catalog-title').fill(marker);
    await admin.locator('#catalog-approver').selectOption({ label: 'サンプル株式会社 approver' });
    await check(
      'Common inputs support all four visibility combinations in the unsaved preview',
      async () => {
        const preview = trial(admin);
        for (const [reason, duration] of [
          [true, true],
          [true, false],
          [false, true],
          [false, false],
        ]) {
          await reasonToggle(admin).setChecked(reason);
          await durationToggle(admin).setChecked(duration);
          assert.equal(
            await preview.getByLabel('利用する理由（必須）', { exact: true }).count(),
            Number(reason),
          );
          assert.equal(
            await preview.getByLabel('希望する利用日数（必須）', { exact: true }).count(),
            Number(duration),
          );
        }
        await preview.getByLabel('ノートPC', { exact: true }).check();
        await preview.getByLabel('モニター', { exact: true }).check();
        await preview.getByLabel('ノートPCの種類（必須）', { exact: true }).selectOption('Mac');
        await preview.getByLabel('モニターの希望（必須）', { exact: true }).selectOption('大画面');
        await preview.getByLabel('モニター', { exact: true }).uncheck();
        assert.equal(
          await preview.getByLabel('モニターの希望（必須）', { exact: true }).count(),
          0,
        );
        await preview.getByLabel('モニター', { exact: true }).check();
        assert.equal(
          await preview.getByLabel('モニターの希望（必須）', { exact: true }).inputValue(),
          '',
        );
        assert.ok(Object.values(report.writes).every((count) => count === 0));
      },
    );
    await check(
      'Editor visibility controls are keyboard accessible and fit desktop and mobile',
      async () => {
        await reasonToggle(admin).focus();
        const key = engine === 'webkit' ? 'Alt+Tab' : 'Tab';
        await admin.keyboard.press(key);
        const focus = await admin.evaluate(() => ({
          id: document.activeElement?.id,
          tag: document.activeElement?.tagName,
        }));
        assert.ok(focus.id && focus.tag !== 'BODY');
        report.keyboard = { key, ...focus };
        await accessible(admin, 'hardware-editor-desktop-1440');
        await shot(admin, 'hardware-editor-desktop-1440', reasonToggle(admin));
        await shot(admin, 'hardware-preview-desktop-1440', trial(admin));
        await mobile(admin, 'hardware-editor', reasonToggle(admin));
        await mobileViewport(admin);
        await shot(
          admin,
          'hardware-preview-mobile-375',
          trial(admin).getByLabel('ノートPC', { exact: true }),
        );
        await admin.setViewportSize({ width: 1440, height: 900 });
      },
    );
    await check(
      'Saving persists the exact disabled common inputs and membership conditions once',
      async () => {
        report.code = await editor(admin).locator('[name="code"]').inputValue();
        await flush();
        const navigation = admin.waitForURL((url) =>
          /^\/catalog\/manage\/[0-9a-f-]{36}$/.test(url.pathname),
        );
        void navigation.catch(() => undefined);
        await mutate(
          admin,
          admin.getByRole('button', { name: '下書きを保存してプレビューする', exact: true }),
          '/catalog/manage/new',
          'save',
          (entries) => {
            const wire = new Map(entries);
            assert.equal(wire.get('title'), marker);
            assert.deepEqual(JSON.parse(wire.get('requestFields')), {
              reason: false,
              duration: false,
            });
            assert.ok(
              JSON.parse(wire.get('fields')).some(
                (question) => question.visibleWhen?.contains === 'ノートPC',
              ),
            );
            assert.equal(
              entries.some(([key]) => /^(value|number|checkbox|multiselect):/.test(key)),
              false,
            );
          },
        );
        await navigation;
        report.ids.catalog = new URL(admin.url()).pathname.split('/').at(-1);
        await flush();
        const detail = await readApi('org_admin', `/catalog-admin/${report.ids.catalog}`);
        assert.equal(detail.active, false);
        assert.deepEqual(detail.draft.definition.requestFields, { reason: false, duration: false });
        await admin.reload();
        await admin.waitForLoadState('networkidle');
        assert.equal(await reasonToggle(admin).isChecked(), false);
        assert.equal(await durationToggle(admin).isChecked(), false);
      },
    );
  }
  if (!report.writes.publication) {
    activePage = admin;
    await admin.goto(new URL(`/catalog/manage/${report.ids.catalog}`, base).href);
    await admin.waitForLoadState('networkidle');
    await check(
      'The synthetic service publishes once with disabled common inputs intact',
      async () => {
        await mutate(
          admin,
          admin.getByRole('button', { name: /^保存済みの下書き版\d+を公開する$/ }),
          `/catalog/manage/${report.ids.catalog}`,
          'publication',
          (entries) => {
            assert.equal(new Map(entries).get('state'), 'published');
          },
        );
        await admin.locator('main > p.notice').filter({ hasText: '公開中:' }).waitFor();
        const published = (await readApi('requester', '/catalog')).items.find(
          (item) => item.id === report.ids.catalog,
        );
        assert.deepEqual(published.definition.requestFields, { reason: false, duration: false });
        report.publishedVersion = published.version;
      },
    );
  }
  if (!report.writes.request) {
    activePage = requester;
    await requester.goto(new URL(`/catalog/${report.ids.catalog}`, base).href);
    await requester.waitForLoadState('networkidle');
    await check(
      'Requester selects multiple items and changes branches with hidden answers cleared',
      async () => {
        const form = await requestValues(requester);
        await accessible(requester, 'request-form-desktop-1440');
        await shot(
          requester,
          'request-form-desktop-1440',
          form.getByLabel('ノートPC', { exact: true }),
        );
        await mobile(requester, 'request-form', form.getByLabel('ノートPC', { exact: true }));
      },
    );
    await check(
      'Submission omits hidden common fields and creates one frozen request',
      async () => {
        const navigation = requester.waitForURL((url) =>
          /^\/requests\/[0-9a-f-]{36}$/.test(url.pathname),
        );
        void navigation.catch(() => undefined);
        await mutate(
          requester,
          requester.getByRole('button', { name: '申請する（模擬）', exact: true }),
          `/catalog/${report.ids.catalog}`,
          'request',
          (entries) => validateWire(entries),
        );
        await navigation;
        report.ids.request = new URL(requester.url()).pathname.split('/').at(-1);
        await flush();
        const detail = await readApi('requester', `/service-requests/${report.ids.request}`);
        const inputs = detail.request.snapshot.inputs;
        assert.ok(!('reason' in inputs) && !('durationDays' in inputs));
        assert.deepEqual(inputs.values.hardware_items, ['ノートPC', 'モニター']);
        assert.equal(inputs.values.delivery_address, '合成配送先。実住所ではありません。');
        report.initialSnapshot = detail.request.snapshot;
        report.initialHash = detail.request.snapshotHash;
        assert.equal(snapshotHash(detail.request.snapshot), report.initialHash);
        await flush();
      },
    );
  }
  if (!report.writes.edit) {
    activePage = requester;
    await requester.goto(new URL(`/requests/${report.ids.request}`, base).href);
    await requester.waitForLoadState('networkidle');
    await check(
      'Request editing keeps the frozen visibility settings and omits newly hidden answers',
      async () => {
        await requester.getByText('申請内容を変更して再承認を依頼する', { exact: true }).click();
        const form = await requestValues(requester, true);
        await shot(requester, 'request-edit-desktop-1440', form);
        await mutate(
          requester,
          requester.getByRole('button', { name: '変更して再承認を依頼する', exact: true }),
          `/requests/${report.ids.request}`,
          'edit',
          (entries) => validateWire(entries, true),
        );
        await requester.getByText('申請の状態を保存しました。', { exact: true }).waitFor();
      },
    );
  }
  activePage = requester;
  await requester.goto(new URL(`/requests/${report.ids.request}`, base).href);
  await requester.waitForLoadState('networkidle');
  await check(
    'Revised request and approval history retain the old snapshot without invented common values',
    async () => {
      const detail = await readApi('requester', `/service-requests/${report.ids.request}`);
      assert.equal(detail.request.revision, 2);
      assert.equal(detail.request.snapshot.item.version, report.publishedVersion);
      assert.ok(!('reason' in detail.request.snapshot.inputs));
      assert.ok(!('durationDays' in detail.request.snapshot.inputs));
      assert.ok(!('delivery_address' in detail.request.snapshot.inputs.values));
      assert.equal(detail.request.snapshot.inputs.values.department, '合成検証部（変更）');
      const original = detail.history.find((approval) => approval.revision === 1);
      assert.ok(original);
      assert.deepEqual(original.inputs, report.initialSnapshot.inputs);
      assert.deepEqual(original.item, report.initialSnapshot.item);
      assert.equal(
        snapshotHash({ ...report.initialSnapshot, item: original.item, inputs: original.inputs }),
        report.initialHash,
      );
      assert.equal(snapshotHash(detail.request.snapshot), detail.request.snapshotHash);
      assert.notEqual(detail.request.snapshotHash, report.initialHash);
      assert.equal(
        await requester
          .locator('dt')
          .filter({ hasText: /^(利用日数|理由)$/ })
          .count(),
        0,
      );
      await accessible(requester, 'request-detail-desktop-1440');
      await shot(
        requester,
        'request-detail-desktop-1440',
        requester.getByRole('heading', { level: 1 }),
      );
      await mobile(requester, 'request-detail', requester.getByRole('heading', { level: 1 }));
      report.snapshotInvariant = {
        originalRevision: 1,
        revisedRevision: 2,
        originalInputsPreserved: true,
        originalDefinitionPreserved: true,
        originalHashPreserved: true,
        hiddenCommonValues: 0,
      };
    },
  );
  assert.ok(Object.values(report.writes).every((count) => count === 1));
  assert.deepEqual(report.blocked, []);
  report.success = true;
  report.currentStep = 'complete';
  delete report.failure;
}

try {
  await main();
} catch (error) {
  report.failure = String(error?.message ?? error).replaceAll(password, '<redacted>');
  if (activePage) {
    try {
      await activePage.screenshot({ path: resolve(output, 'failure.png'), fullPage: false });
    } catch {
      // Preserve the last successfully recorded step if the page already closed.
    }
  }
} finally {
  armed?.release.resolve();
  for (const context of contexts.values()) await context.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await mkdir(output, { recursive: true });
  await flush();
  console.log(
    `Catalog flexible ${engine}: ${report.success ? 'PASS' : 'FAIL'}; ${report.checks.length} checks; ${report.accessibility.length} axe scans; ${JSON.stringify(report.writes)}`,
  );
  if (report.failure) console.log(report.failure);
  if (!report.success) process.exitCode = 1;
}
