/* global document, window */
// NFR-SEC-011 / ADR-0027 / WP-P2-SEC-025: browser security headers on the real screens.
//
// Checks, on the local synthetic environment only:
//   1. HTML responses carry the ADR-0027 fixed headers and a CSP with a per-request nonce
//      that matches every <script nonce> in the same response.
//   2. The main flows (login, portal, tickets list/detail/new, approvals inbox, knowledge,
//      attachment upload) raise zero CSP violations (securitypolicyviolation events, which
//      fire in both Report-Only and enforce mode).
//   3. A page on another origin cannot frame SOLVI.
//
// Env: SOLVI_SMOKE_PASSWORD (synthetic seed password, required), SOLVI_UI_BASE,
//      SOLVI_UI_OUT, SOLVI_UI_BROWSER (chromium|webkit), SOLVI_CSP_EXPECT (report-only|enforce),
//      SOLVI_UI_BROWSER_PATH (optional browser binary), SOLVI_UPLOAD_EXPECT (allowed|fail-closed),
//      SOLVI_UI_DEV=1 (target is `next dev`: 'unsafe-eval' is then allowed in script-src).
// Writes: synthetic sign-in, one synthetic ticket and one small attachment. Never run it
// against an environment holding real data.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';

const base = new URL(process.env.SOLVI_UI_BASE ?? 'http://127.0.0.1:3000');
assert.ok(
  base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname),
  'Only the local synthetic SOLVI environment is supported',
);
const password = process.env.SOLVI_SMOKE_PASSWORD;
assert.ok(password, 'SOLVI_SMOKE_PASSWORD is required');
const output = resolve(process.env.SOLVI_UI_OUT ?? 'evidence/WP-P2-SEC-025/local');
const browserName = process.env.SOLVI_UI_BROWSER ?? 'chromium';
assert.ok(['chromium', 'webkit'].includes(browserName), 'Unsupported browser');
const expectMode = process.env.SOLVI_CSP_EXPECT ?? 'report-only';
assert.ok(['report-only', 'enforce'].includes(expectMode), 'Unsupported SOLVI_CSP_EXPECT');
const devServer = process.env.SOLVI_UI_DEV === '1';
const cspHeader =
  expectMode === 'enforce' ? 'content-security-policy' : 'content-security-policy-report-only';

const FIXED = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
  'x-frame-options': 'DENY',
};

const report = {
  browser: browserName,
  expectMode,
  devServer,
  success: false,
  checks: [],
  violations: [],
  upload: null,
  screenshots: [],
};
let browser;
let framer;

function step(name, detail = {}) {
  report.currentStep = name;
  report.checks.push({ name, ...detail });
}

/** Header and nonce checks on one raw HTML response (no browser involved). */
async function checkResponse(path, cookie) {
  const response = await fetch(new URL(path, base), {
    headers: cookie ? { cookie } : {},
    redirect: 'manual',
  });
  const headers = Object.fromEntries(response.headers);
  for (const [name, value] of Object.entries(FIXED)) {
    assert.equal(headers[name], value, `${path}: ${name}`);
  }
  assert.equal(headers['strict-transport-security'], undefined, `${path}: no HSTS over HTTP`);
  const other =
    cspHeader === 'content-security-policy'
      ? 'content-security-policy-report-only'
      : 'content-security-policy';
  assert.equal(headers[other], undefined, `${path}: only ${cspHeader}`);
  const csp = headers[cspHeader];
  assert.ok(csp, `${path}: ${cspHeader} missing`);
  const nonce = csp.match(/'nonce-([A-Za-z0-9+/]+={0,2})'/)?.[1];
  assert.ok(nonce, `${path}: CSP has no nonce`);
  // `next dev` needs 'unsafe-eval' (ADR-0027 §2, development only). A production build
  // must never carry it; SOLVI_UI_DEV=1 states that the target is a dev server.
  const forbiddenTokens = ["'unsafe-inline'", ' * ', ' https: '];
  if (!devServer) forbiddenTokens.push("'unsafe-eval'");
  for (const forbidden of forbiddenTokens) {
    const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src')) ?? '';
    assert.ok(!` ${scriptSrc} `.includes(forbidden), `${path}: script-src has ${forbidden}`);
  }
  const html = response.status === 200 ? await response.text() : '';
  const tags = html.match(/<script\b[^>]*>/g) ?? [];
  const mismatched = tags.filter((tag) => !tag.includes(`nonce="${nonce}"`)).length;
  assert.equal(mismatched, 0, `${path}: ${mismatched} script tags without the response nonce`);
  const connectSrc =
    csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('connect-src'))
      ?.split(/\s+/)
      .slice(1) ?? [];
  return { path, status: response.status, nonce, scripts: tags.length, connectSrc };
}

async function open(page, path) {
  report.currentStep = `open ${path}`;
  await page.goto(new URL(path, base).href, { waitUntil: 'networkidle' });
  await page.locator('main h1').first().waitFor({ state: 'visible' });
}

async function screenshot(page, name) {
  await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true });
  report.screenshots.push(`${name}.png`);
}

/** Serve a page on another origin that tries to frame SOLVI. */
function startFramer() {
  return new Promise((done) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        `<!doctype html><title>framer</title><iframe id="target" src="${new URL('/login', base).href}" width="800" height="600"></iframe>`,
      );
    });
    server.listen(0, '127.0.0.1', () => done(server));
  });
}

async function main() {
  await mkdir(output, { recursive: true });

  // 1. Headers on the anonymous login page; two requests must get different nonces.
  const first = await checkResponse('/login');
  const second = await checkResponse('/login');
  assert.notEqual(first.nonce, second.nonce, 'nonce must differ per request');
  step('headers-login', { scripts: first.scripts, distinctNonces: true });

  // SOLVI_UI_BROWSER_PATH: an already-installed browser binary when Playwright's pinned
  // revision is not downloaded (optional; the default is Playwright's own browser).
  const executablePath = process.env.SOLVI_UI_BROWSER_PATH;
  browser = await (browserName === 'webkit' ? webkit : chromium).launch(
    executablePath ? { executablePath } : {},
  );
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // Every violation is sent to Node as it happens, so a reload (for example after a
  // successful upload) cannot drop it. Fires for Report-Only and enforced policies.
  await context.exposeBinding('__solviCspViolation', (_source, violation) => {
    report.violations.push({ label: 'pending', ...violation });
  });
  await context.addInitScript(() => {
    // Keep only the origin of what was blocked: presigned storage URLs carry a signature
    // (a short-lived credential) in the query and must not reach the Evidence.
    const originOf = (uri) => {
      try {
        return new URL(uri).origin;
      } catch {
        return uri;
      }
    };
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__solviCspViolation({
        directive: event.effectiveDirective,
        blocked: originOf(event.blockedURI),
        disposition: event.disposition,
        source: event.sourceFile,
        line: event.lineNumber,
      });
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  // Assign the violations raised so far to the step that just finished.
  const collect = async (name) => {
    await page.waitForTimeout(300);
    for (const v of report.violations) if (v.label === 'pending') v.label = name;
  };

  // 2. Login (Server Action form post) and organization selection.
  await open(page, '/login');
  await page.getByLabel('メールアドレス', { exact: true }).fill('org_admin@acme.example.test');
  await page.getByLabel('パスワード', { exact: true }).fill(password);
  await Promise.all([
    page.waitForURL((url) => url.pathname !== '/login'),
    page.getByRole('button', { name: 'ログイン', exact: true }).click(),
  ]);
  await page.waitForLoadState('networkidle');
  if (new URL(page.url()).pathname === '/select-organization') {
    await page.getByLabel('サンプル株式会社', { exact: true }).check();
    await Promise.all([
      page.waitForURL((url) => url.pathname !== '/select-organization'),
      page.getByRole('button', { name: 'この組織で続ける', exact: true }).click(),
    ]);
    await page.waitForLoadState('networkidle');
  }
  await collect('login');
  step('login');

  const cookie = (await context.cookies())
    .filter((c) => c.domain === base.hostname)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  for (const path of ['/portal', '/ops', '/inbox', '/knowledge']) {
    step(`headers-${path}`, await checkResponse(path, cookie));
  }

  // 3. Main flows.
  for (const path of ['/portal', '/ops', '/inbox', '/knowledge', '/requests']) {
    await open(page, path);
    await collect(path);
    step(`flow ${path}`);
  }
  await screenshot(page, `${browserName}-requests`);

  await open(page, '/knowledge?q=VPN');
  await collect('knowledge-search');
  step('flow knowledge search');

  // New ticket through the client-side form (Server Action).
  await open(page, '/tickets/new?kind=incident');
  await page.getByLabel('件名', { exact: true }).fill('合成チケット(CSP検証)');
  await page.getByLabel('内容', { exact: true }).fill('WP-P2-SEC-025 の検証用の合成データ');
  await Promise.all([
    page.waitForURL(/\/tickets\/[0-9a-f-]{36}/),
    page.getByRole('button', { name: '障害を報告する', exact: true }).click(),
  ]);
  await page.waitForLoadState('networkidle');
  const ticketId = new URL(page.url()).pathname.split('/')[2];
  await collect('ticket-create');
  step('flow ticket create');
  await screenshot(page, `${browserName}-ticket-detail`);

  await open(page, `/ops/${ticketId}`);
  await collect('ops-ticket-detail');
  step('flow ops ticket detail');

  // Attachment upload: the browser PUTs to object storage (AttachmentForm.tsx).
  // ADR-0029: connect-src carries `<storage origin>/<attachment bucket>/` when the storage
  // settings are valid, and nothing (fail closed) otherwise. SOLVI_UPLOAD_EXPECT says which
  // the environment should show: `allowed` (default) or `fail-closed` (for example a local
  // production build, where http: storage is refused).
  const uploadExpect = process.env.SOLVI_UPLOAD_EXPECT ?? 'allowed';
  assert.ok(['allowed', 'fail-closed'].includes(uploadExpect), 'Unsupported SOLVI_UPLOAD_EXPECT');
  const uploadSource = (await checkResponse(`/tickets/${ticketId}`, cookie)).connectSrc.find(
    (source) => source !== "'self'",
  );
  if (uploadExpect === 'allowed') {
    assert.ok(uploadSource, 'connect-src must carry the attachment upload source (ADR-0029)');
    assert.match(uploadSource, /^https?:\/\/[^/]+\/[a-z0-9][a-z0-9.-]+[a-z0-9]\/$/);
  } else {
    assert.equal(uploadSource, undefined, 'invalid storage settings must add nothing');
  }

  await open(page, `/tickets/${ticketId}`);
  await page.locator('summary', { hasText: '添付ファイル' }).click();
  await page.getByLabel('ファイル', { exact: true }).setInputFiles({
    name: 'csp-check.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('synthetic attachment for WP-P2-SEC-025\n'),
  });
  const put = page
    .waitForRequest((request) => request.method() === 'PUT', { timeout: 15000 })
    .then((request) => new URL(request.url()).origin)
    .catch(() => null);
  await collect('before-upload');
  await page.getByRole('button', { name: '添付する', exact: true }).click();
  const putOrigin = await put;
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);
  await collect('attachment-upload');
  const uploadViolations = report.violations.filter((v) => v.label === 'attachment-upload');
  report.upload = {
    expect: uploadExpect,
    connectSrcSource: uploadSource ?? null,
    putOrigin,
    sameOrigin: putOrigin === base.origin,
    violations: uploadViolations.length,
    alert: await page
      .locator('main [role="alert"]')
      .allInnerTexts()
      .catch(() => []),
  };
  if (uploadExpect === 'allowed') {
    assert.deepEqual(report.upload.alert, [], 'attachment upload must succeed');
    assert.equal(uploadViolations.length, 0, 'attachment upload must not violate the CSP');
  } else {
    assert.ok(
      uploadViolations.some((v) => v.directive === 'connect-src'),
      'with no upload source the upload must violate connect-src',
    );
    // Expected here; kept in report.upload, not counted as a regression below.
    report.violations = report.violations.filter((v) => v.label !== 'attachment-upload');
  }
  step('flow attachment upload', report.upload);
  await screenshot(page, `${browserName}-attachment-upload`);

  // A request to another bucket on the same storage host must violate connect-src. In
  // Report-Only mode the request still leaves the browser; it is unsigned and refused.
  if (uploadSource) {
    const storageOrigin = new URL(uploadSource).origin;
    await collect('before-probe');
    await page.evaluate(async (target) => {
      await fetch(target, { method: 'PUT', body: 'probe' }).catch(() => undefined);
    }, `${storageOrigin}/solvi-csp-probe-other-bucket/probe.txt`);
    await page.waitForTimeout(1000);
    await collect('other-bucket-probe');
    const probe = report.violations.filter(
      (v) =>
        v.label === 'other-bucket-probe' &&
        v.directive === 'connect-src' &&
        v.blocked === storageOrigin,
    );
    assert.ok(probe.length > 0, 'a request to another bucket must violate connect-src');
    report.violations = report.violations.filter((v) => v.label !== 'other-bucket-probe');
    report.otherBucketProbe = { uploadSource, violations: probe.length };
    step('other bucket refused', report.otherBucketProbe);
  }
  await collect('after-upload');

  // 4. Framing from another origin must be refused.
  framer = await startFramer();
  const framerOrigin = `http://127.0.0.1:${framer.address().port}`;
  const framePage = await context.newPage();
  await framePage.goto(`${framerOrigin}/`, { waitUntil: 'load' });
  await framePage.waitForTimeout(1500);
  const framedHeading = await framePage
    .frameLocator('#target')
    .locator('h1')
    .count()
    .catch(() => 0);
  assert.equal(framedHeading, 0, 'SOLVI must not render inside a cross-origin iframe');
  step('iframe refused', { framerOrigin });
  await framePage.screenshot({ path: resolve(output, `${browserName}-iframe-refused.png`) });
  report.screenshots.push(`${browserName}-iframe-refused.png`);

  // The framed SOLVI document may report its own frame-ancestors violation: expected.
  await collect('iframe-probe');
  report.iframeViolations = report.violations.filter((v) => v.label === 'iframe-probe');
  report.violations = report.violations.filter((v) => v.label !== 'iframe-probe');

  assert.deepEqual(report.violations, [], 'CSP violations on the main flows');
  report.success = true;
}

try {
  await main();
} catch (error) {
  report.failure = String(error?.message ?? error).replaceAll(password, '<redacted>');
  console.error('SOLVI security header check failed; inspect summary.json.');
  process.exitCode = 1;
} finally {
  await browser?.close();
  framer?.close();
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(
    `Security headers (${browserName}, expect ${expectMode}): ${report.success ? 'PASS' : 'FAIL'}; ` +
      `${report.checks.length} checks; ${report.violations.length} CSP violations`,
  );
}
