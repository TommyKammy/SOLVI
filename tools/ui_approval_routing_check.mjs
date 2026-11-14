/* global document, innerWidth, HTMLElement, getComputedStyle */
// WP-P4-APR-016: loopback-only approval-rule admin (stage A) and end-to-end
// requester / manager / fixed-approver walkthrough (stage B).
//
// Data rules (brief §ブラウザ確認とデータの扱い):
//  - every write goes through the screens; only SEED synthetic accounts are used
//  - markers: rule code `ui016b-syn-`, department code `UI016B-SYN-`,
//    catalog title contains `UI016B`, request inputs contain `UI016B`
//  - caps (per browser engine): 2 rules, 2 departments, 1 department head,
//    2 people with profile changes, 1 catalog item, 3 requests
//  - a re-run with a previous summary performs read-only reconciliation
//  - cleanup always tries to disable organisation-wide routing first
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
const phase = process.env.SOLVI_UI_PHASE ?? 'full';
assert.ok(
  ['full', 'cleanup', 'verify', 'resume', 'b2', 'b2readonly', 'b2detail', 'wp018', 'wp018resume', 'wp018cleanup'].includes(
    phase,
  ),
  `Unknown phase ${phase}`,
);
const wp018Phase = phase.startsWith('wp018');
const output = resolve(
  process.env.SOLVI_UI_OUT ??
    `evidence/${wp018Phase ? 'WP-P4-APR-018' : 'WP-P4-APR-016'}/browser/${engine}`,
);
const MAX_RULES = 2;
const MAX_REVISIONS = 2;
const MAX_DEPARTMENTS = 2;
const MAX_DEPARTMENT_HEADS = 1;
const MAX_PROFILE_PEOPLE = 2;
const MAX_CATALOG_ITEMS = 1;
const MAX_REQUESTS = 3;

// WP-P4-APR-018 (B2): organisation admin reassignment of an unavailable approver.
// Caps are shared across both engines: 2 rules, 2 departments, 3 people with
// profile changes, 2 catalog items, 4 requests, 4 reassignments.
const MAX_WP018_RULES = 2;
const MAX_WP018_DEPARTMENTS = 2;
const MAX_WP018_PROFILE_PEOPLE = 3;
const MAX_WP018_CATALOG_ITEMS = 2;
const MAX_WP018_REQUESTS = 4;
const MAX_WP018_REASSIGNMENTS = 4;
const wp018Marker = `UI018-SYN-${Date.now()}-${engine}`;
const wp018RuleCode = `ui018-syn-${Date.now()}-${engine}`;
const wp018RuleName = `UI018 合成 再割当確認 ${engine}`;
const wp018DepartmentCode = `UI018-SYN-${Date.now()}-${engine}`;
const wp018ItemTitle = `UI018 合成カタログ ${wp018Marker}`;
const wp018Reason = `UI018 再割当の理由: 上長Aの所属が一時的に無効になったため。`;
const wp018RoleReason = `UI018 ブラウザ確認のため一時的に役割を外す（${engine}）`;

const stamp = Date.now();
const marker = `UI016B-SYN-${stamp}-${engine}`;
const ruleCode = `ui016b-syn-${stamp}-${engine}`;
const resumeRuleCode = `ui016b-syn-${stamp + 1}-${engine}`;
const ruleName = `UI016B 合成 2段承認 ${engine}`;
const departmentCode = `UI016B-SYN-${stamp}-${engine}`;

let previous;
try {
  previous = JSON.parse(await readFile(resolve(output, 'summary.json'), 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (previous) {
  assert.equal(previous.browser, engine, 'The previous summary belongs to another browser');
  if (wp018Phase) assert.match(previous.marker, /^UI018-SYN-\d+-(chromium|webkit)$/);
  else assert.match(previous.marker, /^UI016B-SYN-\d+-(chromium|webkit)$/);
}
const previousHasData = Boolean(
  previous &&
  (Object.values(previous.writes ?? {}).some((count) => count > 0) ||
    Object.values(previous.ids ?? {}).some(Boolean)),
);
if (!previousHasData) previous = undefined;

// Stage B2 (supervisor re-run): reuse the stage-B synthetic catalog item and
// completed request, add exactly one temporary rule per engine, and cover the
// two checks that were left open. The previous summary is read from
// SOLVI_UI_PREVIOUS; the new evidence directory gets a fresh summary.
let b2Previous;
if (phase === 'b2') {
  assert.ok(process.env.SOLVI_UI_PREVIOUS, 'SOLVI_UI_PREVIOUS is required for the b2 phase');
  b2Previous = JSON.parse(await readFile(resolve(process.env.SOLVI_UI_PREVIOUS), 'utf8'));
  assert.equal(b2Previous.browser, engine, 'The previous summary belongs to another browser');
  assert.equal(b2Previous.success, true, 'The previous stage-B run must have succeeded');
  assert.ok(b2Previous.ids?.catalogItem, 'The previous synthetic catalog item is required');
  assert.ok(b2Previous.ids?.request, 'The previous completed request is required');
}

let report = previous
  ? {
      ...previous,
      success: false,
      currentStep: 'reconciliation',
      blocked: [],
    }
  : {
      workPackage: 'WP-P4-APR-016',
      stage: 'B',
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
        departmentsCreated: 0,
        departmentHeadAssignments: 0,
        departmentDeactivations: 0,
        profileUpdates: 0,
        profilePeople: [],
        requestsCreated: 0,
      },
      ids: {
        rule: null,
        catalogItem: null,
        department: null,
        request: null,
        requesterUser: null,
        managerUser: null,
        fixedApproverUser: null,
        headUser: null,
        agentUser: null,
      },
      applied: {
        rule: false,
        revision: false,
        catalog: false,
        catalogRuleBound: false,
        catalogPublished: false,
        routingEnabledOnce: false,
        department: false,
        profiles: false,
        departmentHead: false,
        requestCreated: false,
        managerApproved: false,
        fixedApproved: false,
        simulated: false,
      },
      cleanup: { attempted: false, complete: false, steps: [], errors: [] },
      keyboard: null,
      blocked: [],
    };

if (b2Previous) {
  report.stage = 'B2';
  report.previousEvidence = process.env.SOLVI_UI_PREVIOUS;
  report.success = false;
  report.currentStep = 'start-b2';
  report.checks = [];
  report.accessibility = [];
  report.screenshots = [];
  report.blocked = [];
  report.keyboard = null;
  report.writes = {
    rulesCreated: 0,
    revisions: 0,
    catalogCreated: 0,
    catalogUpdates: 0,
    catalogPublished: 0,
    catalogUnpublished: 0,
    routingEnabled: 0,
    routingDisabled: 0,
    ruleDeactivations: 0,
    departmentsCreated: 0,
    departmentHeadAssignments: 0,
    departmentDeactivations: 0,
    profileUpdates: 0,
    profilePeople: [],
    requestsCreated: 0,
  };
  report.ids = {
    rule: null,
    catalogItem: b2Previous.ids.catalogItem,
    department: null,
    request: b2Previous.ids.request,
    requesterUser: b2Previous.ids.requesterUser,
    managerUser: b2Previous.ids.managerUser,
    fixedApproverUser: b2Previous.ids.fixedApproverUser,
    headUser: b2Previous.ids.headUser,
    agentUser: b2Previous.ids.agentUser,
    adminUser: b2Previous.ids.adminUser,
  };
  report.applied = {
    rule: false,
    revision: false,
    catalog: false,
    catalogRuleBound: false,
    catalogPublished: false,
    routingEnabledOnce: false,
    department: false,
    profiles: false,
    departmentHead: false,
    requestCreated: false,
    managerApproved: false,
    fixedApproved: false,
    simulated: false,
  };
  report.cleanup = { attempted: false, complete: false, steps: [], errors: [] };
}

if (wp018Phase) {
  report = {
    workPackage: 'WP-P4-APR-018',
    stage: 'B2',
    browser: engine,
    marker: wp018Marker,
    success: false,
    createdAt: new Date().toISOString(),
    base: base.origin,
    apiBase: apiBase.origin,
    node: process.version,
    platform: process.platform,
    command:
      'SOLVI_SMOKE_PASSWORD=<redacted> SOLVI_UI_BROWSER=<engine> SOLVI_UI_PHASE=wp018 node tools/ui_approval_routing_check.mjs',
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
      departmentsCreated: 0,
      departmentHeadAssignments: 0,
      departmentDeactivations: 0,
      profileUpdates: 0,
      profilePeople: [],
      requestsCreated: 0,
      reassignments: 0,
      roleRevokes: 0,
      roleGrants: 0,
    },
    ids: {
      rule: null,
      catalogItem: null,
      department: null,
      request: null,
      requestNumber: null,
      requesterUser: null,
      managerAUser: null,
      managerBUser: null,
      fixedApproverUser: null,
      agentUser: null,
      adminUser: null,
    },
    applied: {
      department: false,
      profiles: false,
      rule: false,
      catalog: false,
      catalogRuleBound: false,
      catalogPublished: false,
      routingEnabledOnce: false,
      requestCreated: false,
      managerARoleRevoked: false,
      managerARoleRestored: false,
      reassigned: false,
      managerBApproved: false,
      fixedApproved: false,
      simulated: false,
    },
    roleChange: {
      targetEmail: 'auditor@acme.example.test',
      roleCode: 'auditor',
      hadExpiry: false,
      removedAt: null,
      restoredAt: null,
      removalNotice: null,
      restoreNotice: null,
      restoreVia: null,
      hiddenFromDirectory: null,
    },
    reassignAttempts: [],
    cleanup: { attempted: false, complete: false, steps: [], errors: [] },
    keyboard: null,
    blocked: [],
  };
  if (previous) {
    report.previousEvidence = resolve(output, 'summary.json');
    report.previousSuccess = previous.success === true;
  }
}

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

async function login(page, email, orgName = 'サンプル株式会社') {
  await page.goto(new URL('/login', base).href);
  await page.getByLabel('メールアドレス', { exact: true }).fill(email);
  await page.getByLabel('パスワード', { exact: true }).fill(password);
  await Promise.all([
    page.waitForURL((url) => url.pathname !== '/login'),
    page.getByRole('button', { name: 'ログイン', exact: true }).click(),
  ]);
  if (new URL(page.url()).pathname === '/select-organization') {
    await page.getByLabel(orgName, { exact: true }).check();
    await Promise.all([
      page.waitForURL((url) => url.pathname !== '/select-organization'),
      page.getByRole('button', { name: /この組織(で続ける|へ切り替える)/ }).click(),
    ]);
  }
  await page.waitForLoadState('networkidle');
}

async function actor(key, email = `${key}@acme.example.test`, orgName = 'サンプル株式会社') {
  if (pages.has(key)) return pages.get(key);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  contexts.set(key, context);
  await guard(context);
  const page = await context.newPage();
  activePage = page;
  page.setDefaultTimeout(25000);
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await login(page, email, orgName);
      pages.set(key, page);
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
  if (target) {
    await target
      .evaluate((element) => element.scrollIntoView({ block: 'center', behavior: 'auto' }))
      .catch(() => undefined);
  }
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

async function desktop(page, name, target) {
  await accessible(page, `${name}-desktop-1440`);
  await shot(page, `${name}-desktop-1440`, target);
  await mobile(page, name, target);
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

function syntheticRule(entry) {
  return (
    String(entry.code).toLowerCase().startsWith('ui016b-syn-') &&
    String(entry.code).toLowerCase().endsWith(`-${engine}`)
  );
}

function hasValue(profile) {
  return Boolean(profile.primaryDepartmentId || profile.managerUserId);
}

async function preflight() {
  const rules = (await readApi('org_admin', '/approval-rules')).items;
  const syntheticRules = rules.filter(syntheticRule);
  assert.ok(
    syntheticRules.length + 1 <= MAX_RULES,
    `Synthetic approval-rule cap for ${engine}: ${syntheticRules.length} already exist`,
  );
  assert.ok(
    syntheticRules.every((entry) => entry.active === false),
    'A leftover UI016B rule must be inactive',
  );
  const catalog = (await readApi('org_admin', '/catalog-admin')).items;
  const syntheticItems = catalog.filter(
    (item) => String(item.title).includes('UI016B') && String(item.title).includes(`-${engine}`),
  );
  assert.equal(syntheticItems.length, 0, 'A prior UI016B catalog item must be reconciled first');
  const departments = (await readApi('org_admin', '/departments')).items;
  const syntheticDepartments = departments.filter(
    (entry) =>
      String(entry.code).startsWith('UI016B-SYN-') && String(entry.code).endsWith(`-${engine}`),
  );
  assert.equal(syntheticDepartments.length, 0, 'A prior UI016B department must be reconciled');
  const users = (await readApi('org_admin', '/users')).items;
  const filled = [];
  for (const user of users) {
    const profile = await readApi('org_admin', `/users/${user.userId}/profile`);
    if (hasValue(profile.profile)) filled.push(user.email);
  }
  assert.deepEqual(filled, [], 'Profiles must start empty for this run');
  const requests = await readApi('org_admin', `/service-requests?q=${encodeURIComponent(marker)}`);
  assert.equal(requests.total, 0, 'A prior UI016B request must be reconciled first');
  const settings = await readApi('org_admin', '/approval-routing');
  assert.equal(settings.setting.enabled, false, 'Approval routing must start disabled');
}

async function disableRouting(admin) {
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
}

async function resetRequesterProfile(admin) {
  const users = (await readApi('org_admin', '/users')).items;
  const requester = userByEmail(users, 'requester@acme.example.test');
  const profile = (await readApi('org_admin', `/users/${requester.userId}/profile`)).profile;
  if (!hasValue(profile)) return false;
  await go(admin, `/ops/users?selected=${requester.userId}`);
  await admin.locator('#profile-primary-department').selectOption('');
  await admin.locator('#profile-manager').selectOption('');
  await submit(
    admin,
    admin.getByRole('button', { name: 'プロフィールを保存する', exact: true }),
    (url) => url.searchParams.get('notice') === 'profile',
  );
  report.writes.profileUpdates += 1;
  await admin.locator('#directory-notice').waitFor();
  const after = (await readApi('org_admin', `/users/${requester.userId}/profile`)).profile;
  assert.equal(hasValue(after), false, 'the requester profile must be unset');
  return true;
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

  // 1. Organisation-wide rule usage must never be left enabled.
  await step('組織での承認ルールを無効へ戻す', () => disableRouting(admin));

  // 2. Reset the profile values changed for the walkthrough.
  await step('変更したプロフィール(主部署・上長)を未設定へ戻す', async () => {
    await resetRequesterProfile(admin);
  });

  // 3. End the department head, then deactivate the synthetic department.
  if (ids.department) {
    await step('合成部署の部署長を終了する', async () => {
      await go(admin, `/ops/departments?department=${ids.department}#department-head`);
      if ((await admin.locator('#department-head-end').count()) === 0) return;
      await submit(
        admin,
        admin.getByRole('button', { name: '部署長を終了する', exact: true }),
        (url) => url.searchParams.get('notice') === 'head-ended',
      );
      await admin.locator('#department-notice').waitFor();
    });
    await step('合成部署を無効化する', async () => {
      await go(admin, `/ops/departments?department=${ids.department}#deactivate-department`);
      const trigger = admin.getByRole('link', { name: 'この部署を無効化する', exact: true });
      if ((await trigger.count()) === 0) return;
      await Promise.all([
        admin.waitForURL((url) => url.searchParams.get('confirm') === 'deactivate'),
        trigger.click(),
      ]);
      await submit(
        admin,
        admin.getByRole('button', { name: '無効化する', exact: true }),
        (url) => url.searchParams.get('notice') === 'deactivated',
      );
      report.writes.departmentDeactivations += 1;
      await admin.locator('#department-notice').waitFor();
    });
  }

  // 4. Unbind and unpublish the synthetic catalog item.
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

  // 5. Deactivate every synthetic rule left active.
  const rules = (await readApi('org_admin', '/approval-rules')).items;
  const activeSynthetic = rules.filter((entry) => syntheticRule(entry) && entry.active);
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

  // 6. Final invariants.
  const settings = await readApi('org_admin', '/approval-routing');
  if (settings.setting.enabled !== false) {
    report.cleanup.errors.push({
      name: '最終確認',
      message: '組織での承認ルールが有効なままです',
    });
  }
  const remainingActive = (await readApi('org_admin', '/approval-rules')).items.filter(
    (entry) => syntheticRule(entry) && entry.active,
  );
  if (remainingActive.length > 0) {
    report.cleanup.errors.push({
      name: '最終確認',
      message: `有効な合成承認ルールが ${remainingActive.length} 件残っています`,
    });
  }
  const departments = (await readApi('org_admin', '/departments')).items;
  const activeDepartments = departments.filter(
    (entry) => String(entry.code).startsWith('UI016B-SYN-') && entry.active,
  );
  if (activeDepartments.length > 0) {
    report.cleanup.errors.push({
      name: '最終確認',
      message: `有効な合成部署が ${activeDepartments.length} 件残っています`,
    });
  }
  for (const department of departments.filter((entry) =>
    String(entry.code).startsWith('UI016B-SYN-'),
  )) {
    const head = await readApi('org_admin', `/departments/${department.id}/head`);
    if (head.head !== null) {
      report.cleanup.errors.push({
        name: '最終確認',
        message: `終了していない合成部署長が残っています(${department.code})`,
      });
    }
  }
  const users = (await readApi('org_admin', '/users')).items;
  const filled = [];
  for (const user of users) {
    const profile = (await readApi('org_admin', `/users/${user.userId}/profile`)).profile;
    if (hasValue(profile)) filled.push(user.email);
  }
  if (filled.length > 0) {
    report.cleanup.errors.push({
      name: '最終確認',
      message: `値の入ったプロフィールが ${filled.length} 件残っています`,
    });
  }
  if (report.writes.profilePeople.length > MAX_WP018_PROFILE_PEOPLE) {
    report.cleanup.errors.push({
      name: '最終確認',
      message: `プロフィールを変更した人数が上限を超えています(${report.writes.profilePeople.length})`,
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
    await desktop(auditor, 'approvals-changes-auditor', auditor.getByRole('heading', { level: 1 }));
  });
}

async function mobileChecks(admin) {
  await check('管理画面は1440pxと375pxで横溢れがない', async () => {
    await go(admin, `/ops/approvals?rule=${report.ids.rule}&unresolved=1#approval-rule-detail`);
    await mobile(admin, 'approvals-rule-detail', admin.getByRole('heading', { level: 1 }));
    await go(admin, '/ops/approvals/changes?from=2026-10-01&to=2026-11-14');
    await mobile(admin, 'approvals-changes', admin.getByRole('heading', { level: 1 }));
  });
}

async function adminFirstRun(admin) {
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
    report.ids.requesterUser = userByEmail(users, 'requester@acme.example.test').userId;
    report.ids.managerUser = userByEmail(users, 'auditor@acme.example.test').userId;
    report.ids.fixedApproverUser = approver.userId;
    report.ids.headUser = report.ids.agentUser;
    const manager = users.find((user) => user.userId === report.ids.managerUser);
    assert.ok(!manager.roleCodes.includes('approver'), 'the manager must not hold approver');

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
    await desktop(admin, 'approvals-rules', admin.getByRole('heading', { level: 1 }));
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
    await desktop(admin, 'approvals-rule-detail', admin.locator('#approval-rule-detail-title'));
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
    await desktop(admin, 'approvals-preview-unresolved', result);
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
    await desktop(admin, 'approvals-unresolved-people', table);
  });

  await check('合成カタログ項目を作成し、承認ルールを結び付けて公開できる', async () => {
    const itemTitle = `UI016B 合成カタログ ${marker}`;
    await go(admin, '/catalog/manage/new');
    await admin.locator('#catalog-title').fill(itemTitle);
    await admin
      .locator('#catalog-description')
      .fill('UI016B の承認ルール結び付けを確認するための合成項目です。');
    await admin.locator('#catalog-approver').selectOption(report.ids.fixedApproverUser);
    await submit(
      admin,
      admin.getByRole('button', { name: '下書きを保存してプレビューする', exact: true }),
      (url) => url.pathname.startsWith('/catalog/manage/') && url.searchParams.get('saved') === '1',
    );
    report.ids.catalogItem = new URL(admin.url()).pathname.split('/').at(-1);
    assert.ok(report.ids.catalogItem);
    report.writes.catalogCreated += 1;
    assert.ok(report.writes.catalogCreated <= MAX_CATALOG_ITEMS);
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
    await desktop(admin, 'approvals-enable-confirm', confirm);
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
    await desktop(admin, 'approvals-unavailable', section);
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
    const text = await admin.locator('main').innerText();
    assert.ok(!text.includes('社員番号'));
    assert.ok(!text.includes('役職'));
    assert.ok(!text.includes('勤務地'));
    await desktop(admin, 'approvals-changes', admin.getByRole('heading', { level: 1 }));
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
}

async function stageBWalkthrough(admin, resume = false) {
  if (!resume) {
    await check('組織管理者が合成の部署を作り、申請者の主部署と上長を設定する', async () => {
      await go(admin, '/ops/departments');
      await admin.locator('#department-code').fill(departmentCode);
      await admin.locator('#department-name').fill(`UI016B 合成部署 ${engine}`);
      await submit(admin, admin.locator('#department-create-submit'), (url) =>
        Boolean(url.searchParams.get('notice') === 'created'),
      );
      report.ids.department = new URL(admin.url()).searchParams.get('department');
      assert.ok(report.ids.department, 'the created department id is required');
      report.applied.department = true;
      report.writes.departmentsCreated += 1;
      assert.ok(report.writes.departmentsCreated <= MAX_DEPARTMENTS);
      await admin.locator('#department-notice').waitFor();

      await go(admin, `/ops/users?selected=${report.ids.requesterUser}`);
      await admin.locator('#profile-primary-department').selectOption(report.ids.department);
      await admin.locator('#profile-manager').selectOption(report.ids.managerUser);
      await submit(
        admin,
        admin.getByRole('button', { name: 'プロフィールを保存する', exact: true }),
        (url) => url.searchParams.get('notice') === 'profile',
      );
      report.applied.profiles = true;
      report.writes.profileUpdates += 1;
      if (!report.writes.profilePeople.includes(report.ids.requesterUser))
        report.writes.profilePeople.push(report.ids.requesterUser);
      assert.ok(report.writes.profilePeople.length <= MAX_PROFILE_PEOPLE);
      const profile = await readApi('org_admin', `/users/${report.ids.requesterUser}/profile`);
      assert.equal(profile.profile.primaryDepartmentId, report.ids.department);
      assert.equal(profile.profile.managerUserId, report.ids.managerUser);
      await shot(admin, 'users-profile-manager-set-desktop-1440', admin.locator('#member-details'));

      await go(admin, `/ops/departments?department=${report.ids.department}#department-head`);
      await admin.locator('#department-head-user').selectOption(report.ids.headUser);
      await submit(
        admin,
        admin.getByRole('button', { name: '部署長に設定する', exact: true }),
        (url) => url.searchParams.get('notice') === 'head-assigned',
      );
      report.applied.departmentHead = true;
      report.writes.departmentHeadAssignments += 1;
      assert.ok(report.writes.departmentHeadAssignments <= MAX_DEPARTMENT_HEADS);
      await admin.locator('#department-notice').waitFor();
      await desktop(admin, 'departments-head-assigned', admin.locator('#department-head'));
    });
  } else {
    await check('再開: 合成ルールを作り直し、項目に結び付けて公開する', async () => {
      await go(admin, '/ops/approvals');
      await admin.locator('#approval-create-code').fill(resumeRuleCode);
      await admin.locator('#approval-create-name').fill(`${ruleName} 再開`);
      await admin.locator('#approval-create-step-type-0').selectOption('manager');
      await admin.locator('#approval-create-step-unresolved-0').selectOption('reject');
      await admin.locator('#approval-create-step-type-1').selectOption('fixed');
      await admin
        .locator('#approval-create-step-approver-1')
        .selectOption(report.ids.fixedApproverUser);
      await submit(
        admin,
        admin.locator('#approval-create-submit'),
        (url) => url.searchParams.get('notice') === 'created',
      );
      report.ids.resumeRule = new URL(admin.url()).searchParams.get('rule');
      assert.ok(report.ids.resumeRule);
      report.writes.rulesCreated += 1;
      assert.ok(report.writes.rulesCreated <= MAX_RULES, 'The rule cap must hold');

      await go(admin, `/catalog/manage/${report.ids.catalogItem}`);
      await admin.locator('summary').filter({ hasText: '下書きの項目と承認者を編集する' }).click();
      await admin.locator('#catalog-approval-rule').selectOption(report.ids.resumeRule);
      await submit(
        admin,
        admin.getByRole('button', { name: '下書きを保存してプレビューする', exact: true }),
        (url) => url.searchParams.get('saved') === '1',
      );
      report.writes.catalogUpdates += 1;
      await go(admin, `/catalog/manage/${report.ids.catalogItem}`);
      await submit(
        admin,
        admin.getByRole('button', { name: /保存済みの下書き版\d+を公開する/ }),
        (url) => url.searchParams.get('saved') === '1',
      );
      report.writes.catalogPublished += 1;

      await go(admin, `/ops/users?selected=${report.ids.requesterUser}`);
      await admin.locator('#profile-manager').selectOption(report.ids.managerUser);
      await submit(
        admin,
        admin.getByRole('button', { name: 'プロフィールを保存する', exact: true }),
        (url) => url.searchParams.get('notice') === 'profile',
      );
      report.writes.profileUpdates += 1;
      const profile = await readApi('org_admin', `/users/${report.ids.requesterUser}/profile`);
      assert.equal(profile.profile.managerUserId, report.ids.managerUser);
      const published = await readApi('org_admin', `/catalog-admin/${report.ids.catalogItem}`);
      assert.equal(published.active, true);
      assert.equal(published.draft.definition.approval?.ruleId, report.ids.resumeRule);
    });
  }

  await check('組織でルールを有効にし、申請画面が2段の経路を表示する', async () => {
    await go(
      admin,
      `/ops/approvals?rule=${report.ids.resumeRule ?? report.ids.rule}#approval-routing`,
    );
    await admin.locator('#approval-routing-toggle').click();
    await admin.waitForURL((url) => url.searchParams.get('confirm') === 'enable-routing');
    await submit(
      admin,
      admin.locator('#approval-routing-submit'),
      (url) => url.searchParams.get('notice') === 'routing-enabled',
    );
    report.writes.routingEnabled += 1;
    assert.equal((await readApi('org_admin', '/approval-routing')).setting.enabled, true);

    const requester = await actor('requester');
    await go(requester, `/catalog/${report.ids.catalogItem}`);
    const route = requester.locator('section[aria-labelledby="request-approval-route-title"]');
    await route.waitFor();
    const text = await route.innerText();
    assert.match(text, /段1（上長）/);
    assert.match(text, /段2（固定承認者）/);
    assert.match(text, /サンプル株式会社 auditor/);
    assert.match(text, /サンプル株式会社 approver/);
    assert.equal(await requester.locator('#request-approver').count(), 0);
    assert.equal(await requester.locator('input[name="approverId"]').count(), 0);
    const submitButton = requester.getByRole('button', { name: '申請する（模擬）', exact: true });
    assert.equal(await submitButton.isDisabled(), false);
    const tabs = await tabTo(requester, 'request-reason');
    const focus = await focusVisible(requester);
    assert.ok(focus && (focus.outlineStyle !== 'none' || focus.boxShadow !== 'none'));
    report.keyboard = { ...(report.keyboard ?? {}), requesterTabs: tabs, requesterFocus: focus };
    await desktop(requester, 'request-route-resolved', route);
  });

  if (!resume)
    await check('申請者がキーボードで申請し、理由にUI016Bを含める', async () => {
      const requester = await actor('requester');
      await go(requester, `/catalog/${report.ids.catalogItem}`);
      const reason = requester.locator('#request-reason');
      await reason.fill('UI016B 通し確認の申請理由です。');
      const submitButton = requester.getByRole('button', { name: '申請する（模擬）', exact: true });
      await submitButton.focus();
      assert.equal(await requester.evaluate(() => document.activeElement?.tagName), 'BUTTON');
      await Promise.all([
        requester.waitForURL((url) => url.pathname.startsWith('/requests/')),
        requester.keyboard.press('Enter'),
      ]);
      await requester.waitForLoadState('networkidle');
      report.ids.request = new URL(requester.url()).pathname.split('/').at(-1);
      assert.ok(report.ids.request);
      report.applied.requestCreated = true;
      report.writes.requestsCreated += 1;
      assert.ok(report.writes.requestsCreated <= MAX_REQUESTS);
      const request = (await readApi('org_admin', `/service-requests/${report.ids.request}`))
        .request;
      assert.equal(request.state, 'pending');
      const snapshot = request.snapshot;
      assert.match(String(snapshot.inputs.reason), /UI016B/);
    });

  await check('無関係な利用者(まだ承認者でない固定承認者)は他人宛ての詳細URLで404', async () => {
    const fixed = await actor('approver');
    const response = await fixed.goto(new URL(`/requests/${report.ids.request}`, base).href);
    assert.equal(response?.status(), 404);
    await shot(fixed, 'request-unrelated-404-desktop-1440');
  });

  await check(
    'approver ロールを持たない上長が承認待ち一覧・受信箱で自分宛てを見て承認する',
    async () => {
      const manager = await actor('auditor');
      await go(manager, '/requests?view=approvals');
      const listText = await manager.locator('main').innerText();
      assert.match(listText, /UI016B/);
      assert.match(listText, /承認/);
      await desktop(
        manager,
        'requests-approvals-manager',
        manager.getByRole('heading', { level: 1 }),
      );

      await go(manager, '/inbox?kind=approval');
      const inboxText = await manager.locator('main').innerText();
      assert.match(inboxText, /UI016B/);
      assert.match(inboxText, /自分への承認/);
      await desktop(manager, 'inbox-approval-manager', manager.getByRole('heading', { level: 1 }));

      await go(manager, `/requests/${report.ids.request}`);
      const detailText = await manager.locator('main').innerText();
      assert.match(detailText, /段1（上長）/);
      assert.match(detailText, /承認待ち/);
      assert.match(detailText, /段2（固定承認者）/);
      assert.match(detailText, /前の段の承認後に依頼/);
      await desktop(
        manager,
        'request-detail-manager-pending',
        manager.getByRole('heading', { level: 1 }),
      );

      const approve = manager.getByRole('button', { name: '承認する', exact: true });
      await approve.focus();
      assert.equal(await manager.evaluate(() => document.activeElement?.tagName), 'BUTTON');
      await Promise.all([
        manager.waitForURL((url) => url.searchParams.get('saved') === '1'),
        manager.keyboard.press('Enter'),
      ]);
      await manager.waitForLoadState('networkidle');
      report.applied.managerApproved = true;
      const after = (await readApi('org_admin', `/service-requests/${report.ids.request}`)).request;
      assert.equal(after.state, 'pending');
    },
  );

  await check('固定承認者が自分宛てを見て承認する', async () => {
    const fixed = await actor('approver');
    await go(fixed, '/requests?view=approvals');
    assert.match(await fixed.locator('main').innerText(), /UI016B/);
    await go(fixed, '/inbox?kind=approval');
    assert.match(await fixed.locator('main').innerText(), /UI016B/);
    await go(fixed, `/requests/${report.ids.request}`);
    const detailText = await fixed.locator('main').innerText();
    assert.match(detailText, /段1（上長）/);
    assert.match(detailText, /段2（固定承認者）/);
    await desktop(fixed, 'request-detail-fixed-pending', fixed.getByRole('heading', { level: 1 }));
    await submit(
      fixed,
      fixed.getByRole('button', { name: '承認する', exact: true }),
      (url) => url.searchParams.get('saved') === '1',
    );
    report.applied.fixedApproved = true;
    const after = (await readApi('org_admin', `/service-requests/${report.ids.request}`)).request;
    assert.equal(after.state, 'approved');
  });

  await check('担当者が模擬完了まで進める', async () => {
    const agent = await actor('agent');
    await go(agent, `/requests/${report.ids.request}`);
    const approveCount = await agent.getByRole('button', { name: '承認する', exact: true }).count();
    assert.equal(approveCount, 0, 'the agent is not an approver of this request');
    await submit(
      agent,
      agent.getByRole('button', { name: 'ローカルで模擬実行する', exact: true }),
      (url) => url.searchParams.get('saved') === '1',
    );
    report.applied.simulated = true;
    const after = (await readApi('org_admin', `/service-requests/${report.ids.request}`)).request;
    assert.equal(after.state, 'completed');
  });

  await check('申請者が詳細で2段の承認の経過(承認者・日時)を確認する', async () => {
    const requester = await actor('requester');
    await go(requester, `/requests/${report.ids.request}`);
    const section = requester.locator('ol[aria-label="承認の経過"]');
    await section.waitFor();
    const text = await section.innerText();
    assert.match(text, /段1（上長）/);
    assert.match(text, /段2（固定承認者）/);
    assert.match(text, /サンプル株式会社 auditor/);
    assert.match(text, /サンプル株式会社 approver/);
    assert.match(text, /決定日時/);
    assert.equal(await section.getByText('前の段の承認後に依頼').count(), 0);
    await desktop(
      requester,
      'request-detail-requester-completed',
      requester.getByRole('heading', { level: 1 }),
    );
    const detailText = await requester.locator('main').innerText();
    assert.ok(!detailText.includes('社員番号'));
    assert.ok(!detailText.includes('役職'));
    assert.ok(!detailText.includes('勤務地'));
  });

  await check('上長を外した申請者には送信が無効で理由と設定依頼を表示する', async () => {
    const before = (await readApi('org_admin', `/service-requests?q=${encodeURIComponent(marker)}`))
      .total;
    await resetRequesterProfile(admin);
    const profile = (await readApi('org_admin', `/users/${report.ids.requesterUser}/profile`))
      .profile;
    assert.equal(profile.primaryDepartmentId, null);
    assert.equal(profile.managerUserId, null);

    const requester = await actor('requester');
    await go(requester, `/catalog/${report.ids.catalogItem}`);
    const alert = requester.locator('#request-route-blocked');
    await alert.waitFor();
    const text = await alert.innerText();
    assert.match(text, /上長/);
    assert.match(text, /組織の管理者へ設定を依頼/);
    const submitButton = requester.getByRole('button', { name: '申請する（模擬）', exact: true });
    assert.equal(await submitButton.isDisabled(), true);
    assert.equal(await submitButton.getAttribute('aria-describedby'), 'request-route-blocked');
    assert.equal(await requester.locator('#request-approver').count(), 0);
    assert.equal(await requester.locator('input[name="approverId"]').count(), 0);
    await desktop(requester, 'request-route-unresolved', alert);
    const after = (await readApi('org_admin', `/service-requests?q=${encodeURIComponent(marker)}`))
      .total;
    assert.equal(after, before, 'a blocked form must not create a request');
  });

  await check('他組織の利用者は他人宛ての詳細URLで404', async () => {
    const beta = await actor('beta-requester', 'requester@beta.example.test', 'ベータ商事株式会社');
    const response = await beta.goto(new URL(`/requests/${report.ids.request}`, base).href);
    assert.equal(response?.status(), 404);
    await shot(beta, 'request-other-org-404-desktop-1440');
  });
}

async function cleanupOnly(admin) {
  report.cleanup = { attempted: false, complete: false, steps: [], errors: [] };
  await cleanup(admin);
  assert.deepEqual(report.cleanup.errors, [], 'cleanup errors must be empty');
  const settings = await readApi('org_admin', '/approval-routing');
  assert.equal(settings.setting.enabled, false, 'Approval routing must be disabled');
  const rules = (await readApi('org_admin', '/approval-rules')).items;
  const rule = rules.find((entry) => entry.id === report.ids.rule);
  if (rule) assert.equal(rule.active, false, 'The synthetic rule must be inactive');
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
  assert.ok(report.writes.departmentsCreated <= MAX_DEPARTMENTS, 'The department cap must hold');
  assert.ok(
    report.writes.departmentHeadAssignments <= MAX_DEPARTMENT_HEADS,
    'The department-head cap must hold',
  );
  assert.ok(report.writes.profilePeople.length <= MAX_PROFILE_PEOPLE, 'The profile cap must hold');
  assert.ok(report.writes.requestsCreated <= MAX_REQUESTS, 'The request cap must hold');

  await check('再検証: 無効化したルールの版の履歴を読み取れる', async () => {
    activePage = admin;
    await go(admin, `/ops/approvals?rule=${report.ids.rule}#approval-rule-detail`);
    const detail = await admin.locator('#approval-rule-detail').innerText();
    assert.match(detail, /無効/);
    assert.match(detail, /版2/);
    assert.ok((await admin.locator('#approval-rule-detail table tbody tr').count()) >= 2);
    await desktop(
      admin,
      'approvals-rule-detail-readonly',
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
    await desktop(admin, 'approvals-unavailable-readonly', section);
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

  await check('再検証: 組織での使用の説明が利用者向けの文になっている', async () => {
    await go(admin, '/ops/approvals');
    const text = await admin.locator('#approval-routing').innerText();
    assert.match(text, /まだ有効にしていない組織では無効です/);
    assert.ok(!text.includes('行が無い組織'), 'internal wording must not be shown');
  });

  await visibilityChecks();
  await mobileChecks(admin);
  await check('再検証: 完了した申請の承認の経過を申請者が読める', async () => {
    const requester = await actor('requester');
    await go(requester, `/requests/${report.ids.request}`);
    const text = await requester.locator('ol[aria-label="承認の経過"]').innerText();
    assert.match(text, /段1（上長）/);
    assert.match(text, /段2（固定承認者）/);
    await desktop(
      requester,
      'request-detail-requester-completed-readonly',
      requester.getByRole('heading', { level: 1 }),
    );
  });
  assert.deepEqual(report.blocked, []);
  report.success = true;
  report.currentStep = 'verify-complete';
  delete report.failure;
  report.finishedAt = new Date().toISOString();
  await flush();
}

async function preflightB2() {
  const settings = await readApi('org_admin', '/approval-routing');
  assert.equal(settings.setting.enabled, false, 'Approval routing must start disabled');
  const rules = (await readApi('org_admin', '/approval-rules')).items;
  const syntheticRules = rules.filter(syntheticRule);
  assert.ok(
    syntheticRules.length <= MAX_RULES,
    `Unexpected synthetic approval rules: ${syntheticRules.length}`,
  );
  assert.ok(
    syntheticRules.every((entry) => entry.active === false),
    'Every earlier UI016B rule must be inactive',
  );
  const users = (await readApi('org_admin', '/users')).items;
  const requester = userByEmail(users, 'requester@acme.example.test');
  assert.equal(requester.userId, report.ids.requesterUser, 'The requester seed user must match');
  const profile = (await readApi('org_admin', `/users/${requester.userId}/profile`)).profile;
  assert.equal(hasValue(profile), false, 'The requester profile must start unset');
  const catalog = await readApi('org_admin', `/catalog-admin/${report.ids.catalogItem}`);
  assert.equal(catalog.active, false, 'The reused synthetic catalog item must be unpublished');
  assert.ok(
    !catalog.draft.definition.approval?.ruleId,
    'The reused catalog draft must not keep an approval-rule reference',
  );
  const request = await readApi('org_admin', `/service-requests/${report.ids.request}`);
  assert.equal(request.request.state, 'completed', 'The reused request must be completed');
  const departments = (await readApi('org_admin', '/departments')).items;
  assert.equal(
    departments.filter((entry) => String(entry.code).startsWith('UI016B-SYN-') && entry.active)
      .length,
    0,
    'No synthetic department may be active at the start',
  );
}

async function createB2Rule(admin) {
  await go(admin, '/ops/approvals');
  await admin.locator('#approval-create-code').fill(ruleCode);
  await admin.locator('#approval-create-name').fill(`${ruleName} B2`);
  await admin.locator('#approval-create-step-type-0').selectOption('manager');
  await admin.locator('#approval-create-step-unresolved-0').selectOption('reject');
  await admin.locator('#approval-create-step-type-1').selectOption('fixed');
  await admin
    .locator('#approval-create-step-approver-1')
    .selectOption(report.ids.fixedApproverUser);
  await submit(
    admin,
    admin.locator('#approval-create-submit'),
    (url) => url.searchParams.get('notice') === 'created',
  );
  report.ids.rule = new URL(admin.url()).searchParams.get('rule');
  assert.ok(report.ids.rule, 'The new synthetic rule id is required');
  report.applied.rule = true;
  report.writes.rulesCreated += 1;
  assert.equal(report.writes.rulesCreated, 1, 'Exactly one new rule is allowed in this re-run');
  await admin.locator('#approval-notice').waitFor();
  const after = (await readApi('org_admin', '/approval-rules')).items.find(
    (entry) => entry.id === report.ids.rule,
  );
  assert.ok(after?.active, 'The new rule must be active for the check');
  assert.ok(String(after.code).startsWith('ui016b-syn-'));
}

async function bindAndPublishCatalog(admin) {
  await go(admin, `/catalog/manage/${report.ids.catalogItem}`);
  const summary = admin.locator('summary').filter({ hasText: '下書きの項目と承認者を編集する' });
  assert.ok((await summary.count()) >= 1, 'The catalog draft editor must be present');
  const ruleSelect = admin.locator('#catalog-approval-rule');
  if (!(await ruleSelect.isVisible())) await summary.click();
  await ruleSelect.selectOption(report.ids.rule);
  await submit(
    admin,
    admin.getByRole('button', { name: '下書きを保存してプレビューする', exact: true }),
    (url) => url.searchParams.get('saved') === '1',
  );
  report.applied.catalogRuleBound = true;
  report.writes.catalogUpdates += 1;
  const bound = await readApi('org_admin', `/catalog-admin/${report.ids.catalogItem}`);
  assert.equal(bound.draft.definition.approval?.ruleId, report.ids.rule);

  await go(admin, `/catalog/manage/${report.ids.catalogItem}`);
  await submit(
    admin,
    admin.getByRole('button', { name: /保存済みの下書き版\d+を公開する/ }),
    (url) => url.searchParams.get('saved') === '1',
  );
  report.applied.catalogPublished = true;
  report.writes.catalogPublished += 1;
  const published = await readApi('org_admin', `/catalog-admin/${report.ids.catalogItem}`);
  assert.equal(published.active, true, 'The reused catalog item must be published');
  assert.ok(published.publishedRevision !== null);
}

async function setRequesterManager(admin, managerUserId) {
  await go(admin, `/ops/users?selected=${report.ids.requesterUser}`);
  await admin.locator('#profile-manager').selectOption(managerUserId);
  await submit(
    admin,
    admin.getByRole('button', { name: 'プロフィールを保存する', exact: true }),
    (url) => url.searchParams.get('notice') === 'profile',
  );
  report.writes.profileUpdates += 1;
  if (!report.writes.profilePeople.includes(report.ids.requesterUser))
    report.writes.profilePeople.push(report.ids.requesterUser);
  await admin.locator('#directory-notice').waitFor();
}

async function previewRule(admin) {
  await go(admin, `/ops/approvals?rule=${report.ids.rule}#approval-preview`);
  await admin.locator('input[name="previewKind"][value="rule"]').check();
  await admin.locator('#approval-preview-rule').selectOption(report.ids.rule);
  await admin.locator('#approval-preview-requester').selectOption(report.ids.requesterUser);
  await submit(
    admin,
    admin.locator('#approval-preview-submit'),
    (url) => url.searchParams.get('previewKind') === 'rule',
  );
  const result = admin.locator('section[aria-labelledby="approval-preview-result-title"]');
  await result.waitFor();
  return result;
}

async function enableRoutingB2(admin) {
  await go(admin, `/ops/approvals?rule=${report.ids.rule}#approval-routing`);
  await admin.locator('#approval-routing-toggle').click();
  await admin.waitForURL((url) => url.searchParams.get('confirm') === 'enable-routing');
  await submit(
    admin,
    admin.locator('#approval-routing-submit'),
    (url) => url.searchParams.get('notice') === 'routing-enabled',
  );
  report.applied.routingEnabledOnce = true;
  report.writes.routingEnabled += 1;
  assert.equal((await readApi('org_admin', '/approval-routing')).setting.enabled, true);
}

async function checkPendingApprovals() {
  const users = (await readApi('org_admin', '/users')).items;
  const manager = userByEmail(users, 'auditor@acme.example.test');
  assert.ok(!manager.roleCodes.includes('approver'), 'the checked user must not hold approver');
  const page = await actor('auditor');
  await go(page, '/requests?view=approvals');
  assert.equal(await page.locator('#request-view').inputValue(), 'approvals');
  assert.match(
    (await page.locator('#request-view option:checked').textContent()) ?? '',
    /自分が判断する承認待ち/,
  );
  const text = await page.locator('main').innerText();
  assert.match(text, /表示対象/);
  // No request may be created in this re-run and the walkthrough request is
  // completed, so the non-approver's own queue is expected to be empty.
  assert.match(text, /条件に合う申請はありません/);
  await desktop(page, 'requests-approvals-manager', page.getByRole('heading', { level: 1 }));
}

async function checkOtherOrg404() {
  const beta = await actor('beta-requester', 'requester@beta.example.test', 'ベータ商事株式会社');
  const response = await beta.goto(new URL(`/requests/${report.ids.request}`, base).href);
  assert.equal(response?.status(), 404);
  await shot(beta, 'request-other-org-404-desktop-1440');
}

async function stageB2(admin) {
  report.currentStep = 'start-b2';
  await flush();

  await check('B2: 組織での使用の説明が利用者向けの文になっている', async () => {
    activePage = admin;
    await go(admin, '/ops/approvals');
    const routing = admin.locator('#approval-routing');
    await routing.waitFor();
    const text = await routing.innerText();
    assert.match(text, /まだ有効にしていない組織では無効です/);
    assert.ok(!text.includes('行が無い組織'), 'internal wording must not be shown');
    await desktop(admin, 'approvals-routing-description', routing);
  });

  await check('B2: 合成の承認ルールを1件だけ作る', async () => {
    await createB2Rule(admin);
  });

  await check('B2: プレビューが解決できない理由を表示する', async () => {
    const result = await previewRule(admin);
    const text = await result.innerText();
    assert.match(text, /経路を解決できません/);
    assert.match(text, /上長/);
    await desktop(admin, 'approvals-preview-unresolved', result);
  });

  await check('B2: 既存の合成カタログ項目に結び付けて公開する', async () => {
    await bindAndPublishCatalog(admin);
  });

  await check('B2: 上長を設定すると申請画面が2段の経路を表示する', async () => {
    await setRequesterManager(admin, report.ids.managerUser);
    const profile = (await readApi('org_admin', `/users/${report.ids.requesterUser}/profile`))
      .profile;
    assert.equal(profile.managerUserId, report.ids.managerUser);
    const result = await previewRule(admin);
    const previewText = await result.innerText();
    assert.match(previewText, /段1/);
    assert.match(previewText, /段2/);
    await desktop(admin, 'approvals-preview-resolved', result);

    await enableRoutingB2(admin);

    const requester = await actor('requester');
    await go(requester, `/catalog/${report.ids.catalogItem}`);
    const route = requester.locator('section[aria-labelledby="request-approval-route-title"]');
    await route.waitFor();
    const text = await route.innerText();
    assert.match(text, /段1（上長）/);
    assert.match(text, /段2（固定承認者）/);
    assert.match(text, /サンプル株式会社 auditor/);
    assert.match(text, /サンプル株式会社 approver/);
    assert.equal(await requester.locator('#request-approver').count(), 0);
    assert.equal(await requester.locator('input[name="approverId"]').count(), 0);
    const submitButton = requester.getByRole('button', { name: '申請する（模擬）', exact: true });
    assert.equal(await submitButton.isDisabled(), false);
    await desktop(requester, 'request-route-resolved', route);
  });

  await check('B2: 上長を外すと理由と管理者への依頼が表示され、送信が無効になる', async () => {
    await setRequesterManager(admin, '');
    const profile = (await readApi('org_admin', `/users/${report.ids.requesterUser}/profile`))
      .profile;
    assert.equal(profile.primaryDepartmentId, null);
    assert.equal(profile.managerUserId, null);

    const before = (await readApi('org_admin', `/service-requests?q=${encodeURIComponent(marker)}`))
      .total;
    const requester = await actor('requester');
    await go(requester, `/catalog/${report.ids.catalogItem}`);
    const alert = requester.locator('#request-route-blocked');
    await alert.waitFor();
    const text = await alert.innerText();
    assert.match(text, /上長/);
    assert.match(text, /組織の管理者へ設定を依頼/);
    const submitButton = requester.getByRole('button', { name: '申請する（模擬）', exact: true });
    assert.equal(await submitButton.isDisabled(), true);
    assert.equal(await submitButton.getAttribute('aria-describedby'), 'request-route-blocked');
    assert.equal(await requester.locator('#request-approver').count(), 0);
    assert.equal(await requester.locator('input[name="approverId"]').count(), 0);
    await desktop(requester, 'request-route-unresolved', alert);
    const after = (await readApi('org_admin', `/service-requests?q=${encodeURIComponent(marker)}`))
      .total;
    assert.equal(after, before, 'a blocked form must not create a request');
  });

  await check('B2: 申請者が詳細で2段の承認の経過を読める', async () => {
    const requester = await actor('requester');
    await go(requester, `/requests/${report.ids.request}`);
    const section = requester.locator('ol[aria-label="承認の経過"]');
    await section.waitFor();
    const text = await section.innerText();
    assert.match(text, /段1（上長）/);
    assert.match(text, /段2（固定承認者）/);
    assert.match(text, /サンプル株式会社 auditor/);
    assert.match(text, /サンプル株式会社 approver/);
    assert.match(text, /決定日時/);
    await desktop(
      requester,
      'request-detail-requester-completed',
      requester.getByRole('heading', { level: 1 }),
    );
  });

  await check('B2: approver ロールを持たない利用者にも承認待ちの絞り込みが見える', async () => {
    await checkPendingApprovals();
  });

  await check('B2: 他組織(beta)の利用者は他人宛ての詳細URLで404', async () => {
    await checkOtherOrg404();
  });
}

async function verifyB2ReadOnly() {
  assert.ok(previous, 'The b2readonly phase needs the previous B2 summary');
  assert.equal(previous.stage, 'B2', 'The previous summary must belong to stage B2');
  const settings = await readApi('org_admin', '/approval-routing');
  assert.equal(settings.setting.enabled, false, 'Approval routing must be disabled');
  const rules = (await readApi('org_admin', '/approval-rules')).items;
  assert.ok(
    rules.filter(syntheticRule).every((entry) => entry.active === false),
    'Every synthetic rule must be inactive',
  );
  const profile = (await readApi('org_admin', `/users/${report.ids.requesterUser}/profile`))
    .profile;
  assert.equal(hasValue(profile), false, 'The requester profile must be unset');
  const catalog = await readApi('org_admin', `/catalog-admin/${report.ids.catalogItem}`);
  assert.equal(catalog.active, false, 'The reused catalog item must be unpublished');
  assert.ok(!catalog.draft.definition.approval?.ruleId, 'The draft must not keep a rule');
  const request = await readApi('org_admin', `/service-requests/${report.ids.request}`);
  assert.equal(request.request.state, 'completed', 'The reused request must stay completed');
  const writesBefore = JSON.stringify(report.writes);

  await check('B2(追加): 承認待ち一覧を両エンジンで撮り直す', async () => {
    await checkPendingApprovals();
  });
  await check('B2(追加): 他組織(beta)の詳細URLが404になる', async () => {
    await checkOtherOrg404();
  });

  assert.equal(JSON.stringify(report.writes), writesBefore, 'The extra phase must not write');
  assert.deepEqual(report.blocked, []);
  report.success = true;
  report.currentStep = 'complete-b2-readonly';
  delete report.failure;
  report.finishedAt = new Date().toISOString();
  await flush();
}

async function verifyB2Detail() {
  assert.ok(previous, 'The b2detail phase needs the previous B2 summary');
  assert.equal(previous.stage, 'B2', 'The previous summary must belong to stage B2');
  const writesBefore = JSON.stringify(report.writes);
  const requester = await actor('requester');
  await go(requester, `/requests/${report.ids.request}`);
  const history = requester.locator('ol[aria-label="承認の経過"]');
  await history.waitFor();
  const text = await history.innerText();
  assert.match(text, /段1（上長）/);
  assert.match(text, /段2（固定承認者）/);
  assert.match(text, /決定日時/);

  await check('B2(追加): 詳細の承認の経過を1440pxと375pxで撮り直す', async () => {
    await desktop(requester, 'request-detail-requester-completed', history);
  });

  assert.equal(JSON.stringify(report.writes), writesBefore, 'The screenshot retake must not write');
  assert.deepEqual(report.blocked, []);
  report.success = true;
  report.currentStep = 'complete-b2-detail';
  delete report.failure;
  report.finishedAt = new Date().toISOString();
  await flush();
}

async function wp018Reconcile(admin) {
  const ids = report.ids;
  const settings = await readApi('org_admin', '/approval-routing');
  assert.equal(settings.setting.enabled, false, 'Approval routing must be disabled');
  const rules = (await readApi('org_admin', '/approval-rules')).items.filter(wp018Rule);
  assert.ok(
    rules.every((entry) => entry.active === false),
    'Every UI018 synthetic rule must be inactive',
  );
  const departments = (await readApi('org_admin', '/departments')).items.filter(wp018Department);
  assert.ok(
    departments.every((entry) => entry.active === false),
    'Every UI018 synthetic department must be inactive',
  );
  const users = (await readApi('org_admin', '/users')).items;
  const managerA = userByEmail(users, 'auditor@acme.example.test');
  assert.ok(managerA.roleCodes.includes('auditor'), 'The manager A role must be restored');
  const requester = userByEmail(users, 'requester@acme.example.test');
  const profile = (await readApi('org_admin', `/users/${requester.userId}/profile`)).profile;
  assert.equal(hasValue(profile), false, 'The requester profile must be unset');
  if (ids.catalogItem) {
    const catalog = await readApi('org_admin', `/catalog-admin/${ids.catalogItem}`);
    assert.equal(catalog.active, false, 'The synthetic catalog item must be unpublished');
    assert.ok(
      !catalog.draft.definition.approval?.ruleId,
      'The synthetic catalog draft must not keep the rule',
    );
  }
  if (ids.request) {
    const detail = await readApi('org_admin', `/service-requests/${ids.request}`);
    assert.equal(detail.request.state, 'completed', 'The walkthrough request must be completed');
    assert.equal(detail.currentRouteGeneration, 2, 'The walkthrough request must keep generation 2');
    assert.equal(detail.routeGenerations.length, 2, 'Exactly one reassignment must remain');
  }
  await check('再実行(読み取り): 片付けの状態を確認する', async () => {
    activePage = admin;
    await go(admin, '/ops/approvals#approval-unavailable');
    await admin.locator('section[aria-labelledby="approval-unavailable-title"]').waitFor();
    await desktop(
      admin,
      'approvals-unavailable-reconciled',
      admin.locator('section[aria-labelledby="approval-unavailable-title"]'),
    );
  });
  if (ids.request) {
    await check('再実行(読み取り): 再割当の記録を確認する', async () => {
      const requesterPage = await actor('requester');
      await go(requesterPage, `/requests/${ids.request}`);
      const records = requesterPage.locator('ol[aria-label="再割当の記録"]');
      await records.waitFor();
      assert.match(await records.innerText(), /UI018/);
      await desktop(requesterPage, 'request-detail-reassigned-reconciled', records);
    });
  }
  assert.deepEqual(report.blocked, []);
  report.success = true;
  report.currentStep = 'complete-wp018-reconciled';
  delete report.failure;
  report.finishedAt = new Date().toISOString();
  await flush();
}

function wp018Rule(entry) {
  return String(entry.code).toLowerCase().startsWith('ui018-syn-');
}

function wp018Department(entry) {
  return String(entry.code).startsWith('UI018-SYN-');
}

async function preflightWP018() {
  const settings = await readApi('org_admin', '/approval-routing');
  assert.equal(settings.setting.enabled, false, 'Approval routing must start disabled');
  const rules = (await readApi('org_admin', '/approval-rules')).items.filter(wp018Rule);
  assert.ok(
    rules.length <= MAX_WP018_RULES - 1,
    `The UI018 rule cap is exhausted (${rules.length} already exist)`,
  );
  assert.ok(
    rules.every((entry) => entry.active === false),
    'Every earlier UI018 rule must be inactive before a new run',
  );
  const departments = (await readApi('org_admin', '/departments')).items.filter(wp018Department);
  assert.ok(
    departments.length <= MAX_WP018_DEPARTMENTS - 1,
    `The UI018 department cap is exhausted (${departments.length} already exist)`,
  );
  assert.ok(
    departments.every((entry) => entry.active === false),
    'Every earlier UI018 department must be inactive before a new run',
  );
  const catalog = (await readApi('org_admin', '/catalog-admin')).items.filter((item) =>
    String(item.title).includes('UI018'),
  );
  assert.ok(
    catalog.length <= MAX_WP018_CATALOG_ITEMS - 1,
    `The UI018 catalog cap is exhausted (${catalog.length} already exist)`,
  );
  assert.ok(
    catalog.every((item) => item.active === false),
    'Every earlier UI018 catalog item must be unpublished before a new run',
  );
  const requests = await readApi(
    'org_admin',
    `/service-requests?q=${encodeURIComponent('UI018')}`,
  );
  assert.ok(
    requests.total <= MAX_WP018_REQUESTS - 1,
    `The UI018 request cap is exhausted (${requests.total} already exist)`,
  );
  for (const entry of requests.items) {
    const detail = await readApi('org_admin', `/service-requests/${entry.id}`);
    assert.equal(
      detail.request.state,
      'completed',
      'Every earlier UI018 request must be completed before a new run',
    );
  }
  const users = (await readApi('org_admin', '/users')).items;
  const requester = userByEmail(users, 'requester@acme.example.test');
  const managerA = userByEmail(users, 'auditor@acme.example.test');
  const managerB = userByEmail(users, 'agent@acme.example.test');
  const fixed = userByEmail(users, 'approver@acme.example.test');
  const adminUser = userByEmail(users, 'org_admin@acme.example.test');
  assert.deepEqual(managerA.roleCodes, ['auditor'], 'Manager A must hold exactly the auditor role');
  assert.ok(!managerA.roleCodes.includes('approver'), 'Manager A must not hold approver');
  assert.ok(!managerB.roleCodes.includes('approver'), 'Manager B must not hold approver');
  assert.ok(fixed.roleCodes.includes('approver'), 'The fixed approver must hold approver');
  assert.ok(adminUser.roleCodes.includes('org_admin'), 'The admin must hold org_admin');
  const profile = (await readApi('org_admin', `/users/${requester.userId}/profile`)).profile;
  assert.equal(hasValue(profile), false, 'The requester profile must start unset');
  report.ids.requesterUser = requester.userId;
  report.ids.managerAUser = managerA.userId;
  report.ids.managerBUser = managerB.userId;
  report.ids.fixedApproverUser = fixed.userId;
  report.ids.agentUser = managerB.userId;
  report.ids.adminUser = adminUser.userId;
  report.roleChange.targetEmail = managerA.email;
  report.roleChange.roleCode = 'auditor';
}

async function wp018CreateDepartmentProfileAndRule(admin) {
  await go(admin, '/ops/departments');
  await admin.locator('#department-code').fill(wp018DepartmentCode);
  await admin.locator('#department-name').fill(`UI018 合成部署 ${engine}`);
  await submit(
    admin,
    admin.locator('#department-create-submit'),
    (url) => url.searchParams.get('notice') === 'created',
  );
  report.ids.department = new URL(admin.url()).searchParams.get('department');
  assert.ok(report.ids.department, 'The created department id is required');
  report.applied.department = true;
  report.writes.departmentsCreated += 1;
  await admin.locator('#department-notice').waitFor();

  await go(admin, `/ops/users?selected=${report.ids.requesterUser}`);
  await admin.locator('#profile-primary-department').selectOption(report.ids.department);
  await admin.locator('#profile-manager').selectOption(report.ids.managerAUser);
  await submit(
    admin,
    admin.getByRole('button', { name: 'プロフィールを保存する', exact: true }),
    (url) => url.searchParams.get('notice') === 'profile',
  );
  report.applied.profiles = true;
  report.writes.profileUpdates += 1;
  report.writes.profilePeople.push(report.ids.requesterUser);
  await admin.locator('#directory-notice').waitFor();
  const profile = await readApi('org_admin', `/users/${report.ids.requesterUser}/profile`);
  assert.equal(profile.profile.primaryDepartmentId, report.ids.department);
  assert.equal(profile.profile.managerUserId, report.ids.managerAUser);

  await go(admin, '/ops/approvals');
  await admin.locator('#approval-create-code').fill(wp018RuleCode);
  await admin.locator('#approval-create-name').fill(wp018RuleName);
  await admin.locator('#approval-create-step-type-0').selectOption('manager');
  await admin.locator('#approval-create-step-unresolved-0').selectOption('reject');
  await admin.locator('#approval-create-step-type-1').selectOption('fixed');
  await admin
    .locator('#approval-create-step-approver-1')
    .selectOption(report.ids.fixedApproverUser);
  await submit(
    admin,
    admin.locator('#approval-create-submit'),
    (url) => url.searchParams.get('notice') === 'created',
  );
  report.ids.rule = new URL(admin.url()).searchParams.get('rule');
  assert.ok(report.ids.rule, 'The created rule id is required');
  report.applied.rule = true;
  report.writes.rulesCreated += 1;
  assert.ok(report.writes.rulesCreated <= MAX_WP018_RULES);
  await admin.locator('#approval-notice').waitFor();
  const rule = (await readApi('org_admin', '/approval-rules')).items.find(
    (entry) => entry.id === report.ids.rule,
  );
  assert.ok(rule?.active);
  assert.ok(String(rule.code).startsWith('ui018-syn-'));
}

async function wp018CreateCatalogAndEnable(admin) {
  await go(admin, '/catalog/manage/new');
  await admin.locator('#catalog-title').fill(wp018ItemTitle);
  await admin
    .locator('#catalog-description')
    .fill('UI018 の再割当を確認するための合成項目です。');
  await admin.locator('#catalog-approver').selectOption(report.ids.fixedApproverUser);
  await submit(
    admin,
    admin.getByRole('button', { name: '下書きを保存してプレビューする', exact: true }),
    (url) => url.pathname.startsWith('/catalog/manage/') && url.searchParams.get('saved') === '1',
  );
  report.ids.catalogItem = new URL(admin.url()).pathname.split('/').at(-1);
  assert.ok(report.ids.catalogItem);
  report.applied.catalog = true;
  report.writes.catalogCreated += 1;
  assert.ok(report.writes.catalogCreated <= MAX_WP018_CATALOG_ITEMS);

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
  assert.equal(published.draft.definition.approval?.ruleId, report.ids.rule);

  await go(admin, `/ops/approvals?rule=${report.ids.rule}#approval-routing`);
  await admin.locator('#approval-routing-toggle').click();
  await admin.waitForURL((url) => url.searchParams.get('confirm') === 'enable-routing');
  await submit(
    admin,
    admin.locator('#approval-routing-submit'),
    (url) => url.searchParams.get('notice') === 'routing-enabled',
  );
  report.applied.routingEnabledOnce = true;
  report.writes.routingEnabled += 1;
  assert.equal((await readApi('org_admin', '/approval-routing')).setting.enabled, true);
}

async function wp018CreateRequest() {
  const requester = await actor('requester');
  await go(requester, `/catalog/${report.ids.catalogItem}`);
  const route = requester.locator('section[aria-labelledby="request-approval-route-title"]');
  await route.waitFor();
  const routeText = await route.innerText();
  assert.match(routeText, /段1（上長）/);
  assert.match(routeText, /段2（固定承認者）/);
  assert.match(routeText, /サンプル株式会社 auditor/);
  assert.match(routeText, /サンプル株式会社 approver/);
  await requester.locator('#request-reason').fill('UI018 通し確認の申請理由です。');
  await submit(
    requester,
    requester.getByRole('button', { name: '申請する（模擬）', exact: true }),
    (url) => url.pathname.startsWith('/requests/'),
  );
  report.ids.request = new URL(requester.url()).pathname.split('/').at(-1);
  assert.ok(report.ids.request);
  report.applied.requestCreated = true;
  report.writes.requestsCreated += 1;
  assert.ok(report.writes.requestsCreated <= MAX_WP018_REQUESTS);
  const detail = await readApi('org_admin', `/service-requests/${report.ids.request}`);
  assert.equal(detail.request.state, 'pending');
  assert.equal(detail.currentRouteGeneration, 1);
  assert.equal(detail.routeGenerations.length, 1);
  assert.equal(detail.route.steps.length, 2);
  assert.equal(detail.effectiveSteps.length, 1);
  assert.equal(detail.effectiveSteps[0].approverName, 'サンプル株式会社 auditor');
  const list = await readApi('org_admin', `/service-requests?q=${encodeURIComponent('UI018')}`);
  const row = list.items.find((entry) => entry.id === report.ids.request);
  assert.ok(row, 'The new request must be listed');
  report.ids.requestNumber = row.number;
}

async function wp018RevokeManagerARole(admin) {
  await go(admin, `/ops/users?selected=${report.ids.managerAUser}`);
  const details = admin.locator('details.user-action').filter({ hasText: '役割を変える' });
  await details.locator('summary').click();
  const form = admin.getByRole('form', {
    name: 'サンプル株式会社 auditorの役割を取り消す',
  });
  await form.getByLabel('取り消す役割', { exact: true }).selectOption('auditor');
  await form
    .getByLabel('取り消しの理由', { exact: true })
    .fill(`${wp018RoleReason}: 承認者不在の再現`);
  // Mark the intent before the click: if the server commits and the navigation
  // fails, the cleanup must still know that it has to put the role back.
  report.applied.managerARoleRevoked = true;
  report.roleChange.removedAt = new Date().toISOString();
  await submit(
    admin,
    form.getByRole('button', { name: '役割を取り消す', exact: true }),
    (url) => url.searchParams.get('notice') === 'revoked',
  );
  report.writes.roleRevokes += 1;
  report.roleChange.removalNotice = 'revoked';
  await admin.locator('#directory-notice').waitFor();
  const unavailable = await readApi('org_admin', '/service-requests?approverUnavailable=1');
  assert.ok(
    unavailable.items.some((entry) => entry.id === report.ids.request),
    'The request must be listed as unavailable after the role removal',
  );
  const visibleUsers = (await readApi('org_admin', '/users')).items;
  report.roleChange.hiddenFromDirectory = !visibleUsers.some(
    (entry) => entry.email === 'auditor@acme.example.test',
  );
}

async function wp018RestoreManagerARole(admin) {
  if (report.applied.managerARoleRestored) return;
  const currentUsers = (await readApi('org_admin', '/users')).items;
  const current = currentUsers.find((entry) => entry.email === 'auditor@acme.example.test');
  if (current?.roleCodes.includes('auditor')) {
    report.applied.managerARoleRestored = true;
    return;
  }
  if (!report.applied.managerARoleRevoked)
    throw new Error('This run did not remove the auditor role; refusing to grant it');
  await go(admin, `/ops/users?selected=${report.ids.managerAUser}`);
  const details = admin.locator('details.user-action').filter({ hasText: '役割を変える' });
  if ((await details.count()) === 0) {
    // Known gap: the directory lists only users with an active role binding, so a
    // user whose last role was removed has no screen entry and cannot be restored
    // from the screen. Use the same authenticated management endpoint the screen
    // calls, and record the deviation in the summary.
    const response = await admin.context().request.post(
      new URL(`/users/${report.ids.managerAUser}/roles`, apiBase).href,
      {
        data: {
          roleCode: 'auditor',
          reason: `${wp018RoleReason}: 管理画面に復元の導線が無いため管理APIで戻す`,
        },
      },
    );
    assert.equal(response.status(), 204, 'The management API must restore the role');
    report.roleChange.restoreVia = 'management-api';
  } else {
    await details.locator('summary').click();
    const form = admin.getByRole('form', { name: 'サンプル株式会社 auditorの役割を与える' });
    await form.getByLabel('与える役割', { exact: true }).selectOption('auditor');
    const until = form.getByLabel('期限（任意）', { exact: true });
    assert.equal(await until.inputValue(), '', 'The restored role must have no expiry');
    await form
      .getByLabel('付与の理由', { exact: true })
      .fill(`${wp018RoleReason}: 確認後に元へ戻す`);
    await submit(
      admin,
      form.getByRole('button', { name: '役割を与える', exact: true }),
      (url) => url.searchParams.get('notice') === 'granted',
    );
    report.roleChange.restoreVia = 'screen';
  }
  report.applied.managerARoleRestored = true;
  report.writes.roleGrants += 1;
  report.roleChange.restoredAt = new Date().toISOString();
  report.roleChange.restoreNotice = 'restored';
  await go(admin, `/ops/users?selected=${report.ids.managerAUser}`).catch(() => undefined);
  const users = (await readApi('org_admin', '/users')).items;
  const managerA = userByEmail(users, 'auditor@acme.example.test');
  assert.ok(managerA.roleCodes.includes('auditor'), 'Manager A must hold auditor again');
  assert.deepEqual(managerA.temporaryRoles ?? [], [], 'The restored role must have no expiry');
}

async function wp018UnavailableList(admin) {
  await go(admin, '/ops/approvals#approval-unavailable');
  const section = admin.locator('section[aria-labelledby="approval-unavailable-title"]');
  await section.waitFor();
  const text = await section.innerText();
  assert.match(text, /組織管理者は「再割当」で/);
  assert.match(text, /承認者を手で選べません/);
  assert.match(text, /固定承認者の段は再割当では変わりません/);
  const requestRow = section.locator('tbody tr', { hasText: report.ids.requestNumber });
  await requestRow.waitFor();
  assert.match(await requestRow.innerText(), /UI018/);
  // 再割当の欄は操作の列に無く、申請の行の直後の全列をまたぐ行にある。
  const row = requestRow.locator('xpath=following-sibling::tr[1]');
  const summary = row.locator('summary').filter({ hasText: '再割当' });
  await summary.focus();
  const focus = await focusVisible(admin);
  assert.ok(focus && (focus.outlineStyle !== 'none' || focus.boxShadow !== 'none'));
  await admin.keyboard.press('Enter');
  assert.notEqual(await row.locator('details').getAttribute('open'), null);
  const reason = row.getByLabel('再割当の理由', { exact: true });
  await reason.focus();
  const fieldFocus = await focusVisible(admin);
  assert.ok(fieldFocus && (fieldFocus.outlineStyle !== 'none' || fieldFocus.boxShadow !== 'none'));
  report.keyboard = { reassignSummary: focus, reassignReason: fieldFocus, openedWith: 'Enter' };
  await desktop(admin, 'approvals-unavailable-reassign-open', section);
}

async function wp018FindReassignRow(admin) {
  await go(admin, '/ops/approvals#approval-unavailable');
  const section = admin.locator('section[aria-labelledby="approval-unavailable-title"]');
  await section.waitFor();
  const requestRow = section.locator('tbody tr', { hasText: report.ids.requestNumber });
  await requestRow.waitFor();
  const row = requestRow.locator('xpath=following-sibling::tr[1]');
  const summary = row.locator('summary').filter({ hasText: '再割当' });
  if ((await row.locator('details').getAttribute('open')) === null) await summary.click();
  return row;
}

async function wp018AttemptSameManager(admin, row) {
  const before = await readApi('org_admin', `/service-requests/${report.ids.request}`);
  const reason = row.getByLabel('再割当の理由', { exact: true });
  const confirm = row.getByLabel(
    '今の組織の設定（上長・部署長）から承認者を決め直すことを確認しました',
    { exact: true },
  );
  const submitButton = row.getByRole('button', { name: '再割当を実行する', exact: true });
  await reason.fill(wp018Reason);
  await confirm.check();
  await submitButton.click();
  const failure = row.locator('[role="alert"]').filter({ hasText: '保存・送信できませんでした' });
  await failure.waitFor();
  const text = await failure.innerText();
  assert.ok(!text.includes('API'), 'Internal wording must not be shown');
  assert.match(text, /再割当できません/);
  report.reassignAttempts.push({ name: 'same-manager', text, at: new Date().toISOString() });
  await desktop(admin, 'reassign-failure', failure);
  const after = await readApi('org_admin', `/service-requests/${report.ids.request}`);
  assert.equal(after.request.version, before.request.version, 'A refused reassignment must not bump the version');
  assert.equal(after.currentRouteGeneration, before.currentRouteGeneration);
  assert.equal(after.routeGenerations.length, before.routeGenerations.length);
  assert.equal(after.history.length, before.history.length);
  return text;
}

async function wp018ValidationChecks(admin, row) {
  const reason = row.getByLabel('再割当の理由', { exact: true });
  const confirm = row.getByLabel(
    '今の組織の設定（上長・部署長）から承認者を決め直すことを確認しました',
    { exact: true },
  );
  const submitButton = row.getByRole('button', { name: '再割当を実行する', exact: true });
  await reason.fill('');
  if (await confirm.isChecked()) await confirm.uncheck();
  await submitButton.click();
  const missingReason = row.locator('[role="alert"]').filter({ hasText: '保存・送信できませんでした' });
  await missingReason.waitFor();
  const missingReasonText = await missingReason.innerText();
  assert.match(missingReasonText, /入力が必要な項目・形式を確認してください/);
  assert.match(missingReasonText, /この項目を入力してください/);
  report.reassignAttempts.push({
    name: 'missing-reason',
    text: missingReasonText,
    at: new Date().toISOString(),
  });

  await reason.fill(wp018Reason);
  await submitButton.click();
  const missingConfirm = row.locator('[role="alert"]').filter({
    hasText: '内容を確認してチェックしてください',
  });
  await missingConfirm.waitFor({ timeout: 5000 }).catch(async () => {
    await row.waitFor();
  });
  const missingConfirmText = await missingConfirm.innerText().catch(() => '');
  assert.match(missingConfirmText, /内容を確認してチェックしてください/);
  report.reassignAttempts.push({
    name: 'missing-confirm',
    text: missingConfirmText,
    at: new Date().toISOString(),
  });
}

async function wp018ReassignSuccess(admin, row) {
  const reason = row.getByLabel('再割当の理由', { exact: true });
  const confirm = row.getByLabel(
    '今の組織の設定（上長・部署長）から承認者を決め直すことを確認しました',
    { exact: true },
  );
  const submitButton = row.getByRole('button', { name: '再割当を実行する', exact: true });
  await reason.fill(wp018Reason);
  await confirm.check();
  await submitButton.focus();
  await Promise.all([
    admin.waitForURL((url) => url.searchParams.get('reassigned') === report.ids.request),
    admin.keyboard.press('Enter'),
  ]);
  await admin.waitForLoadState('networkidle');
  const status = admin
    .locator('section[aria-labelledby="approval-unavailable-title"] [role="status"]')
    .filter({ hasText: '再割当されました' });
  await status.waitFor();
  const text = await status.innerText();
  assert.match(text, /段1の承認者は/);
  assert.match(text, /サンプル株式会社 agent/);
  assert.match(text, /\(\d{4}年\d{1,2}月\d{1,2}日/);
  report.applied.reassigned = true;
  report.writes.reassignments += 1;
  assert.ok(report.writes.reassignments <= MAX_WP018_REASSIGNMENTS);
  report.reassignSuccess = text;
  await desktop(admin, 'reassign-success', status);

  const detail = await readApi('org_admin', `/service-requests/${report.ids.request}`);
  assert.equal(detail.currentRouteGeneration, 2);
  assert.equal(detail.routeGenerations.length, 2);
  const generation = detail.routeGenerations.find((entry) => entry.routeGeneration === 2);
  assert.ok(generation, 'The generation row must be returned');
  assert.equal(generation.fromStepNo, 1);
  assert.equal(generation.reason, wp018Reason);
  assert.equal(generation.createdByName, 'サンプル株式会社 org_admin');
  assert.equal(generation.newApproverName, 'サンプル株式会社 agent');
  assert.equal(generation.invalidatedApproverName, 'サンプル株式会社 auditor');
  const invalidated = detail.history.find((entry) => entry.invalidatedByReassign === true);
  assert.ok(invalidated, 'The old step must be marked as invalidated by reassignment');
  assert.equal(invalidated.state, 'invalidated');
  assert.equal(detail.effectiveSteps.length, 1);
  assert.equal(detail.effectiveSteps[0].approverName, 'サンプル株式会社 agent');
  assert.equal(detail.effectiveSteps[0].state, 'pending');
  assert.equal(detail.route.steps[0].approverName, 'サンプル株式会社 agent');
  assert.equal(detail.route.steps[1].approverName, 'サンプル株式会社 approver');
}

async function wp018DetailChecks() {
  const admin = await actor('org_admin');
  await go(admin, `/requests/${report.ids.request}`);
  const timeline = admin.locator('ol[aria-label="承認の経過"]');
  await timeline.waitFor();
  const timelineText = await timeline.innerText();
  assert.match(timelineText, /段1（上長）/);
  assert.match(timelineText, /承認待ち/);
  assert.match(timelineText, /サンプル株式会社 agent/);
  assert.match(timelineText, /段2（固定承認者）/);
  assert.match(timelineText, /前の段の承認後に依頼/);
  assert.ok(!timelineText.includes('サンプル株式会社 auditor'), 'The replaced step must not be current');
  const records = admin.locator('ol[aria-label="再割当の記録"]');
  await records.waitFor();
  const recordText = await records.innerText();
  assert.match(recordText, /段1の承認者を再割当/);
  assert.match(recordText, /実行者: サンプル株式会社 org_admin/);
  assert.match(recordText, /理由: UI018/);
  assert.match(recordText, /無効になったステップ: 段1（サンプル株式会社 auditor）/);
  assert.match(recordText, /新しい承認者: サンプル株式会社 agent/);
  assert.equal(await records.locator('li').count(), 1);
  assert.match(await admin.locator('main').innerText(), /再割当により無効/);

  const requester = await actor('requester');
  await go(requester, `/requests/${report.ids.request}`);
  const requesterTimeline = requester.locator('ol[aria-label="承認の経過"]');
  await requesterTimeline.waitFor();
  assert.match(await requesterTimeline.innerText(), /サンプル株式会社 agent/);
  assert.ok(!(await requesterTimeline.innerText()).includes('サンプル株式会社 auditor'));
  const requesterRecords = requester.locator('ol[aria-label="再割当の記録"]');
  await requesterRecords.waitFor();
  assert.match(await requesterRecords.innerText(), /理由: UI018/);
  assert.match(await requesterRecords.innerText(), /新しい承認者: サンプル株式会社 agent/);
  assert.match(await requester.locator('main').innerText(), /再割当により無効/);
  await desktop(requester, 'request-detail-reassigned', requesterRecords);
}

async function wp018ManagerACannotDecide() {
  const managerA = await actor('auditor');
  await go(managerA, '/requests?view=approvals');
  const listText = await managerA.locator('main').innerText();
  assert.ok(
    !listText.includes(report.ids.requestNumber),
    'The replaced manager must not see the request in the approval queue',
  );
  await go(managerA, `/requests/${report.ids.request}`);
  const detailText = await managerA.locator('main').innerText();
  assert.equal(
    await managerA.getByRole('button', { name: '承認する', exact: true }).count(),
    0,
  );
  assert.match(detailText, /承認の経過/);
  await go(managerA, '/inbox?kind=approval');
  assert.ok(
    !(await managerA.locator('main').innerText()).includes(report.ids.requestNumber),
    'The replaced manager must not see the request in the inbox',
  );
  await desktop(managerA, 'request-detail-replaced-manager', managerA.getByRole('heading', { level: 1 }));
}

async function wp018FinalApprovals(admin) {
  const managerB = await actor('agent');
  await go(managerB, '/requests?view=approvals');
  const queueText = await managerB.locator('main').innerText();
  assert.ok(queueText.includes(report.ids.requestNumber), 'Manager B must see the reassigned request');
  await go(managerB, `/requests/${report.ids.request}`);
  await submit(
    managerB,
    managerB.getByRole('button', { name: '承認する', exact: true }),
    (url) => url.searchParams.get('saved') === '1',
  );
  report.applied.managerBApproved = true;
  let detail = await readApi('org_admin', `/service-requests/${report.ids.request}`);
  assert.equal(detail.request.state, 'pending');
  assert.equal(detail.approval.step_no, 2);
  assert.equal(detail.approval.approver_id, report.ids.fixedApproverUser);
  assert.equal(detail.currentRouteGeneration, 2);

  const fixed = await actor('approver');
  await go(fixed, `/requests/${report.ids.request}`);
  await submit(
    fixed,
    fixed.getByRole('button', { name: '承認する', exact: true }),
    (url) => url.searchParams.get('saved') === '1',
  );
  report.applied.fixedApproved = true;
  detail = await readApi('org_admin', `/service-requests/${report.ids.request}`);
  assert.equal(detail.request.state, 'approved');

  await go(managerB, `/requests/${report.ids.request}`);
  await submit(
    managerB,
    managerB.getByRole('button', { name: 'ローカルで模擬実行する', exact: true }),
    (url) => url.searchParams.get('saved') === '1',
  );
  report.applied.simulated = true;
  detail = await readApi('org_admin', `/service-requests/${report.ids.request}`);
  assert.equal(detail.request.state, 'completed');
  assert.ok(detail.receipt, 'The simulation receipt must be created');

  await go(admin, `/requests/${report.ids.request}`);
  const timeline = admin.locator('ol[aria-label="承認の経過"]');
  await timeline.waitFor();
  const timelineText = await timeline.innerText();
  assert.match(timelineText, /段1（上長）/);
  assert.match(timelineText, /承認/);
  assert.match(timelineText, /サンプル株式会社 agent/);
  assert.match(timelineText, /段2（固定承認者）/);
  assert.match(timelineText, /サンプル株式会社 approver/);
  assert.match(timelineText, /決定日時/);
  assert.ok(!timelineText.includes('前の段の承認後に依頼'));
}

async function wp018Cleanup(admin) {
  report.currentStep = 'wp018-cleanup';
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

  // 1. Restore manager A first. Never leave the synthetic role removed.
  await step('上長Aの役割を元に戻す', async () => {
    await wp018RestoreManagerARole(admin);
  });

  // 2. Organisation-wide rule usage must never be left enabled.
  await step('組織での承認ルールを無効へ戻す', async () => {
    await disableRouting(admin);
  });

  // 3. Reset the profile values changed for the walkthrough.
  await step('変更したプロフィール(主部署・上長)を未設定へ戻す', async () => {
    await resetRequesterProfile(admin);
  });

  // 4. Deactivate the synthetic department.
  if (ids.department) {
    await step('合成部署を無効化する', async () => {
      await go(admin, `/ops/departments?department=${ids.department}#deactivate-department`);
      const trigger = admin.getByRole('link', { name: 'この部署を無効化する', exact: true });
      if ((await trigger.count()) === 0) return;
      await Promise.all([
        admin.waitForURL((url) => url.searchParams.get('confirm') === 'deactivate'),
        trigger.click(),
      ]);
      await submit(
        admin,
        admin.getByRole('button', { name: '無効化する', exact: true }),
        (url) => url.searchParams.get('notice') === 'deactivated',
      );
      report.writes.departmentDeactivations += 1;
      await admin.locator('#department-notice').waitFor();
    });
  }

  // 5. Unbind and unpublish the synthetic catalog item.
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
    });
  }

  // 6. Deactivate the synthetic rule.
  if (ids.rule) {
    await step('合成承認ルールを無効化する', async () => {
      const rules = (await readApi('org_admin', '/approval-rules')).items;
      const rule = rules.find((entry) => entry.id === ids.rule);
      if (!rule?.active) return;
      await go(admin, `/ops/approvals?rule=${ids.rule}#approval-rule-detail`);
      await admin.locator('#approval-deactivate-link').click();
      await admin.waitForURL((url) => url.searchParams.get('confirm') === 'deactivate');
      await submit(
        admin,
        admin.locator('#approval-deactivate-submit'),
        (url) => url.searchParams.get('notice') === 'deactivated',
      );
      report.writes.ruleDeactivations += 1;
      await admin.locator('#approval-notice').waitFor();
    });
  }

  // 7. Final invariants.
  const settings = await readApi('org_admin', '/approval-routing');
  if (settings.setting.enabled !== false) {
    report.cleanup.errors.push({ name: '最終確認', message: '組織での承認ルールが有効なままです' });
  }
  const remainingRules = (await readApi('org_admin', '/approval-rules')).items.filter(
    (entry) => wp018Rule(entry) && entry.active,
  );
  if (remainingRules.length > 0) {
    report.cleanup.errors.push({
      name: '最終確認',
      message: `有効な UI018 合成承認ルールが ${remainingRules.length} 件残っています`,
    });
  }
  const departments = (await readApi('org_admin', '/departments')).items;
  const activeDepartments = departments.filter(
    (entry) => wp018Department(entry) && entry.active,
  );
  if (activeDepartments.length > 0) {
    report.cleanup.errors.push({
      name: '最終確認',
      message: `有効な UI018 合成部署が ${activeDepartments.length} 件残っています`,
    });
  }
  const users = (await readApi('org_admin', '/users')).items;
  const filled = [];
  for (const user of users) {
    const profile = (await readApi('org_admin', `/users/${user.userId}/profile`)).profile;
    if (hasValue(profile)) filled.push(user.email);
  }
  if (filled.length > 0) {
    report.cleanup.errors.push({
      name: '最終確認',
      message: `値の入ったプロフィールが ${filled.length} 件残っています`,
    });
  }
  if (report.writes.profilePeople.length > MAX_WP018_PROFILE_PEOPLE) {
    report.cleanup.errors.push({
      name: '最終確認',
      message: `プロフィールを変更した人数が上限を超えています(${report.writes.profilePeople.length})`,
    });
  }
  const managerA = userByEmail(users, report.roleChange.targetEmail);
  if (!managerA.roleCodes.includes('auditor')) {
    report.cleanup.errors.push({
      name: '最終確認',
      message: '上長A(auditor)の役割が元に戻っていません',
    });
  }
  if (report.ids.request) {
    const detail = await readApi('org_admin', `/service-requests/${report.ids.request}`);
    report.requestStateAfterCleanup = detail.request.state;
    if (detail.request.state !== 'completed') {
      report.unfinishedRequests = [
        { id: report.ids.request, number: report.ids.requestNumber, state: detail.request.state },
      ];
    }
  }
  const roleRestored = !report.applied.managerARoleRevoked || report.applied.managerARoleRestored;
  report.cleanup.attempted = true;
  report.cleanup.complete = report.cleanup.errors.length === 0 && roleRestored;
  report.currentStep = 'wp018-cleanup-complete';
  await flush();
}

async function wp018RunReassignFlow(admin, prefix) {
  await check(`${prefix}: 上長Aの役割を管理画面から一時的に外し、承認者不在にする`, async () => {
    await wp018RevokeManagerARole(admin);
  });

  await check(`${prefix}: 承認者不在の一覧に申請が出て、案内と再割当の欄を表示する`, async () => {
    await wp018UnavailableList(admin);
  });

  await check(`${prefix}: 上長Aのまま再割当すると拒否され、何も変わらない`, async () => {
    await wp018AttemptSameManager(admin, await wp018FindReassignRow(admin));
  });

  await check(`${prefix}: 申請者の上長を上長Bへ変える`, async () => {
    await setRequesterManager(admin, report.ids.managerBUser);
    const profile = (await readApi('org_admin', `/users/${report.ids.requesterUser}/profile`))
      .profile;
    assert.equal(profile.managerUserId, report.ids.managerBUser);
  });

  await check(`${prefix}: 理由なし・確認なしの送信は入力の検査で止まる`, async () => {
    await wp018ValidationChecks(admin, await wp018FindReassignRow(admin));
  });

  await check(`${prefix}: 理由と確認を入れて再割当でき、段と新しい承認者が表示される`, async () => {
    await wp018ReassignSuccess(admin, await wp018FindReassignRow(admin));
  });

  await wp018FinishFlow(admin, prefix);
}

async function wp018FinishFlow(admin, prefix) {
  await check(`${prefix}: 申請の詳細に再割当の記録が出て、申請者本人にも同じ記録が見える`, async () => {
    await wp018DetailChecks();
  });

  await check(`${prefix}: 上長Aの役割を元に戻す`, async () => {
    await wp018RestoreManagerARole(admin);
  });

  await check(`${prefix}: 上長Aは決定できない(承認待ち一覧・詳細・受信箱)`, async () => {
    await wp018ManagerACannotDecide();
  });

  await check(`${prefix}: 上長Bと固定承認者が承認し、担当者が模擬完了まで進める`, async () => {
    await wp018FinalApprovals(admin);
  });

  await check(`${prefix}: 片付け(役割・ルール・部署・プロフィール・カタログ)`, async () => {
    await wp018Cleanup(admin);
  });

  assert.deepEqual(report.blocked, []);
  report.success = report.cleanup.complete === true;
  report.currentStep = report.success ? 'complete-wp018' : 'wp018-incomplete';
  if (report.success) {
    delete report.failure;
    report.finishedAt = new Date().toISOString();
  }
  await flush();
}

async function stageWP018(admin) {
  report.currentStep = 'wp018-start';
  await flush();

  await check('WP018: 事前確認(合成データの上限・ロール・プロフィール)', async () => {
    activePage = admin;
    await preflightWP018();
  });

  await check('WP018: 合成部署を作り、申請者の主部署と上長Aを設定する', async () => {
    await wp018CreateDepartmentProfileAndRule(admin);
  });

  await check('WP018: 合成カタログ項目を作成し、ルールを結び付けて公開し、組織で有効にする', async () => {
    await wp018CreateCatalogAndEnable(admin);
  });

  await check('WP018: 申請者が2段の経路で申請する', async () => {
    await wp018CreateRequest();
  });

  await wp018RunReassignFlow(admin, 'WP018');
}

async function wp018Resume(admin) {
  report.currentStep = 'wp018-resume';
  await flush();
  if (!report.ids.requestNumber) {
    const list = await readApi('org_admin', `/service-requests?q=${encodeURIComponent('UI018')}`);
    const row = list.items.find((entry) => entry.id === report.ids.request);
    report.ids.requestNumber = row?.number ?? null;
  }
  assert.ok(report.ids.requestNumber, 'The resumed request number is required');
  let detail = await readApi('org_admin', `/service-requests/${report.ids.request}`);
  if (detail.request.state === 'completed') {
    assert.equal(detail.currentRouteGeneration, 2);
    assert.ok(detail.receipt, 'The completed request must have a receipt');
    report.applied.managerARoleRevoked = true;
    report.applied.managerARoleRestored = true;
    report.applied.reassigned = true;
    report.applied.managerBApproved = true;
    report.applied.fixedApproved = true;
    report.applied.simulated = true;
    await check('再開: 完了した申請の承認の経過を確認する', async () => {
      activePage = admin;
      await go(admin, `/requests/${report.ids.request}`);
      const timeline = admin.locator('ol[aria-label="承認の経過"]');
      await timeline.waitFor();
      const text = await timeline.innerText();
      assert.match(text, /段1（上長）/);
      assert.match(text, /段2（固定承認者）/);
      assert.match(text, /承認/);
      assert.match(text, /決定日時/);
      assert.ok(!text.includes('前の段の承認後に依頼'));
      await desktop(admin, 'request-detail-approved', timeline);
    });
    await check('再開: 片付け(役割・ルール・部署・プロフィール・カタログ)', async () => {
      await wp018Cleanup(admin);
    });
    assert.deepEqual(report.blocked, []);
    report.success = report.cleanup.complete === true;
    report.currentStep = report.success ? 'complete-wp018' : 'wp018-incomplete';
    if (report.success) {
      delete report.failure;
      report.finishedAt = new Date().toISOString();
    }
    await flush();
    return;
  }
  detail = await readApi('org_admin', `/service-requests/${report.ids.request}`);
  assert.equal(detail.request.state, 'pending', 'The resumed request must still be pending');
  const managerA = userByEmail(
    (await readApi('org_admin', '/users')).items,
    'auditor@acme.example.test',
  );
  assert.ok(managerA.roleCodes.includes('auditor'), 'Manager A must start with the auditor role');
  const item = await readApi('org_admin', `/catalog-admin/${report.ids.catalogItem}`);
  assert.equal(item.active, false, 'The leftover synthetic catalog item must stay unpublished');

  if (detail.currentRouteGeneration >= 2) {
    // The previous attempt already executed the reassignment and only failed to
    // show the success message. Continue from the detail checks, and verify the
    // success message on the URL that the action now returns.
    assert.equal(detail.currentRouteGeneration, 2);
    assert.ok(detail.effectiveSteps[0], 'The reassigned request must have a current step');
    assert.equal(detail.effectiveSteps[0].approverId, report.ids.managerBUser);
    assert.equal(detail.effectiveSteps[0].state, 'pending');
    report.applied.managerARoleRevoked = true;
    report.applied.managerARoleRestored = true;
    report.applied.reassigned = true;
    report.applied.managerBApproved = false;
    report.applied.fixedApproved = false;
    report.applied.simulated = false;
    await check('再開: 再割当の成功が段と新しい承認者で表示される', async () => {
      await go(admin, `/ops/approvals?reassigned=${report.ids.request}#approval-unavailable`);
      const status = admin
        .locator('section[aria-labelledby="approval-unavailable-title"] [role="status"]')
        .filter({ hasText: '再割当されました' });
      await status.waitFor();
      const text = await status.innerText();
      assert.match(text, /段1の承認者は/);
      assert.match(text, /サンプル株式会社 agent/);
      assert.match(text, /\(\d{4}年\d{1,2}月\d{1,2}日/);
      report.reassignSuccess = text;
      await desktop(admin, 'reassign-success', status);
    });
    await wp018FinishFlow(admin, '再開');
    return;
  }

  assert.equal(detail.currentRouteGeneration, 1, 'The resumed request must not be reassigned yet');
  assert.ok(detail.effectiveSteps[0], 'The resumed request must have a current step');
  assert.equal(detail.effectiveSteps[0].approverId, report.ids.managerAUser);
  assert.equal(detail.effectiveSteps[0].state, 'pending');
  const requesterProfile = (
    await readApi('org_admin', `/users/${report.ids.requesterUser}/profile`)
  ).profile;
  assert.equal(hasValue(requesterProfile), false, 'The requester profile must be unset');

  await check('再開: 申請者の上長を上長Aへ戻す', async () => {
    await setRequesterManager(admin, report.ids.managerAUser);
    const profile = (await readApi('org_admin', `/users/${report.ids.requesterUser}/profile`))
      .profile;
    assert.equal(profile.managerUserId, report.ids.managerAUser);
  });

  await wp018RunReassignFlow(admin, '再開');
}


async function reconcile(admin) {
  const ids = report.ids ?? {};
  const rules = (await readApi('org_admin', '/approval-rules')).items;
  const rule = rules.find((entry) => entry.id === ids.rule);
  assert.ok(rule, 'The previous synthetic rule must still be readable');
  assert.equal(rule.active, false, 'The previous synthetic rule must be inactive');
  const settings = await readApi('org_admin', '/approval-routing');
  assert.equal(settings.setting.enabled, false, 'Approval routing must be disabled');
  if (ids.department) {
    const departments = (await readApi('org_admin', '/departments')).items;
    const department = departments.find((entry) => entry.id === ids.department);
    assert.ok(
      department && department.active === false,
      'The synthetic department must be inactive',
    );
    const head = await readApi('org_admin', `/departments/${ids.department}/head`);
    assert.equal(head.head, null, 'The synthetic department head must be finished');
  }
  if (ids.requesterUser) {
    const profile = (await readApi('org_admin', `/users/${ids.requesterUser}/profile`)).profile;
    assert.equal(hasValue(profile), false, 'The requester profile must be unset');
  }
  if (ids.catalogItem) {
    const detail = await readApi('org_admin', `/catalog-admin/${ids.catalogItem}`);
    assert.equal(detail.active, false, 'The previous synthetic catalog item must be unpublished');
    assert.ok(
      !detail.draft.definition.approval?.ruleId,
      'The previous synthetic catalog item must not keep the rule reference',
    );
  }
  if (ids.request) {
    const request = await readApi('org_admin', `/service-requests/${ids.request}`);
    assert.equal(request.request.state, 'completed', 'The walkthrough request must be completed');
  }
  const departments = (await readApi('org_admin', '/departments')).items;
  assert.equal(
    departments.filter((entry) => String(entry.code).startsWith('UI016B-SYN-') && entry.active)
      .length,
    0,
    'No synthetic department may remain active',
  );
  const users = (await readApi('org_admin', '/users')).items;
  for (const user of users) {
    const profile = (await readApi('org_admin', `/users/${user.userId}/profile`)).profile;
    assert.equal(hasValue(profile), false, `The profile of ${user.email} must be unset`);
  }

  await check('再実行: 合成ルールは無効、組織の設定は無効のまま', async () => {
    activePage = admin;
    await go(admin, `/ops/approvals?rule=${ids.rule}#approval-rule-detail`);
    assert.equal(await admin.getByRole('heading', { name: '承認ルール', exact: true }).count(), 1);
    assert.match(await admin.locator('#approval-rule-detail').innerText(), /無効/);
    assert.match(await admin.locator('#approval-routing').innerText(), /現在の状態:\s*無効/);
    await desktop(
      admin,
      'approvals-rule-detail-readonly',
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
    await desktop(
      admin,
      'approvals-unavailable-readonly',
      admin.locator('section[aria-labelledby="approval-unavailable-title"]'),
    );
  });

  await check('再実行: 完了した申請の承認の経過と404を読み取りで確認する', async () => {
    if (!ids.request) return;
    const requester = await actor('requester');
    await go(requester, `/requests/${ids.request}`);
    const text = await requester.locator('ol[aria-label="承認の経過"]').innerText();
    assert.match(text, /段1（上長）/);
    assert.match(text, /段2（固定承認者）/);
    const beta = await actor('beta-requester', 'requester@beta.example.test', 'ベータ商事株式会社');
    const response = await beta.goto(new URL(`/requests/${ids.request}`, base).href);
    assert.equal(response?.status(), 404);
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
  if (phase === 'wp018resume') {
    assert.ok(previous, 'The wp018resume phase needs the previous summary');
    assert.ok(previous.ids?.request, 'The previous summary must contain the pending request');
    report.ids = { ...report.ids, ...(previous.ids ?? {}) };
    report.roleChange = { ...report.roleChange, ...(previous.roleChange ?? {}) };
    report.applied = { ...report.applied, ...(previous.applied ?? {}) };
    report.writes = { ...report.writes, ...(previous.writes ?? {}) };
    report.checks = previous.checks ?? [];
    report.accessibility = previous.accessibility ?? [];
    report.screenshots = previous.screenshots ?? [];
    report.reassignAttempts = previous.reassignAttempts ?? [];
    report.reassignSuccess = previous.reassignSuccess ?? null;
    report.applied.managerARoleRevoked = false;
    report.applied.managerARoleRestored = false;
    report.applied.reassigned = false;
    await wp018Resume(admin);
    return;
  }
  if (phase === 'wp018') {
    if (previous) {
      report.ids = { ...report.ids, ...(previous.ids ?? {}) };
      report.roleChange = { ...report.roleChange, ...(previous.roleChange ?? {}) };
      report.applied = { ...report.applied, ...(previous.applied ?? {}) };
      report.writes = { ...report.writes, ...(previous.writes ?? {}) };
      if (previous.success === true) {
        await wp018Reconcile(admin);
        return;
      }
      await wp018Cleanup(admin);
      report.success = report.cleanup.complete === true;
      report.currentStep = report.success ? 'complete-wp018-cleanup' : 'wp018-cleanup-incomplete';
      if (report.success) {
        delete report.failure;
        report.finishedAt = new Date().toISOString();
      }
      await flush();
      return;
    }
    await stageWP018(admin);
    return;
  }
  if (phase === 'wp018cleanup') {
    assert.ok(previous, 'The wp018cleanup phase needs the previous summary');
    report.ids = { ...report.ids, ...(previous.ids ?? {}) };
    report.roleChange = { ...report.roleChange, ...(previous.roleChange ?? {}) };
    report.applied = { ...report.applied, ...(previous.applied ?? {}) };
    await wp018Cleanup(admin);
    report.success = report.cleanup.complete === true;
    report.currentStep = report.success ? 'complete-wp018-cleanup' : 'wp018-cleanup-incomplete';
    if (report.success) {
      delete report.failure;
      report.finishedAt = new Date().toISOString();
    }
    await flush();
    return;
  }
  if (phase === 'b2') {
    await preflightB2();
    await stageB2(admin);
    assert.deepEqual(report.blocked, []);
    await cleanup(admin);
    report.success = report.cleanup.complete;
    report.currentStep = 'complete-b2';
    delete report.failure;
    report.finishedAt = new Date().toISOString();
    await flush();
    return;
  }
  if (phase === 'b2readonly') {
    await verifyB2ReadOnly();
    return;
  }
  if (phase === 'b2detail') {
    await verifyB2Detail();
    return;
  }
  if (phase === 'cleanup') {
    await cleanupOnly(admin);
    return;
  }
  if (phase === 'verify') {
    assert.ok(previous, 'The verify phase needs the previous summary');
    await verifyOnly(admin);
    return;
  }
  if (phase === 'resume') {
    assert.ok(previous, 'The resume phase needs the previous summary');
    assert.ok(report.ids.request, 'The resume phase needs the created request');
    const request = await readApi('org_admin', `/service-requests/${report.ids.request}`);
    assert.equal(request.request.state, 'pending', 'Only a pending request can be resumed');
    report.cleanup = { attempted: false, complete: false, steps: [], errors: [] };
    await stageBWalkthrough(admin, true);
    assert.deepEqual(report.blocked, []);
    await cleanup(admin);
    report.success = report.cleanup.complete;
    report.currentStep = 'complete-resume';
    delete report.failure;
    report.finishedAt = new Date().toISOString();
    await flush();
    return;
  }
  if (previous) {
    await reconcile(admin);
    return;
  }
  await preflight();
  await adminFirstRun(admin);
  await stageBWalkthrough(admin);
  assert.deepEqual(report.blocked, []);
  await cleanup(admin);
  report.success = true;
  report.currentStep = 'complete';
  delete report.failure;
  report.finishedAt = new Date().toISOString();
  await flush();
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
  if (wp018Phase && pages.has('org_admin')) {
    try {
      await wp018Cleanup(pages.get('org_admin'));
    } catch (cleanupError) {
      report.cleanup.errors.push({
        name: '失敗後の片付け',
        message: String(cleanupError?.message ?? cleanupError),
      });
    }
  } else if ((!previous || phase === 'b2') && pages.has('org_admin')) {
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
