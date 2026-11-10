/**
 * WP-P2-UX-037: isolated UI contract checks. No database, existing API, real
 * account, or saved browser session is used. The HTTP fixture is deliberately
 * not evidence that production authorization or persistence works.
 * Run: node tools/e2e/user_directory_flow.mjs
 */
/* global document, window, getComputedStyle */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createPortGuard } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

const root = fileURLToPath(new URL('../..', import.meta.url));
const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' })
  .format(new Date())
  .replaceAll('-', '');
const evidence = join(root, 'evidence', 'WP-P2-UX-037', day);
const webPort = 3307;
const webBase = `http://127.0.0.1:${webPort}`;
const orgA = '03700000-0000-4000-8000-000000000001';
const orgB = '03700000-0000-4000-8000-000000000002';
const scopeCookie = 'solvi_session_wp037_synthetic';
const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const fixtureName = (index) => `検証利用者${String(index + 1).padStart(2, '0')}`;
const fixtures = Array.from({ length: 61 }, (_, index) => ({
  userId: `03700000-0000-4000-8001-${String(index + 1).padStart(12, '0')}`,
  displayName:
    index === 0
      ? `${fixtureName(index)} 長い表示名の折り返し確認用サンプル部署担当者`
      : fixtureName(index),
  email: `synthetic.member.${String(index + 1).padStart(2, '0')}@example.invalid`,
  status: index % 10 === 9 ? 'deactivated' : 'active',
  deactivatedAt: index % 10 === 9 ? '2026-09-01T00:00:00.000Z' : null,
  roleCodes:
    index === 2 ? ['requester', 'agent', 'approver'] : [index % 3 === 0 ? 'agent' : 'requester'],
  temporaryRoles:
    index === 2
      ? [
          {
            roleCode: 'approver',
            validUntil: '2026-10-06T00:00:00.000Z',
            daysRemaining: 2,
            expiringSoon: true,
          },
        ]
      : [],
  openTicketCount: index % 5,
}));
const report = {
  workPackage: 'WP-P2-UX-037',
  startedAt: new Date().toISOString(),
  scope:
    'Synthetic UI contracts against an isolated in-memory HTTP fixture; no real DB/API/session. Not production authorization evidence.',
  checks: [],
  mutations: [],
  unexpectedRequests: [],
  axe: [],
};
let scenario = 'normal';
let mutationMode = 'success';
let authMode = 'normal';
let mutationDelayMs = 0;
const hiddenMemberIds = new Set();
let created = [];
let temp;
let web;
let browser;
let context;
let page;
let server;
let apiPort;
let webLog = '';

async function hashFile(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function snapshotWeb(directory) {
  const files = [];
  async function visit(relative = '') {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile())
        files.push({ path: `apps/web/${path}`, sha256: await hashFile(join(directory, path)) });
    }
  }
  await visit();
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    algorithm: 'sha256',
    capturedAt: new Date().toISOString(),
    manifestSha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    scriptSha256: await hashFile(fileURLToPath(import.meta.url)),
    lockfileSha256: await hashFile(join(root, 'package-lock.json')),
    files,
  };
}

async function portAvailable(port) {
  if (!port) return true;
  const probe = createPortGuard();
  return new Promise((resolve) => {
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

function send(res, status, body) {
  if (status === 204) {
    res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, {
    'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
  });
  res.end(JSON.stringify(body));
}

function problem(res, status, message, field) {
  send(res, status, {
    type: `https://solvi.example/problems/${status === 403 ? 'forbidden' : status === 503 ? 'unavailable' : 'validation'}`,
    title: message,
    status,
    detail: message,
    ...(field ? { errors: [{ field, message }] } : {}),
  });
}

async function startFixture() {
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const identity =
        /solvi_session_wp037_synthetic=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? 'admin';
      const organizationId = identity === 'other-org' ? orgB : orgA;
      const roleCode = ['agent', 'requester'].includes(identity) ? identity : 'org_admin';
      if (url.pathname === '/auth/me' && req.method === 'GET') {
        if (authMode === 'expired') return problem(res, 401, 'セッションの有効期限が切れました。');
        if (authMode === 'unavailable') return problem(res, 503, 'セッションを確認できません。');
        return send(res, 200, {
          userId: fixtures[0].userId,
          organizationId,
          roles: [{ roleCode, organizationId }],
        });
      }
      if (url.pathname === '/auth/organizations' && req.method === 'GET') {
        return send(res, 200, {
          selected: organizationId,
          organizations: [{ id: organizationId, code: 'synthetic', name: '合成検証組織' }],
        });
      }
      if (url.pathname === '/users') {
        if (roleCode !== 'org_admin' || scenario === 'forbidden')
          return problem(res, 403, '利用者を管理する権限がありません。');
        if (req.method === 'GET') {
          if (scenario === 'unavailable')
            return problem(
              res,
              503,
              '利用者一覧を取得できません。時間をおいて再試行してください。',
            );
          const items =
            scenario === 'empty'
              ? []
              : organizationId === orgB
                ? [
                    {
                      ...fixtures[0],
                      userId: '03700000-0000-4000-8002-000000000001',
                      displayName: '別組織の検証利用者',
                      email: 'other.organization@example.invalid',
                    },
                  ]
                : [...fixtures, ...created].filter((member) => !hiddenMemberIds.has(member.userId));
          return send(res, 200, {
            items:
              scenario === 'density'
                ? items.map((member, index) => ({
                    ...member,
                    displayName: fixtureName(index),
                    roleCodes: ['requester'],
                    temporaryRoles: [],
                  }))
                : items,
          });
        }
        if (req.method === 'POST') {
          let raw = '';
          for await (const chunk of req) raw += chunk;
          const body = JSON.parse(raw);
          report.mutations.push({ method: req.method, path: url.pathname, body });
          if (mutationDelayMs) await new Promise((resolve) => setTimeout(resolve, mutationDelayMs));
          if (mutationMode === 'duplicate')
            return problem(res, 400, 'このメールアドレスはすでに登録されています。', 'email');
          if (mutationMode === 'invalid')
            return problem(res, 400, '表示名を確認してください。', 'displayName');
          const userId = `03700000-0000-4000-8003-${String(created.length + 1).padStart(12, '0')}`;
          created.push({
            ...fixtures[1],
            userId,
            displayName: body.displayName,
            email: body.email,
            roleCodes: [body.roleCode],
          });
          return send(res, 201, { userId });
        }
      }
      const action = /^\/users\/([^/]+)\/(roles(?:\/revoke)?|deactivate|reactivate)$/.exec(
        url.pathname,
      );
      if (action && req.method === 'POST') {
        if (roleCode !== 'org_admin')
          return problem(res, 403, '利用者を管理する権限がありません。');
        const member = [...fixtures, ...created].find((item) => item.userId === action[1]);
        if (!member) return problem(res, 404, '利用者が見つかりません。');
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        report.mutations.push({ method: req.method, path: url.pathname, body });
        if (action[2] === 'roles')
          member.roleCodes = [...new Set([...member.roleCodes, body.roleCode])];
        if (action[2] === 'roles/revoke') {
          member.roleCodes = member.roleCodes.filter((role) => role !== body.roleCode);
          if (!member.roleCodes.length) hiddenMemberIds.add(member.userId);
        }
        if (action[2] === 'deactivate') {
          member.status = 'deactivated';
          member.deactivatedAt = '2026-10-04T00:00:00.000Z';
          return send(res, 200, { revokedSessions: 2, openTicketCount: member.openTicketCount });
        }
        if (action[2] === 'reactivate') {
          member.status = 'active';
          member.deactivatedAt = null;
        }
        return send(res, 204);
      }
      report.unexpectedRequests.push({ method: req.method, path: url.pathname });
      problem(res, 404, 'この検証では定義されていないAPIです。');
    } catch {
      problem(res, 500, '検証用APIの処理に失敗しました。');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  apiPort = server.address().port;
  return `http://127.0.0.1:${apiPort}`;
}

async function startWeb(apiBase) {
  const guard = createPortGuard();
  await new Promise((resolve, reject) => {
    guard.once('error', () =>
      reject(new Error(`Port ${webPort} is occupied; existing processes were not stopped.`)),
    );
    guard.listen(webPort, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => guard.close(resolve));
  temp = await mkdtemp(join(tmpdir(), 'solvi-wp037-'));
  const webDir = join(temp, 'web');
  await cp(join(root, 'apps/web'), webDir, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (path) =>
      !/(?:^|\/)(?:node_modules|\.next|\.env[^/]*)(?:\/|$)/.test(path) &&
      !path.endsWith('.tsbuildinfo'),
  });
  report.sourceSnapshot = await snapshotWeb(webDir);
  await symlink(join(root, 'node_modules'), join(webDir, 'node_modules'), 'dir');
  const env = Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ']
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );
  web = spawn(
    process.execPath,
    [
      join(root, 'node_modules/next/dist/bin/next'),
      'dev',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(webPort),
    ],
    {
      cwd: webDir,
      env: { ...env, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', API_BASE_URL: apiBase },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  for (const stream of [web.stdout, web.stderr])
    stream.on('data', (chunk) => {
      webLog = (webLog + chunk.toString()).slice(-20_000);
    });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (web.exitCode !== null) throw new Error(`Isolated Web exited (${web.exitCode}).`);
    try {
      const response = await fetch(`${webBase}/ops/users`, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return;
    } catch {
      /* Child process may still be binding or compiling. */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('Isolated Web did not become ready within 90 seconds.');
}

async function identity(value = 'admin') {
  await context.clearCookies();
  await context.addCookies([
    { name: scopeCookie, value, url: webBase, httpOnly: true, sameSite: 'Lax' },
  ]);
}

async function open(path = '/ops/users') {
  await page.goto(`${webBase}${path}`, { waitUntil: 'networkidle' });
}

async function visible(locator) {
  await locator.waitFor({ state: 'visible', timeout: 10_000 });
}
async function textVisible(text) {
  await visible(page.getByText(text, { exact: false }).first());
}
async function tabTo(locator) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await page.keyboard.press('Tab');
    if (await locator.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error('Keyboard Tab did not reach the expected control within 80 stops.');
}
async function noOverflow() {
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    true,
    'page must not overflow horizontally',
  );
}
async function capture(name, withAxe = true) {
  await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: true });
  if (withAxe) {
    const results = await new AxeBuilder({ page }).withTags(tags).analyze();
    await writeFile(join(evidence, `${name}-axe.json`), JSON.stringify(results, null, 2));
    report.axe.push({
      name,
      violations: results.violations.map(({ id, impact, nodes }) => ({
        id,
        impact,
        nodes: nodes.length,
      })),
    });
    assert.equal(results.violations.length, 0, `${name}: axe violations`);
  }
}
async function check(name, run) {
  const startedAt = Date.now();
  try {
    await run();
    report.checks.push({ name, passed: true, durationMs: Date.now() - startedAt });
  } catch (error) {
    report.checks.push({
      name,
      passed: false,
      error: String(error.message),
      durationMs: Date.now() - startedAt,
    });
    if (page)
      await page
        .screenshot({ path: join(evidence, `failure-${report.checks.length}.png`), fullPage: true })
        .catch(() => {});
  }
  process.stdout.write(`${report.checks.at(-1).passed ? 'PASS' : 'FAIL'} ${name}\n`);
  scenario = 'normal';
  authMode = 'normal';
  mutationMode = 'success';
  mutationDelayMs = 0;
}

async function createForm(kind) {
  scenario = 'normal';
  await identity();
  await open();
  await page.getByRole('link', { name: `${kind}を追加`, exact: true }).click();
  await visible(page.getByLabel('表示名', { exact: true }));
  return page.locator('form').filter({ has: page.getByLabel('表示名', { exact: true }) });
}
async function fillCreate(form, suffix) {
  await form.getByLabel('表示名', { exact: true }).fill(`追加検証${suffix}`);
  await form
    .getByLabel('メールアドレス', { exact: true })
    .fill(`created.${suffix}@example.invalid`);
  await form.getByLabel('追加の理由', { exact: true }).fill('隔離された合成UI検証');
}
async function submitCreate(form) {
  await form.getByRole('button', { name: /追加/ }).click();
}

try {
  await access(chromium.executablePath()).catch(() => {
    throw new Error(
      'Installed Playwright Chromium is required; this test does not install browsers or packages.',
    );
  });
  await mkdir(evidence, { recursive: true });
  const apiBase = await startFixture();
  await startWeb(apiBase);
  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ja-JP' });
  page = await context.newPage();
  await identity();

  await check('61-member directory, independent entry points, desktop accessibility', async () => {
    await open();
    await visible(page.getByRole('heading', { name: '利用者管理', exact: true }));
    for (const name of ['全員', 'リクエスター', 'オペレーター'])
      await visible(
        page
          .getByRole('navigation', { name: '利用者の種類' })
          .getByRole('link', { name: new RegExp(`^${name}`) }),
      );
    for (const name of ['リクエスターを追加', 'オペレーターを追加'])
      await visible(page.getByRole('link', { name, exact: true }));
    const count = await page.locator('tbody tr').count();
    assert.equal(count, 25, '61 fixtures must paginate as 25 / 25 / 11');
    await noOverflow();
    await capture('directory-desktop');
  });
  await check('1280x720 at 100 percent displays at least eight complete normal rows', async () => {
    scenario = 'density';
    await page.setViewportSize({ width: 1280, height: 720 });
    await open();
    const density = await page.evaluate(() => ({
      scale: window.visualViewport?.scale,
      width: window.innerWidth,
      height: window.innerHeight,
      completeRows: Array.from(document.querySelectorAll('.directory-table tbody tr')).filter(
        (row) => {
          const bounds = row.getBoundingClientRect();
          return bounds.top >= 0 && bounds.bottom <= window.innerHeight;
        },
      ).length,
    }));
    report.density = {
      ...density,
      fixture: '61 normal names with one role and no temporary roles',
    };
    await page.screenshot({ path: join(evidence, 'directory-1280x720-density.png') });
    assert.equal(density.scale, 1);
    assert(
      density.completeRows >= 8,
      `expected eight complete normal rows, found ${density.completeRows}`,
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await check('pagination and browser back retain the directory URL', async () => {
    await open();
    const first = page.url();
    await page.getByRole('link', { name: /次へ/ }).click();
    await page.waitForURL((url) => url.href !== first);
    assert.equal(new URL(page.url()).searchParams.get('page'), '2');
    assert.equal(await page.locator('tbody tr').count(), 25);
    await visible(page.getByRole('link', { name: /前へ/ }));
    await page.getByRole('link', { name: /次へ/ }).click();
    await page.waitForURL((url) => url.searchParams.get('page') === '3');
    assert.equal(await page.locator('tbody tr').count(), 11);
    await page.goBack({ waitUntil: 'networkidle' });
    await page.waitForURL((url) => url.searchParams.get('page') === '2');
    assert.equal(new URL(page.url()).searchParams.get('page'), '2');
    await page.goBack({ waitUntil: 'networkidle' });
    await page.waitForURL(first);
    assert.equal(page.url(), first);
  });
  await check(
    'keyboard Tab and Enter operate search and direct operator creation with visible focus',
    async () => {
      await open();
      const search = page.getByLabel('名前・メール', { exact: true });
      await tabTo(search);
      const focus = await search.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          visible: element.matches(':focus-visible'),
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
          boxShadow: style.boxShadow,
        };
      });
      assert.equal(focus.visible, true);
      assert(
        (focus.outlineStyle !== 'none' && Number.parseFloat(focus.outlineWidth) > 0) ||
          focus.boxShadow !== 'none',
        'keyboard focus must have a visible outline or shadow',
      );
      await page.screenshot({ path: join(evidence, 'directory-keyboard-focus.png') });
      await page.keyboard.type('member.61');
      await tabTo(page.getByRole('button', { name: '絞り込む', exact: true }));
      await page.keyboard.press('Enter');
      await page.waitForURL((url) => url.searchParams.get('q') === 'member.61');
      assert.equal(await page.locator('.directory-table tbody tr').count(), 1);
      await textVisible(fixtures[60].email);
      await open();
      await tabTo(page.getByRole('link', { name: 'オペレーターを追加', exact: true }));
      await page.keyboard.press('Enter');
      await page.waitForURL((url) => url.searchParams.get('create') === 'agent');
      await visible(page.getByLabel('表示名', { exact: true }));
      report.keyboard = {
        searchFocus: focus,
        actions: [
          'Tab to search',
          'type synthetic query',
          'Tab to filter',
          'Enter submits filter',
          'Tab to operator-create link',
          'Enter opens operator form',
        ],
        resultRows: 1,
        operatorCreateParameter: 'agent',
      };
    },
  );
  await check('search and filters are reflected in URL and reset pagination', async () => {
    await open('/ops/users?page=2');
    await page.getByLabel('名前・メール', { exact: true }).fill('member.61');
    await page.getByRole('button', { name: '絞り込む', exact: true }).click();
    await page.waitForLoadState('networkidle');
    assert(page.url().includes('member.61'));
    assert.notEqual(new URL(page.url()).searchParams.get('page'), '2');
    assert.equal(await page.locator('tbody tr').count(), 1);
    await textVisible(fixtures[60].email);
    await page.getByLabel('名前・メール', { exact: true }).fill('nonexistent-synthetic-user');
    await page.getByRole('button', { name: '絞り込む', exact: true }).click();
    await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('tbody tr').count(), 0);
    await capture('directory-search-empty');
  });
  await check('requester/operator views, role and lifecycle filters', async () => {
    await open();
    await page
      .getByRole('navigation', { name: '利用者の種類' })
      .getByRole('link', { name: /^オペレーター/ })
      .click();
    await page.waitForURL((url) => url.searchParams.get('role') === 'agent');
    await page.waitForLoadState('networkidle');
    assert.equal(new URL(page.url()).searchParams.get('role'), 'agent');
    await visible(page.getByLabel('役割', { exact: true }));
    await page.getByLabel('状態', { exact: true }).selectOption('deactivated');
    await page.getByRole('button', { name: '絞り込む', exact: true }).click();
    await page.waitForLoadState('networkidle');
    const rows = await page.locator('tbody tr').allTextContents();
    assert(rows.length > 0);
    assert(
      rows.every((value) => /停止|無効/.test(value)),
      'all returned rows must display stopped status',
    );
  });
  await check('member detail exposes multiple roles and expiry', async () => {
    await open();
    await page
      .getByRole('link', { name: `${fixtures[2].displayName} の詳細`, exact: true })
      .click();
    await page.waitForURL((url) => url.searchParams.get('selected') === fixtures[2].userId);
    const details = page.locator('#member-details');
    assert.match(await details.innerText(), /承認者/);
    assert.match(await details.innerText(), /2026/);
    await capture('member-detail');
  });
  await check('create error keeps fields and focuses accessible error summary', async () => {
    const form = await createForm('リクエスター');
    mutationMode = 'duplicate';
    await fillCreate(form, 'duplicate');
    await submitCreate(form);
    await textVisible('このメールアドレスはすでに登録されています。');
    assert.equal(
      await form.getByLabel('表示名', { exact: true }).inputValue(),
      '追加検証duplicate',
    );
    assert.equal(
      await form.getByLabel('メールアドレス', { exact: true }).inputValue(),
      'created.duplicate@example.invalid',
    );
    assert.equal(
      await form.getByLabel('追加の理由', { exact: true }).inputValue(),
      '隔離された合成UI検証',
    );
    await page.waitForFunction(() => document.activeElement?.classList.contains('error-summary'));
    assert.equal(
      await form.getByLabel('メールアドレス', { exact: true }).getAttribute('aria-invalid'),
      'true',
    );
    await capture('create-duplicate-error');
  });
  await check('400 field validation retains form and marks display name invalid', async () => {
    const form = await createForm('リクエスター');
    mutationMode = 'invalid';
    await fillCreate(form, 'invalid');
    await submitCreate(form);
    await textVisible('表示名を確認してください。');
    assert.equal(
      await form.getByLabel('メールアドレス', { exact: true }).inputValue(),
      'created.invalid@example.invalid',
    );
    await page.waitForFunction(() => document.activeElement?.classList.contains('error-summary'));
    assert.equal(
      await form.getByLabel('表示名', { exact: true }).getAttribute('aria-invalid'),
      'true',
    );
  });
  await check('requester and operator create submit the correct initial role', async () => {
    mutationMode = 'success';
    for (const [kind, suffix, expectedRole] of [
      ['リクエスター', 'requester', 'requester'],
      ['オペレーター', 'agent', 'agent'],
    ]) {
      const form = await createForm(kind);
      await fillCreate(form, suffix);
      await submitCreate(form);
      await page.waitForURL((url) => url.searchParams.get('notice') === 'created');
      assert.equal(report.mutations.at(-1).body.roleCode, expectedRole);
      await textVisible('追加');
    }
  });
  await check(
    'pending create disables its fields and prevents a duplicate submission',
    async () => {
      const form = await createForm('リクエスター');
      await fillCreate(form, 'pending');
      const before = report.mutations.length;
      mutationDelayMs = 2_000;
      await submitCreate(form);
      const pending = form.getByRole('button', { name: '追加しています…', exact: true });
      await visible(pending);
      assert.equal(await pending.isDisabled(), true);
      assert.equal(await form.getByLabel('表示名', { exact: true }).isDisabled(), true);
      assert.equal(await form.getAttribute('aria-busy'), 'true');
      await page.keyboard.press('Enter');
      await page.waitForURL((url) => url.searchParams.get('notice') === 'created');
      assert.equal(report.mutations.length, before + 1);
    },
  );
  await check('session 401 and 503 preserve form input without a mutation', async () => {
    for (const mode of ['expired', 'unavailable']) {
      authMode = 'normal';
      const form = await createForm('リクエスター');
      await fillCreate(form, `session-${mode}`);
      const before = report.mutations.length;
      authMode = mode;
      await submitCreate(form);
      await visible(form.getByRole('alert'));
      assert.equal(
        await form.getByLabel('表示名', { exact: true }).inputValue(),
        `追加検証session-${mode}`,
      );
      assert.equal(
        await form.getByLabel('メールアドレス', { exact: true }).inputValue(),
        `created.session-${mode}@example.invalid`,
      );
      assert.equal(report.mutations.length, before);
      if (mode === 'expired') {
        const login = form.getByRole('link', { name: /ログイン/ });
        await visible(login);
        assert.equal(await login.getAttribute('target'), '_blank');
        assert.match(await login.getAttribute('href'), /^\/login/);
      }
      authMode = 'normal';
    }
  });
  await check(
    'role grant/revoke and access stop/reactivate submit bound member payloads',
    async () => {
      const member = fixtures[1];
      const selected = `/ops/users?selected=${member.userId}#member-details`;
      for (const [operation, label, roleLabel, reasonLabel, path, notice] of [
        ['grant', '役割を与える', '与える役割', '付与の理由', 'roles', 'granted'],
        ['revoke', '役割を取り消す', '取り消す役割', '取り消しの理由', 'roles/revoke', 'revoked'],
      ]) {
        await open(selected);
        await page.locator('#member-details summary').filter({ hasText: '役割を変える' }).click();
        const form = page.getByRole('form', {
          name: `${member.displayName}の${label}`,
          exact: true,
        });
        await form.getByLabel(roleLabel, { exact: true }).selectOption('approver');
        await form.getByLabel(reasonLabel, { exact: true }).fill(`合成検証 ${operation}`);
        await form.getByRole('button', { name: label, exact: true }).click();
        await page.waitForURL((url) => url.searchParams.get('notice') === notice);
        assert.equal(report.mutations.at(-1).path, `/users/${member.userId}/${path}`);
        assert.equal(report.mutations.at(-1).body.roleCode, 'approver');
        assert.equal(report.mutations.at(-1).body.reason, `合成検証 ${operation}`);
      }
      for (const [operation, label, reasonLabel, notice] of [
        ['deactivate', 'アクセスを止める', '止める理由', 'stopped'],
        ['reactivate', 'アクセスを戻す', '戻す理由', 'reactivated'],
      ]) {
        await open(selected);
        await page.locator('#member-details summary').filter({ hasText: label }).click();
        const form = page.getByRole('form', {
          name: `${member.displayName}の${label}`,
          exact: true,
        });
        await form.getByLabel(reasonLabel, { exact: true }).fill(`合成検証 ${operation}`);
        await form.getByRole('button', { name: label, exact: true }).click();
        await page.waitForURL((url) => url.searchParams.get('notice') === notice);
        assert.deepEqual(report.mutations.at(-1).body, { reason: `合成検証 ${operation}` });
        assert.equal(report.mutations.at(-1).path, `/users/${member.userId}/${operation}`);
        if (operation === 'deactivate') {
          assert.equal(
            new URL(page.url()).searchParams.get('count'),
            String(member.openTicketCount),
          );
          await textVisible('対応中の問い合わせが');
        }
      }
    },
  );
  await check('revoking the final role explains why the selected member is absent', async () => {
    const member = fixtures[1];
    await open(`/ops/users?selected=${member.userId}#member-details`);
    await page.locator('#member-details summary').filter({ hasText: '役割を変える' }).click();
    const form = page.getByRole('form', {
      name: `${member.displayName}の役割を取り消す`,
      exact: true,
    });
    await form.getByLabel('取り消す役割', { exact: true }).selectOption('requester');
    await form.getByLabel('取り消しの理由', { exact: true }).fill('最後の役割取り消しの合成検証');
    await form.getByRole('button', { name: '役割を取り消す', exact: true }).click();
    await page.waitForURL((url) => url.searchParams.get('notice') === 'revoked');
    await textVisible('すべての役割が取り消されたか、失効した可能性があります');
    assert.equal(await page.locator('#member-details form').count(), 0);
  });
  await check(
    'API unavailable, forbidden, and genuinely empty states remain distinct',
    async () => {
      for (const value of ['unavailable', 'forbidden', 'empty']) {
        scenario = value;
        await open();
        assert.equal(await page.locator('tbody tr').count(), 0);
        if (value === 'unavailable') await textVisible('利用者一覧を読み込めませんでした');
        if (value === 'forbidden') await textVisible('利用者を表示する権限がありません');
        if (value === 'empty') await textVisible('表示できる在籍者がいません');
        await capture(`directory-${value}`);
      }
      scenario = 'normal';
    },
  );
  await check('agent/requester UI guard and explicit fixture HTTP 403', async () => {
    scenario = 'normal';
    for (const value of ['agent', 'requester']) {
      await identity(value);
      await open();
      await textVisible('権限がありません');
      assert.equal(
        await page.getByRole('link', { name: 'オペレーターを追加', exact: true }).count(),
        0,
      );
      const response = await fetch(`${apiBase}/users`, {
        headers: { cookie: `${scopeCookie}=${value}` },
      });
      assert.equal(response.status, 403);
    }
  });
  await check('organization switch does not retain prior directory rows', async () => {
    await identity();
    await open();
    await textVisible(fixtures[0].email);
    await identity('other-org');
    await open();
    await textVisible('other.organization@example.invalid');
    assert.equal(await page.getByText(fixtures[0].email, { exact: true }).count(), 0);
    await identity();
  });
  await check('a form opened in another organization cannot submit a stale action', async () => {
    const form = await createForm('リクエスター');
    mutationMode = 'success';
    await fillCreate(form, 'scope-change');
    const priorMutations = report.mutations.length;
    await identity('other-org');
    await submitCreate(form);
    await visible(page.getByRole('alert').first());
    assert.equal(
      report.mutations.length,
      priorMutations,
      'scope change must be rejected before calling the mutation API',
    );
    await identity();
  });
  await check('mobile directory and create form have no page overflow and pass axe', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open();
    await noOverflow();
    await capture('directory-mobile');
    await createForm('オペレーター');
    await noOverflow();
    await capture('create-operator-mobile');
  });
  assert.equal(
    report.unexpectedRequests.length,
    0,
    'All API traffic must be covered explicitly by the fixture',
  );
} catch (error) {
  report.checks.push({
    name: 'harness setup/completion',
    passed: false,
    error: String(error.message),
  });
} finally {
  await browser?.close().catch(() => {});
  if (web && web.exitCode === null && web.signalCode === null) {
    web.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => web.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 4_000)),
    ]);
    if (web.exitCode === null && web.signalCode === null) {
      web.kill('SIGKILL');
      await new Promise((resolve) => web.once('exit', resolve));
    }
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  if (temp) await rm(temp, { recursive: true, force: true });
  report.cleanup = {
    checkedAt: new Date().toISOString(),
    webProcessExited: !web || web.exitCode !== null || web.signalCode !== null,
    webPort: webPort,
    webPortAvailable: await portAvailable(webPort),
    fixtureClosed: !server?.listening,
    fixturePort: apiPort ?? null,
    fixturePortAvailable: await portAvailable(apiPort),
    ownedTemporaryDirectoryRemoved:
      !temp ||
      (await access(temp).then(
        () => false,
        (error) => error.code === 'ENOENT',
      )),
  };
  report.checks.push({
    name: 'owned Web/API listeners and temporary directory cleaned up',
    passed:
      report.cleanup.webProcessExited &&
      report.cleanup.webPortAvailable &&
      report.cleanup.fixtureClosed &&
      report.cleanup.fixturePortAvailable &&
      report.cleanup.ownedTemporaryDirectoryRemoved,
  });
  if (report.sourceSnapshot) {
    const unchanged = await Promise.all(
      report.sourceSnapshot.files.map(
        async (file) => (await hashFile(join(root, file.path))) === file.sha256,
      ),
    );
    report.sourceSnapshot.currentMatchesCopied =
      unchanged.every(Boolean) &&
      (await hashFile(fileURLToPath(import.meta.url))) === report.sourceSnapshot.scriptSha256 &&
      (await hashFile(join(root, 'package-lock.json'))) === report.sourceSnapshot.lockfileSha256;
    report.checks.push({
      name: 'source and lockfile unchanged since copied Web snapshot',
      passed: report.sourceSnapshot.currentMatchesCopied,
    });
  }
  report.finishedAt = new Date().toISOString();
  report.passed = report.checks.length > 0 && report.checks.every((item) => item.passed);
  await mkdir(evidence, { recursive: true });
  await writeFile(
    join(evidence, 'user-directory-report.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  if (!report.passed) await writeFile(join(evidence, 'isolated-web-log.txt'), webLog);
  process.stdout.write(
    `${report.passed ? 'PASS' : 'FAIL'} WP-P2-UX-037 isolated UI checks: ${evidence}\n`,
  );
  process.exitCode = report.passed ? 0 : 1;
}
