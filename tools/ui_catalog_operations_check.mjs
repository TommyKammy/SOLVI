/* global document, window, innerWidth */
// WP-P2-UIX-041: own synthetic catalog/library/clone/request only; no role changes.
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
const engine = process.env.SOLVI_UI_BROWSER ?? 'chromium';
assert.ok(['chromium', 'webkit'].includes(engine));
const output = resolve(process.env.SOLVI_UI_OUT ?? `evidence/WP-P2-UIX-041/browser/${engine}`);
const resumeAgent = process.env.SOLVI_UI_RESUME_AGENT === '1';
const resumeTarget = process.env.SOLVI_UI_RESUME_TARGET === '1';
assert.ok(!(resumeAgent && resumeTarget));
const resumeSteps = resumeAgent ? 7 : resumeTarget ? 2 : 0;
let previous;
try {
  previous = JSON.parse(await readFile(resolve(output, 'summary.json'), 'utf8'));
  if (resumeSteps) {
    assert.equal(
      previous.checks.slice(0, resumeSteps).every((result) => result.passed),
      true,
    );
    for (const key of ['source', 'set']) assert.equal(previous.network.writes[key], 1);
    for (const key of ['target', 'clone', 'publish', 'request', 'approve'])
      assert.equal(previous.network.writes[key], resumeAgent ? 1 : 0);
    assert.equal(previous.network.writes.checklist, 0);
    assert.equal(previous.network.writes.simulate, 0);
    assert.match(previous.ids[resumeAgent ? 'request' : 'source'], /^[0-9a-f-]{36}$/i);
    assert.match(previous.marker, /^UI041-SYN-\d+-(chromium|webkit)$/);
  } else {
    assert.equal(
      Object.values(previous.network?.writes ?? {}).reduce((n, value) => n + value, 0),
      0,
      'A previous write requires read-only reconciliation; do not repeat creation',
    );
  }
} catch (error) {
  if (error.code !== 'ENOENT' || resumeSteps) throw error;
}
const marker = resumeSteps ? previous.marker : `UI041-SYN-${Date.now()}-${engine}`;
const report = {
  ...(resumeSteps ? previous : {}),
  workPackage: 'WP-P2-UIX-041',
  browser: engine,
  marker,
  success: false,
  checks: resumeSteps ? previous.checks.slice(0, resumeSteps) : [],
  accessibility: resumeSteps
    ? previous.accessibility.filter((scan) =>
        resumeTarget ? scan.name.startsWith('library-') : !scan.name.startsWith('agent-'),
      )
    : [],
  screenshots: resumeSteps
    ? previous.screenshots.filter((name) =>
        resumeTarget ? name.startsWith('library-') : !name.startsWith('agent-'),
      )
    : [],
  ids: resumeSteps ? previous.ids : {},
  network: resumeSteps
    ? previous.network
    : {
        authWrites: 0,
        writes: {
          source: 0,
          set: 0,
          target: 0,
          clone: 0,
          publish: 0,
          request: 0,
          approve: 0,
          checklist: 0,
          simulate: 0,
        },
        blocked: [],
      },
};
let browser, activePage, armed;
const contexts = new Map();
const pages = new Map();
const flush = () =>
  writeFile(resolve(output, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Synthetic action did not arrive')), 20000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function check(name, run) {
  report.currentStep = name;
  await flush();
  try {
    await run();
    report.checks.push({ name, passed: true });
  } catch (error) {
    report.checks.push({ name, passed: false });
    throw error;
  }
}
async function guard(context) {
  await context.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
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
        const data = await new Request(request.url(), {
          method: 'POST',
          headers: { 'content-type': request.headers()['content-type'] },
          body: request.postDataBuffer(),
        }).formData();
        current.entries = [...data.entries()]
          .filter(([, value]) => typeof value === 'string')
          .map(([key, value]) => [key.replace(/^_?\d+_/, ''), value]);
        current.validate(current.entries);
      } catch (error) {
        current.error = error;
      }
      current.arrival.resolve();
      await current.release.promise;
      if (current.approved && !current.error) {
        report.network.writes[current.kind]++;
        await flush();
        return route.continue();
      }
      return route.abort();
    }
    report.network.blocked.push({ method: request.method(), path: url.pathname });
    return route.abort();
  });
}
async function actor(name) {
  if (pages.has(name)) {
    activePage = pages.get(name);
    return activePage;
  }
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
async function mutate(page, button, path, kind, validate, pending = async () => {}) {
  assert.equal(armed, undefined);
  assert.equal(report.network.writes[kind], 0);
  const invalid = await button.evaluate((node) =>
    [...node.form.elements]
      .filter((element) => element.willValidate && !element.validity.valid)
      .map((element) => element.id || element.name),
  );
  assert.deepEqual(invalid, [], 'The hydrated form must be valid before its one allowed submit');
  const current = {
    path,
    kind,
    validate,
    arrival: deferred(),
    release: deferred(),
    approved: false,
  };
  armed = current;
  await button.click({ noWaitAfter: true });
  try {
    await bounded(current.arrival.promise);
    if (current.error) throw current.error;
    await pending();
    current.approved = true;
  } finally {
    current.release.resolve();
    armed = undefined;
  }
}
const editor = (page) => page.locator('form:has(#catalog-title)');
async function definition(page) {
  return {
    fields: JSON.parse(await editor(page).locator('[name="fields"]').inputValue()),
    sections: JSON.parse(await editor(page).locator('[name="sections"]').inputValue()),
    checklist: JSON.parse(await editor(page).locator('[name="checklist"]').inputValue()),
    ownerId: await editor(page).locator('[name="ownerId"]').inputValue(),
    fulfillmentGroupId: await editor(page).locator('[name="fulfillmentGroupId"]').inputValue(),
  };
}
async function openNew(page, title, options) {
  await page.goto(new URL('/catalog/manage/new', base).href);
  await page.locator('input[name="creationKey"]:not([value=""])').waitFor({ state: 'attached' });
  await page.waitForLoadState('networkidle');
  await page.locator('#catalog-title').fill(title);
  await page
    .locator('#catalog-description')
    .fill('合成のカタログ再利用・受付後運用確認です。実リソース操作は行いません。');
  await page.locator('#catalog-approver').selectOption({ label: 'サンプル株式会社 approver' });
  await page.locator('#catalog-owner').selectOption(options.viewerId);
}
async function saveNew(page, kind, title) {
  const expected = await definition(page);
  const code = await editor(page).locator('[name="code"]').inputValue();
  report[`${kind}Code`] = code;
  await flush();
  const navigation = page.waitForURL((url) =>
    /^\/catalog\/manage\/[0-9a-f-]{36}$/.test(url.pathname),
  );
  void navigation.catch(() => undefined);
  await mutate(
    page,
    page.getByRole('button', { name: '下書きを保存してプレビューする', exact: true }),
    '/catalog/manage/new',
    kind,
    (entries) => {
      const wire = new Map(entries);
      assert.equal(wire.get('title'), title);
      assert.equal(wire.get('code'), code);
      for (const key of ['fields', 'sections', 'checklist'])
        assert.deepEqual(JSON.parse(wire.get(key)), expected[key]);
      assert.equal(wire.get('ownerId'), expected.ownerId);
      assert.equal(wire.get('fulfillmentGroupId'), expected.fulfillmentGroupId);
    },
    async () => {
      await page
        .getByRole('form', { name: '編集中フォームの入力試験', exact: true })
        .locator('fieldset[disabled]')
        .first()
        .waitFor();
    },
  );
  await navigation;
  await page.getByRole('heading', { level: 1, name: title, exact: true }).waitFor();
  const id = new URL(page.url()).pathname.split('/').at(-1);
  report.ids[kind] = id;
  await flush();
  const saved = await readApi('org_admin', `/catalog-admin/${id}`);
  assert.equal(saved.code, code);
  assert.equal(saved.active, false);
  for (const key of ['fields', 'sections', 'checklist'])
    assert.deepEqual(saved.draft.definition[key] ?? [], expected[key]);
  return saved;
}
async function shot(page, name, top = false) {
  if (top)
    await page.evaluate(() => {
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
async function mobile(page, name) {
  await page.setViewportSize({ width: 375, height: 900 });
  const dimensions = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }));
  assert.ok(dimensions.document <= dimensions.viewport, 'No horizontal overflow at 375px');
  report[name + 'Width'] = dimensions;
  await axe(page, name + '-mobile');
  await shot(page, name + '-mobile-375', true);
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function main() {
  await mkdir(output, { recursive: true });
  browser = await (engine === 'webkit' ? webkit : chromium).launch(
    engine === 'chromium' ? { channel: 'chrome' } : {},
  );
  report.browserVersion = browser.version();
  const admin = await actor('org_admin');
  const options = await readApi('org_admin', '/catalog-admin');
  assert.equal(options.canCreate, true);
  assert.equal(options.canManageQuestionSets, true);
  assert.ok(options.groups.length, 'An existing active synthetic assignment group is required');
  let selectedGroup = options.groups[0];
  const sourceTitle = marker + '-source',
    targetTitle = marker + '-target',
    cloneTitle = marker + '-clone',
    setTitle = marker + '-set';
  let source, target, clone, questionSet, requestDetail, approvedBaseline;

  if (!resumeAgent) {
    if (!resumeTarget) {
      await check(
        'Create one own synthetic source with a section and a conditional question',
        async () => {
          await openNew(admin, sourceTitle, options);
          await admin.getByRole('button', { name: 'セクションを追加する', exact: true }).click();
          await admin.locator('#catalog-section-title-0').fill('合成配送情報');
          const section = JSON.parse(
            await editor(admin).locator('[name="sections"]').inputValue(),
          )[0].key;
          await admin.getByRole('button', { name: '申請項目を追加する', exact: true }).click();
          await admin.locator('#field-label-0').fill('合成受取区分');
          await admin.locator('#field-type-0').selectOption('select');
          await admin.locator('#field-options-0').fill('配送\n窓口');
          await admin.locator('#field-section-0').selectOption(section);
          await admin
            .locator('fieldset.catalog-editor-field')
            .nth(0)
            .getByRole('checkbox', { name: '必須にする', exact: true })
            .check();
          await admin.getByRole('button', { name: '申請項目を追加する', exact: true }).click();
          await admin.locator('#field-label-1').fill('合成配送先');
          await admin.locator('#field-section-1').selectOption(section);
          await admin
            .locator('fieldset.catalog-editor-field')
            .nth(1)
            .getByRole('checkbox', { name: '必須にする', exact: true })
            .check();
          await admin.getByText('項目2の表示条件', { exact: true }).click();
          const fields = JSON.parse(await editor(admin).locator('[name="fields"]').inputValue());
          await admin.locator('#field-condition-1').selectOption(fields[0].key);
          source = await saveNew(admin, 'source', sourceTitle);
          assert.equal(source.draft.definition.fields.length, 2);
          assert.equal(
            source.draft.definition.fields[1].visibleWhen.field,
            source.draft.definition.fields[0].key,
          );
        },
      );

      await check(
        'Create an immutable shared question set from the selected saved revision',
        async () => {
          await admin.goto(new URL('/catalog/manage/question-sets', base).href);
          const form = admin.getByRole('form', { name: '共有項目セットを作成する', exact: true });
          await form
            .locator('input[name="creationKey"]:not([value=""])')
            .waitFor({ state: 'attached' });
          await form.getByLabel('セット名', { exact: true }).fill(setTitle);
          await form.getByLabel('セットの説明', { exact: true }).fill('合成の再利用用質問です。');
          await form
            .getByLabel('質問の元サービス', { exact: true })
            .selectOption(`${source.id}|${source.draft.revision}`);
          await mutate(
            admin,
            form.getByRole('button', { name: '共有項目セットを作成する', exact: true }),
            '/catalog/manage/question-sets',
            'set',
            (entries) => {
              assert.equal(new Map(entries).get('source'), `${source.id}|1`);
            },
          );
          await admin
            .getByRole('status')
            .filter({ hasText: '共有項目セットを保存しました' })
            .waitFor();
          questionSet = (await readApi('org_admin', '/catalog-question-sets')).items.find(
            (entry) => entry.title === setTitle,
          );
          assert.ok(questionSet);
          report.ids.questionSet = questionSet.id;
          await flush();
          assert.equal(questionSet.revision, 1);
          assert.deepEqual(questionSet.fields, source.draft.definition.fields);
          await admin.getByRole('link', { name: 'カタログ管理へ戻る', exact: true }).focus();
          const forwardKey = engine === 'webkit' ? 'Alt+Tab' : 'Tab';
          await admin.keyboard.press(forwardKey);
          const keyboardFocus = await admin.evaluate(() => ({
            tag: document.activeElement?.tagName,
            visible: Boolean(document.activeElement?.getClientRects().length),
          }));
          assert.equal(keyboardFocus.visible, true);
          assert.notEqual(keyboardFocus.tag, 'BODY');
          report.keyboard = { forwardKey, ...keyboardFocus };
          await axe(admin, 'library-desktop');
          await shot(admin, 'library-desktop-1440', true);
          await mobile(admin, 'library');
        },
      );
    } else {
      source = await readApi('org_admin', `/catalog-admin/${report.ids.source}`);
      assert.equal(source.draft.title, sourceTitle);
      assert.equal(source.active, false);
      questionSet = (await readApi('org_admin', '/catalog-question-sets')).items.find(
        (entry) => entry.id === report.ids.questionSet,
      );
      assert.equal(questionSet?.title, setTitle);
      assert.deepEqual(questionSet.fields, source.draft.definition.fields);
      report.recovery = {
        reusedSource: source.id,
        reusedQuestionSet: questionSet.id,
        additionalSourceCreates: 0,
        additionalSetCreates: 0,
        priorTargetWriteReachedServer: false,
        reason:
          'WebKit mobile layout corrected before target save; reuse the already saved synthetic source and set',
      };
    }

    await check(
      'Insert a remapped independent copy and save owner, group and required checklist',
      async () => {
        await openNew(admin, targetTitle, options);
        await admin.locator('#catalog-question-set').selectOption(questionSet.id);
        await admin.getByRole('button', { name: '質問セットを追加する', exact: true }).click();
        const copied = await definition(admin);
        assert.equal(copied.fields.length, 2);
        assert.ok(
          copied.fields.every(
            (field) => !questionSet.fields.some((entry) => entry.key === field.key),
          ),
        );
        assert.equal(copied.fields[1].visibleWhen.field, copied.fields[0].key);
        assert.notEqual(copied.sections[0].key, questionSet.sections[0].key);
        await admin.locator('#catalog-fulfillment-group').selectOption(selectedGroup.id);
        await admin.getByRole('button', { name: '作業項目を追加する', exact: true }).click();
        await admin.getByLabel('作業項目 1', { exact: true }).fill('合成在庫を確認する');
        await admin.getByRole('button', { name: '作業項目を追加する', exact: true }).click();
        await admin.getByLabel('作業項目 2', { exact: true }).fill('合成連絡を記録する');
        await editor(admin).locator('[name="checklist.1.required"]').uncheck();
        await axe(admin, 'operations-editor-desktop');
        await shot(admin, 'operations-editor-desktop-1440', true);
        await mobile(admin, 'operations-editor');
        target = await saveNew(admin, 'target', targetTitle);
        assert.equal(target.draft.definition.ownerId, options.viewerId);
        assert.equal(target.draft.definition.fulfillmentGroupId, selectedGroup.id);
        assert.deepEqual(
          target.draft.definition.checklist.map((entry) => entry.required),
          [true, false],
        );
        assert.deepEqual(
          (await readApi('org_admin', '/catalog-question-sets')).items.find(
            (entry) => entry.id === questionSet.id,
          ),
          questionSet,
        );
      },
    );

    await check(
      'Clone GET sends no write and saving creates one distinct unpublished service',
      async () => {
        const writes = JSON.stringify(report.network.writes);
        await admin.goto(new URL(`/catalog/manage/new?copyFrom=${target.id}`, base).href);
        await admin
          .locator('input[name="creationKey"]:not([value=""])')
          .waitFor({ state: 'attached' });
        await admin.getByRole('heading', { name: 'サービスを複製する', exact: true }).waitFor();
        assert.equal(JSON.stringify(report.network.writes), writes);
        assert.notEqual(await editor(admin).locator('[name="code"]').inputValue(), target.code);
        await admin.locator('#catalog-title').fill(cloneTitle);
        clone = await saveNew(admin, 'clone', cloneTitle);
        assert.notEqual(clone.id, target.id);
        assert.notEqual(clone.code, target.code);
        assert.deepEqual(clone.draft.definition.fields, target.draft.definition.fields);
        assert.deepEqual(clone.draft.definition.checklist, target.draft.definition.checklist);
        assert.equal(
          (await readApi('org_admin', `/catalog-admin/${target.id}`)).draft.title,
          targetTitle,
        );
        report.cloneGetBusinessWrites = 0;
      },
    );

    await check(
      'Publish only the own clone and show owner, update and readiness on its list row',
      async () => {
        await mutate(
          admin,
          admin.getByRole('button', { name: /^保存済みの下書き版\d+を公開する$/ }),
          `/catalog/manage/${clone.id}`,
          'publish',
          (entries) => assert.equal(new Map(entries).get('state'), 'published'),
        );
        await admin.locator('main > p.notice').filter({ hasText: '公開中:' }).waitFor();
        clone = await readApi('org_admin', `/catalog-admin/${clone.id}`);
        assert.equal(clone.active, true);
        await admin.goto(new URL(`/catalog/manage?q=${encodeURIComponent(cloneTitle)}`, base).href);
        const row = admin
          .locator('li.attachment')
          .filter({ has: admin.getByRole('heading', { level: 2, name: cloneTitle, exact: true }) });
        await row.waitFor();
        assert.match(await row.innerText(), /担当責任者|最終更新|公開前の確認/);
        assert.equal(
          await row.getByRole('link', { name: 'このサービスを複製する', exact: true }).count(),
          1,
        );
        await shot(admin, 'management-list-desktop-1440', true);
      },
    );

    await check(
      'Requester submits the clone and sees responsible owner, routed group and read-only tasks',
      async () => {
        const page = await actor('requester');
        await page.goto(new URL(`/catalog/${clone.id}`, base).href);
        await page
          .locator('input[name="idempotencyKey"]:not([value=""])')
          .waitFor({ state: 'attached' });
        await page.waitForLoadState('networkidle');
        await page.getByLabel('利用する理由', { exact: true }).fill('UI041合成の受付後運用確認');
        await page.getByLabel('合成受取区分（必須）', { exact: true }).selectOption('配送');
        await page.getByLabel('合成配送先（必須）', { exact: true }).fill('UI041合成の受取窓口');
        const navigation = page.waitForURL((url) =>
          /^\/requests\/[0-9a-f-]{36}$/.test(url.pathname),
        );
        void navigation.catch(() => undefined);
        await mutate(
          page,
          page.getByRole('button', { name: '申請する（模擬）', exact: true }),
          `/catalog/${clone.id}`,
          'request',
          (entries) => assert.equal(new Map(entries).get('itemId'), clone.id),
        );
        await navigation;
        await page.getByRole('heading', { level: 2, name: '承認待ち', exact: true }).waitFor();
        report.ids.request = new URL(page.url()).pathname.split('/').at(-1);
        await flush();
        requestDetail = await readApi('requester', `/service-requests/${report.ids.request}`);
        assert.equal(requestDetail.fulfillment.groupName, selectedGroup.name);
        assert.equal(requestDetail.fulfillment.canUpdate, false);
        const panel = page.getByRole('region', { name: '受付後の担当と作業', exact: true });
        assert.equal(await panel.getByRole('button').count(), 0);
        await shot(page, 'requester-readonly-desktop-1440', true);
      },
    );

    await check('The selected synthetic approver approves only this new request', async () => {
      const page = await actor('approver');
      await page.goto(new URL(`/requests/${report.ids.request}`, base).href);
      await page.getByRole('button', { name: '承認する', exact: true }).waitFor();
      await page.waitForLoadState('networkidle');
      await page.getByLabel('判断の理由', { exact: true }).fill('UI041合成申請の内容を確認');
      await mutate(
        page,
        page.getByRole('button', { name: '承認する', exact: true }),
        `/requests/${report.ids.request}`,
        'approve',
        (entries) => assert.equal(new Map(entries).get('decision'), 'approve'),
      );
      await page
        .getByRole('heading', { level: 2, name: '承認済み・模擬実行待ち', exact: true })
        .waitFor();
    });
  } else {
    clone = await readApi('org_admin', `/catalog-admin/${report.ids.clone}`);
    assert.equal(clone.draft.title, marker + '-clone');
    assert.equal(clone.active, true);
    selectedGroup = options.groups.find(
      (entry) => entry.id === clone.draft.definition.fulfillmentGroupId,
    );
    assert.ok(selectedGroup);
    report.recovery = {
      reusedRequest: report.ids.request,
      additionalCatalogCreates: 0,
      additionalSetCreates: 0,
      additionalApprovals: 0,
      priorChecklistWriteReachedServer: false,
      reason:
        'TicketView omits optional group names; group was verified in fulfillment and API/DB evidence',
    };
  }

  await check(
    'Agent sees a required-task gate and updating one task preserves request version and snapshot hash',
    async () => {
      const page = await actor('agent');
      await page.goto(new URL(`/requests/${report.ids.request}`, base).href);
      await page.getByRole('region', { name: '受付後の担当と作業', exact: true }).waitFor();
      await page.waitForLoadState('networkidle');
      approvedBaseline = await readApi('agent', `/service-requests/${report.ids.request}`);
      assert.equal(approvedBaseline.request.state, 'approved');
      assert.equal(approvedBaseline.fulfillment.canUpdate, true);
      const ticket = await readApi('agent', `/tickets/${approvedBaseline.request.ticketId}`);
      assert.equal(ticket.state, 'new');
      assert.equal(approvedBaseline.fulfillment.groupName, selectedGroup.name);
      assert.equal(approvedBaseline.request.snapshot.item.id, report.ids.clone);
      assert.equal(
        await page.getByRole('button', { name: 'ローカルで模擬実行する', exact: true }).count(),
        0,
      );
      await page
        .getByRole('status')
        .filter({ hasText: '必須の作業チェックを完了すると' })
        .waitFor();
      await axe(page, 'agent-checklist-desktop');
      await shot(page, 'agent-required-gate-desktop-1440', true);
      await mobile(page, 'agent-checklist');
      const required = approvedBaseline.fulfillment.checks.find((entry) => entry.required);
      const button = page.getByRole('button', {
        name: '「' + required.label + '」を完了にする',
        exact: true,
      });
      await mutate(page, button, `/requests/${report.ids.request}`, 'checklist', (entries) => {
        const wire = new Map(entries);
        assert.equal(wire.get('key'), required.key);
        assert.equal(wire.get('completed:' + required.key), 'true');
        assert.equal(
          Number(wire.get('expectedVersion')),
          approvedBaseline.fulfillment.checklistVersion,
        );
      });
      await page
        .getByRole('button', { name: '「' + required.label + '」を未完了に戻す', exact: true })
        .waitFor();
      const after = await readApi('agent', `/service-requests/${report.ids.request}`);
      assert.deepEqual(after.request.snapshot, approvedBaseline.request.snapshot);
      assert.equal(after.request.snapshotHash, approvedBaseline.request.snapshotHash);
      assert.equal(after.request.version, approvedBaseline.request.version);
      assert.equal(
        after.fulfillment.checklistVersion,
        approvedBaseline.fulfillment.checklistVersion + 1,
      );
      assert.equal(
        after.fulfillment.checks.find((entry) => entry.key === required.key).completed,
        true,
      );
      assert.equal(after.fulfillment.checks.find((entry) => !entry.required).completed, false);
      report.progressInvariant = {
        snapshotUnchanged: true,
        hashUnchanged: true,
        requestVersionUnchanged: true,
        independentChecklistVersion: after.fulfillment.checklistVersion,
      };
      await page.getByRole('button', { name: 'ローカルで模擬実行する', exact: true }).waitFor();
    },
  );

  await check(
    'Required completion enables local simulation while optional work can remain unfinished',
    async () => {
      const page = await actor('agent');
      await mutate(
        page,
        page.getByRole('button', { name: 'ローカルで模擬実行する', exact: true }),
        `/requests/${report.ids.request}`,
        'simulate',
        (entries) => assert.equal(new Map(entries).get('operation'), 'simulate'),
      );
      await page.getByRole('heading', { level: 2, name: '模擬実行完了', exact: true }).waitFor();
      const completed = await readApi('agent', `/service-requests/${report.ids.request}`);
      assert.equal(completed.request.state, 'completed');
      assert.ok(completed.receipt);
      await shot(page, 'agent-completed-desktop-1440', true);
      report.completed = true;
    },
  );
  assert.deepEqual(report.network.blocked, []);
  assert.ok(Object.values(report.network.writes).every((value) => value === 1));
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
  if (activePage)
    try {
      await activePage.screenshot({ path: resolve(output, 'failure.png'), fullPage: false });
    } catch {
      /* Keep structured evidence. */
    }
  process.exitCode = 1;
} finally {
  if (armed) {
    armed.approved = false;
    armed.release.resolve();
  }
  await flush();
  for (const context of contexts.values()) await context.close();
  await browser?.close();
  console.log(
    `Catalog operations ${engine}: ${report.success ? 'PASS' : 'FAIL'}; ${report.checks.length} checks; ${report.accessibility.length} axe scans; ${JSON.stringify(report.network.writes)}`,
  );
}
