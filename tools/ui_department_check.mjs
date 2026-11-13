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
// 段階Bの再実行(B2)は、エンジンごとに追加3件までの部署と、部署長1件・
// プロフィール1人を認める。累計の合成部署は9件を超えない。
const MAX_SYNTHETIC_DEPARTMENTS = 9;
const ADDITIONAL_DEPARTMENTS = 3;
const ADDITIONAL_HEADS = 1;
const ADDITIONAL_PROFILES = 1;
// 途中で失敗したときの再開。`hold` は片付けを保留し、`verify` は
// 別エンジンが保留した有効な合成データを読み取りと拒否操作だけで確認し、
// `cleanup` は保留したデータを片付ける。新規の部署は作らない。
const phase = process.env.SOLVI_UI_PHASE ?? 'full';
assert.ok(
  ['full', 'hold', 'verify', 'cleanup', 'menu'].includes(phase),
  `Unknown phase ${phase}`,
);
const donorPath = process.env.SOLVI_UI_DONOR ? resolve(process.env.SOLVI_UI_DONOR) : null;

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

function flattenDepartments(items) {
  return items.flatMap((item) => [item, ...flattenDepartments(item.children ?? [])]);
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
      if ((await admin.locator('#department-head-end').count()) === 0) return;
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
      const fields = ['#profile-primary-department', '#profile-manager', '#profile-job-title'];
      if ((await admin.locator(fields[0]).count()) === 0) return;
      const empty =
        (await admin.locator(fields[0]).inputValue()) === '' &&
        (await admin.locator(fields[1]).inputValue()) === '' &&
        (await admin.locator(fields[2]).inputValue()) === '' &&
        (await admin.locator('#profile-location').inputValue()) === '' &&
        (await admin.locator('#profile-employee-id').inputValue()) === '';
      if (empty) return;
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
      if ((await admin.locator('#department-edit-parent').count()) === 0) return;
      if ((await admin.locator('#department-edit-parent').inputValue()) === '') return;
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
      if ((await admin.getByRole('link', { name: 'この部署を無効化する', exact: true }).count()) === 0)
        return;
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

async function menuChecks(admin) {
  report.accessibility = report.accessibility.filter(
    (scan) => scan.name !== 'admin-rail-desktop-1440',
  );
  report.screenshots = report.screenshots.filter((name) => name !== 'admin-rail-desktop-1440.png');
  await check('管理ホームと左レールに部署管理の導線がある', async () => {
    await go(admin, '/ops/admin');
    const card = admin.locator('.fs-admin-grid a[href="/ops/departments"]');
    assert.equal(await card.count(), 1, 'The admin home must contain the departments card');
    await accessible(admin, 'admin-home-desktop-1440');
    await shot(admin, 'admin-home-desktop-1440', card);

    await go(admin, '/ops/users');
    const rail = admin.locator('.fs-rail a[href="/ops/departments"]');
    assert.equal(await rail.count(), 1, 'The admin rail must contain /ops/departments');
    await admin.locator('.fs-rail a.fs-rail-link[href="/ops/admin"]').focus();
    await rail.waitFor({ state: 'visible' });
    await rail.focus();
    await Promise.all([
      admin.waitForURL((url) => url.pathname === '/ops/departments'),
      admin.keyboard.press('Enter'),
    ]);
    await admin.waitForLoadState('networkidle');
    assert.equal(await admin.getByRole('heading', { name: '部署管理', exact: true }).count(), 1);
  });
  assert.deepEqual(report.blocked, []);
  report.success = true;
  report.currentStep = 'complete';
  delete report.failure;
  await flush();
}

async function completionChecks(admin) {
  assert.ok(donorPath, 'SOLVI_UI_DONOR is required for the verify phase');
  const donor = JSON.parse(await readFile(donorPath, 'utf8'));
  assert.equal(donor.browser, 'webkit', 'The donor run must be WebKit');
  assert.equal(donor.held, true, 'The donor run must hold its synthetic data');
  const ids = donor.ids;
  for (const key of ['rootDepartment', 'childDepartment', 'headDepartment', 'agentUser']) {
    assert.ok(ids?.[key], `The donor summary must contain ${key}`);
  }
  const departments = (await readApi('org_admin', '/departments')).items;
  const byId = new Map(
    flattenDepartments(departments).map((department) => [department.id, department]),
  );
  for (const key of ['rootDepartment', 'childDepartment', 'headDepartment']) {
    const department = byId.get(ids[key]);
    assert.ok(department, `Donor department ${key} must be readable`);
    assert.equal(department.active, true, `Donor department ${key} must still be active`);
  }
  const donorAgent = (await readApi('org_admin', '/users')).items.find(
    (user) => user.userId === ids.agentUser,
  );
  assert.ok(donorAgent, 'The donor agent must exist');
  report.donor = { browser: donor.browser, marker: donor.marker, ids };

  await check('再開: 合成データが入れ子のまま有効で残っている', async () => {
    const root = byId.get(ids.rootDepartment);
    assert.equal(root.children.length, 1, 'The donor root must still have one child');
    assert.equal(root.children[0].id, ids.childDepartment);
    assert.equal(root.children[0].active, true);
  });

  await check('再開: 現在の部署長が表示される', async () => {
    await go(admin, `/ops/departments?department=${ids.headDepartment}`);
    await admin.locator('#department-head').getByText(/現在の部署長:/).waitFor();
    const text = await admin.locator('#department-head').innerText();
    assert.ok(text.includes('現在の部署長:'), 'The current head must be labelled');
    assert.ok(text.includes(donorAgent.displayName), 'The current head must be the donor agent');
    await accessible(admin, 'departments-head-desktop-1440-resume');
    await shot(
      admin,
      'departments-head-desktop-1440-resume',
      admin.locator('#department-head'),
    );
  });

  const rejected = async (name, departmentId, pattern, screenshot) => {
    await check(name, async () => {
      await go(admin, `/ops/departments?department=${departmentId}`);
      await admin.getByRole('link', { name: 'この部署を無効化する', exact: true }).click();
      await admin.waitForURL((url) => url.searchParams.get('confirm') === 'deactivate');
      await admin.locator('#department-confirm-title').waitFor();
      await submit(admin, admin.getByRole('button', { name: '無効化する', exact: true }), (url) =>
        Boolean(url.searchParams.get('error')),
      );
      report.writes.rejectedDeactivations += 1;
      await admin.locator('#department-error').waitFor();
      assert.match(await admin.locator('#department-error').innerText(), pattern);
      await accessible(admin, `${screenshot}-desktop-1440-resume`);
      await shot(admin, `${screenshot}-desktop-1440-resume`, admin.locator('#department-error'));
    });
  };
  await rejected(
    '再開: 子部署が残る部署の無効化が理由付きで拒否される',
    ids.rootDepartment,
    /子部署が残っているため無効化できません/,
    'departments-reject-child',
  );
  await rejected(
    '再開: メンバーが残る部署の無効化が理由付きで拒否される',
    ids.childDepartment,
    /有効な所属メンバーが残っているため無効化できません/,
    'departments-reject-member',
  );
  await rejected(
    '再開: 部署長が残る部署の無効化が理由付きで拒否される',
    ids.headDepartment,
    /有効な部署長が残っているため無効化できません/,
    'departments-reject-head',
  );

  await check('再開: 同じ文言の見出しと凡例が視覚的に重ならない', async () => {
    await go(admin, `/ops/departments?department=${ids.childDepartment}`);
    assert.equal(await admin.getByRole('heading', { name: '部署を編集', exact: true }).count(), 1);
    const departmentLegend = await admin
      .locator('#department-details fieldset legend')
      .first()
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return { position: style.position, width: style.width };
      });
    assert.deepEqual(departmentLegend, { position: 'absolute', width: '1px' });
    assert.equal(await admin.locator('.sr-only').count(), 0, 'No undefined sr-only class');

    await go(admin, `/ops/users?selected=${report.ids.adminUser}`);
    assert.equal(
      await admin.getByRole('heading', { name: '組織プロフィール', exact: true }).count(),
      1,
    );
    const profileLegend = await admin
      .locator('.directory-profile fieldset legend')
      .first()
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return { position: style.position, width: style.width };
      });
    assert.deepEqual(profileLegend, { position: 'absolute', width: '1px' });
    assert.equal(await admin.locator('.sr-only').count(), 0, 'No undefined sr-only class');
  });

  await check('再開: 本人かつ組織管理者の行では主部署と上長が無効で理由が出る', async () => {
    await go(admin, `/ops/users?selected=${report.ids.adminUser}`);
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
    await accessible(admin, 'users-self-disabled-desktop-1440-resume');
    await shot(
      admin,
      'users-self-disabled-desktop-1440-resume',
      admin.locator('#directory-profile-title'),
    );
  });

  await check('再開: 社員番号を一覧・URLに出さない', async () => {
    await go(admin, '/ops/users');
    const table = await admin.locator('table.directory-table').innerText();
    assert.ok(!table.includes('社員番号'));
    assert.ok(!admin.url().includes('employeeId'));
  });

  await check('再開: 1440px と 375px で横溢れがない', async () => {
    await go(admin, '/ops/users');
    await mobile(admin, 'users-list-resume', admin.getByRole('heading', { level: 1 }));
    await go(admin, `/ops/departments?department=${ids.childDepartment}`);
    await mobile(admin, 'departments-detail-resume', admin.getByRole('heading', { level: 1 }));
    await go(admin, '/ops/departments');
    const rootNode = admin.locator('li.group', { hasText: `${donor.marker}-ROOT` }).first();
    await rootNode.getByText('子部署 1 件', { exact: true }).waitFor();
    assert.equal(await rootNode.getByText(`${donor.marker}-CHILD`, { exact: true }).count(), 1);
    await mobile(admin, 'departments-tree-resume', rootNode);
  });

  await check('再開: org_admin 以外には画面も導線も出ない', async () => {
    const agent = await actor('agent');
    await go(agent, '/portal');
    assert.equal(await agent.getByRole('link', { name: '部署管理', exact: true }).count(), 0);
    await go(agent, '/ops/departments');
    assert.match(await agent.locator('main').innerText(), /この画面を表示する権限がありません/);
    await go(agent, '/ops/users');
    assert.match(await agent.locator('main').innerText(), /この画面を表示する権限がありません/);
    assert.equal(
      await agent.locator('.fs-rail a[href="/ops/departments"]').count(),
      0,
      'Non org_admin must not see the departments rail item',
    );
  });

  const after = flattenDepartments((await readApi('org_admin', '/departments')).items);
  for (const key of ['rootDepartment', 'childDepartment', 'headDepartment']) {
    assert.equal(
      after.find((department) => department.id === ids[key])?.active,
      true,
      `The donor department ${key} must be left for the donor cleanup`,
    );
  }
  assert.deepEqual(report.blocked, []);
  report.success = true;
  report.currentStep = 'complete';
  delete report.failure;
  await flush();
}

async function cleanupOnly(admin) {
  report.cleanup = { attempted: false, complete: false, steps: [], errors: [] };
  await cleanup(admin);
  assert.ok(report.cleanup.complete, `Cleanup: ${JSON.stringify(report.cleanup.errors)}`);
  const departments = (await readApi('org_admin', '/departments')).items;
  const ownDepartments = flattenDepartments(departments).filter((department) =>
    [report.ids.rootDepartment, report.ids.childDepartment, report.ids.headDepartment].includes(
      department.id,
    ),
  );
  assert.equal(ownDepartments.length, 3);
  assert.ok(ownDepartments.every((department) => !department.active));
  for (const department of ownDepartments) {
    const head = (await readApi('org_admin', `/departments/${department.id}/head`)).head;
    assert.equal(head, null);
  }
  const agent = (await readApi('org_admin', '/users')).items.find(
    (user) => user.userId === report.ids.agentUser,
  );
  assert.equal(agent.primaryDepartmentId, null);
  assert.equal(agent.managerUserId, null);
  assert.equal(agent.jobTitle, null);
  assert.deepEqual(report.blocked, []);
  report.held = false;
  report.success = true;
  report.currentStep = 'complete';
  delete report.failure;
  await flush();
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
    engineDepartments.length + ADDITIONAL_DEPARTMENTS <= MAX_SYNTHETIC_DEPARTMENTS,
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
    const link = admin
      .locator('.directory-heading-actions')
      .getByRole('link', { name: '部署管理', exact: true });
    assert.equal(await link.count(), 1, 'The users screen must link to /ops/departments');
    await link.focus();
    await Promise.all([
      admin.waitForURL((url) => url.pathname === '/ops/departments'),
      admin.keyboard.press('Enter'),
    ]);
    await admin.waitForLoadState('networkidle');
    assert.equal(await admin.getByRole('heading', { name: '部署管理', exact: true }).count(), 1);
  });

  await check('左レールと管理ホームにも部署管理の導線がある', async () => {
    await go(admin, '/ops/users');
    const rail = admin.locator('.fs-rail a[href="/ops/departments"]');
    assert.equal(await rail.count(), 1, 'The admin rail must contain /ops/departments');
    await go(admin, '/ops/admin');
    const card = admin.locator('.fs-admin-grid a[href="/ops/departments"]');
    assert.equal(await card.count(), 1, 'The admin home must contain the departments card');
    await card.focus();
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
    assert.ok(report.writes.departments <= ADDITIONAL_DEPARTMENTS);
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
    assert.ok(report.writes.departments <= ADDITIONAL_DEPARTMENTS);
    await go(admin, '/ops/departments');
    const rootNode = admin.locator('li.group', { hasText: `${marker}-ROOT` }).first();
    await rootNode.getByText('子部署 1 件', { exact: true }).waitFor();
    assert.equal(
      await rootNode.getByText(`${marker}-CHILD`, { exact: true }).count(),
      1,
      'The child department must be nested under the root',
    );
    await accessible(admin, 'departments-tree-desktop-1440');
    await shot(admin, 'departments-tree-desktop-1440', admin.getByRole('heading', { level: 1 }));
    // 片付け(子部署を最上位へ移す)より前の入れ子を、子部署数の表示ごと残す。
    await accessible(admin, 'departments-tree-nested-desktop-1440');
    await shot(admin, 'departments-tree-nested-desktop-1440', rootNode);
    await mobile(admin, 'departments-tree-nested', rootNode);
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
    assert.ok(report.writes.departments <= ADDITIONAL_DEPARTMENTS);
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
    assert.ok(report.profilePeople.length <= ADDITIONAL_PROFILES);
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
    assert.ok(report.writes.headsAssigned <= ADDITIONAL_HEADS);
    await admin
      .locator('#department-head')
      .getByText(/現在の部署長:/)
      .waitFor();
    await accessible(admin, 'departments-detail-desktop-1440');
    await shot(admin, 'departments-detail-desktop-1440', admin.locator('#department-head'));
  });

  await check('同じ文言の見出しと凡例が視覚的に重ならない', async () => {
    await go(admin, `/ops/departments?department=${report.ids.childDepartment}`);
    assert.equal(
      await admin.getByRole('heading', { name: '部署を編集', exact: true }).count(),
      1,
      'The department edit heading must appear once',
    );
    const legendStyle = await admin
      .locator('#department-details fieldset legend')
      .first()
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return { position: style.position, width: style.width };
      });
    assert.deepEqual(legendStyle, { position: 'absolute', width: '1px' });
    assert.equal(await admin.locator('.sr-only').count(), 0, 'No undefined sr-only class');

    await go(admin, `/ops/users?selected=${report.ids.agentUser}`);
    assert.equal(
      await admin.getByRole('heading', { name: '組織プロフィール', exact: true }).count(),
      1,
      'The profile heading must appear once',
    );
    const profileLegendStyle = await admin
      .locator('.directory-profile fieldset legend')
      .first()
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return { position: style.position, width: style.width };
      });
    assert.deepEqual(profileLegendStyle, { position: 'absolute', width: '1px' });
    assert.equal(await admin.locator('.sr-only').count(), 0, 'No undefined sr-only class');
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
    assert.equal(
      await agent.locator('.fs-rail a[href="/ops/departments"]').count(),
      0,
      'Non org_admin must not see the departments rail item',
    );
  });

  if (phase === 'hold') {
    // 片付けは別の再開実行で行う。作った部署は有効なまま残る。
    report.held = true;
    report.cleanup = { ...report.cleanup, complete: false };
    assert.deepEqual(report.blocked, []);
    report.success = true;
    report.currentStep = 'held';
    await flush();
    return;
  }

  await cleanup(admin);
  const departments = (await readApi('org_admin', '/departments')).items;
  const ownDepartments = flattenDepartments(departments).filter((department) =>
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
  if (phase === 'menu') {
    await menuChecks(admin);
    return;
  }
  if (phase === 'verify') {
    assert.ok(previous, 'The verify phase needs the previous summary');
    await completionChecks(admin);
    return;
  }
  if (phase === 'cleanup') {
    assert.ok(previous, 'The cleanup phase needs the previous summary');
    await cleanupOnly(admin);
    return;
  }
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
