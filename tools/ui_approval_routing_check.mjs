/* global document, innerWidth, HTMLElement, getComputedStyle */
// WP-P4-APR-016 stage A: loopback-only approval-rule admin walkthrough.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
const output = resolve(process.env.SOLVI_UI_OUT ?? `evidence/WP-P4-APR-016/browser/${engine}`);
const phase = process.env.SOLVI_UI_PHASE ?? 'full';
assert.ok(['full', 'cleanup', 'verify'].includes(phase), `Unknown phase ${phase}`);
const MAX_RULES = 4;
const MAX_REVISIONS = 4;
const MAX_CATALOG_ITEMS = 1;
const reuseCatalogId = process.env.SOLVI_UI_REUSE_CATALOG
  ? process.env.SOLVI_UI_REUSE_CATALOG.trim()
  : null;

const marker = `UI016-SYN-${Date.now()}-${engine}`;
const ruleCode = `ui016-syn-${Date.now()}-${engine}`;
const ruleName = `UI016 合成 2段承認 ${engine}`;

let previous;
try {
  previous = JSON.parse(await readFile(resolve(output, 'summary.json'), 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (previous) {
  assert.equal(previous.browser, engine, 'The previous summary belongs to another browser');
  assert.match(previous.marker, /^UI016-SYN-\d+-(chromium|webkit)$/);
}
const previousHasData = Boolean(
  previous &&
  (Object.values(previous.writes ?? {}).some((count) => count > 0) ||
    Object.values(previous.ids ?? {}).some(Boolean)),
);
if (!previousHasData) previous = undefined;

const report = previous
  ? {
      ...previous,
      success: false,
      currentStep: 'reconciliation',
      blocked: [],
    }
  : {
      workPackage: 'WP-P4-APR-016',
      stage: 'A',
      browser: engine,
      marker,
      success: false,
      createdAt: new Date().toISOString(),
      base: base.origin,
      apiBase: apiBase.origin,
      node: process.version,
      platform: process.platform,
      command:
        'SOLVI_SMOKE_PASSWORD=<redacted> SOLVI_UI_BROWSER=<engine> node tools/ui_approval_routing_check.mjs',
      commitSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      checks: [],
      accessibility: [],
      screenshots: [],
      writes: {
        rulesCreated: 0,
        revisions: 0,
        catalogCreated: 0,
        catalogUpdates: 0,
        catalogPublished: 0,
        catalogUnpublished: 0,
        routingEnabled: 0,
        routingDisabled: 0,
        ruleDeactivations: 0,
      },
      ids: { rule: null, catalogItem: null },
      applied: {
        rule: false,
        revision: false,
        catalog: false,
        catalogRuleBound: false,
        catalogPublished: false,
        routingEnabledOnce: false,
      },
      cleanup: { attempted: false, complete: false, steps: [], errors: [] },
      keyboard: null,
      blocked: [],
    };

let browser;
let activePage;
const contexts = new Map();
const pages = new Map();
const flush = () =>
  writeFile(resolve(output, 'summary.json'), JSON.stringify(report, null, 2) + '\n');

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
    if (url.origin === base.origin || url.origin === apiBase.origin) return route.continue();
    report.blocked.push({ method: request.method(), origin: url.origin, path: url.pathname });
    return route.abort();
  });
}

async function login(page, email) {
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
}

async function actor(name) {
  if (pages.has(name)) return pages.get(name);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  contexts.set(name, context);
  await guard(context);
  const page = await context.newPage();
  activePage = page;
  page.setDefaultTimeout(25000);
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await login(page, `${name}@acme.example.test`);
      pages.set(name, page);
      return page;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await page.goto(new URL('/login', base).href).catch(() => undefined);
    }
  }
  throw lastError;
}

async function readApi(name, path) {
  const context = contexts.get(name);
  assert.ok(context, `A signed-in context is required for ${path}`);
  const response = await context.request.get(new URL(path, apiBase).href);
  assert.equal(response.status(), 200, `Read-only API ${path}`);
  return response.json();
}

async function go(page, path) {
  const target = new URL(path, base).href;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await page.goto(target);
      await page.waitForLoadState('networkidle');
      return;
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!message.includes('interrupted by another navigation') || attempt === 3) throw error;
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await page.waitForTimeout(250);
    }
  }
}

async function submit(page, button, predicate) {
  await Promise.all([page.waitForURL(predicate, { timeout: 30000 }), button.click()]);
  await page.waitForLoadState('load');
  await page.waitForLoadState('networkidle');
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
  assert.ok(dimensions.document <= dimensions.viewport, `No horizontal overflow at ${name}`);
  assert.deepEqual(dimensions.duplicateIds, [], `Every control ID must be unique at ${name}`);
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
  await flush();
}

async function mobileViewport(page) {
  await page.setViewportSize({ width: 375, height: 900 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => {
    const rail = document.querySelector('.fs-rail');
    return !rail || rail.getBoundingClientRect().right <= 1;
  });
}

async function mobile(page, name, target) {
  await mobileViewport(page);
  await accessible(page, `${name}-mobile-375`);
  await shot(page, `${name}-mobile-375`, target);
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function tabTo(page, id, limit = 80) {
  let tabs = 0;
  while (tabs < limit) {
    const active = await page.evaluate(() => document.activeElement?.id ?? '');
    if (active === id) return tabs;
    await page.keyboard.press(engine === 'webkit' ? 'Alt+Tab' : 'Tab');
    tabs += 1;
  }
  throw new Error(`Could not reach #${id} with Tab`);
}

async function focusVisible(page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement)) return null;
    const style = getComputedStyle(element);
    return {
      id: element.id,
      tag: element.tagName,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      boxShadow: style.boxShadow,
    };
  });
}

function userByEmail(users, email) {
  const user = users.find((entry) => entry.email === email);
  assert.ok(user, `seed user ${email} must exist`);
  return user;
}

async function preflight() {
  const rules = (await readApi('org_admin', '/approval-rules')).items;
  const syntheticRules = rules.filter(
    (rule) =>
      String(rule.code).toLowerCase().startsWith('ui016-syn-') &&
      String(rule.code).toLowerCase().endsWith(`-${engine}`),
  );
  assert.ok(
    syntheticRules.length + 1 <= MAX_RULES,
    `Synthetic approval-rule cap for ${engine}: ${syntheticRules.length} already exist`,
  );
  const catalog = (await readApi('org_admin', '/catalog-admin')).items;
  const syntheticItems = catalog.filter(
    (item) => String(item.title).includes('UI016') && String(item.title).includes(`-${engine}`),
  );
  if (reuseCatalogId) {
    const reusable = syntheticItems.find((item) => item.id === reuseCatalogId);
    assert.ok(reusable, 'The reused catalog item must exist and carry the UI016 marker');
    assert.equal(reusable.active, false, 'The reused catalog item must be unpublished first');
  } else {
    assert.equal(
      syntheticItems.length,
      0,
      `A prior UI016 catalog item exists without a summary: ${syntheticItems.length}`,
    );
  }
  const settings = await readApi('org_admin', '/approval-routing');
  assert.equal(settings.setting.enabled, false, 'Approval routing must start disabled');
}

async function cleanup(admin) {
  if (report.cleanup.attempted) return;
  report.cleanup.attempted = true;
  report.currentStep = 'cleanup';
  await flush();
  const step = async (name, run) => {
    try {
      await run();
      report.cleanup.steps.push({ name, passed: true });
    } catch (error) {
      report.cleanup.errors.push({ name, message: String(error?.message ?? error) });
    }
    await flush();
  };
  const ids = report.ids;

  if (report.applied.routingEnabledOnce) {
    await step('組織での承認ルールを無効へ戻す', async () => {
      const settings = await readApi('org_admin', '/approval-routing');
      if (settings.setting.enabled === false) return;
      await go(admin, '/ops/approvals');
      await admin.locator('#approval-routing-toggle').click();
      await admin.waitForURL((url) => url.searchParams.get('confirm') === 'disable-routing');
      await submit(
        admin,
        admin.locator('#approval-routing-submit'),
        (url) => url.searchParams.get('notice') === 'routing-disabled',
      );
      report.writes.routingDisabled += 1;
      await admin.locator('#approval-notice').waitFor();
      const after = await readApi('org_admin', '/approval-routing');
      assert.equal(after.setting.enabled, false, 'routing must be disabled after cleanup');
    });
  }

  if (ids.catalogItem) {
    await step('合成カタログ項目から承認ルールの結び付けを外す', async () => {
      const detail = await readApi('org_admin', `/catalog-admin/${ids.catalogItem}`);
      if (!detail.draft.definition.approval?.ruleId) return;
      await go(admin, `/catalog/manage/${ids.catalogItem}`);
      const summary = admin
        .locator('summary')
        .filter({ hasText: '下書きの項目と承認者を編集する' });
      if ((await summary.count()) === 0) return;
      const ruleSelect = admin.locator('#catalog-approval-rule');
      if (!(await ruleSelect.isVisible())) await summary.click();
      if ((await ruleSelect.inputValue()) === '') return;
      await ruleSelect.selectOption('');
      await submit(
        admin,
        admin.getByRole('button', { name: '下書きを保存してプレビューする', exact: true }),
        (url) => url.searchParams.get('saved') === '1',
      );
      report.writes.catalogUpdates += 1;
    });

    await step('合成カタログ項目を非公開にする', async () => {
      const detail = await readApi('org_admin', `/catalog-admin/${ids.catalogItem}`);
      if (!detail.active) return;
      await go(admin, `/catalog/manage/${ids.catalogItem}`);
      const unpublish = admin.getByRole('button', { name: /新規受付を停止する/ });
      if ((await unpublish.count()) === 0) return;
      await submit(admin, unpublish, (url) => url.searchParams.get('saved') === '1');
      report.writes.catalogUnpublished += 1;
      const after = await readApi('org_admin', `/catalog-admin/${ids.catalogItem}`);
      assert.equal(after.active, false, 'catalog item must be unpublished');
      assert.ok(
        !after.draft.definition.approval?.ruleId,
        'the draft must not keep the approval-rule reference',
      );
    });
  }

  const rules = (await readApi('org_admin', '/approval-rules')).items;
  const activeSynthetic = rules.filter(
    (entry) =>
      String(entry.code).toLowerCase().startsWith('ui016-syn-') &&
      String(entry.code).toLowerCase().endsWith(`-${engine}`) &&
      entry.active,
  );
  for (const rule of activeSynthetic) {
    await step(`合成承認ルールを無効化する(${rule.code})`, async () => {
      await go(admin, `/ops/approvals?rule=${rule.id}#approval-rule-detail`);
      await admin.locator('#approval-deactivate-link').click();
      await admin.waitForURL((url) => url.searchParams.get('confirm') === 'deactivate');
      await submit(
        admin,
        admin.locator('#approval-deactivate-submit'),
        (url) => url.searchParams.get('notice') === 'deactivated',
      );
      report.writes.ruleDeactivations += 1;
      await admin.locator('#approval-notice').waitFor();
      const after = (await readApi('org_admin', '/approval-rules')).items.find(
        (entry) => entry.id === rule.id,
      );
      assert.equal(after.active, false, 'approval rule must be inactive');
    });
  }

  const settings = await readApi('org_admin', '/approval-routing');
  if (settings.setting.enabled !== false) {
    report.cleanup.errors.push({
      name: '最終確認',
      message: '組織での承認ルールが有効なままです',
    });
  }
  const remainingActive = (await readApi('org_admin', '/approval-rules')).items.filter(
    (entry) =>
      String(entry.code).toLowerCase().startsWith('ui016-syn-') &&
      String(entry.code).toLowerCase().endsWith(`-${engine}`) &&
      entry.active,
  );
  if (remainingActive.length > 0) {
    report.cleanup.errors.push({
      name: '最終確認',
      message: `有効な合成承認ルールが ${remainingActive.length} 件残っています`,
    });
  }
  report.cleanup.complete = report.cleanup.errors.length === 0;
  report.currentStep = 'cleanup-complete';
  await flush();
}

async function visibilityChecks() {
  await check('org_admin 以外には画面も導線も出ない(auditor は変更履歴だけ)', async () => {
    const agent = await actor('agent');
    await go(agent, '/portal');
    assert.equal(await agent.locator('.fs-rail a[href="/ops/approvals"]').count(), 0);
    assert.equal(await agent.locator('.fs-rail a[href="/ops/approvals/changes"]').count(), 0);
    await go(agent, '/ops/approvals');
    assert.match(await agent.locator('main').innerText(), /この画面を表示する権限がありません/);
    await go(agent, '/ops/approvals/changes');
    assert.match(await agent.locator('main').innerText(), /この画面を表示する権限がありません/);
    await shot(
      agent,
      'approvals-permission-agent-desktop-1440',
      agent.getByRole('heading', { level: 1 }),
    );

    const auditor = await actor('auditor');
    await go(auditor, '/ops/approvals');
    assert.match(await auditor.locator('main').innerText(), /この画面を表示する権限がありません/);
    assert.equal(await auditor.locator('.fs-rail a[href="/ops/approvals"]').count(), 0);
    assert.ok(
      (await auditor.locator('.fs-rail a[href="/ops/approvals/changes"]').count()) >= 1,
      'The audit rail must link to the change history',
    );
    await go(auditor, '/ops/approvals/changes?from=2026-10-01&to=2026-11-14');
    assert.equal(
      await auditor.getByRole('heading', { name: '上長・部署長の変更履歴', exact: true }).count(),
      1,
    );
    assert.ok((await auditor.locator('table.directory-table tbody tr').count()) >= 1);
    await accessible(auditor, 'approvals-changes-auditor-desktop-1440');
    await shot(
      auditor,
      'approvals-changes-auditor-desktop-1440',
      auditor.getByRole('heading', { level: 1 }),
    );
  });
}

async function mobileChecks(admin) {
  await check('1440px と 375px で横溢れがない', async () => {
    await go(admin, `/ops/approvals?rule=${report.ids.rule}&unresolved=1#approval-rule-detail`);
    await mobile(admin, 'approvals-rule-detail', admin.getByRole('heading', { level: 1 }));
    await go(admin, '/ops/approvals/changes?from=2026-10-01&to=2026-11-14');
    await mobile(admin, 'approvals-changes', admin.getByRole('heading', { level: 1 }));
  });
}

async function firstRun(admin) {
  report.currentStep = 'start';
  await flush();

  await check('管理ホームと左レールに承認ルールの導線がある', async () => {
    activePage = admin;
    await go(admin, '/ops/admin');
    const card = admin.locator('.fs-admin-grid a[href="/ops/approvals"]');
    assert.equal(await card.count(), 1, 'The admin home must contain the approvals card');
    await go(admin, '/ops/users');
    await admin.locator('.fs-rail a.fs-rail-link[href="/ops/admin"]').focus();
    const rail = admin.locator('.fs-rail a[href="/ops/approvals"]');
    assert.equal(await rail.count(), 1, 'The admin rail must contain /ops/approvals');
    await rail.waitFor({ state: 'visible' });
    await rail.focus();
    await Promise.all([
      admin.waitForURL((url) => url.pathname === '/ops/approvals'),
      admin.keyboard.press('Enter'),
    ]);
    await admin.waitForLoadState('networkidle');
    assert.equal(await admin.getByRole('heading', { name: '承認ルール', exact: true }).count(), 1);
  });

  await check('キーボードだけで上長→固定承認者の2段ルールを作成できる', async () => {
    await go(admin, '/ops/approvals');
    const users = (await readApi('org_admin', '/users')).items;
    const approver = users.find(
      (user) =>
        user.status === 'active' &&
        Array.isArray(user.roleCodes) &&
        user.roleCodes.includes('approver'),
    );
    assert.ok(approver, 'an active approver seed user is required');
    report.ids.adminUser = userByEmail(users, 'org_admin@acme.example.test').userId;
    report.ids.agentUser = userByEmail(users, 'agent@acme.example.test').userId;
    report.ids.approverUser = approver.userId;

    const tabsBefore = await tabTo(admin, 'approval-create-code');
    const focus = await focusVisible(admin);
    assert.ok(focus && (focus.outlineStyle !== 'none' || focus.boxShadow !== 'none'));
    await admin.keyboard.type(ruleCode);
    await tabTo(admin, 'approval-create-name');
    assert.equal(await admin.evaluate(() => document.activeElement?.id), 'approval-create-name');
    await admin.keyboard.type(ruleName);
    await admin.locator('#approval-create-step-type-0').selectOption('manager');
    await admin.locator('#approval-create-step-unresolved-0').selectOption('department_head');
    await admin.locator('#approval-create-step-type-1').selectOption('fixed');
    await admin.locator('#approval-create-step-approver-1').selectOption(approver.userId);
    const submitTabs = await tabTo(admin, 'approval-create-submit');
    assert.equal(await admin.evaluate(() => document.activeElement?.tagName), 'BUTTON');
    await Promise.all([
      admin.waitForURL((url) => url.searchParams.get('notice') === 'created'),
      admin.keyboard.press('Enter'),
    ]);
    await admin.waitForLoadState('networkidle');
    report.ids.rule = new URL(admin.url()).searchParams.get('rule');
    assert.ok(report.ids.rule);
    report.applied.rule = true;
    report.writes.rulesCreated += 1;
    report.keyboard = { tabsBefore, submitTabs, focus, submittedWith: 'Enter' };
    await admin.locator('#approval-notice').waitFor();
    const listText = await admin.locator('table.directory-table').first().innerText();
    assert.ok(listText.includes(ruleCode));
    assert.ok(listText.includes('上長（未解決時は部署長へ） → 固定承認者'));
    await accessible(admin, 'approvals-rules-desktop-1440');
    await shot(admin, 'approvals-rules-desktop-1440', admin.getByRole('heading', { level: 1 }));
  });

  await check('既存の版を変えずに新しい版を追加できる', async () => {
    await go(admin, `/ops/approvals?rule=${report.ids.rule}#approval-rule-detail`);
    await admin.locator('#approval-revise-step-unresolved-0').selectOption('reject');
    await submit(
      admin,
      admin.locator('#approval-revise-submit'),
      (url) => url.searchParams.get('notice') === 'revised',
    );
    report.applied.revision = true;
    report.writes.revisions += 1;
    assert.ok(report.writes.revisions <= MAX_REVISIONS);
    await admin.locator('#approval-notice').waitFor();
    const detail = await admin.locator('#approval-rule-detail').innerText();
    assert.match(detail, /現在の版:\s*版2/);
    assert.match(detail, /上長（未解決時は拒否） → 固定承認者/);
    const historyRows = admin.locator('#approval-rule-detail table tbody tr');
    assert.ok((await historyRows.count()) >= 2, 'the revision history must keep both versions');
    await accessible(admin, 'approvals-rule-detail-desktop-1440');
    await shot(
      admin,
      'approvals-rule-detail-desktop-1440',
      admin.locator('#approval-rule-detail-title'),
    );
  });

  await check('ルールのプレビューで解決できない理由を表示する', async () => {
    await go(admin, `/ops/approvals?rule=${report.ids.rule}#approval-preview`);
    await admin.locator('input[name="previewKind"][value="rule"]').check();
    await admin.locator('#approval-preview-rule').selectOption(report.ids.rule);
    await admin.locator('#approval-preview-requester').selectOption(report.ids.adminUser);
    await submit(
      admin,
      admin.locator('#approval-preview-submit'),
      (url) => url.searchParams.get('previewKind') === 'rule',
    );
    const result = admin.locator('section[aria-labelledby="approval-preview-result-title"]');
    await result.waitFor();
    const text = await result.innerText();
    assert.match(text, /経路を解決できません/);
    assert.match(text, /申請者は組織管理者のため上長が未設定です/);
    await accessible(admin, 'approvals-preview-unresolved-desktop-1440');
    await shot(admin, 'approvals-preview-unresolved-desktop-1440', result);
  });

  await check('公開済みカタログ項目のプレビューで承認者の経路を表示する', async () => {
    const catalog = await readApi('org_admin', '/catalog-admin');
    const item =
      catalog.items.find(
        (entry) =>
          entry.active && entry.publishedRevision !== null && entry.title.includes('PC利用申請'),
      ) ?? catalog.items.find((entry) => entry.active && entry.publishedRevision !== null);
    assert.ok(item, 'a published catalog item is required for the resolved preview');
    await go(admin, `/ops/approvals?rule=${report.ids.rule}#approval-preview`);
    await admin.locator('input[name="previewKind"][value="item"]').check();
    await admin.locator('#approval-preview-item').selectOption(item.id);
    await admin.locator('#approval-preview-requester').selectOption(report.ids.agentUser);
    await submit(
      admin,
      admin.locator('#approval-preview-submit'),
      (url) => url.searchParams.get('previewKind') === 'item',
    );
    const result = admin.locator('section[aria-labelledby="approval-preview-result-title"]');
    await result.waitFor();
    const text = await result.innerText();
    assert.match(text, /固定承認者/);
    assert.match(text, /段1/);
    assert.match(text, /承認者/);
    await shot(admin, 'approvals-preview-resolved-desktop-1440', result);
  });

  await check('解決できない人の一覧を表示し、利用者管理へ辿れる', async () => {
    await go(admin, `/ops/approvals?rule=${report.ids.rule}#approval-unresolved`);
    await admin.getByRole('link', { name: '解決できない人を表示する', exact: true }).click();
    await admin.waitForURL((url) => url.searchParams.get('unresolved') === '1');
    const table = admin.locator('table', {
      has: admin.locator('caption', { hasText: '解決できない人の一覧' }),
    });
    await table.waitFor();
    assert.ok((await table.locator('tbody tr').count()) >= 1);
    const link = table.getByRole('link', { name: '利用者管理で確認する' }).first();
    assert.match(await link.getAttribute('href'), /^\/ops\/users\?selected=/);
    await accessible(admin, 'approvals-unresolved-people-desktop-1440');
    await shot(admin, 'approvals-unresolved-people-desktop-1440', table);
  });

  await check('合成カタログ項目を作成し、承認ルールを結び付けて公開できる', async () => {
    if (reuseCatalogId) {
      report.ids.catalogItem = reuseCatalogId;
      report.reusedCatalog = reuseCatalogId;
    } else {
      const itemTitle = `UI016 合成カタログ ${marker}`;
      await go(admin, '/catalog/manage/new');
      await admin.locator('#catalog-title').fill(itemTitle);
      await admin
        .locator('#catalog-description')
        .fill('UI016 の承認ルール結び付けを確認するための合成項目です。');
      await admin.locator('#catalog-approver').selectOption(report.ids.approverUser);
      await submit(
        admin,
        admin.getByRole('button', { name: '下書きを保存してプレビューする', exact: true }),
        (url) =>
          url.pathname.startsWith('/catalog/manage/') && url.searchParams.get('saved') === '1',
      );
      report.ids.catalogItem = new URL(admin.url()).pathname.split('/').at(-1);
      assert.ok(report.ids.catalogItem);
      report.writes.catalogCreated += 1;
      assert.ok(report.writes.catalogCreated <= MAX_CATALOG_ITEMS);
    }
    report.applied.catalog = true;

    await go(admin, `/catalog/manage/${report.ids.catalogItem}`);
    await admin.locator('summary').filter({ hasText: '下書きの項目と承認者を編集する' }).click();
    await admin.locator('#catalog-approval-rule').selectOption(report.ids.rule);
    await submit(
      admin,
      admin.getByRole('button', { name: '下書きを保存してプレビューする', exact: true }),
      (url) => url.searchParams.get('saved') === '1',
    );
    report.applied.catalogRuleBound = true;
    report.writes.catalogUpdates += 1;
    const draft = await readApi('org_admin', `/catalog-admin/${report.ids.catalogItem}`);
    assert.equal(draft.draft.definition.approval?.ruleId, report.ids.rule);
    await shot(admin, 'catalog-rule-bound-desktop-1440', admin.locator('#catalog-approval-rule'));

    await go(admin, `/catalog/manage/${report.ids.catalogItem}`);
    await submit(
      admin,
      admin.getByRole('button', { name: /保存済みの下書き版\d+を公開する/ }),
      (url) => url.searchParams.get('saved') === '1',
    );
    report.applied.catalogPublished = true;
    report.writes.catalogPublished += 1;
    const published = await readApi('org_admin', `/catalog-admin/${report.ids.catalogItem}`);
    assert.equal(published.active, true);
    assert.ok(published.publishedRevision !== null);
  });

  await check('有効化の確認画面に3点を表示し、有効化して状態を確認できる', async () => {
    await go(admin, `/ops/approvals?rule=${report.ids.rule}#approval-routing`);
    await admin.locator('#approval-routing-toggle').click();
    await admin.waitForURL((url) => url.searchParams.get('confirm') === 'enable-routing');
    const confirm = admin.locator('section[aria-labelledby="approval-routing-title"]');
    const text = await confirm.innerText();
    assert.match(text, /新しい申請/);
    assert.match(text, /進行中の申請の経路は変わりません/);
    assert.match(text, /変更履歴/);
    await accessible(admin, 'approvals-enable-confirm-desktop-1440');
    await shot(admin, 'approvals-enable-confirm-desktop-1440', confirm);
    await submit(
      admin,
      admin.locator('#approval-routing-submit'),
      (url) => url.searchParams.get('notice') === 'routing-enabled',
    );
    report.applied.routingEnabledOnce = true;
    report.writes.routingEnabled += 1;
    const enabled = await admin.locator('#approval-routing').innerText();
    assert.match(enabled, /現在の状態:\s*有効/);
    await shot(admin, 'approvals-routing-enabled-desktop-1440', admin.locator('#approval-routing'));
  });

  await check('組織での承認ルールを確認画面を挟んで無効へ戻せる', async () => {
    await go(admin, `/ops/approvals?rule=${report.ids.rule}#approval-routing`);
    await admin.locator('#approval-routing-toggle').click();
    await admin.waitForURL((url) => url.searchParams.get('confirm') === 'disable-routing');
    assert.match(
      await admin.locator('section[aria-labelledby="approval-routing-title"]').innerText(),
      /進行中の申請の経路は変わりません/,
    );
    await submit(
      admin,
      admin.locator('#approval-routing-submit'),
      (url) => url.searchParams.get('notice') === 'routing-disabled',
    );
    report.writes.routingDisabled += 1;
    const disabled = await admin.locator('#approval-routing').innerText();
    assert.match(disabled, /現在の状態:\s*無効/);
    const settings = await readApi('org_admin', '/approval-routing');
    assert.equal(settings.setting.enabled, false);
  });

  await check('承認者不在の申請の節と案内を表示し、再割当を出さない', async () => {
    await go(admin, '/ops/approvals#approval-unavailable');
    const section = admin.locator('section[aria-labelledby="approval-unavailable-title"]');
    await section.waitFor();
    const text = await section.innerText();
    assert.match(text, /承認者不在の申請/);
    assert.match(text, /申請者が内容を変更すると/);
    assert.match(text, /再割当の操作はこの画面にはありません/);
    assert.equal(await section.getByRole('button', { name: /再割当/ }).count(), 0);
    await accessible(admin, 'approvals-unavailable-desktop-1440');
    await shot(admin, 'approvals-unavailable-desktop-1440', section);
  });

  await check('上長・部署長の変更履歴を期間指定で表示する', async () => {
    await go(admin, '/ops/approvals/changes?from=2026-10-01&to=2026-11-14');
    assert.equal(
      await admin.getByRole('heading', { name: '上長・部署長の変更履歴', exact: true }).count(),
      1,
    );
    for (const header of ['日時', '種類', '操作者', '対象者', '変更前', '変更後']) {
      assert.equal(await admin.getByRole('columnheader', { name: header, exact: true }).count(), 1);
    }
    assert.ok((await admin.locator('table.directory-table tbody tr').count()) >= 1);
    const text = await admin.locator('main').innerText();
    assert.ok(!text.includes('社員番号'));
    assert.ok(!text.includes('役職'));
    assert.ok(!text.includes('勤務地'));
    await accessible(admin, 'approvals-changes-desktop-1440');
    await shot(admin, 'approvals-changes-desktop-1440', admin.getByRole('heading', { level: 1 }));
  });

  await check('アクセスレビューから変更履歴へ辿れる', async () => {
    await go(admin, '/ops/access-review');
    const link = admin.getByRole('link', { name: '上長・部署長の変更履歴', exact: true });
    assert.equal(await link.count(), 1);
    await link.focus();
    await Promise.all([
      admin.waitForURL((url) => url.pathname === '/ops/approvals/changes'),
      admin.keyboard.press('Enter'),
    ]);
    await admin.waitForLoadState('networkidle');
    assert.equal(
      await admin.getByRole('heading', { name: '上長・部署長の変更履歴', exact: true }).count(),
      1,
    );
  });

  await visibilityChecks();
  await mobileChecks(admin);

  assert.deepEqual(report.blocked, []);
  await cleanup(admin);
  report.success = true;
  report.currentStep = 'complete';
  delete report.failure;
  report.finishedAt = new Date().toISOString();
  await flush();
}

async function cleanupOnly(admin) {
  report.cleanup = { attempted: false, complete: false, steps: [], errors: [] };
  await cleanup(admin);
  assert.deepEqual(report.cleanup.errors, [], 'cleanup errors must be empty');
  const settings = await readApi('org_admin', '/approval-routing');
  assert.equal(settings.setting.enabled, false, 'Approval routing must be disabled');
  const rules = (await readApi('org_admin', '/approval-rules')).items;
  const rule = rules.find((entry) => entry.id === report.ids.rule);
  assert.ok(rule && rule.active === false, 'The synthetic rule must be inactive');
  if (report.ids.catalogItem) {
    const detail = await readApi('org_admin', `/catalog-admin/${report.ids.catalogItem}`);
    assert.equal(detail.active, false, 'The synthetic catalog item must be unpublished');
    assert.ok(
      !detail.draft.definition.approval?.ruleId,
      'The draft must not keep the approval-rule reference',
    );
  }
  report.success = true;
  report.currentStep = 'cleanup-complete';
  delete report.failure;
  report.finishedAt = new Date().toISOString();
  await flush();
}

async function verifyOnly(admin) {
  const settings = await readApi('org_admin', '/approval-routing');
  assert.equal(settings.setting.enabled, false, 'Approval routing must be disabled');
  assert.ok(report.writes.rulesCreated <= MAX_RULES, 'The rule cap must hold');
  assert.ok(report.writes.revisions <= MAX_REVISIONS, 'The revision cap must hold');
  assert.ok(report.writes.catalogCreated <= MAX_CATALOG_ITEMS, 'The catalog cap must hold');

  await check('再検証: 無効化したルールの版の履歴を読み取れる', async () => {
    activePage = admin;
    await go(admin, `/ops/approvals?rule=${report.ids.rule}#approval-rule-detail`);
    const detail = await admin.locator('#approval-rule-detail').innerText();
    assert.match(detail, /無効/);
    assert.match(detail, /版2/);
    assert.ok((await admin.locator('#approval-rule-detail table tbody tr').count()) >= 2);
    await accessible(admin, 'approvals-rule-detail-desktop-1440-readonly');
    await shot(
      admin,
      'approvals-rule-detail-desktop-1440-readonly',
      admin.locator('#approval-rule-detail-title'),
    );
  });

  await check('再検証: 承認者不在の節が案内と再割当の不在を表示する', async () => {
    await go(admin, '/ops/approvals#approval-unavailable');
    const section = admin.locator('section[aria-labelledby="approval-unavailable-title"]');
    await section.waitFor();
    const text = await section.innerText();
    assert.match(text, /承認者不在の申請/);
    assert.match(text, /申請者が内容を変更すると/);
    assert.match(text, /再割当の操作はこの画面にはありません/);
    assert.equal(await section.getByRole('button', { name: /再割当/ }).count(), 0);
    await accessible(admin, 'approvals-unavailable-desktop-1440-readonly');
    await shot(admin, 'approvals-unavailable-desktop-1440-readonly', section);
  });

  await check('再検証: 変更した既存画面に新しい導線と選択肢がある(axe)', async () => {
    await go(admin, '/ops/admin');
    assert.equal(await admin.locator('.fs-admin-grid a[href="/ops/approvals"]').count(), 1);
    await accessible(admin, 'admin-home-desktop-1440-verify');
    await go(admin, '/catalog/manage/new');
    assert.equal(await admin.locator('#catalog-approval-rule').count(), 1);
    assert.match(
      await admin.locator('#catalog-approval-rule-hint').innerText(),
      /組織で承認ルールが有効なときだけ/,
    );
    await accessible(admin, 'catalog-new-desktop-1440-verify');
    await go(admin, '/ops/access-review');
    assert.equal(
      await admin.getByRole('link', { name: '上長・部署長の変更履歴', exact: true }).count(),
      1,
    );
    await accessible(admin, 'access-review-desktop-1440-verify');
  });

  await check('再検証: APIの拒否理由を画面に表示する(重複コード)', async () => {
    await go(admin, '/ops/approvals');
    const existingCode = String(report.marker).toLowerCase();
    await admin.locator('#approval-create-code').fill(existingCode);
    await admin.locator('#approval-create-name').fill(`UI016 重複確認 ${report.marker}`);
    await admin.locator('#approval-create-step-type-0').selectOption('manager');
    await admin.locator('#approval-create-step-unresolved-0').selectOption('reject');
    await submit(admin, admin.locator('#approval-create-submit'), (url) =>
      Boolean(url.searchParams.get('error')),
    );
    const text = await admin.locator('#approval-error').innerText();
    assert.match(text, /同じコードの承認ルールが既にあります/);
    assert.ok(!/23505|duplicate key|Error:/.test(text));
    await accessible(admin, 'approvals-create-error-desktop-1440');
    await shot(admin, 'approvals-create-error-desktop-1440', admin.locator('#approval-error'));
  });

  await visibilityChecks();
  await mobileChecks(admin);
  assert.deepEqual(report.blocked, []);
  report.success = true;
  report.currentStep = 'verify-complete';
  delete report.failure;
  report.finishedAt = new Date().toISOString();
  await flush();
}

async function reconcile(admin) {
  const ids = report.ids ?? {};
  const rules = (await readApi('org_admin', '/approval-rules')).items;
  const rule = rules.find((entry) => entry.id === ids.rule);
  assert.ok(rule, 'The previous synthetic rule must still be readable');
  assert.equal(rule.active, false, 'The previous synthetic rule must be inactive');
  const settings = await readApi('org_admin', '/approval-routing');
  assert.equal(settings.setting.enabled, false, 'Approval routing must be disabled');
  if (ids.catalogItem) {
    const detail = await readApi('org_admin', `/catalog-admin/${ids.catalogItem}`);
    assert.equal(detail.active, false, 'The previous synthetic catalog item must be unpublished');
    assert.ok(
      !detail.draft.definition.approval?.ruleId,
      'The previous synthetic catalog item must not keep the rule reference',
    );
  }

  await check('再実行: 合成ルールは無効、組織の設定は無効のまま', async () => {
    activePage = admin;
    await go(admin, `/ops/approvals?rule=${ids.rule}#approval-rule-detail`);
    assert.equal(await admin.getByRole('heading', { name: '承認ルール', exact: true }).count(), 1);
    assert.match(await admin.locator('#approval-rule-detail').innerText(), /無効/);
    assert.match(await admin.locator('#approval-routing').innerText(), /現在の状態:\s*無効/);
    await accessible(admin, 'approvals-rule-detail-desktop-1440-readonly');
    await shot(
      admin,
      'approvals-rule-detail-desktop-1440-readonly',
      admin.locator('#approval-rule-detail-title'),
    );
  });

  await check('再実行: 変更履歴と承認者不在の節を読み取りで確認する', async () => {
    await go(admin, '/ops/approvals/changes?from=2026-10-01&to=2026-11-14');
    assert.equal(
      await admin.getByRole('heading', { name: '上長・部署長の変更履歴', exact: true }).count(),
      1,
    );
    await go(admin, '/ops/approvals#approval-unavailable');
    assert.equal(
      await admin.getByRole('heading', { name: '承認者不在の申請', exact: true }).count(),
      1,
    );
    await accessible(admin, 'approvals-unavailable-desktop-1440-readonly');
    await shot(
      admin,
      'approvals-unavailable-desktop-1440-readonly',
      admin.locator('section[aria-labelledby="approval-unavailable-title"]'),
    );
  });

  const previousWrites = previous?.writes ?? {};
  assert.deepEqual(report.writes, previousWrites, 'A re-run must not write');
  assert.deepEqual(report.blocked, []);
  report.success = true;
  report.currentStep = 'complete-reconciliation';
  delete report.failure;
  report.finishedAt = new Date().toISOString();
  await flush();
}

async function main() {
  await mkdir(output, { recursive: true });
  browser = await (engine === 'webkit' ? webkit : chromium).launch(
    engine === 'chromium' ? { channel: 'chrome', headless: true } : { headless: true },
  );
  report.browserVersion = browser.version();
  const admin = await actor('org_admin');
  if (phase === 'cleanup') {
    assert.ok(previous, 'The cleanup phase needs the previous summary');
    await cleanupOnly(admin);
    return;
  }
  if (phase === 'verify') {
    assert.ok(previous, 'The verify phase needs the previous summary');
    await verifyOnly(admin);
    return;
  }
  if (previous) {
    await reconcile(admin);
    return;
  }
  await preflight();
  await firstRun(admin);
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
  if (!previous && pages.has('org_admin')) {
    try {
      await cleanup(pages.get('org_admin'));
    } catch (cleanupError) {
      report.cleanup.errors.push({
        name: '失敗後の片付け',
        message: String(cleanupError?.message ?? cleanupError),
      });
    }
  }
} finally {
  for (const context of contexts.values()) await context.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await mkdir(output, { recursive: true });
  await flush();
  console.log(
    `Approval UI ${engine}: ${report.success ? 'PASS' : 'FAIL'}; ${report.checks.length} checks; ${report.accessibility.length} axe scans; ${JSON.stringify(report.writes)}`,
  );
  if (report.failure) console.log(report.failure);
  if (!report.success) process.exitCode = 1;
}
