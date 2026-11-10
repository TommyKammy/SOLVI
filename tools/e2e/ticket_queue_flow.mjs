/** WP-P2-UX-038: isolated Web + read-only synthetic API. No real DB or account.
 * node tools/e2e/ticket_queue_flow.mjs [--baseline-only]
 * Baseline Web is always extracted from immutable commit e60131f without checkout.
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
const baselineRef = 'e60131f';
const baselineOnly = process.argv.includes('--baseline-only');
const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' })
  .format(new Date())
  .replaceAll('-', '');
const evidence = join(root, 'evidence', 'WP-P2-UX-038', day);
const org = '03800000-0000-4000-8000-000000000001';
const agent = '03800000-0000-4000-8000-000000000002';
const requester = '03800000-0000-4000-8000-000000000003';
const group = '03800000-0000-4000-8000-000000000004';
const missingGroup = '03800000-0000-4000-8000-000000000099';
const cookie = 'solvi_session_wp038_synthetic';
const states = ['new', 'assigned', 'in_progress', 'pending', 'resolved', 'closed'];
const priorities = ['critical', 'high', 'medium', 'low'];
const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const tickets = Array.from({ length: 61 }, (_, index) => ({
  id: `03800000-0000-4000-8001-${String(index + 1).padStart(12, '0')}`,
  number: `INC-${String(index + 1).padStart(4, '0')}`,
  subject: `合成問い合わせ ${String(index + 1).padStart(2, '0')}`,
  body: '外部接続を伴わない合成チケットです。',
  kind: index % 2 === 0 ? 'incident' : 'request',
  state: states[index % states.length],
  impact: 'medium',
  urgency: 'medium',
  priority: priorities[index % priorities.length],
  createdAt: `2026-10-03T${String(20 - Math.floor(index / 60)).padStart(2, '0')}:${String(59 - (index % 60)).padStart(2, '0')}:00.123456Z`,
  resolvedAt: null,
  assigned: index % 3 !== 0,
  assigneeId: index % 3 === 0 ? null : index % 3 === 1 ? agent : requester,
  assigneeName: index % 3 === 0 ? null : '検証担当者',
  assigneeGroupId: index % 5 === 0 ? null : group,
  assigneeGroupName: index % 5 === 0 ? null : '検証窓口',
  requesterId: index % 2 === 0 ? requester : agent,
  requesterName: '検証依頼者',
  pendingReason: index % 2 === 0 ? 'wait_requester' : 'wait_external',
  sla: {
    remainingSeconds: index % 4 === 0 ? -3600 : 3600 * (index + 1),
    breached: index % 4 === 0,
  },
}));
const report = {
  workPackage: 'WP-P2-UX-038',
  startedAt: new Date().toISOString(),
  baselineRef,
  fixtureSha256: createHash('sha256').update(JSON.stringify(tickets)).digest('hex'),
  scope:
    'UI contract verification with a loopback synthetic API; no production persistence or authorization claim.',
  checks: [],
  apiRequests: [],
  unexpectedRequests: [],
  mutations: [],
  axe: [],
  snapshots: [],
  cleanup: [],
};
let scenario = 'normal';
let groupScenario = 'normal';
let phase = 'before';
let activeCheck = 'baseline';
let server;
let apiPort;
let browser;
let context;
let page;
let runtime;
let apiBase;

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
function problem(res, status) {
  respond(res, status, {
    type: `https://solvi.example/problems/${status}`,
    status,
    title: `合成検証 ${status}`,
    detail: `合成APIの${status}応答です。`,
  });
}
function filtered(query) {
  return tickets
    .filter((ticket) => {
      for (const key of ['state', 'kind', 'priority']) {
        const values = query.getAll(key).filter(Boolean);
        if (values.length && !values.includes(ticket[key])) return false;
      }
      const keyword = query.get('keyword');
      if (keyword && !`${ticket.subject} ${ticket.body} ${ticket.number}`.includes(keyword))
        return false;
      if (query.get('assignment') === 'mine' && ticket.assigneeId !== agent) return false;
      if (query.get('assignment') === 'unassigned' && ticket.assigned) return false;
      if (query.get('requester') && ticket.requesterId !== query.get('requester')) return false;
      if (query.get('sla') === 'breached' && !ticket.sla.breached) return false;
      const selectedGroup = query.get('group');
      if (selectedGroup === 'mine' && ticket.assigneeGroupId !== group) return false;
      if (selectedGroup === 'ungrouped' && ticket.assigneeGroupId !== null) return false;
      if (
        selectedGroup &&
        !['mine', 'ungrouped'].includes(selectedGroup) &&
        ticket.assigneeGroupId !== selectedGroup
      )
        return false;
      if (query.get('createdFrom') && ticket.createdAt.slice(0, 10) < query.get('createdFrom'))
        return false;
      if (query.get('createdTo') && ticket.createdAt.slice(0, 10) > query.get('createdTo'))
        return false;
      return true;
    })
    .sort((a, b) =>
      query.get('sort') === 'deadline' ? a.sla.remainingSeconds - b.sla.remainingSeconds : 0,
    );
}
async function fixture() {
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const role = new RegExp(`${cookie}=([^;]+)`).exec(req.headers.cookie ?? '')?.[1] ?? 'agent';
    report.apiRequests.push({
      phase,
      check: activeCheck,
      method: req.method,
      path: url.pathname,
      query: [...url.searchParams],
    });
    if (req.method !== 'GET') {
      report.mutations.push({ method: req.method, path: url.pathname });
      return problem(res, 403);
    }
    if (url.pathname === '/auth/me')
      return respond(res, 200, {
        userId: agent,
        organizationId: org,
        roles: [{ roleCode: role, organizationId: org }],
      });
    if (url.pathname === '/auth/organizations')
      return respond(res, 200, {
        selected: org,
        organizations: [{ id: org, code: 'synthetic', name: '合成検証組織' }],
      });
    if (url.pathname === '/groups') {
      if (groupScenario === 'unavailable') return problem(res, 503);
      return respond(res, 200, {
        items:
          groupScenario === 'missing'
            ? []
            : [
                {
                  id: group,
                  code: 'fixture',
                  name: '検証窓口',
                  active: true,
                  description: null,
                  memberCount: 1,
                },
              ],
      });
    }
    if (url.pathname === '/tickets') {
      if (role === 'requester') return problem(res, 403);
      if (['400', '403', '503'].includes(scenario)) return problem(res, Number(scenario));
      const all = scenario === 'empty' ? [] : filtered(url.searchParams);
      const cursor = url.searchParams.get('cursorId');
      const index = cursor ? all.findIndex((ticket) => ticket.id === cursor) + 1 : 0;
      if (
        cursor &&
        (index === 0 || all[index - 1].createdAt !== url.searchParams.get('cursorCreatedAt'))
      )
        return problem(res, 400);
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const items = all.slice(index, index + limit);
      const last = items.at(-1);
      return respond(res, 200, {
        items,
        total: all.length,
        scope: 'organization',
        appliedFilter: Object.fromEntries(url.searchParams),
        nextCursor:
          last && index + items.length < all.length && url.searchParams.get('sort') !== 'deadline'
            ? { createdAt: last.createdAt, id: last.id }
            : null,
      });
    }
    const match = /^\/tickets\/([^/]+)\/(workspace|relations|assets|changes)$/.exec(url.pathname);
    if (match) {
      const ticket = tickets.find((item) => item.id === match[1]);
      if (!ticket) return problem(res, 404);
      if (match[2] === 'workspace')
        return respond(res, 200, {
          ticket: { ...ticket, version: '1' },
          replyContext: { ticketVersion: '1', latestCommentId: null },
          comments: [],
          attachments: [],
          availableActions: [],
          priorityIsDerived: true,
          availableGroups: [{ id: group, code: 'fixture', name: '検証窓口' }],
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
    report.unexpectedRequests.push({ phase, method: req.method, path: url.pathname });
    problem(res, 404);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  apiPort = server.address().port;
  apiBase = `http://127.0.0.1:${apiPort}`;
}
async function startWeb(label) {
  const temp = await mkdtemp(join(tmpdir(), 'solvi-wp038-'));
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
        if ((await fetch(`${runtime.base}/ops`, { signal: AbortSignal.timeout(5000) })).ok) break;
      } catch {
        /* starting */
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'ja-JP' });
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
async function open(query = '') {
  await page.goto(`${runtime.base}/ops${query ? `?${query}` : ''}`, { waitUntil: 'networkidle' });
}
const form = () => page.getByRole('form', { name: '問い合わせの絞り込み' });
const rows = () => page.locator('table.tickets tbody tr');
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
async function density(label) {
  await open();
  await visible(page.getByRole('heading', { name: '問い合わせの一覧', exact: true }));
  const value = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scale: window.visualViewport?.scale,
    completeRows: [...document.querySelectorAll('table.tickets tbody tr')].filter((row) => {
      const bounds = row.getBoundingClientRect();
      return bounds.top >= 0 && bounds.bottom <= window.innerHeight;
    }).length,
  }));
  report[label === 'before' ? 'beforeDensity' : 'afterDensity'] = value;
  await capture(`queue-${label}-1280x720`, false, false);
  assert.equal(value.scale, 1);
  if (label === 'after')
    assert(value.completeRows >= 5, `expected >=5 complete rows, found ${value.completeRows}`);
}
async function check(name, run) {
  activeCheck = name;
  try {
    await run();
    report.checks.push({ name, passed: true });
  } catch (error) {
    report.checks.push({ name, passed: false, error: String(error.message) });
    await page
      .screenshot({
        path: join(evidence, `queue-failure-${report.checks.length}.png`),
        fullPage: true,
      })
      .catch(() => {});
  }
  process.stdout.write(`${report.checks.at(-1).passed ? 'PASS' : 'FAIL'} ${name}\n`);
  scenario = 'normal';
  groupScenario = 'normal';
}
async function expand() {
  const details = form().locator('details');
  if ((await details.getAttribute('open')) === null) await details.locator('summary').click();
}
async function submit() {
  await form().getByRole('button', { name: '絞り込む', exact: true }).click();
  await page.waitForLoadState('networkidle');
}
function lastQuery() {
  const item = report.apiRequests.findLast(
    (request) =>
      request.phase === 'after' && request.path === '/tickets' && request.check === activeCheck,
  );
  assert(item, 'ticket API request must be recorded');
  return new URLSearchParams(item.query);
}
async function resultMatches(query = lastQuery()) {
  const expected = filtered(query);
  const cursor = query.get('cursorId');
  const start = cursor ? expected.findIndex((item) => item.id === cursor) + 1 : 0;
  const selected = expected.slice(start, start + 50);
  await page.waitForFunction(
    (count) => document.querySelectorAll('table.tickets tbody tr').length === count,
    selected.length,
  );
  assert.equal(await rows().count(), selected.length);
  const shown = await rows().allTextContents();
  for (let index = 0; index < selected.length; index++)
    assert(
      shown[index].includes(selected[index].number),
      `row ${index} must match API fixture ${selected[index].number}`,
    );
}
async function tabTo(locator) {
  for (let i = 0; i < 100; i++) {
    await page.keyboard.press('Tab');
    if (await locator.evaluate((element) => document.activeElement === element)) return;
  }
  throw new Error('Tab did not reach the target control.');
}

try {
  await access(chromium.executablePath()).catch(() => {
    throw new Error(
      'Installed Playwright Chromium required; this runner does not install packages or browsers.',
    );
  });
  await mkdir(evidence, { recursive: true });
  await fixture();
  browser = await chromium.launch();
  await startWeb('before');
  await check('immutable baseline screenshot and visible-row measurement', () => density('before'));
  await stopWeb();
  if (!baselineOnly) {
    phase = 'after';
    await startWeb('after');
    await check('initial 1280x720 density and desktop accessibility', async () => {
      await density('after');
      await capture('queue-desktop');
      assert.equal(await rows().count(), 50);
      await resultMatches();
    });
    await check('five exact presets and custom query never mislabel active preset', async () => {
      const presets = [
        ['すべて', ''],
        ['未完了', 'state=new&state=assigned&state=in_progress&state=pending'],
        ['自分の対応中', 'assignment=mine&state=assigned&state=in_progress&state=pending'],
        ['未割当', 'assignment=unassigned&state=new'],
        ['期限超過', 'sla=breached&state=new&state=assigned&state=in_progress&state=pending'],
      ];
      for (const [name, query] of presets) {
        await open(query);
        const nav = page.getByRole('navigation', { name: '担当者の絞り込み' });
        assert.equal(
          await nav.getByRole('link', { name, exact: true }).getAttribute('aria-current'),
          'page',
        );
        await resultMatches();
      }
      await open('state=new&keyword=合成');
      assert.equal(
        await page
          .getByRole('navigation', { name: '担当者の絞り込み' })
          .locator('[aria-current="page"]')
          .count(),
        0,
      );
      await visible(page.getByText('カスタム条件', { exact: false }).first());
    });
    await check('all UI filter selections reach the API and determine rendered rows', async () => {
      await open(
        `requester=${requester}&page=4&cursorId=${tickets[49].id}&cursorCreatedAt=${encodeURIComponent(tickets[49].createdAt)}`,
      );
      await expand();
      await form().getByLabel('キーワード', { exact: true }).fill('合成');
      for (const [name, values] of [
        ['state', ['new', 'assigned']],
        ['kind', ['incident', 'request']],
        ['priority', ['critical', 'high']],
      ])
        for (const value of values)
          await form().locator(`input[name="${name}"][value="${value}"]`).check();
      await form().getByLabel('担当', { exact: true }).selectOption('unassigned');
      await form().getByLabel('期限', { exact: true }).selectOption('breached');
      await form().getByLabel('並び順', { exact: true }).selectOption('deadline');
      await form().getByLabel('担当グループ', { exact: true }).selectOption(group);
      await form().getByLabel('受付日(から)', { exact: true }).fill('2026-10-01');
      await form().getByLabel('受付日(まで)', { exact: true }).fill('2026-10-04');
      await submit();
      const query = lastQuery();
      for (const [name, values] of [
        ['state', ['new', 'assigned']],
        ['kind', ['incident', 'request']],
        ['priority', ['critical', 'high']],
      ])
        assert.deepEqual(query.getAll(name), values);
      for (const [key, value] of Object.entries({
        keyword: '合成',
        requester,
        assignment: 'unassigned',
        sla: 'breached',
        sort: 'deadline',
        group,
        createdFrom: '2026-10-01',
        createdTo: '2026-10-04',
      }))
        assert.equal(query.get(key), value);
      for (const key of ['cursorId', 'cursorCreatedAt', 'page'])
        assert.equal(query.has(key), false);
      assert.equal(new URL(page.url()).searchParams.has('page'), false);
      await resultMatches(query);
      assert((await rows().count()) > 0);
      await capture('queue-combined-filters');
    });
    await check(
      'individual condition removal keeps every other repeated filter and clears cursor/page',
      async () => {
        const original = new URLSearchParams({
          keyword: '合成',
          requester,
          group,
          createdFrom: '2026-10-01',
          createdTo: '2026-10-04',
          cursorId: tickets[49].id,
          cursorCreatedAt: tickets[49].createdAt,
          page: '2',
          redirect: 'https://outside.invalid/',
        });
        for (const [key, values] of [
          ['state', ['new', 'assigned']],
          ['kind', ['incident', 'request']],
          ['priority', ['critical', 'high']],
        ])
          values.forEach((value) => original.append(key, value));
        await open(original.toString());
        const chip = page
          .getByRole('navigation', { name: '適用中の条件' })
          .getByRole('link')
          .filter({ hasText: '検索:' });
        await chip.click();
        await page.waitForURL((url) => !url.searchParams.has('keyword'));
        const query = new URL(page.url()).searchParams;
        for (const key of ['keyword', 'cursorId', 'cursorCreatedAt', 'page', 'redirect'])
          assert.equal(query.has(key), false);
        for (const [key, value] of original)
          if (!['keyword', 'cursorId', 'cursorCreatedAt', 'page', 'redirect'].includes(key))
            assert(query.getAll(key).includes(value), `preserve ${key}=${value}`);
        await resultMatches();
      },
    );
    await check(
      'unavailable and missing selected groups survive resubmission with explicit removal',
      async () => {
        for (const value of ['unavailable', 'missing']) {
          groupScenario = value;
          await open(`group=${missingGroup}&state=new`);
          await expand();
          await visible(
            form().getByText('現在のグループ条件を保持して検索します', { exact: false }),
          );
          assert.equal(await form().locator('input[name="group"]').inputValue(), missingGroup);
          await submit();
          assert.equal(lastQuery().get('group'), missingGroup);
          await expand();
          await form().getByRole('link', { name: 'グループの指定を外す', exact: true }).click();
          await page.waitForURL((url) => !url.searchParams.has('group'));
          assert.deepEqual(lastQuery().getAll('state'), ['new']);
        }
      },
    );
    await check(
      'next/first page preserve microsecond cursor and API total versus returned rows',
      async () => {
        await open('keyword=合成');
        await visible(page.getByText(/61.*50|50.*61/).first());
        await page.getByRole('link', { name: /次のページへ/ }).click();
        await page.waitForURL((url) => url.searchParams.get('page') === '2');
        assert.equal(lastQuery().get('cursorCreatedAt'), tickets[49].createdAt);
        assert.equal(lastQuery().get('cursorId'), tickets[49].id);
        await page.waitForFunction(
          () => document.querySelectorAll('table.tickets tbody tr').length === 11,
        );
        assert.equal(await rows().count(), 11);
        assert.equal(lastQuery().get('keyword'), '合成');
        await page.reload({ waitUntil: 'networkidle' });
        assert.equal(await rows().count(), 11);
        await page.getByRole('link', { name: '最初のページへ', exact: true }).click();
        await page.waitForURL((url) => !url.searchParams.has('page'));
        await page.waitForFunction(
          () => document.querySelectorAll('table.tickets tbody tr').length === 50,
        );
        assert.equal(await rows().count(), 50);
        await page.goBack({ waitUntil: 'networkidle' });
        await page.waitForURL((url) => url.searchParams.get('page') === '2');
        await page.waitForFunction(
          () => document.querySelectorAll('table.tickets tbody tr').length === 11,
        );
        assert.equal(await rows().count(), 11);
      },
    );
    await check(
      'ticket detail returnTo and browser history retain the exact queue conditions',
      async () => {
        await open(`keyword=合成&state=assigned&kind=request&sort=newest`);
        const queue = new URL(page.url()).pathname + new URL(page.url()).search;
        const link = rows().first().getByRole('link').first();
        await link.click();
        await page.waitForURL((url) => /^\/ops\//.test(url.pathname));
        assert.equal(new URL(page.url()).searchParams.get('returnTo'), queue);
        await page.getByRole('link', { name: '元の画面へ戻る', exact: true }).click();
        await page.waitForURL(`${runtime.base}${queue}`);
        await resultMatches();
        await page.reload({ waitUntil: 'networkidle' });
        await resultMatches();
      },
    );
    await check('unknown URL keys are dropped from API and detail returnTo', async () => {
      await open(
        'keyword=合成&redirect=https%3A%2F%2Foutside.invalid&unexpected=secretless-synthetic',
      );
      assert.equal(lastQuery().has('redirect'), false);
      assert.equal(lastQuery().has('unexpected'), false);
      const href = await rows().first().getByRole('link').first().getAttribute('href');
      const target = new URL(href, runtime.base);
      const returnTo = new URL(target.searchParams.get('returnTo'), runtime.base);
      assert.equal(returnTo.origin, new URL(runtime.base).origin);
      assert.equal(returnTo.searchParams.has('redirect'), false);
      assert.equal(returnTo.searchParams.has('unexpected'), false);
      assert.equal(returnTo.searchParams.get('keyword'), '合成');
    });
    await check(
      'page without a cursor uses the first page and keeps next-page navigation',
      async () => {
        await open('page=999');
        assert.equal(await rows().count(), 50);
        const next = page.getByRole('link', { name: /次のページへ/ });
        await visible(next);
        assert.equal(
          new URL(await next.getAttribute('href'), runtime.base).searchParams.get('page'),
          '2',
        );
      },
    );
    await check('deadline ordering has no next-page cursor or navigation', async () => {
      await open('sort=deadline');
      await resultMatches();
      assert.equal(await page.getByRole('link', { name: /次のページへ/ }).count(), 0);
    });
    await check('400/403/503 and genuine/filtered empty states remain distinct', async () => {
      const statesSeen = [];
      for (const value of ['400', '403', '503', 'empty', 'filtered-empty']) {
        scenario = value === 'filtered-empty' ? 'normal' : value;
        await open(value === 'filtered-empty' ? 'keyword=no-such-synthetic-ticket' : '');
        assert.equal(await rows().count(), 0);
        const status = await page.locator('main').innerText();
        statesSeen.push({ value, text: status });
        const titles = {
          400: '検索条件を確認してください',
          403: '問い合わせを表示する権限がありません',
          503: '一覧を取得できませんでした',
          empty: '問い合わせはまだありません',
          'filtered-empty': '条件に合う問い合わせはありません',
        };
        await visible(page.getByRole('heading', { name: titles[value], exact: true }));
        await capture(`queue-state-${value}`);
      }
      report.stateEvidence = statesSeen;
      assert.equal(new Set(statesSeen.map((item) => item.text)).size, statesSeen.length);
    });
    await check(
      '503 retry fetches fresh API data and recovers without changing conditions',
      async () => {
        scenario = '503';
        await open('keyword=合成');
        await visible(
          page.getByRole('heading', { name: '一覧を取得できませんでした', exact: true }),
        );
        const before = report.apiRequests.filter((item) => item.path === '/tickets').length;
        scenario = 'normal';
        await page.getByRole('link', { name: /再読み込み/ }).click();
        await page.waitForLoadState('networkidle');
        assert(report.apiRequests.filter((item) => item.path === '/tickets').length > before);
        assert.equal(lastQuery().get('keyword'), '合成');
        await resultMatches();
      },
    );
    await check('nonstaff guard prevents rendering and calling ticket queue API', async () => {
      await context.clearCookies();
      await context.addCookies([{ name: cookie, value: 'requester', url: runtime.base }]);
      const before = report.apiRequests.filter((request) => request.path === '/tickets').length;
      await open();
      assert.equal(await rows().count(), 0);
      assert.equal(
        report.apiRequests.filter((request) => request.path === '/tickets').length,
        before,
      );
      await visible(page.getByText(/権限|担当者向け/).first());
      await context.clearCookies();
      await context.addCookies([{ name: cookie, value: 'agent', url: runtime.base }]);
    });
    await check(
      'keyboard reaches search, advanced conditions, remove chip, and table links',
      async () => {
        await open();
        const search = form().getByLabel('キーワード', { exact: true });
        await tabTo(search);
        const focus = await search.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            visible: element.matches(':focus-visible'),
            outline: style.outlineStyle,
            width: style.outlineWidth,
          };
        });
        assert.equal(focus.visible, true);
        assert.notEqual(focus.outline, 'none');
        assert(Number.parseFloat(focus.width) > 0);
        await page.keyboard.type('合成');
        await tabTo(form().locator('summary'));
        await page.keyboard.press('Enter');
        assert.equal(
          await form()
            .locator('details')
            .evaluate((element) => element.open),
          true,
        );
        await tabTo(form().getByRole('button', { name: '絞り込む', exact: true }));
        await page.keyboard.press('Enter');
        await page.waitForURL((url) => url.searchParams.get('keyword') === '合成');
        const chip = page
          .getByRole('navigation', { name: '適用中の条件' })
          .getByRole('link')
          .filter({ hasText: '検索:' });
        await tabTo(chip);
        await capture('queue-keyboard-focus', false, false);
        await page.keyboard.press('Enter');
        await page.waitForURL((url) => !url.searchParams.has('keyword'));
        await tabTo(rows().first().getByRole('link').first());
        assert.equal(
          await rows()
            .first()
            .getByRole('link')
            .first()
            .evaluate((element) => element.matches(':focus-visible')),
          true,
        );
        await tabTo(page.getByRole('link', { name: /次のページへ/ }));
        await page.keyboard.press('Enter');
        await page.waitForURL((url) => url.searchParams.get('page') === '2');
        await page.waitForFunction(
          () => document.querySelectorAll('table.tickets tbody tr').length === 11,
        );
        report.keyboard = {
          focus,
          actions: [
            'Tab search',
            'type keyword',
            'Tab/Enter details',
            'Tab/Enter submit',
            'Tab/Enter chip removal',
            'Tab table link',
            'Tab/Enter next page',
          ],
          nextPageRows: 11,
        };
      },
    );
    await check(
      '390px uses a local scrollable table without page overflow and passes axe',
      async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        await open();
        const dimensions = await page.evaluate(() => {
          const table = document.querySelector('table.tickets');
          let region = table?.parentElement;
          while (region && !['auto', 'scroll'].includes(getComputedStyle(region).overflowX))
            region = region.parentElement;
          return {
            pageWidth: document.documentElement.scrollWidth,
            viewport: window.innerWidth,
            regionWidth: region?.clientWidth,
            contentWidth: region?.scrollWidth,
          };
        });
        report.mobile = dimensions;
        assert(dimensions.pageWidth <= dimensions.viewport + 1);
        assert(
          dimensions.contentWidth > dimensions.regionWidth,
          'table must scroll within a local region at 390px',
        );
        await capture('queue-mobile');
        await expand();
        report.mobile.expandedPageWidth = await page.evaluate(
          () => document.documentElement.scrollWidth,
        );
        assert(
          report.mobile.expandedPageWidth <= 391,
          'expanded filters must not overflow the 390px viewport',
        );
        await capture('queue-mobile-filters');
      },
    );
    assert.equal(report.unexpectedRequests.length, 0, 'Unexpected API request');
    assert.equal(report.mutations.length, 0, 'This read-only UI runner must never send a mutation');
    await stopWeb();
  }
} catch (error) {
  report.checks.push({
    name: 'harness setup/completion',
    passed: false,
    error: String(error.message),
  });
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
        (item) => item.processExited && item.portAvailable && item.temporaryDirectoryRemoved,
      ) &&
      report.apiCleanup.closed &&
      report.apiCleanup.available &&
      report.snapshots.every((item) => item.label === 'before' || item.currentMatchesCopied),
  });
  report.finishedAt = new Date().toISOString();
  report.passed = report.checks.every((item) => item.passed);
  await mkdir(evidence, { recursive: true });
  await writeFile(
    join(evidence, baselineOnly ? 'baseline-report.json' : 'ticket-queue-report.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  await writeFile(
    join(
      evidence,
      baselineOnly ? 'baseline-source-manifest.json' : 'ticket-queue-source-manifest.json',
    ),
    JSON.stringify(report.snapshots, null, 2) + '\n',
  );
  process.stdout.write(
    `${report.passed ? 'PASS' : 'FAIL'} WP-P2-UX-038 ${baselineOnly ? 'baseline' : 'isolated UI'}: ${evidence}\n`,
  );
  process.exitCode = report.passed ? 0 : 1;
}
