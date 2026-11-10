/** WP-P2-UX-039: copied Web + read-only synthetic API; no real DB or accounts.
 * node tools/e2e/requester_portal_flow.mjs [--baseline-only]
 * Immutable before Web: 1d520db. Existing installed Chromium only.
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
const baselineRef = '1d520db';
const baselineOnly = process.argv.includes('--baseline-only');
const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' })
  .format(new Date())
  .replaceAll('-', '');
const evidence = join(root, 'evidence', 'WP-P2-UX-039', day);
const org = '03900000-0000-4000-8000-000000000001';
const agent = '03900000-0000-4000-8000-000000000002';
const requester = '03900000-0000-4000-8000-000000000003';
const other = '03900000-0000-4000-8000-000000000099';
const cookie = 'solvi_session_wp039_synthetic';
const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const states = ['new', 'assigned', 'in_progress', 'pending'];
const tickets = Array.from({ length: 25 }, (_, i) => ({
  id: `03900000-0000-4000-8001-${String(i + 1).padStart(12, '0')}`,
  number: `INC-${String(i + 1).padStart(4, '0')}`,
  subject: `本人の問い合わせ ${String(i + 1).padStart(2, '0')}`,
  body: '実データを含まない検証用問い合わせです。',
  kind: i % 2 === 0 ? 'incident' : 'request',
  state: i < 21 ? states[i % 4] : i % 2 ? 'resolved' : 'closed',
  impact: 'medium',
  urgency: 'medium',
  priority: 'medium',
  createdAt: `2026-10-03T20:${String(59 - i).padStart(2, '0')}:00.123456Z`,
  resolvedAt: null,
  assigned: i % 4 !== 0,
  assigneeName: i % 4 === 0 ? null : '検証担当者',
  pendingReason: i === 3 ? 'wait_requester' : i === 7 ? 'wait_external' : null,
  sla: { remainingSeconds: -123456, breached: true },
}));
const catalog = Array.from({ length: 15 }, (_, i) => ({
  id: `03900000-0000-4000-8002-${String(i + 1).padStart(12, '0')}`,
  version: 1,
  title:
    i === 0
      ? 'ＶＰＮ 接続サービス'
      : i === 1
        ? '端末セットアップ — 長い日本語のサービス名を表示する確認用サンプル'
        : `公開サービス ${String(i + 1).padStart(2, '0')}`,
  description:
    i === 0
      ? '社外から安全にネットワークへ接続するための申請です。'
      : `検証用の公開サービス説明 ${i + 1}。`,
  definition: {
    mode: 'local_simulation',
    action: 'simulate.access_grant',
    targetLabel: ['ネットワーク', '端末', '標準アカウント'][i % 3],
    allowedDurations: [7, 30],
    maxReasonLength: 1000,
  },
}));
const requestStates = ['pending', 'rejected', 'completed', 'approved', 'invalidated', 'cancelled'];
const longText = '申'.repeat(100);
const requests = Array.from({ length: 6 }, (_, i) => ({
  id: `03900000-0000-4000-8003-${String(i + 1).padStart(12, '0')}`,
  ticketId: tickets[i].id,
  number: `REQ-${String(i + 1).padStart(4, '0')}`,
  title: `本人のサービス申請 ${i + 1}`,
  version: 1,
  state: requestStates[i],
  createdAt: '2026-10-01T10:00:00Z',
  updatedAt: `2026-10-03T10:0${5 - i}:00Z`,
  expiresAt: i === 0 ? '2026-10-02T10:00:00Z' : '2099-10-02T10:00:00Z',
  decisionReason: i === 1 ? '申請内容の追加説明が必要です。' : null,
  requesterName: '検証依頼者',
  approverName: '検証承認者',
  own: true,
  assigned: false,
  expired: i === 0,
  nextAction: [
    '期限切れの内容を修正して再承認を依頼する',
    '理由を確認して修正・再申請する',
    '模擬実行の結果を確認する',
    '担当者の模擬実行を待っています',
    '理由を確認して修正・再申請する',
    '取消内容を確認する',
  ][i],
  approvalState: requestStates[i],
}));
const report = {
  workPackage: 'WP-P2-UX-039',
  startedAt: new Date().toISOString(),
  baselineRef,
  fixtureSha256: createHash('sha256')
    .update(JSON.stringify({ tickets, catalog, requests, longText }))
    .digest('hex'),
  scope:
    'Copied Web browser contract checks with loopback synthetic API. No real DB, business writes, or backend authorization claim.',
  checks: [],
  apiRequests: [],
  unexpectedRequests: [],
  mutations: [],
  axe: [],
  snapshots: [],
  cleanup: [],
};
let scenarios = { tickets: 'normal', catalog: 'normal', requests: 'normal' };
let phase = 'before',
  activeCheck = 'baseline',
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
function problem(res, status) {
  respond(res, status, {
    type: `https://solvi.example/problems/${status}`,
    status,
    title: `合成検証 ${status}`,
    detail: `合成APIの${status}応答です。`,
  });
}

function filteredTickets(query) {
  const selected = query.getAll('state');
  return tickets.filter((t) => !selected.length || selected.includes(t.state));
}
async function fixture() {
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const role = new RegExp(`${cookie}=([^;]+)`).exec(req.headers.cookie ?? '')?.[1] ?? 'requester';
    const userId = role === 'requester' ? requester : agent;
    report.apiRequests.push({
      phase,
      check: activeCheck,
      role,
      userId,
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
        userId,
        organizationId: org,
        roles: [{ roleCode: role, organizationId: org }],
      });
    if (url.pathname === '/auth/organizations')
      return respond(res, 200, {
        selected: org,
        organizations: [{ id: org, code: 'synthetic', name: '合成検証組織' }],
      });
    if (url.pathname === '/catalog') {
      if (/^\d+$/.test(scenarios.catalog)) return problem(res, Number(scenarios.catalog));
      return respond(res, 200, {
        items:
          scenarios.catalog === 'empty'
            ? []
            : scenarios.catalog === 'long'
              ? [
                  {
                    ...catalog[0],
                    title: longText,
                    definition: { ...catalog[0].definition, targetLabel: longText },
                  },
                ]
              : catalog,
        approvers: [{ id: other, name: '検証承認者' }],
        canManage: role === 'org_admin',
        simulation: true,
      });
    }
    if (url.pathname === '/service-requests') {
      if (/^\d+$/.test(scenarios.requests)) return problem(res, Number(scenarios.requests));
      const f = {
        q: url.searchParams.get('q') ?? '',
        state: url.searchParams.get('state') ?? 'all',
        view: url.searchParams.get('view') ?? 'all',
        page: Number(url.searchParams.get('page') ?? 1),
      };
      const all = scenarios.requests === 'empty' ? [] : requests;
      let items =
        scenarios.requests === 'waiting'
          ? [
              requests[3],
              { ...requests[0], expired: false, nextAction: '承認者の判断を待っています' },
              requests[2],
              ...requests.slice(4),
            ]
          : all;
      if (scenarios.requests === 'foreign')
        items = [
          { ...requests[0], id: other, title: '別人の申請は表示しない', own: false },
          ...requests,
        ];
      return respond(res, 200, {
        items,
        total: all.length,
        page: f.page,
        pageSize: 25,
        appliedFilter: f,
      });
    }
    if (url.pathname === '/tickets') {
      if (/^\d+$/.test(scenarios.tickets)) return problem(res, Number(scenarios.tickets));
      if (url.searchParams.get('requester') !== userId) return problem(res, 403);
      const all = scenarios.tickets === 'empty' ? [] : filteredTickets(url.searchParams);
      const cursor = url.searchParams.get('cursorId');
      const start = cursor ? all.findIndex((t) => t.id === cursor) + 1 : 0;
      const limit = Number(url.searchParams.get('limit') ?? 10);
      const items = all.slice(start, start + limit),
        last = items.at(-1);
      return respond(res, 200, {
        items,
        total: all.length,
        scope: role === 'requester' ? 'own' : 'organization',
        appliedFilter: Object.fromEntries(url.searchParams),
        nextCursor: start + limit < all.length ? { createdAt: last.createdAt, id: last.id } : null,
      });
    }
    const detail = /^\/tickets\/([^/]+)(?:\/(comments|attachments|relations|assets))?$/.exec(
      url.pathname,
    );
    if (detail) {
      const t = tickets.find((t) => t.id === detail[1]);
      if (!t) return problem(res, 404);
      if (!detail[2])
        return respond(res, 200, {
          ...t,
          sla: undefined,
          replyContext: { ticketVersion: '1', latestCommentId: null },
        });
      if (detail[2] === 'relations')
        return respond(res, 200, { items: [], unresolvedChildren: [] });
      if (detail[2] === 'assets')
        return respond(res, 200, { canManage: false, items: [], history: [] });
      if (detail[2] === 'comments')
        return respond(res, 200, {
          items: [],
          replyContext: { ticketVersion: '1', latestCommentId: null },
        });
      return respond(res, 200, { items: [] });
    }
    if (url.pathname === '/knowledge') return respond(res, 200, { items: [] });
    report.unexpectedRequests.push({ phase, method: req.method, path: url.pathname });
    return problem(res, 404);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  apiPort = server.address().port;
  apiBase = `http://127.0.0.1:${apiPort}`;
}
async function startWeb(label) {
  const temp = await mkdtemp(join(tmpdir(), 'solvi-wp039-'));
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
        if ((await fetch(`${runtime.base}/portal`, { signal: AbortSignal.timeout(5000) })).ok)
          break;
      } catch {
        /* starting */
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'ja-JP' });
    await context.addCookies([
      { name: cookie, value: 'requester', url: runtime.base, httpOnly: true, sameSite: 'Lax' },
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

async function open(path = '/portal') {
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
        path: join(evidence, `portal-failure-${report.checks.length}.png`),
        fullPage: true,
      })
      .catch(() => {});
  }
  process.stdout.write(`${report.checks.at(-1).passed ? 'PASS' : 'FAIL'} ${name}\n`);
  scenarios = { tickets: 'normal', catalog: 'normal', requests: 'normal' };
}
async function density(label) {
  await open();
  await visible(
    page.getByRole('heading', {
      name: label === 'before' ? 'お困りごとを、一緒に解決。' : 'あなたのITサポート',
      exact: true,
    }),
  );
  const measures = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scale: window.visualViewport?.scale,
    firstTicket:
      [...document.querySelectorAll('a')]
        .filter((a) => /\/tickets\/[0-9a-f-]+/.test(a.getAttribute('href') ?? ''))
        .map((a) => {
          const r = a.getBoundingClientRect();
          return { text: a.textContent, top: r.top, bottom: r.bottom };
        })[0] ?? null,
  }));
  report[label + 'Density'] = measures;
  await capture(`portal-${label}-1280x720`, false, false);
  assert.equal(measures.scale, 1);
  if (label === 'after') {
    assert(
      measures.firstTicket && measures.firstTicket.top >= 0 && measures.firstTicket.bottom <= 720,
      'first own ticket visible in initial viewport',
    );
  }
}
async function afterChecks() {
  await check('after initial viewport exposes first own ticket', () => density('after'));
  await check(
    'default unresolved counts, four states, next actions and accessibility',
    async () => {
      await open();
      await ticketRows(10);
      assert.deepEqual(lastQuery('/tickets').getAll('state'), states);
      assert.match(
        await ticketSection().getByRole('status').innerText(),
        /未解決 21件.*このページ 10件.*1ページ目/,
      );
      await visible(ticketSection().getByText('あなたの返答待ち', { exact: true }));
      await visible(ticketSection().getByText('外部の対応待ち', { exact: true }));
      assert.equal(await ticketSection().getByText('あなたの返答待ち', { exact: true }).count(), 1);
      assert(!/SLA|123456|内部メモ|内部コメント/.test(await page.locator('main').innerText()));
      assert.equal(await page.locator('main a[href="/catalog/manage"]').count(), 0);
      await capture('portal-default');
    },
  );
  await check('requester and staff identity cannot be changed through URL parameters', async () => {
    for (const role of ['requester', 'agent']) {
      await setRole(role);
      await open(
        '/portal?requester=' +
          other +
          '&organizationId=' +
          other +
          '&state=closed&assignment=mine&unknown=discard',
      );
      await ticketRows(10);
      const query = lastQuery('/tickets');
      assert.equal(query.get('requester'), role === 'requester' ? requester : agent);
      assert.equal(query.get('organizationId'), null);
      assert.equal(query.get('assignment'), null);
      assert.deepEqual(query.getAll('state'), states);
      const href = await ticketLinks().first().getAttribute('href');
      const back = new URL(href, runtime.base).searchParams.get('returnTo');
      assert.equal(back, '/portal');
      assert(!/SLA|123456|内部メモ|内部コメント/.test(await page.locator('main').innerText()));
    }
    await setRole('requester');
  });
  await check('opaque cursor pages 10/10/1, detail return, history and reload', async () => {
    await open();
    await ticketRows(10);
    const next = page
      .getByRole('navigation', { name: '問い合わせのページ' })
      .getByRole('link', { name: '次のページへ →', exact: true });
    await next.click();
    await ticketRows(10, tickets[10].number);
    const query = lastQuery('/tickets');
    assert.equal(query.get('cursorCreatedAt'), tickets[9].createdAt);
    assert.equal(query.get('cursorId'), tickets[9].id);
    const page2 = new URL(page.url()).pathname + new URL(page.url()).search;
    await page.reload({ waitUntil: 'networkidle' });
    await ticketRows(10, tickets[10].number);
    const href = await ticketLinks().first().getAttribute('href');
    assert.equal(new URL(href, runtime.base).searchParams.get('returnTo'), page2);
    await ticketLinks().first().click();
    await visible(page.getByRole('heading', { name: tickets[10].subject, exact: true }));
    await page.getByRole('link', { name: '元の画面へ戻る', exact: true }).click();
    await ticketRows(10, tickets[10].number);
    assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, page2);
    await next.click();
    await ticketRows(1, tickets[20].number);
    assert.equal(await next.count(), 0);
    await page.goBack({ waitUntil: 'networkidle' });
    await ticketRows(10, tickets[10].number);
    await page
      .getByRole('navigation', { name: '問い合わせのページ' })
      .getByRole('link', { name: '最初のページへ', exact: true })
      .click();
    await ticketRows(10, tickets[0].number);
  });
  await check('partial cursor and page-only queries reset to first page', async () => {
    for (const query of [
      'page=999',
      'cursorId=' + tickets[9].id + '&page=2',
      'cursorCreatedAt=' + encodeURIComponent(tickets[9].createdAt) + '&page=2',
    ]) {
      await open('/portal?' + query);
      await ticketRows(10, tickets[0].number);
      const apiQuery = lastQuery('/tickets');
      assert.equal(apiQuery.get('cursorId'), null);
      assert.equal(apiQuery.get('cursorCreatedAt'), null);
      assert.match(await ticketSection().getByRole('status').innerText(), /1ページ目/);
    }
  });
  await check('all view includes resolved and closed, view changes reset paging', async () => {
    await open();
    await page
      .getByRole('navigation', { name: '問い合わせの表示' })
      .getByRole('link', { name: 'すべて', exact: true })
      .click();
    await ticketRows(10);
    await visible(ticketSection().getByRole('status').filter({ hasText: '25件' }));
    assert.equal(lastQuery('/tickets').getAll('state').length, 0);
    assert.match(await ticketSection().getByRole('status').innerText(), /25件/);
    const next = page
      .getByRole('navigation', { name: '問い合わせのページ' })
      .getByRole('link', { name: '次のページへ →', exact: true });
    await next.click();
    await ticketRows(10, tickets[10].number);
    await next.click();
    await ticketRows(5, tickets[20].number);
    assert((await ticketSection().getByText('解決内容を確認する', { exact: true }).count()) > 0);
    assert((await ticketSection().getByText('対応は完了しています', { exact: true }).count()) > 0);
    await page
      .getByRole('navigation', { name: '問い合わせの表示' })
      .getByRole('link', { name: '未解決', exact: true })
      .click();
    await ticketRows(10, tickets[0].number);
    await visible(ticketSection().getByRole('status').filter({ hasText: '未解決 21件' }));
    assert.equal(lastQuery('/tickets').get('cursorId'), null);
    assert.equal(new URL(page.url()).searchParams.get('page'), null);
  });
  await check(
    'recent own requests preserve total, expiry, waiting and completion guidance',
    async () => {
      scenarios.requests = 'foreign';
      await open();
      assert.equal(lastQuery('/service-requests').get('view'), 'mine');
      assert.equal(lastQuery('/service-requests').get('page'), '1');
      const section = page.getByRole('region', { name: '最近の申請' });
      assert.equal(await section.locator('li').count(), 3);
      assert.match(await section.getByRole('status').innerText(), /全6件.*新しい3件/);
      assert(!/別人の申請/.test(await section.innerText()));
      for (const request of requests.slice(0, 3))
        await visible(section.getByText(request.nextAction, { exact: true }));
      await visible(section.getByText('承認期限切れ・再承認が必要', { exact: true }));
      scenarios.requests = 'waiting';
      await open();
      await visible(section.getByText('担当者の模擬実行を待っています', { exact: true }));
      await visible(section.getByText('承認者の判断を待っています', { exact: true }));
      await section.getByRole('link', { name: '自分の申請をすべて見る', exact: true }).click();
      await visible(page.getByRole('heading', { name: '申請の状況', exact: true }));
      assert.equal(new URL(page.url()).searchParams.get('view'), 'mine');
      assert.equal(lastQuery('/service-requests').get('view'), 'mine');
    },
  );
  await check('catalog pages 12/3 and conditioned detail return preserve navigation', async () => {
    await open('/catalog');
    await catalogRows(12);
    assert.match(await page.locator('.catalog-result').innerText(), /15件.*公開サービス 15件/s);
    const pagination = page.getByRole('navigation', { name: 'サービスカタログのページ' });
    await pagination.getByRole('link', { name: '次のページ', exact: true }).click();
    await catalogRows(3);
    const page2 = pathOf(page.url());
    const link = page.locator('.catalog-list h2 a').first(),
      title = await link.innerText();
    assert.equal(
      new URL(await link.getAttribute('href'), runtime.base).searchParams.get('returnTo'),
      page2,
    );
    await link.click();
    await visible(page.getByRole('heading', { name: title, exact: true }));
    await visible(page.getByLabel('利用する理由', { exact: true }));
    await page.getByRole('link', { name: '元の画面へ戻る', exact: true }).click();
    await catalogRows(3);
    assert.equal(pathOf(page.url()), page2);
    await page.reload({ waitUntil: 'networkidle' });
    await catalogRows(3);
    await pagination.getByRole('link', { name: '前のページ', exact: true }).click();
    await catalogRows(12);
    await capture('catalog-default');
  });
  await check(
    'catalog Unicode keyword and target filters preserve conditions and reset pages',
    async () => {
      await open('/catalog?page=2');
      await catalogRows(3);
      const form = catalogForm();
      await form.getByLabel('サービスを検索', { exact: true }).fill('vpn');
      await form.getByRole('button', { name: '絞り込む', exact: true }).click();
      await catalogRows(1);
      await visible(
        page.locator('.catalog-list').getByRole('link', { name: catalog[0].title, exact: true }),
      );
      assert.equal(new URL(page.url()).searchParams.get('page'), null);
      await form.getByLabel('サービスを検索', { exact: true }).fill('公開');
      await form.getByLabel('対象で絞る', { exact: true }).selectOption('端末');
      await form.getByRole('button', { name: '絞り込む', exact: true }).click();
      await catalogRows(5);
      assert.equal(new URL(page.url()).searchParams.get('q'), '公開');
      assert.equal(new URL(page.url()).searchParams.get('target'), '端末');
      assert.match(await page.locator('.catalog-result').innerText(), /5件.*公開サービス 15件/s);
      const conditioned = pathOf(page.url());
      await page.locator('.catalog-list h2 a').first().click();
      await visible(page.getByLabel('利用する理由', { exact: true }));
      await page.getByRole('link', { name: '元の画面へ戻る', exact: true }).click();
      await catalogRows(5);
      assert.equal(pathOf(page.url()), conditioned);
      await open(
        '/catalog?q=' +
          encodeURIComponent('公開') +
          '&target=' +
          encodeURIComponent('候補にない対象') +
          '&page=2&unknown=discard',
      );
      assert.equal(
        await catalogForm().getByLabel('対象で絞る', { exact: true }).inputValue(),
        '候補にない対象',
      );
      await visible(
        page.getByRole('heading', { name: '条件に合うサービスはありません', exact: true }),
      );
      assert(!/非公開サービス|別組織サービス/.test(await page.locator('main').innerText()));
      await capture('catalog-filter-empty');
    },
  );
  await check('catalog empty, filtered empty and out-of-range page are distinct', async () => {
    await open('/catalog?q=存在しない条件');
    await visible(
      page.getByRole('heading', { name: '条件に合うサービスはありません', exact: true }),
    );
    await open('/catalog?target=' + encodeURIComponent('端末') + '&page=999');
    await visible(
      page.getByRole('heading', { name: 'このページにサービスはありません', exact: true }),
    );
    await page.getByRole('link', { name: '最初のページへ', exact: true }).click();
    await catalogRows(5);
    assert.equal(new URL(page.url()).searchParams.get('target'), '端末');
    scenarios.catalog = 'empty';
    await open('/catalog');
    await visible(page.getByRole('heading', { name: '公開中のサービスはありません', exact: true }));
    await capture('catalog-empty');
  });
  await check(
    'catalog valid 100-character conditions return safely and overlong URL retains correction input',
    async () => {
      scenarios.catalog = 'long';
      const valid = '/catalog?' + new URLSearchParams({ q: longText, target: longText });
      await open(valid);
      await catalogRows(1);
      const link = page.locator('.catalog-list h2 a').first();
      const returnTo = new URL(await link.getAttribute('href'), runtime.base).searchParams.get(
        'returnTo',
      );
      assert(returnTo.length <= 2000);
      assert.equal(returnTo, valid);
      await link.click();
      await visible(page.getByLabel('利用する理由', { exact: true }));
      await page.getByRole('link', { name: '元の画面へ戻る', exact: true }).click();
      await catalogRows(1);
      assert.equal(pathOf(page.url()), valid);
      report.longQuery = {
        keywordLength: longText.length,
        targetLength: longText.length,
        returnToLength: returnTo.length,
      };
      for (const field of ['q', 'target']) {
        const params = new URLSearchParams({ q: longText, target: longText });
        params.set(field, longText + '超');
        await open('/catalog?' + params);
        await visible(
          page.getByText(
            field === 'q'
              ? '検索語は100文字以内で入力してください'
              : '対象の指定は100文字以内で選び直してください',
            { exact: true },
          ),
        );
        assert.equal(
          await catalogForm()
            .getByLabel(field === 'q' ? 'サービスを検索' : '対象で絞る', { exact: true })
            .inputValue(),
          longText + '超',
        );
        assert.equal(await page.locator('.catalog-list li').count(), 0);
        assert.equal(
          await page.getByRole('navigation', { name: 'サービスカタログのページ' }).count(),
          0,
        );
      }
      await capture('catalog-overlength');
    },
  );
  await check(
    'catalog 400/403/503 keeps keyword and unknown target, retry re-fetches',
    async () => {
      for (const status of ['400', '403', '503']) {
        scenarios.catalog = status;
        await open('/catalog?q=vpn&target=' + encodeURIComponent('ネットワーク') + '&page=2');
        await visible(page.locator('main').getByRole('alert'));
        assert.equal(
          await catalogForm().getByLabel('サービスを検索', { exact: true }).inputValue(),
          'vpn',
        );
        assert.equal(
          await catalogForm().getByLabel('対象で絞る', { exact: true }).inputValue(),
          'ネットワーク',
        );
        const errorText = await page.locator('main').getByRole('alert').innerText();
        assert.match(
          errorText,
          status === '403' ? /権限/ : status === '400' ? /条件/ : /読み込めません/,
        );
        if (status === '503') {
          await capture('catalog-error');
          const count = report.apiRequests.filter((r) => r.path === '/catalog').length;
          scenarios.catalog = 'normal';
          await page.getByRole('link', { name: '再読み込み', exact: true }).click();
          await visible(
            page.getByRole('heading', { name: 'このページにサービスはありません', exact: true }),
          );
          assert(report.apiRequests.filter((r) => r.path === '/catalog').length > count);
          assert.equal(new URL(page.url()).searchParams.get('q'), 'vpn');
        }
      }
    },
  );
  await check(
    'portal independent region errors preserve successful data and reload scope',
    async () => {
      for (const resource of ['tickets', 'requests', 'catalog'])
        for (const status of ['403', '503']) {
          scenarios = {
            tickets: 'normal',
            catalog: 'normal',
            requests: 'normal',
            [resource]: status,
          };
          await open('/portal?view=all');
          const selector = {
            tickets: '.portal-tickets',
            requests: '.portal-requests',
            catalog: '.portal-services',
          }[resource];
          const section = page.locator(selector);
          await visible(section.getByRole('alert'));
          assert.match(
            await section.getByRole('alert').innerText(),
            status === '403' ? /権限/ : /取得できません/,
          );
          if (resource !== 'tickets') await ticketRows(10);
          if (resource !== 'requests')
            assert.equal(await page.locator('.portal-request-list li').count(), 3);
          if (resource !== 'catalog')
            assert.equal(await page.locator('.portal-service-links li').count(), 6);
          const count = report.apiRequests.length;
          scenarios[resource] = 'normal';
          await section.getByRole('link', { name: '再読み込み', exact: true }).click();
          await page.waitForLoadState('networkidle');
          assert.equal(new URL(page.url()).searchParams.get('view'), 'all');
          assert(report.apiRequests.length > count);
          assert.equal(await section.getByRole('alert').count(), 0);
        }
      scenarios.tickets = '400';
      await open('/portal');
      await visible(ticketSection().getByRole('alert'));
      assert.match(await ticketSection().getByRole('alert').innerText(), /条件/);
      await capture('portal-error');
    },
  );
  await check('portal genuine empty states are not failures', async () => {
    scenarios = { tickets: 'empty', requests: 'empty', catalog: 'empty' };
    await open();
    await visible(
      page.getByRole('heading', { name: '未解決の問い合わせはありません', exact: true }),
    );
    await visible(page.getByRole('heading', { name: '申請はまだありません', exact: true }));
    assert.equal(await page.locator('main').getByRole('alert').count(), 0);
    await visible(
      page.getByText('公開中のサービスはありません。メニューにない依頼は一般相談から送れます。', {
        exact: true,
      }),
    );
    await capture('portal-empty');
  });
  await check(
    'request and incident form starts need two and one clicks without writes',
    async () => {
      await open();
      let clicks = 0;
      await page.getByRole('link', { name: 'サービスを申請する', exact: true }).click();
      clicks++;
      await catalogRows(12);
      await page.locator('.catalog-list h2 a').first().click();
      clicks++;
      await visible(page.getByLabel('利用する理由', { exact: true }));
      assert(clicks <= 3);
      report.formStartClicks = { service: clicks };
      await open();
      await page.getByRole('link', { name: '障害を報告する', exact: true }).click();
      await visible(page.getByRole('heading', { name: '障害を報告する', exact: true }));
      report.formStartClicks.incident = 1;
      assert.equal(report.mutations.length, 0);
    },
  );
  await check('keyboard Tab/Enter reaches service form with visible focus', async () => {
    await open();
    const start = page.getByRole('link', { name: 'サービスを申請する', exact: true });
    await tabTo(start);
    const focus = await start.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        active: document.activeElement === el,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        boxShadow: style.boxShadow,
      };
    });
    assert(
      focus.active &&
        ((focus.outlineStyle !== 'none' && parseFloat(focus.outlineWidth) > 0) ||
          focus.boxShadow !== 'none'),
    );
    report.keyboard = { keys: ['Tab', 'Enter', 'Tab', 'Enter', 'Tab'], focus };
    await capture('portal-keyboard-focus', false, false);
    await page.keyboard.press('Enter');
    await catalogRows(12);
    await tabTo(page.locator('.catalog-list h2 a').first());
    await page.keyboard.press('Enter');
    await visible(page.getByLabel('利用する理由', { exact: true }));
    await tabTo(page.getByLabel('利用する理由', { exact: true }));
    assert(
      await page
        .getByLabel('利用する理由', { exact: true })
        .evaluate((el) => document.activeElement === el),
    );
  });
  await check('375px and 390px portal/catalog do not overflow and pass axe', async () => {
    report.mobile = [];
    for (const width of [375, 390])
      for (const route of ['/portal', '/catalog?target=' + encodeURIComponent('端末')]) {
        await page.setViewportSize({ width, height: 812 });
        await open(route);
        const bounds = await page.evaluate(() => ({
          viewport: window.innerWidth,
          document: document.documentElement.scrollWidth,
          scale: window.visualViewport?.scale,
        }));
        assert(bounds.document <= width, JSON.stringify(bounds));
        report.mobile.push({ route, ...bounds });
        await capture(`mobile-${width}-${route.startsWith('/portal') ? 'portal' : 'catalog'}`);
      }
    await page.setViewportSize({ width: 1280, height: 720 });
  });
}
const pathOf = (url) => new URL(url).pathname + new URL(url).search;
const ticketSection = () => page.getByRole('region', { name: 'あなたの問い合わせ' });
const ticketLinks = () => page.locator('.portal-ticket-list .portal-ticket-line a');
const catalogForm = () => page.getByRole('form', { name: 'サービスの絞り込み' });
async function ticketRows(count, first) {
  await page.waitForFunction(
    (n) => document.querySelectorAll('.portal-ticket-list > li').length === n,
    count,
  );
  if (first) await visible(ticketLinks().first().filter({ hasText: first }));
}
async function catalogRows(count) {
  await page.waitForFunction(
    (n) => document.querySelectorAll('.catalog-list > li').length === n,
    count,
  );
}
function lastQuery(path) {
  const request = report.apiRequests.findLast(
    (r) => r.phase === 'after' && r.check === activeCheck && r.path === path,
  );
  assert(request, 'recorded API query for ' + path);
  return new URLSearchParams(request.query);
}
async function setRole(role) {
  await context.addCookies([
    { name: cookie, value: role, url: runtime.base, httpOnly: true, sameSite: 'Lax' },
  ]);
}
try {
  await access(chromium.executablePath()).catch(() => {
    throw new Error('Installed Chromium is required; automatic browser installation is forbidden.');
  });
  await mkdir(evidence, { recursive: true });
  await fixture();
  browser = await chromium.launch();
  await startWeb('before');
  await check('immutable baseline screenshot', () => density('before'));
  await stopWeb();
  if (!baselineOnly) {
    phase = 'after';
    await startWeb('after');
    await afterChecks();
  }
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
      report.snapshots.every((i) => i.label === 'before' || i.currentMatchesCopied),
  });
  report.checks.push({
    name: 'read-only API fixture has no writes or unexpected endpoints',
    passed: report.mutations.length === 0 && report.unexpectedRequests.length === 0,
  });
  report.finishedAt = new Date().toISOString();
  report.passed = report.checks.every((i) => i.passed);
  await mkdir(evidence, { recursive: true });
  await writeFile(
    join(evidence, baselineOnly ? 'baseline-report.json' : 'requester-portal-report.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  await writeFile(
    join(
      evidence,
      baselineOnly ? 'baseline-source-manifest.json' : 'requester-portal-source-manifest.json',
    ),
    JSON.stringify(report.snapshots, null, 2) + '\n',
  );
  process.stdout.write(
    `${report.passed ? 'PASS' : 'FAIL'} WP-P2-UX-039 ${baselineOnly ? 'baseline' : 'isolated UI'}: ${evidence}\n`,
  );
  process.exitCode = report.passed ? 0 : 1;
}
