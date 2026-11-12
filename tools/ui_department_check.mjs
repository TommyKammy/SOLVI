/* global document, innerWidth, HTMLElement, getComputedStyle */
// WP-P4-IDM-013 stage B: loopback-only department and profile walkthrough.
import assert from 'node:assert/strict';
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
const output = resolve(process.env.SOLVI_UI_OUT ?? `evidence/WP-P4-IDM-013/browser/${engine}`);

let previous;
try {
  previous = JSON.parse(await readFile(resolve(output, 'summary.json'), 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (previous) {
  assert.equal(previous.browser, engine, 'The previous summary belongs to another browser');
  assert.match(previous.marker, /^UI013-SYN-\d+-(chromium|webkit)$/);
}
const previousHasData = Boolean(
  previous &&
  (Object.values(previous.writes ?? {}).some((count) => count > 0) ||
    Object.values(previous.ids ?? {}).some(Boolean)),
);
if (!previousHasData) previous = undefined;
const marker = previous?.marker ?? `UI013-SYN-${Date.now()}-${engine}`;
const report = previous
  ? {
      ...previous,
      success: false,
      currentStep: 'reconciliation',
      blocked: [],
      reconciliation: previous.reconciliation ?? null,
    }
  : {
      workPackage: 'WP-P4-IDM-013',
      stage: 'B',
      browser: engine,
      marker,
      success: false,
      createdAt: new Date().toISOString(),
      base: base.origin,
      apiBase: apiBase.origin,
      checks: [],
      accessibility: [],
      screenshots: [],
      writes: {
        departments: 0,
        headsAssigned: 0,
        profileUpdates: 0,
        deactivations: 0,
        rejectedDeactivations: 0,
      },
      profilePeople: [],
      ids: {},
      applied: { root: false, child: false, head: false, headAssigned: false, profile: false },
      cleanup: { attempted: false, complete: false, steps: [], errors: [] },
      keyboard: null,
      blocked: [],
      reconciliation: null,
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
  if (ids.headDepartment && report.applied.headAssigned) {
    await step('部署長の終了', async () => {
      await go(admin, `/ops/departments?department=${ids.headDepartment}`);
      await admin.locator('#department-head-end').fill('');
      await submit(
        admin,
        admin.getByRole('button', { name: '部署長を終了する', exact: true }),
        (url) => url.searchParams.get('notice') === 'head-ended',
      );
      await admin.locator('#department-notice').waitFor();
    });
  }
  if (ids.agentUser && report.applied.profile) {
    await step('プロフィールを未設定へ戻す', async () => {
      await go(admin, `/ops/users?selected=${ids.agentUser}`);
      await admin.locator('#profile-primary-department').selectOption('');
      await admin.locator('#profile-manager').selectOption('');
      await admin.locator('#profile-job-title').fill('');
      await admin.locator('#profile-location').fill('');
      await admin.locator('#profile-employee-id').fill('');
      await submit(
        admin,
        admin.getByRole('button', { name: 'プロフィールを保存する', exact: true }),
        (url) => ['profile', 'profile-unchanged'].includes(url.searchParams.get('notice') ?? ''),
      );
      await admin.locator('#directory-notice').waitFor();
    });
  }
  if (ids.childDepartment && ids.rootDepartment && report.applied.child) {
    await step('子部署を最上位へ移す', async () => {
      await go(admin, `/ops/departments?department=${ids.childDepartment}`);
      await admin.locator('#department-edit-parent').selectOption('');
      await submit(
        admin,
        admin.getByRole('button', { name: '変更を保存する', exact: true }),
        (url) => url.searchParams.get('notice') === 'updated',
      );
    });
  }
  for (const [label, key] of [
    ['子部署の無効化', 'childDepartment'],
    ['ルート部署の無効化', 'rootDepartment'],
    ['部署長用部署の無効化', 'headDepartment'],
  ]) {
    const id = ids[key];
    if (!id) continue;
    const appliedKey =
      key === 'childDepartment' ? 'child' : key === 'rootDepartment' ? 'root' : 'head';
    if (!report.applied[appliedKey]) continue;
    await step(label, async () => {
      await go(admin, `/ops/departments?department=${id}`);
      await admin.getByRole('link', { name: 'この部署を無効化する', exact: true }).click();
      await admin.waitForURL((url) => url.searchParams.get('confirm') === 'deactivate');
      await submit(
        admin,
        admin.getByRole('button', { name: '無効化する', exact: true }),
        (url) =>
          url.searchParams.get('notice') === 'deactivated' ||
          Boolean(url.searchParams.get('error')),
      );
      await admin.locator('#department-notice, #department-error').first().waitFor();
      const error = await admin.locator('#department-error').count();
      if (error > 0) throw new Error(await admin.locator('#department-error').innerText());
      report.writes.deactivations += 1;
    });
  }
  report.cleanup.complete = report.cleanup.errors.length === 0;
  report.currentStep = 'cleanup-complete';
  await flush();
}

async function readOnlyChecks(admin) {
  await check('読み取り: 利用者一覧の列・絞り込み・充足状況', async () => {
    activePage = admin;
    await go(admin, '/ops/users');
    for (const header of ['部署', '上長', '役職']) {
      assert.equal(await admin.getByRole('columnheader', { name: header, exact: true }).count(), 1);
    }
    for (const id of ['directory-department', 'directory-manager', 'directory-job-title']) {
      assert.equal(await admin.locator(`#${id}`).count(), 1);
    }
    assert.equal(await admin.getByText('プロフィールの充足状況', { exact: true }).count(), 1);
    await accessible(admin, 'users-list-desktop-1440-readonly');
    await shot(admin, 'users-list-desktop-1440-readonly', admin.getByRole('heading', { level: 1 }));
  });

  await check('読み取り: 部署ツリーと無効化済み部署の詳細', async () => {
    await go(admin, '/ops/departments');
    assert.equal(
      await admin.getByRole('heading', { name: '部署のツリー', exact: true }).count(),
      1,
    );
    assert.ok((await admin.locator('.group-code').count()) >= 1);
    await accessible(admin, 'departments-tree-desktop-1440-readonly');
    await shot(
      admin,
      'departments-tree-desktop-1440-readonly',
      admin.getByRole('heading', { level: 1 }),
    );
    await go(admin, `/ops/departments?department=${report.ids.headDepartment}`);
    await admin.locator('#department-details').waitFor();
    assert.match(await admin.locator('#department-details').innerText(), /無効化されています/);
    await accessible(admin, 'departments-detail-desktop-1440-readonly');
    await shot(
      admin,
      'departments-detail-desktop-1440-readonly',
      admin.locator('#department-details-title'),
    );
  });

  await check('読み取り: 無効化の拒否理由を画面に表示する', async () => {
    const reason =
      '有効な部署長が残っているため無効化できません。先に部署長の終了日を設定してください。';
    await go(
      admin,
      `/ops/departments?department=${report.ids.headDepartment}&error=${encodeURIComponent(reason)}`,
    );
    await admin.locator('#department-error').waitFor();
    assert.match(
      await admin.locator('#department-error').innerText(),
      /有効な部署長が残っているため無効化できません/,
    );
    await accessible(admin, 'departments-error-desktop-1440-readonly');
    await shot(
      admin,
      'departments-error-desktop-1440-readonly',
      admin.locator('#department-error'),
    );
  });

  await check('読み取り: 本人かつ組織管理者の欄が無効で理由が出る', async () => {
    await go(admin, `/ops/users?selected=${report.ids.adminUser}`);
    await admin.locator('#profile-primary-department').waitFor();
    assert.equal(await admin.locator('#profile-primary-department').isDisabled(), true);
    assert.equal(await admin.locator('#profile-manager').isDisabled(), true);
    assert.match(
      await admin.locator('#profile-manager-reason').innerText(),
      /組織管理者の上長は設定できません/,
    );
    assert.match(
      await admin.locator('#profile-primary-department-reason').innerText(),
      /自分自身の主部署は自分では変更できません/,
    );
    await accessible(admin, 'users-self-disabled-desktop-1440-readonly');
    await shot(
      admin,
      'users-self-disabled-desktop-1440-readonly',
      admin.locator('#directory-profile-title'),
    );
  });

  await check('読み取り: 社員番号を一覧・URLに出さない', async () => {
    await go(admin, '/ops/users');
    const table = await admin.locator('table.directory-table').innerText();
    assert.ok(!table.includes('社員番号'));
    assert.ok(!admin.url().includes('employeeId'));
    assert.ok(!admin.url().includes('UI013-SYN-EMP'));
  });

  await check('読み取り: 1440px と 375px で横溢れがない', async () => {
    await go(admin, '/ops/users');
    await mobile(admin, 'users-list-readonly', admin.getByRole('heading', { level: 1 }));
    await go(admin, `/ops/departments?department=${report.ids.headDepartment}`);
    await mobile(admin, 'departments-detail-readonly', admin.getByRole('heading', { level: 1 }));
  });

  await check('読み取り: org_admin 以外には画面も導線も出ない', async () => {
    const agent = await actor('agent');
    await go(agent, '/portal');
    assert.equal(await agent.getByRole('link', { name: '部署管理', exact: true }).count(), 0);
    await go(agent, '/ops/departments');
    assert.match(await agent.locator('main').innerText(), /この画面を表示する権限がありません/);
    await go(agent, '/ops/users');
    assert.match(await agent.locator('main').innerText(), /この画面を表示する権限がありません/);
  });
}

async function reconcile() {
  const departments = (await readApi('org_admin', '/departments')).items;
  const ownIds = [
    report.ids.rootDepartment,
    report.ids.childDepartment,
    report.ids.headDepartment,
  ].filter(Boolean);
  assert.ok(ownIds.length > 0, 'The previous run must have created synthetic data');
  const syntheticDepartments = departments.filter((department) => ownIds.includes(department.id));
  assert.equal(
    syntheticDepartments.length,
    ownIds.length,
    'Every synthetic department recorded by the previous run must still be readable',
  );
  assert.ok(
    syntheticDepartments.every((department) => department.active === false),
    'Synthetic departments must be inactive after cleanup',
  );
  for (const department of syntheticDepartments) {
    const head = (await readApi('org_admin', `/departments/${department.id}/head`)).head;
    assert.equal(head, null, `Synthetic department ${department.code} must have no head`);
  }
  const users = (await readApi('org_admin', '/users')).items;
  const agent = users.find((user) => user.email === 'agent@acme.example.test');
  assert.ok(agent, 'The synthetic agent must remain');
  assert.equal(agent.primaryDepartmentId, null);
  assert.equal(agent.managerUserId, null);
  assert.equal(agent.jobTitle, null);
  const profile = (await readApi('org_admin', `/users/${agent.userId}/profile`)).profile;
  assert.equal(profile.location, null);
  assert.equal(profile.employeeId, null);
  assert.ok(
    users.every((user) => !String(user.jobTitle ?? '').includes('UI013')),
    'No synthetic profile value may remain in the directory',
  );
  report.reconciliation = {
    readOnly: true,
    syntheticDepartments: syntheticDepartments.map((department) => ({
      code: department.code,
      active: department.active,
    })),
    profileRestored: true,
    headsEnded: true,
  };
  if (report.checks.length < 14) {
    await readOnlyChecks(pages.get('org_admin'));
  }
  report.cleanup = { ...report.cleanup, complete: true };
  report.checks = report.checks.filter(
    (entry) => entry.name !== '前回の合成データを読み取りで照合した',
  );
  report.checks.push({ name: '前回の合成データを読み取りで照合した', passed: true });
  report.success = true;
  report.currentStep = 'complete';
  delete report.failure;
  await flush();
  console.log(
    `Department UI ${engine}: PASS (read-only reconciliation, ${syntheticDepartments.length} departments)`,
  );
}

async function preflight() {
  const departments = (await readApi('org_admin', '/departments')).items;
  const engineDepartments = departments.filter(
    (department) =>
      department.code.startsWith('UI013-SYN-') && department.code.includes(`-${engine}-`),
  );
  assert.ok(
    engineDepartments.length + 3 <= 6,
    `Synthetic department cap for ${engine}: ${engineDepartments.length} already exist`,
  );
}

async function firstRun(admin) {
  report.currentStep = 'start';
  await flush();

  await check('利用者一覧に部署・上長・役職の列と絞り込みがある', async () => {
    activePage = admin;
    await go(admin, '/ops/users');
    for (const header of ['部署', '上長', '役職']) {
      assert.equal(
        await admin.getByRole('columnheader', { name: header, exact: true }).count(),
        1,
        `Directory column ${header}`,
      );
    }
    for (const id of ['directory-department', 'directory-manager', 'directory-job-title']) {
      assert.equal(await admin.locator(`#${id}`).count(), 1, `Directory filter ${id}`);
    }
    assert.equal(await admin.getByText('プロフィールの充足状況', { exact: true }).count(), 1);
    await accessible(admin, 'users-list-desktop-1440');
    await shot(admin, 'users-list-desktop-1440', admin.getByRole('heading', { level: 1 }));
  });

  await check('管理メニューの導線から部署管理をキーボードで開ける', async () => {
    const link = admin.getByRole('link', { name: '部署管理', exact: true });
    assert.equal(await link.count(), 1, 'The users screen must link to /ops/departments');
    await link.focus();
    await Promise.all([
      admin.waitForURL((url) => url.pathname === '/ops/departments'),
      admin.keyboard.press('Enter'),
    ]);
    await admin.waitForLoadState('networkidle');
    assert.equal(await admin.getByRole('heading', { name: '部署管理', exact: true }).count(), 1);
  });

  await check('キーボードだけでルート部署を作成できる', async () => {
    const tabsBefore = await tabTo(admin, 'department-code');
    const focus = await focusVisible(admin);
    assert.ok(focus && (focus.outlineStyle !== 'none' || focus.boxShadow !== 'none'));
    await admin.keyboard.type(`${marker}-ROOT`);
    await tabTo(admin, 'department-name');
    assert.equal(await admin.evaluate(() => document.activeElement?.id), 'department-name');
    await admin.keyboard.type('UI013 合成ルート部署');
    await tabTo(admin, 'department-parent');
    assert.equal(await admin.evaluate(() => document.activeElement?.id), 'department-parent');
    const submitTabs = await tabTo(admin, 'department-create-submit');
    assert.equal(await admin.evaluate(() => document.activeElement?.tagName), 'BUTTON');
    await Promise.all([
      admin.waitForURL((url) => url.searchParams.get('notice') === 'created'),
      admin.keyboard.press('Enter'),
    ]);
    await admin.waitForLoadState('networkidle');
    await admin.locator('#department-notice').waitFor();
    report.ids.rootDepartment = new URL(admin.url()).searchParams.get('department');
    assert.ok(report.ids.rootDepartment);
    report.applied.root = true;
    report.writes.departments += 1;
    report.keyboard = { tabsBefore, submitTabs, focus, submittedWith: 'Enter' };
    assert.ok(report.writes.departments <= 6);
  });

  await check('子部署を作成し、ツリーに親子が表示される', async () => {
    await go(admin, '/ops/departments');
    await admin.locator('#department-code').fill(`${marker}-CHILD`);
    await admin.locator('#department-name').fill('UI013 合成子部署');
    await admin.locator('#department-parent').selectOption(report.ids.rootDepartment);
    await submit(
      admin,
      admin.getByRole('button', { name: '部署を追加する', exact: true }),
      (url) => url.searchParams.get('notice') === 'created',
    );
    report.ids.childDepartment = new URL(admin.url()).searchParams.get('department');
    assert.ok(report.ids.childDepartment);
    report.applied.child = true;
    report.writes.departments += 1;
    assert.ok(report.writes.departments <= 6);
    await go(admin, '/ops/departments');
    await admin.getByText('子部署 1 件', { exact: true }).waitFor();
    await accessible(admin, 'departments-tree-desktop-1440');
    await shot(admin, 'departments-tree-desktop-1440', admin.getByRole('heading', { level: 1 }));
  });

  await check('部署長用の部署を作成し、管理画面のツリーを撮影する', async () => {
    await go(admin, '/ops/departments');
    await admin.locator('#department-code').fill(`${marker}-HEAD`);
    await admin.locator('#department-name').fill('UI013 合成部署長用部署');
    await submit(
      admin,
      admin.getByRole('button', { name: '部署を追加する', exact: true }),
      (url) => url.searchParams.get('notice') === 'created',
    );
    report.ids.headDepartment = new URL(admin.url()).searchParams.get('department');
    assert.ok(report.ids.headDepartment);
    report.applied.head = true;
    report.writes.departments += 1;
    assert.ok(report.writes.departments <= 6);
  });

  await check('管理者が主部署と上長を設定できる', async () => {
    const users = (await readApi('org_admin', '/users')).items;
    report.ids.agentUser = users.find((user) => user.email === 'agent@acme.example.test')?.userId;
    report.ids.managerUser = users.find(
      (user) => user.email === 'requester@acme.example.test',
    )?.userId;
    report.ids.adminUser = users.find(
      (user) => user.email === 'org_admin@acme.example.test',
    )?.userId;
    assert.ok(report.ids.agentUser && report.ids.managerUser && report.ids.adminUser);
    await go(admin, `/ops/users?selected=${report.ids.agentUser}`);
    await admin.locator('#profile-primary-department').selectOption(report.ids.childDepartment);
    await admin.locator('#profile-manager').selectOption(report.ids.managerUser);
    await admin.locator('#profile-job-title').fill('UI013 合成役職');
    await admin.locator('#profile-location').fill('UI013 合成勤務地');
    await admin.locator('#profile-employee-id').fill(`${marker}-EMP`);
    await accessible(admin, 'users-profile-desktop-1440');
    await shot(admin, 'users-profile-desktop-1440', admin.locator('#directory-profile-title'));
    await submit(
      admin,
      admin.getByRole('button', { name: 'プロフィールを保存する', exact: true }),
      (url) => url.searchParams.get('notice') === 'profile',
    );
    report.applied.profile = true;
    report.writes.profileUpdates += 1;
    report.profilePeople = [...new Set([...report.profilePeople, report.ids.agentUser])];
    assert.ok(report.profilePeople.length <= 3);
    await admin.locator('#directory-notice').waitFor();
  });

  await check('部署長を設定し、現在の部署長として表示される', async () => {
    await go(admin, `/ops/departments?department=${report.ids.headDepartment}`);
    await admin.locator('#department-head-user').selectOption(report.ids.agentUser);
    await submit(
      admin,
      admin.getByRole('button', { name: '部署長に設定する', exact: true }),
      (url) => url.searchParams.get('notice') === 'head-assigned',
    );
    report.applied.headAssigned = true;
    report.writes.headsAssigned += 1;
    assert.ok(report.writes.headsAssigned <= 2);
    await admin
      .locator('#department-head')
      .getByText(/現在の部署長:/)
      .waitFor();
    await accessible(admin, 'departments-detail-desktop-1440');
    await shot(admin, 'departments-detail-desktop-1440', admin.locator('#department-head'));
  });

  await check('子部署が残る部署の無効化が理由付きで拒否される', async () => {
    await go(admin, `/ops/departments?department=${report.ids.rootDepartment}`);
    await admin.getByRole('link', { name: 'この部署を無効化する', exact: true }).click();
    await admin.waitForURL((url) => url.searchParams.get('confirm') === 'deactivate');
    await admin.locator('#department-confirm-title').waitFor();
    await accessible(admin, 'departments-confirm-desktop-1440');
    await shot(
      admin,
      'departments-confirm-desktop-1440',
      admin.locator('#department-confirm-title'),
    );
    await submit(admin, admin.getByRole('button', { name: '無効化する', exact: true }), (url) =>
      Boolean(url.searchParams.get('error')),
    );
    report.writes.rejectedDeactivations += 1;
    await admin.locator('#department-error').waitFor();
    const text = await admin.locator('#department-error').innerText();
    assert.match(text, /子部署が残っているため無効化できません/);
    await accessible(admin, 'departments-error-desktop-1440');
    await shot(admin, 'departments-error-desktop-1440', admin.locator('#department-error'));
  });

  await check('メンバーが残る部署の無効化が理由付きで拒否される', async () => {
    await go(admin, `/ops/departments?department=${report.ids.childDepartment}`);
    await admin.getByRole('link', { name: 'この部署を無効化する', exact: true }).click();
    await admin.waitForURL((url) => url.searchParams.get('confirm') === 'deactivate');
    await admin.locator('#department-confirm-title').waitFor();
    await submit(admin, admin.getByRole('button', { name: '無効化する', exact: true }), (url) =>
      Boolean(url.searchParams.get('error')),
    );
    report.writes.rejectedDeactivations += 1;
    await admin.locator('#department-error').waitFor();
    const text = await admin.locator('#department-error').innerText();
    assert.match(text, /有効な所属メンバーが残っているため無効化できません/);
  });

  await check('部署長が残る部署の無効化が理由付きで拒否される', async () => {
    await go(admin, `/ops/departments?department=${report.ids.headDepartment}`);
    await admin.getByRole('link', { name: 'この部署を無効化する', exact: true }).click();
    await admin.waitForURL((url) => url.searchParams.get('confirm') === 'deactivate');
    await admin.locator('#department-confirm-title').waitFor();
    await submit(admin, admin.getByRole('button', { name: '無効化する', exact: true }), (url) =>
      Boolean(url.searchParams.get('error')),
    );
    report.writes.rejectedDeactivations += 1;
    await admin.locator('#department-error').waitFor();
    const text = await admin.locator('#department-error').innerText();
    assert.match(text, /有効な部署長が残っているため無効化できません/);
  });

  await check('本人かつ組織管理者の行では主部署と上長が無効で理由が出る', async () => {
    await go(admin, `/ops/users?selected=${report.ids.adminUser}`);
    assert.equal(await admin.locator('#profile-primary-department').isDisabled(), true);
    assert.equal(await admin.locator('#profile-manager').isDisabled(), true);
    const reasons = await admin.locator('#profile-manager-reason').innerText();
    assert.match(reasons, /組織管理者の上長は設定できません/);
    assert.match(
      await admin.locator('#profile-primary-department-reason').innerText(),
      /自分自身の主部署は自分では変更できません/,
    );
    await accessible(admin, 'users-self-disabled-desktop-1440');
    await shot(
      admin,
      'users-self-disabled-desktop-1440',
      admin.locator('#directory-profile-title'),
    );
  });

  await check('社員番号を一覧・URLに出さない', async () => {
    await go(admin, '/ops/users');
    const table = await admin.locator('table.directory-table').innerText();
    assert.ok(!table.includes(`${marker}-EMP`));
    assert.ok(!table.includes('社員番号'));
    assert.ok(!admin.url().includes('employeeId'));
    assert.ok(!admin.url().includes(`${marker}-EMP`));
  });

  await check('利用者一覧をモバイル幅でも操作でき、横溢れがない', async () => {
    await go(admin, '/ops/users');
    await mobile(admin, 'users-list', admin.getByRole('heading', { level: 1 }));
    await go(admin, `/ops/departments?department=${report.ids.headDepartment}`);
    await mobile(admin, 'departments-detail', admin.getByRole('heading', { level: 1 }));
  });

  await check('org_admin 以外には部署管理の画面も導線も出ない', async () => {
    const agent = await actor('agent');
    await go(agent, '/portal');
    assert.equal(await agent.getByRole('link', { name: '部署管理', exact: true }).count(), 0);
    await go(agent, '/ops/departments');
    assert.match(await agent.locator('main').innerText(), /この画面を表示する権限がありません/);
    assert.equal(await agent.getByText('部署のツリー', { exact: true }).count(), 0);
    await go(agent, '/ops/users');
    assert.match(await agent.locator('main').innerText(), /この画面を表示する権限がありません/);
  });

  await cleanup(admin);
  assert.ok(report.cleanup.complete, `Cleanup: ${JSON.stringify(report.cleanup.errors)}`);
  const departments = (await readApi('org_admin', '/departments')).items;
  const ownDepartments = departments.filter((department) =>
    [report.ids.rootDepartment, report.ids.childDepartment, report.ids.headDepartment].includes(
      department.id,
    ),
  );
  assert.equal(ownDepartments.length, report.writes.departments);
  assert.ok(ownDepartments.every((department) => !department.active));
  const agent = (await readApi('org_admin', '/users')).items.find(
    (user) => user.userId === report.ids.agentUser,
  );
  assert.equal(agent.primaryDepartmentId, null);
  assert.equal(agent.managerUserId, null);
  assert.equal(agent.jobTitle, null);
  assert.deepEqual(report.blocked, []);
  report.success = true;
  report.currentStep = 'complete';
  await flush();
}

async function main() {
  await mkdir(output, { recursive: true });
  browser = await (engine === 'webkit' ? webkit : chromium).launch(
    engine === 'chromium' ? { channel: 'chrome', headless: true } : { headless: true },
  );
  report.browserVersion = browser.version();
  const admin = await actor('org_admin');
  if (previous) {
    await reconcile();
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
    `Department UI ${engine}: ${report.success ? 'PASS' : 'FAIL'}; ${report.checks.length} checks; ${report.accessibility.length} axe scans; ${JSON.stringify(report.writes)}`,
  );
  if (report.failure) console.log(report.failure);
  if (!report.success) process.exitCode = 1;
}
