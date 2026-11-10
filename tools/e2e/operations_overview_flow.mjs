/** WP-P2-PERF-043: isolated copied Web + read-only loopback API.
 * node tools/e2e/operations_overview_flow.mjs
 * Existing installed browser only. No real DB, credentials, or business writes.
 */
/* global document, window, getComputedStyle */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
const baselineRef = 'be2feee';
const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' })
  .format(new Date())
  .replaceAll('-', '');
const evidence = join(
  root,
  'evidence',
  'WP-P2-PERF-043',
  day,
  `ui-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}`,
);
const org = '04000000-0000-4000-8000-000000000001';
const agent = '04000000-0000-4000-8000-000000000002';
const requester = '04000000-0000-4000-8000-000000000003';
const group = '04000000-0000-4000-8000-000000000004';
const missingGroup = '04000000-0000-4000-8000-000000000099';
const cookie = 'solvi_session_wp043_synthetic';
const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const openStates = ['new', 'assigned', 'in_progress', 'pending'];
const activeStates = openStates.slice(0, 3);
const tickets = Array.from({ length: 49 }, (_, i) => ({
  id: `04000000-0000-4000-8001-${String(i + 1).padStart(12, '0')}`,
  number: `INC-${String(i + 1).padStart(4, '0')}`,
  subject: `運営確認の問い合わせ ${String(i + 1).padStart(2, '0')}`,
  body: '合成APIによる読取画面検証用です。',
  kind: i % 2 === 0 ? 'incident' : 'request',
  state: i < 34 ? activeStates[i % 3] : i < 47 ? 'pending' : i === 47 ? 'resolved' : 'closed',
  impact: 'medium',
  urgency: 'medium',
  priority: i < 3 ? 'critical' : 'medium',
  assigned: i >= 12,
  assigneeId: i < 12 ? null : i < 21 ? agent : requester,
  assigneeName: i < 12 ? null : i < 21 ? '検証担当者' : '別の検証担当者',
  assigneeGroupId: group,
  assigneeGroupName: '情報システム窓口',
  requesterId: requester,
  requesterName: '検証依頼者',
  createdAt: `2026-10-03T20:${String(59 - i).padStart(2, '0')}:00.123456Z`,
  resolvedAt: null,
  pendingReason: i % 2 ? 'wait_requester' : 'wait_external',
  ...(i === 4
    ? {}
    : {
        sla: {
          remainingSeconds:
            i === 0 ? -3600 : i === 1 ? 0 : i === 2 ? 7200 : i >= 34 && i < 41 ? -600 : null,
          breached: i === 0 || (i >= 34 && i < 41),
        },
      }),
}));
const metrics = [
  { id: 'open', label: '未完了', entries: openStates.map((s) => ['state', s]), total: 47 },
  {
    id: 'unassigned',
    label: '担当者未割当',
    entries: [...openStates.map((s) => ['state', s]), ['assignment', 'unassigned']],
    total: 12,
  },
  {
    id: 'mine',
    label: '自分の担当',
    entries: [...openStates.map((s) => ['state', s]), ['assignment', 'mine']],
    total: 9,
  },
  { id: 'pending', label: '確認・対応待ち', entries: [['state', 'pending']], total: 13 },
  {
    id: 'breached',
    label: '解決期限超過',
    entries: [...openStates.map((s) => ['state', s]), ['sla', 'breached']],
    total: 8,
  },
  {
    id: 'critical',
    label: '最優先',
    entries: [...openStates.map((s) => ['state', s]), ['priority', 'critical']],
    total: 3,
  },
];
const deadlineEntries = [...activeStates.map((s) => ['state', s]), ['sort', 'deadline']];
const report = {
  workPackage: 'WP-P2-PERF-043',
  startedAt: new Date().toISOString(),
  baselineRef,
  fixtureSha256: createHash('sha256')
    .update(JSON.stringify({ tickets, metrics, deadlineEntries }))
    .digest('hex'),
  scope:
    'UI checks of copied Web with loopback synthetic API. No real DB, business writes or backend authorization proof.',
  checks: [],
  apiRequests: [],
  unexpectedRequests: [],
  externalRequests: [],
  mutations: [],
  axe: [],
  snapshots: [],
  cleanup: [],
};
const normalScenario = () => ({
  groups: 'normal',
  errors: {},
  scopes: {},
  empty: false,
  invalidOverview: null,
});
let scenarios = normalScenario(),
  phase = 'after',
  activeCheck = 'startup',
  server,
  apiPort,
  browser,
  context,
  page,
  runtime,
  apiBase;
const sha = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
function git(args) {
  const result = spawnSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Read-only git ${args[0]} failed (${result.status}).`);
  return result.stdout;
}
async function snapshot(directory, label) {
  const files = [];
  async function visit(relative = '') {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (/(?:^|\/)(?:node_modules|\.next)(?:\/|$)/.test(path) || path.endsWith('.tsbuildinfo'))
        continue;
      if (/(?:^|\/)\.env/.test(path))
        throw new Error('A copied Web environment file is not permitted.');
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile())
        files.push({ path: `apps/web/${path}`, sha256: await sha(join(directory, path)) });
    }
  }
  await visit();
  files.sort((a, b) => a.path.localeCompare(b.path));
  const result = {
    label,
    capturedAt: new Date().toISOString(),
    algorithm: 'sha256',
    files,
    manifestSha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    scriptSha256: await sha(fileURLToPath(import.meta.url)),
    lockfileSha256: await sha(join(root, 'package-lock.json')),
  };
  report.snapshots.push(result);
  return result;
}
async function availablePort(port = 0) {
  const guard = createPortGuard();
  return new Promise((resolve, reject) => {
    guard.once('error', reject);
    guard.listen(port, '127.0.0.1', () => {
      const selected = guard.address().port;
      guard.close(() => resolve(selected));
    });
  });
}
async function portAvailable(port) {
  try {
    await availablePort(port);
    return true;
  } catch {
    return false;
  }
}
function respond(res, status, body) {
  res.writeHead(status, {
    'content-type': status < 400 ? 'application/json' : 'application/problem+json',
  });
  res.end(JSON.stringify(body));
}

function querySignature(params) {
  return [...params]
    .filter(([key]) => !['limit', 'group'].includes(key))
    .map(([k, v]) => k + '=' + v)
    .sort()
    .join('&');
}
function metricFor(query) {
  if (query.get('sort') === 'deadline') return 'deadline';
  return (
    metrics.find((m) => querySignature(new URLSearchParams(m.entries)) === querySignature(query))
      ?.id ?? 'unknown'
  );
}
function selectedTickets(query) {
  let result = tickets.filter(
    (t) => !query.getAll('state').length || query.getAll('state').includes(t.state),
  );
  if (query.get('assignment') === 'unassigned') result = result.filter((t) => !t.assigneeId);
  if (query.get('assignment') === 'mine') result = result.filter((t) => t.assigneeId === agent);
  if (query.get('sla') === 'breached') result = result.filter((t) => t.sla?.breached);
  if (query.get('priority')) result = result.filter((t) => t.priority === query.get('priority'));
  if (['ungrouped', missingGroup].includes(query.get('group'))) result = [];
  return result;
}
function fail(res, status) {
  respond(res, status, {
    type: 'about:blank',
    title: 'Synthetic error',
    status,
    detail: 'PRIVATE_BACKEND_DIAGNOSTIC_DO_NOT_RENDER',
  });
}
async function fixture() {
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const role = new RegExp(`${cookie}=([^;]+)`).exec(req.headers.cookie ?? '')?.[1] ?? 'agent';
    const userId = role === 'requester' ? requester : agent;
    const entry = {
      check: activeCheck,
      phase,
      role,
      userId,
      method: req.method,
      path: url.pathname,
      query: [...url.searchParams],
    };
    report.apiRequests.push(entry);
    if (req.method !== 'GET') {
      report.mutations.push(entry);
      return fail(res, 403);
    }
    if (url.pathname === '/auth/me')
      return respond(res, 200, {
        userId,
        organizationId: org,
        roles: role.split(',').map((roleCode) => ({
          roleCode,
          organizationId: roleCode === 'platform_admin' ? null : org,
        })),
      });
    if (url.pathname === '/auth/organizations')
      return respond(res, 200, {
        selected: org,
        organizations: [{ id: org, code: 'synthetic', name: '合成検証組織' }],
      });
    if (url.pathname === '/groups') {
      if (/^\d+$/.test(scenarios.groups)) return fail(res, Number(scenarios.groups));
      return respond(res, 200, {
        items:
          scenarios.groups === 'empty'
            ? []
            : [
                {
                  id: group,
                  code: 'fixture',
                  name: '情報システム窓口',
                  description: null,
                  active: true,
                  memberCount: 1,
                },
              ],
      });
    }
    if (url.pathname === '/tickets/overview') {
      entry.metric = 'overview';
      if (scenarios.errors.overview) return fail(res, scenarios.errors.overview);
      const counts = Object.fromEntries(
        metrics.map((metric) => {
          const query = new URLSearchParams(metric.entries);
          if (url.searchParams.has('group')) query.set('group', url.searchParams.get('group'));
          return [metric.id, scenarios.empty ? 0 : selectedTickets(query).length];
        }),
      );
      const data = {
        scope: scenarios.scopes.overview ?? scenarios.scopes.all ?? 'organization',
        counts,
      };
      if (scenarios.invalidOverview === 'negative') data.counts.open = -1;
      if (scenarios.invalidOverview === 'fraction') data.counts.mine = 0.5;
      if (scenarios.invalidOverview === 'missing') delete data.counts.critical;
      if (scenarios.invalidOverview === 'string') data.counts.breached = '8';
      if (scenarios.invalidOverview === 'unsafe') data.counts.pending = Number.MAX_SAFE_INTEGER + 1;
      if (scenarios.invalidOverview === 'null') return respond(res, 200, null);
      return respond(res, 200, data);
    }
    if (url.pathname === '/tickets') {
      const metric = metricFor(url.searchParams);
      entry.metric = metric;
      if (scenarios.errors[metric]) return fail(res, scenarios.errors[metric]);
      const selected = scenarios.empty ? [] : selectedTickets(url.searchParams);
      const limit = Number(url.searchParams.get('limit') ?? 50),
        items = selected.slice(0, limit);
      return respond(res, 200, {
        items,
        total: selected.length,
        scope: scenarios.scopes[metric] ?? scenarios.scopes.all ?? 'organization',
        appliedFilter: Object.fromEntries(url.searchParams),
        nextCursor: null,
      });
    }
    const match = /^\/tickets\/([^/]+)\/(workspace|relations|assets|changes)$/.exec(url.pathname);
    if (match) {
      const ticket = tickets.find((t) => t.id === match[1]);
      if (!ticket) return fail(res, 404);
      if (match[2] === 'workspace')
        return respond(res, 200, {
          ticket: { ...ticket, version: '1' },
          replyContext: { ticketVersion: '1', latestCommentId: null },
          comments: [],
          attachments: [],
          availableActions: [],
          priorityIsDerived: true,
          availableGroups: [{ id: group, code: 'fixture', name: '情報システム窓口' }],
          sla: {
            elapsedSeconds: 3600,
            responseTargetSeconds: 3600,
            resolutionTargetSeconds: 7200,
            responseBreached: false,
            resolutionBreached: false,
            remainingSeconds: 3600,
          },
        });
      if (match[2] === 'relations') return respond(res, 200, { items: [], unresolvedChildren: [] });
      if (match[2] === 'assets')
        return respond(res, 200, { canManage: false, items: [], history: [] });
      return respond(res, 200, { canCreate: false, items: [] });
    }
    if (url.pathname === '/knowledge') return respond(res, 200, { items: [] });
    report.unexpectedRequests.push(entry);
    return fail(res, 404);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  apiPort = server.address().port;
  apiBase = `http://127.0.0.1:${apiPort}`;
}
async function startWeb(label) {
  const temp = await mkdtemp(join(tmpdir(), 'solvi-wp043-'));
  try {
    let webDir;
    if (label === 'before') {
      const archive = git(['archive', '--format=tar', baselineRef, 'apps/web']);
      const extraction = spawnSync('tar', ['-xf', '-', '-C', temp], { input: archive });
      if (extraction.status !== 0) throw new Error('Immutable baseline extraction failed.');
      webDir = join(temp, 'apps/web');
      report.baselineCommit = git(['rev-parse', baselineRef]).toString().trim();
    } else {
      webDir = join(temp, 'web');
      await cp(join(root, 'apps/web'), webDir, {
        recursive: true,
        errorOnExist: true,
        force: false,
        filter: (path) =>
          !/(?:^|\/)(?:node_modules|\.next|\.env[^/]*)(?:\/|$)/.test(path) &&
          !path.endsWith('.tsbuildinfo'),
      });
    }
    const source = await snapshot(webDir, label);
    await symlink(join(root, 'node_modules'), join(webDir, 'node_modules'), 'dir');
    const port = await availablePort();
    const env = Object.fromEntries(
      ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ']
        .filter((key) => process.env[key])
        .map((key) => [key, process.env[key]]),
    );
    const child = spawn(
      process.execPath,
      [
        join(root, 'node_modules/next/dist/bin/next'),
        'dev',
        '--hostname',
        '127.0.0.1',
        '--port',
        String(port),
      ],
      {
        cwd: webDir,
        env: {
          ...env,
          NODE_ENV: 'development',
          NEXT_TELEMETRY_DISABLED: '1',
          API_BASE_URL: apiBase,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    runtime = { temp, port, child, source, label, base: `http://127.0.0.1:${port}`, log: '' };
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (value) => {
        runtime.log = (runtime.log + value.toString()).slice(-20000);
      });
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null)
        throw new Error(`Isolated ${label} Web exited (${child.exitCode}).`);
      try {
        if ((await fetch(`${runtime.base}/ops/overview`, { signal: AbortSignal.timeout(5000) })).ok)
          break;
      } catch {
        /* starting */
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'ja-JP' });
    await context.route('**/*', (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (!['data:', 'blob:', 'about:'].includes(url.protocol) && url.origin !== runtime.base) {
        report.externalRequests.push({ method: request.method(), url: url.origin + url.pathname });
        return route.abort();
      }
      return route.continue();
    });
    await context.addCookies([
      { name: cookie, value: 'agent', url: runtime.base, httpOnly: true, sameSite: 'Lax' },
    ]);
    page = await context.newPage();
    page.setDefaultTimeout(10000);
  } catch (error) {
    // Before the child is registered, the temporary copy is still owned here.
    // Once registered, stopWeb handles the process and its temporary directory.
    if (!runtime || runtime.temp !== temp) {
      await rm(temp, { recursive: true, force: true });
      report.cleanup.push({
        phase: label,
        startupFailedBeforeProcessRegistration: true,
        processExited: true,
        port: null,
        portAvailable: true,
        temporaryDirectoryRemoved: await access(temp).then(
          () => false,
          (failure) => failure.code === 'ENOENT',
        ),
      });
    }
    throw error;
  }
}
async function stopWeb() {
  if (!runtime) return;
  const owned = runtime;
  await context?.close();
  if (owned.child.exitCode === null && owned.child.signalCode === null) {
    owned.child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => owned.child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 4000)),
    ]);
    if (owned.child.exitCode === null && owned.child.signalCode === null) {
      owned.child.kill('SIGKILL');
      await new Promise((resolve) => owned.child.once('exit', resolve));
    }
  }
  if (owned.label === 'after') {
    const matches = await Promise.all(
      owned.source.files.map(async (file) => (await sha(join(root, file.path))) === file.sha256),
    );
    owned.source.currentMatchesCopied =
      matches.every(Boolean) &&
      (await sha(fileURLToPath(import.meta.url))) === owned.source.scriptSha256;
  } else {
    owned.source.baselineMatchesArchive = owned.source.files.every(
      (file) =>
        createHash('sha256')
          .update(git(['show', `${baselineRef}:${file.path}`]))
          .digest('hex') === file.sha256,
    );
  }
  await rm(owned.temp, { recursive: true, force: true });
  report.cleanup.push({
    phase: owned.label,
    processExited: owned.child.exitCode !== null || owned.child.signalCode !== null,
    port: owned.port,
    portAvailable: await portAvailable(owned.port),
    temporaryDirectoryRemoved: await access(owned.temp).then(
      () => false,
      (error) => error.code === 'ENOENT',
    ),
  });
  if (report.checks.some((item) => !item.passed))
    await writeFile(join(evidence, `isolated-${owned.label}-web.log`), owned.log);
  runtime = null;
}

async function open(path = '/ops/overview') {
  await page.goto(runtime.base + path, { waitUntil: 'networkidle' });
}
async function visible(locator) {
  await locator.waitFor({ state: 'visible', timeout: 10000 });
}
async function capture(name, axe = true, fullPage = true) {
  await page.screenshot({ path: join(evidence, `${name}.png`), fullPage });
  if (axe) {
    const result = await new AxeBuilder({ page }).withTags(tags).analyze();
    await writeFile(join(evidence, `${name}-axe.json`), JSON.stringify(result, null, 2));
    report.axe.push({
      name,
      violations: result.violations.map(({ id, impact, nodes }) => ({
        id,
        impact,
        count: nodes.length,
      })),
    });
    assert.equal(result.violations.length, 0, `${name} axe violations`);
  }
}

async function tabTo(locator) {
  for (let i = 0; i < 100; i++) {
    await page.keyboard.press('Tab');
    if (await locator.evaluate((element) => document.activeElement === element)) return;
  }
  throw new Error('Tab did not reach the target control.');
}

async function check(name, run) {
  activeCheck = name;
  try {
    await run();
    report.checks.push({ name, passed: true });
  } catch (error) {
    report.checks.push({ name, passed: false, error: String(error.message) });
    await page
      ?.screenshot({
        path: join(evidence, `overview-failure-${report.checks.length}.png`),
        fullPage: true,
      })
      .catch(() => {});
  }
  process.stdout.write(`${report.checks.at(-1).passed ? 'PASS' : 'FAIL'} ${name}\n`);
  scenarios = normalScenario();
  await setRole('agent');
}
function requestsSince(start, path) {
  return report.apiRequests.slice(start).filter((r) => r.path === path);
}
function hrefPath(href) {
  const url = new URL(href, runtime.base);
  return url.pathname + url.search;
}
async function setRole(role) {
  await context.addCookies([
    { name: cookie, value: role, url: runtime.base, httpOnly: true, sameSite: 'Lax' },
  ]);
}
async function runChecks() {
  await check('desktop shows six API totals and first deadline row within 1280x720', async () => {
    const start = report.apiRequests.length;
    await open();
    await ready();
    for (const metric of metrics)
      assert.equal(
        await metricCard(metric.id).locator('.overview-count').innerText(),
        String(metric.total),
      );
    assert.equal(await metricCard('breached').getAttribute('data-overdue'), 'true');
    assert.equal(requestsSince(start, '/tickets').length, 1);
    assert.equal(requestsSince(start, '/tickets/overview').length, 1);
    assert.equal(requestsSince(start, '/groups').length, 1);
    const ticketsCalls = requestsSince(start, '/tickets');
    equalQuery(
      new URLSearchParams(requestsSince(start, '/tickets/overview')[0].query),
      new URLSearchParams(),
    );
    const deadline = ticketsCalls.find((r) => r.metric === 'deadline');
    equalQuery(
      new URLSearchParams(deadline.query),
      new URLSearchParams([...deadlineEntries, ['limit', '5']]),
    );
    report.initialCalls = { tickets: 1, overview: 1, groups: 1, deadlineItemLimit: 5 };
    const geometry = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      scale: window.visualViewport?.scale,
      counts: [...document.querySelectorAll('.overview-count')].map((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, text: el.textContent };
      }),
      firstRow: (() => {
        const r = document
          .querySelector('.overview-deadline-table tbody tr')
          ?.getBoundingClientRect();
        return r ? { top: r.top, bottom: r.bottom } : null;
      })(),
    }));
    report.desktop = geometry;
    assert.equal(geometry.scale, 1);
    assert.equal(geometry.counts.length, 6);
    assert(geometry.counts.every((r) => r.top >= 0 && r.bottom <= 720));
    assert(
      geometry.firstRow && geometry.firstRow.top >= 0 && geometry.firstRow.bottom <= 720,
      'complete first deadline row visible',
    );
    const callsBeforeWait = report.apiRequests.length;
    await page.waitForTimeout(1600);
    assert.equal(report.apiRequests.length, callsBeforeWait);
    report.noPollingObservationMs = 1600;
    await capture('overview-desktop', true, false);
  });
  await check('staff ops entry and sidebar have one active location', async () => {
    for (const role of ['agent', 'org_admin', 'platform_admin']) {
      await setRole(role);
      await open('/ops');
      await visible(page.getByRole('heading', { name: '問い合わせの一覧', exact: true }));
      await page.locator('main').getByRole('link', { name: '運営状況', exact: true }).click();
      await ready();
      assert.equal(await page.locator('.app-navigation a[aria-current="page"]').count(), 1);
      assert.equal(
        await page.locator('.app-navigation a[aria-current="page"]').getAttribute('href'),
        '/ops/overview',
      );
      assert.equal(
        await page
          .getByRole('navigation', { name: '現在地', exact: true })
          .locator('[aria-current="page"]')
          .innerText(),
        '運営状況',
      );
      await page.locator('.app-navigation a[href="/ops"]').click();
      await visible(page.getByRole('heading', { name: '問い合わせの一覧', exact: true }));
      assert.equal(await page.locator('.app-navigation a[aria-current="page"]').count(), 1);
      assert.equal(
        await page.locator('.app-navigation a[aria-current="page"]').getAttribute('href'),
        '/ops',
      );
      await page.locator('.app-navigation a[href="/ops/overview"]').click();
      await ready();
    }
    await setRole('agent');
  });
  await check('requester, approver and auditor cannot trigger aggregate API calls', async () => {
    for (const role of ['requester', 'approver', 'auditor']) {
      await setRole(role);
      const start = report.apiRequests.length;
      await open();
      await visible(page.locator('main').getByRole('alert'));
      assert.match(await page.locator('main').getByRole('alert').innerText(), /権限がありません/);
      assert.equal(requestsSince(start, '/tickets').length, 0);
      assert.equal(requestsSince(start, '/tickets/overview').length, 0);
      assert.equal(requestsSince(start, '/groups').length, 0);
      assert.equal(await page.locator('.overview-count').count(), 0);
      assert.equal(await deadlineRows().count(), 0);
      assert.equal(await page.locator('.app-navigation a[href="/ops/overview"]').count(), 0);
    }
    await capture('overview-role-denied');
    await setRole('agent');
  });
  await check(
    'one aggregate API group and each drilldown preserve only allowed URL conditions',
    async () => {
      for (const metric of metrics) {
        const start = report.apiRequests.length;
        await open(
          '/ops/overview?group=' +
            group +
            '&state=closed&requester=' +
            requester +
            '&organizationId=' +
            requester +
            '&limit=999&sort=newest&unknown=discard',
        );
        await ready();
        const expected = new URLSearchParams([['group', group], ...metric.entries]);
        const aggregateCalls = requestsSince(start, '/tickets/overview');
        assert.equal(aggregateCalls.length, 1);
        const apiCall = aggregateCalls[0];
        assert(apiCall);
        equalQuery(new URLSearchParams(apiCall.query), new URLSearchParams([['group', group]]));
        const link = metricCard(metric.id).getByRole('link');
        const href = new URL(await link.getAttribute('href'), runtime.base);
        assert.equal(href.pathname, '/ops');
        equalQuery(href.searchParams, expected);
        await link.click();
        await visible(page.getByRole('heading', { name: '問い合わせの一覧', exact: true }));
        await page.waitForLoadState('networkidle');
        const drill = report.apiRequests.findLast(
          (r) => r.check === activeCheck && r.path === '/tickets',
        );
        equalQuery(
          new URLSearchParams(drill.query),
          new URLSearchParams([...expected, ['limit', '50']]),
        );
      }
    },
  );
  await check(
    'group all, mine, ungrouped and known selections preserve scope on history/reload',
    async () => {
      await open();
      await ready();
      const form = rangeForm();
      report.groupNavigation = [];
      for (const selected of ['mine', 'ungrouped', group, '']) {
        await form.getByLabel('担当グループ', { exact: true }).selectOption(selected);
        report.groupNavigation.push({
          stage: 'before submit',
          selected,
          url: hrefPath(page.url()),
          value: await form.getByLabel('担当グループ', { exact: true }).inputValue(),
        });
        const start = report.apiRequests.length;
        await form.getByRole('button', { name: '範囲を適用', exact: true }).click();
        await page.waitForURL((url) => (url.searchParams.get('group') ?? '') === selected);
        await page.waitForLoadState('networkidle');
        await visible(page.locator('.overview-count').first());
        assert.equal(await form.getByLabel('担当グループ', { exact: true }).inputValue(), selected);
        report.groupNavigation.push({
          stage: 'after submit',
          selected,
          url: hrefPath(page.url()),
          value: await form.getByLabel('担当グループ', { exact: true }).inputValue(),
        });
        const calls = [
          ...requestsSince(start, '/tickets'),
          ...requestsSince(start, '/tickets/overview'),
        ];
        assert.equal(calls.length, 2);
        for (const call of calls)
          assert.equal(new URLSearchParams(call.query).get('group'), selected || null);
        await page.reload({ waitUntil: 'networkidle' });
        assert.equal(await form.getByLabel('担当グループ', { exact: true }).inputValue(), selected);
      }
      await page.goBack({ waitUntil: 'networkidle' });
      await groupSelectionMatches(group, '情報システム窓口');
      report.groupNavigation.push({
        stage: 'after history back',
        selected: group,
        url: hrefPath(page.url()),
        value: await form.getByLabel('担当グループ', { exact: true }).inputValue(),
      });
      assert.equal(await form.getByLabel('担当グループ', { exact: true }).inputValue(), group);
      await page.goForward({ waitUntil: 'networkidle' });
      await groupSelectionMatches('', '組織全体');
      report.groupNavigation.push({
        stage: 'after history forward',
        selected: '',
        url: hrefPath(page.url()),
        value: await form.getByLabel('担当グループ', { exact: true }).inputValue(),
      });
      await page.getByRole('link', { name: '範囲を解除', exact: true }).click();
      await page.waitForURL((url) => url.pathname === '/ops/overview' && !url.search);
      await ready();
    },
  );
  await check(
    'unknown valid group and group lookup errors never widen requested scope',
    async () => {
      for (const selected of [missingGroup, group]) {
        scenarios.groups = selected === missingGroup ? 'normal' : '503';
        const start = report.apiRequests.length;
        await open('/ops/overview?group=' + selected);
        assert.equal(
          await rangeForm().getByLabel('担当グループ', { exact: true }).inputValue(),
          selected,
        );
        await visible(
          page.getByText('指定したグループの名称を確認できません。範囲はそのまま保持しています。', {
            exact: true,
          }),
        );
        for (const request of requestsSince(start, '/tickets'))
          assert.equal(new URLSearchParams(request.query).get('group'), selected);
        for (const metric of metrics)
          assert.equal(
            new URL(
              await metricCard(metric.id).getByRole('link').getAttribute('href'),
              runtime.base,
            ).searchParams.get('group'),
            selected,
          );
        if (selected === group) {
          await capture('overview-group-error');
          scenarios.groups = 'normal';
          const count = report.apiRequests.length;
          await page.getByRole('link', { name: 'グループ名を再読み込み', exact: true }).click();
          await page.waitForLoadState('networkidle');
          assert(requestsSince(count, '/groups').length > 0);
          assert.equal(new URL(page.url()).searchParams.get('group'), group);
          await visible(
            page
              .getByRole('region', { name: '現在の件数' })
              .getByText('情報システム窓口', { exact: true }),
          );
        }
      }
      scenarios.groups = '403';
      await open('/ops/overview?group=mine');
      await visible(page.getByText(/グループ名を表示する権限がありません/));
      assert.equal(
        await rangeForm().getByLabel('担当グループ', { exact: true }).inputValue(),
        'mine',
      );
      await visible(metricCard('open').locator('.overview-count'));
    },
  );
  await check(
    'invalid and duplicate group values block aggregates and stay available for correction',
    async () => {
      for (const values of [['not-a-uuid'], [group, 'mine']]) {
        const params = new URLSearchParams();
        values.forEach((value) => params.append('group', value));
        const start = report.apiRequests.length;
        await open('/ops/overview?' + params);
        await visible(
          page.getByRole('heading', { name: '表示範囲を確認してください', exact: true }),
        );
        assert.equal(requestsSince(start, '/tickets').length, 0);
        assert.equal(requestsSince(start, '/tickets/overview').length, 0);
        assert.equal(await page.locator('.overview-count').count(), 0);
        assert.equal(
          await rangeForm().getByLabel('担当グループ', { exact: true }).inputValue(),
          values[0],
        );
        assert.equal(
          await rangeForm()
            .getByLabel('担当グループ', { exact: true })
            .getAttribute('aria-invalid'),
          'true',
        );
        for (const value of values)
          assert((await page.locator('main').innerText()).includes(value));
      }
      await capture('overview-invalid-group');
      await rangeForm().getByLabel('担当グループ', { exact: true }).selectOption('mine');
      await rangeForm().getByRole('button', { name: '範囲を適用', exact: true }).click();
      await page.waitForURL(
        (url) =>
          url.searchParams.getAll('group').length === 1 && url.searchParams.get('group') === 'mine',
      );
      await ready();
    },
  );
  await check(
    'scope=own is never displayed as organization metrics or deadline items',
    async () => {
      scenarios.scopes = { overview: 'own', deadline: 'own' };
      await open();
      await visible(metricSection().getByRole('alert'));
      assert.equal(await metricCard('open').locator('.overview-count').count(), 0);
      assert.equal(await deadlineRows().count(), 0);
      assert.equal(await page.locator('.overview-count').count(), 0);
      await visible(deadlineSection().getByRole('alert'));
      await capture('overview-scope-mismatch');
      scenarios.scopes = { all: 'own' };
      await open();
      assert.equal(await page.locator('.overview-count').count(), 0);
      assert.equal(await deadlineRows().count(), 0);
      assert(!/運営確認の問い合わせ/.test(await page.locator('main').innerText()));
    },
  );
  await check(
    'deadline five rows preserve API order and distinguish absent/null/zero/negative SLA',
    async () => {
      const start = report.apiRequests.length;
      await open();
      await ready();
      const call = requestsSince(start, '/tickets').find((r) => r.metric === 'deadline');
      assert(call);
      const query = new URLSearchParams(call.query);
      assert.deepEqual(query.getAll('state'), activeStates);
      assert.equal(query.get('sort'), 'deadline');
      assert.equal(query.get('limit'), '5');
      assert.equal(await deadlineRows().count(), 5);
      for (let i = 0; i < 5; i++)
        assert((await deadlineRows().nth(i).innerText()).includes(tickets[i].number));
      const expected = ['1時間超過', '期限到達', 'あと2時間', '目標未設定', '目標未設定'];
      for (let i = 0; i < 5; i++)
        assert.equal(await deadlineRows().nth(i).locator('td').nth(1).innerText(), expected[i]);
      report.deadlineSlaLabels = expected;
      assert.match(
        await deadlineSection().getByRole('status').innerText(),
        /対象 34件.*先頭5件.*最大5件/,
      );
      assert.match(await deadlineSection().innerText(), /確認・対応待ち.*含みません/s);
      assert.match(await deadlineSection().innerText(), /最大50件/);
      assert.equal(
        await deadlineSection()
          .getByRole('link', { name: /次のページ/ })
          .count(),
        0,
      );
      const link = deadlineSection().getByRole('link', { name: '期限順の一覧を見る', exact: true });
      equalQuery(
        new URL(await link.getAttribute('href'), runtime.base).searchParams,
        new URLSearchParams(deadlineEntries),
      );
      await link.click();
      await visible(page.getByRole('heading', { name: '問い合わせの一覧', exact: true }));
      await page.waitForFunction(
        () => document.querySelectorAll('table.tickets tbody tr').length === 34,
      );
      for (let i = 0; i < 5; i++)
        assert(
          (await page.locator('table.tickets tbody tr').nth(i).innerText()).includes(expected[i]),
        );
      assert(!/あと1分/.test(await page.locator('table.tickets tbody tr').nth(3).innerText()));
      await capture('ops-sla-null-zero');
      await open('/ops?state=pending');
      await page.waitForFunction(
        () => document.querySelectorAll('table.tickets tbody tr').length === 13,
      );
      assert(
        (await page.locator('table.tickets tbody tr').nth(7).innerText()).includes(
          'SLA停止 · 目標未設定',
        ),
      );
    },
  );
  await check(
    'deadline detail returnTo excludes unknown keys and returns selected group',
    async () => {
      await open('/ops/overview?group=' + group + '&requester=' + requester + '&unknown=discard');
      await ready();
      const link = page.locator('.overview-ticket a').first();
      const expected = '/ops/overview?group=' + group;
      assert.equal(
        new URL(await link.getAttribute('href'), runtime.base).searchParams.get('returnTo'),
        expected,
      );
      await link.click();
      await visible(page.getByRole('heading', { name: tickets[0].subject, exact: true }));
      await page.getByRole('link', { name: '元の画面へ戻る', exact: true }).click();
      await ready();
      assert.equal(hrefPath(page.url()), expected);
      await page.reload({ waitUntil: 'networkidle' });
      await ready();
      assert.equal(
        await rangeForm().getByLabel('担当グループ', { exact: true }).inputValue(),
        group,
      );
    },
  );
  await check(
    'aggregate 400/403/503 fails all counts while deadlines and groups survive',
    async () => {
      for (const status of [400, 403, 503]) {
        scenarios.errors = { overview: status };
        await open('/ops/overview?group=mine');
        await visible(metricSection().getByRole('alert'));
        assert.equal(await page.locator('.overview-count').count(), 0);
        assert.equal(await page.locator('.overview-metric').count(), 6);
        assert.equal(await metricSection().getByRole('alert').count(), 1);
        assert.equal(await deadlineRows().count(), 5);
        assert.match(
          await metricSection().getByRole('alert').innerText(),
          status === 403 ? /権限/ : status === 400 ? /表示範囲/ : /取得できません/,
        );
        assert.equal(
          await rangeForm().getByLabel('担当グループ', { exact: true }).inputValue(),
          'mine',
        );
        assert(!/PRIVATE_BACKEND_DIAGNOSTIC/.test(await page.locator('main').innerText()));
      }
      await capture('overview-metric-error');
      const before = report.apiRequests.length;
      scenarios.errors = {};
      await page.getByRole('link', { name: '運営状況を再読み込み', exact: true }).click();
      await ready();
      assert.equal(new URL(page.url()).searchParams.get('group'), 'mine');
      assert.equal(requestsSince(before, '/tickets').length, 1);
      assert.equal(requestsSince(before, '/tickets/overview').length, 1);
      assert.equal(await page.locator('.overview-count').count(), 6);
    },
  );
  await check('HTTP200 invalid aggregate DTO never becomes a zero or partial count', async () => {
    for (const invalid of ['negative', 'fraction', 'missing', 'string', 'unsafe', 'null']) {
      scenarios.invalidOverview = invalid;
      await open();
      await visible(metricSection().getByRole('alert'));
      assert.equal(await page.locator('.overview-count').count(), 0);
      assert.equal(await deadlineRows().count(), 5);
      assert.equal(await page.locator('.overview-metric').count(), 6);
    }
    await capture('overview-invalid-response');
  });
  await check(
    'deadline 403/503 keeps metric successes and retries the selected scope',
    async () => {
      for (const status of [403, 503]) {
        scenarios.errors = { deadline: status };
        await open('/ops/overview?group=' + group);
        await visible(deadlineSection().getByRole('alert'));
        assert.equal(await deadlineRows().count(), 0);
        assert.equal(await page.locator('.overview-count').count(), 6);
        assert.match(
          await deadlineSection().getByRole('alert').innerText(),
          status === 403 ? /権限/ : /取得できません/,
        );
      }
      await capture('overview-deadline-error');
      scenarios.errors = {};
      const before = report.apiRequests.length;
      await page.getByRole('link', { name: '期限一覧を再読み込み', exact: true }).click();
      await ready();
      assert.equal(new URL(page.url()).searchParams.get('group'), group);
      assert.equal(requestsSince(before, '/tickets').length, 1);
      assert.equal(requestsSince(before, '/tickets/overview').length, 1);
    },
  );
  await check('genuine zero counts and empty deadlines remain distinct from errors', async () => {
    scenarios.empty = true;
    await open();
    assert.equal(await page.locator('.overview-count').count(), 6);
    for (const metric of metrics)
      assert.equal(await metricCard(metric.id).locator('.overview-count').innerText(), '0');
    assert.equal(await metricCard('breached').getAttribute('data-overdue'), null);
    assert.equal(await page.locator('main').getByRole('alert').count(), 0);
    await visible(
      page.getByRole('heading', { name: 'この範囲に対応中の問い合わせはありません', exact: true }),
    );
    assert.match(await deadlineSection().getByRole('status').innerText(), /対象 0件.*先頭0件/);
    await capture('overview-empty');
  });
  await check(
    'keyboard applies group, opens definitions and follows metric with visible focus',
    async () => {
      await open();
      await ready();
      const groupSelect = rangeForm().getByLabel('担当グループ', { exact: true });
      await tabTo(groupSelect);
      // macOS headless Chromium does not commit popup-arrow selection. Send a
      // native Japanese character key for the select's standard type-ahead.
      // This is a browser keyboard event, never a DOM value/selectOption change.
      const keyboardSession = await context.newCDPSession(page);
      await keyboardSession.send('Input.dispatchKeyEvent', {
        type: 'char',
        text: '自',
        unmodifiedText: '自',
      });
      await keyboardSession.detach();
      assert.equal(await groupSelect.inputValue(), 'mine');
      const selectionProof = await groupSelect.evaluate((el) => ({
        value: el.value,
        selectedIndex: el.selectedIndex,
        focused: document.activeElement === el,
      }));
      await page.keyboard.press('Tab');
      const submit = rangeForm().getByRole('button', { name: '範囲を適用', exact: true });
      assert(await submit.evaluate((el) => document.activeElement === el));
      await page.keyboard.press('Enter');
      await page.waitForURL((url) => url.searchParams.get('group') === 'mine');
      await page.waitForLoadState('networkidle');
      await ready();
      const summary = page.locator('.overview-definitions summary');
      await tabTo(summary);
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('.overview-definitions').getAttribute('open'), '');
      await visible(page.getByText(/6項目は同じ時点の問い合わせをまとめて集計した現在件数/));
      const link = metricCard('open').getByRole('link');
      await tabTo(link);
      const focus = await link.evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          active: document.activeElement === el,
          outlineStyle: s.outlineStyle,
          outlineWidth: s.outlineWidth,
          boxShadow: s.boxShadow,
        };
      });
      assert(
        focus.active &&
          ((focus.outlineStyle !== 'none' && parseFloat(focus.outlineWidth) > 0) ||
            focus.boxShadow !== 'none'),
      );
      report.keyboard = {
        keys: [
          'Tab',
          '自 (native character type-ahead)',
          'Tab',
          'Enter',
          'Tab',
          'Enter',
          'Tab',
          'Enter',
        ],
        selectionMethod: 'CDP Input.dispatchKeyEvent(char), with no DOM mutation',
        selectionProof,
        focus,
      };
      await capture('overview-keyboard-focus', false, false);
      await page.keyboard.press('Enter');
      await visible(page.getByRole('heading', { name: '問い合わせの一覧', exact: true }));
      assert.equal(new URL(page.url()).searchParams.get('group'), 'mine');
    },
  );
  await check(
    '390px metrics and local table scroll never overflow the page and pass axe',
    async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await open();
      await ready();
      const bounds = await mobileGeometry();
      assert(bounds.document <= 390, JSON.stringify(bounds));
      report.mobile = { collapsed: bounds };
      await capture('overview-mobile');
      await page.locator('.overview-definitions summary').click();
      const expanded = await mobileGeometry();
      assert(expanded.document <= 390, JSON.stringify(expanded));
      report.mobile.expanded = expanded;
      await capture('overview-mobile-definitions');
      await page.setViewportSize({ width: 1280, height: 720 });
    },
  );
}
const metricCard = (id) => page.locator('.overview-metric[data-metric="' + id + '"]');
const metricSection = () => page.getByRole('region', { name: '現在の件数', exact: true });
const rangeForm = () => page.getByRole('form', { name: '運営状況の表示範囲' });
const deadlineSection = () => page.getByRole('region', { name: '解決期限の確認', exact: true });
const deadlineRows = () => page.locator('.overview-deadline-table tbody tr');
async function ready() {
  await visible(page.getByRole('heading', { name: '運営状況', exact: true }));
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.overview-count').length === 6 &&
      document.querySelectorAll('.overview-deadline-table tbody tr').length === 5,
  );
}
function equalQuery(actual, expected) {
  const sorted = (p) => [...p].map(([k, v]) => k + '=' + v).sort();
  assert.deepEqual(sorted(actual), sorted(expected));
}
async function mobileGeometry() {
  return page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    table: document.querySelector('.overview-deadline-table')?.getBoundingClientRect().width,
    region: (() => {
      const e = document.querySelector('.overview-deadline-table')?.closest('[role="region"]');
      return e ? { client: e.clientWidth, scroll: e.scrollWidth } : null;
    })(),
  }));
}
async function groupSelectionMatches(value, scope) {
  await page.waitForFunction((expected) => {
    const current = new URL(window.location.href).searchParams.get('group') ?? '';
    const select = document.querySelector('#overview-group');
    return current === expected && select?.value === expected;
  }, value);
  await visible(page.getByRole('region', { name: '現在の件数' }).getByText(scope, { exact: true }));
}
try {
  await access(chromium.executablePath()).catch(() => {
    throw new Error('Installed Chromium required; no automatic install permitted.');
  });
  await mkdir(evidence, { recursive: true });
  await fixture();
  browser = await chromium.launch();
  phase = 'before';
  await startWeb('before');
  await check(
    'immutable baseline uses six counts and one deadline list with identical fixture',
    async () => {
      const start = report.apiRequests.length;
      await open();
      await ready();
      assert.equal(requestsSince(start, '/tickets').length, 7);
      assert.equal(requestsSince(start, '/tickets/overview').length, 0);
      assert.equal(requestsSince(start, '/groups').length, 1);
      for (const metric of metrics) {
        assert.equal(
          await metricCard(metric.id).locator('.overview-count').innerText(),
          String(metric.total),
        );
        const calls = requestsSince(start, '/tickets').filter((r) => r.metric === metric.id);
        assert.equal(calls.length, 1);
        equalQuery(
          new URLSearchParams(calls[0].query),
          new URLSearchParams([...metric.entries, ['limit', '1']]),
        );
      }
      report.beforeCalls = { tickets: 7, groups: 1, metricItemLimit: 1, deadlineItemLimit: 5 };
      await capture('overview-before-desktop', true, false);
    },
  );
  await stopWeb();
  phase = 'after';
  await startWeb('after');
  await runChecks();
} catch (error) {
  report.checks.push({ name: 'runner', passed: false, error: String(error.stack ?? error) });
} finally {
  await stopWeb().catch((error) =>
    report.checks.push({ name: 'Web cleanup', passed: false, error: String(error.message) }),
  );
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  report.apiCleanup = {
    closed: !server?.listening,
    port: apiPort ?? null,
    available: apiPort ? await portAvailable(apiPort) : true,
  };
  report.checks.push({
    name: 'owned resources closed and copied source unchanged',
    passed:
      report.cleanup.every(
        (i) => i.processExited && i.portAvailable && i.temporaryDirectoryRemoved,
      ) &&
      report.apiCleanup.closed &&
      report.apiCleanup.available &&
      report.snapshots.every((i) =>
        i.label === 'before' ? i.baselineMatchesArchive : i.currentMatchesCopied,
      ),
  });
  report.checks.push({
    name: 'no business writes, unexpected endpoints or external browser requests',
    passed:
      report.mutations.length === 0 &&
      report.unexpectedRequests.length === 0 &&
      report.externalRequests.length === 0,
  });
  report.finishedAt = new Date().toISOString();
  report.passed = report.checks.every((i) => i.passed);
  await mkdir(evidence, { recursive: true });
  await writeFile(
    join(evidence, 'operations-overview-report.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  await writeFile(
    join(evidence, 'operations-overview-source-manifest.json'),
    JSON.stringify(report.snapshots, null, 2) + '\n',
  );
  process.stdout.write(
    `${report.passed ? 'PASS' : 'FAIL'} WP-P2-PERF-043 isolated UI: ${evidence}\n`,
  );
  process.exitCode = report.passed ? 0 : 1;
}
