/* global document, getComputedStyle, innerWidth */
// NFR-UX-001, NFR-UX-002, NFR-UX-003: real support navigation and visible keyboard focus.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

const base = new URL(process.env.SOLVI_UI_BASE ?? 'http://127.0.0.1:3000');
assert.ok(
  base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname),
  'Only the local synthetic SOLVI environment is supported',
);
const password = process.env.SOLVI_SMOKE_PASSWORD;
assert.ok(password, 'SOLVI_SMOKE_PASSWORD is required');
const output = resolve(process.env.SOLVI_UI_OUT ?? 'evidence/WP-P2-UIX-038/local');
const browserName = process.env.SOLVI_UI_BROWSER ?? 'chromium';
assert.ok(['chromium', 'webkit'].includes(browserName), 'Unsupported browser');
const roles = [
  { code: 'requester', work: ['/assets'], inbox: false, staff: false },
  { code: 'approver', work: ['/inbox', '/assets', '/changes'], inbox: true, staff: false },
  { code: 'auditor', work: ['/assets', '/changes'], inbox: false, staff: false },
  { code: 'agent', work: ['/inbox', '/assets', '/changes'], inbox: true, staff: true },
  { code: 'org_admin', work: ['/inbox', '/assets', '/changes'], inbox: true, staff: true },
];
const report = {
  browser: browserName,
  success: false,
  checks: [],
  accessibility: [],
  forbiddenRequests: [],
};
const screenshots = [];
const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
let browser;

async function open(page, path) {
  report.currentStep = `open ${path}`;
  const destination = new URL(path, base).href;
  if (page.url() !== destination) await page.goto(destination, { waitUntil: 'networkidle' });
  await page.locator('main h1').first().waitFor({ state: 'visible' });
}

async function navigate(page, locator, path) {
  report.currentStep = `navigate ${path}`;
  await Promise.all([page.waitForURL((url) => url.pathname === path), locator.click()]);
  await page.waitForLoadState('networkidle');
  await page.locator('main h1').first().waitFor({ state: 'visible' });
  assert.equal(await page.locator('main [role="alert"]').count(), 0, `Route ${path} rejected`);
}

async function axe(page, label) {
  const result = await new AxeBuilder({ page }).withTags(tags).analyze();
  const violations = result.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.length,
  }));
  report.accessibility.push({ label, violations });
  assert.deepEqual(violations, [], `Accessibility: ${label}`);
}

async function screenshot(page, name) {
  await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true });
  screenshots.push(`${name}.png`);
}

async function searchWithKeyboard(page, name) {
  await open(page, '/portal');
  const field = page.locator('#support-search-input');
  const submit = page.locator('.support-search button[type="submit"]');
  await field.fill('VPN');
  // Safari on macOS uses Option-Tab for all webpage items in its default mode.
  // https://support.apple.com/guide/safari/keyboard-shortcuts-and-gestures-cpsh003/mac
  const forwardKey = browserName === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab';
  await field.press(forwardKey);
  const focus = await submit.evaluate((button) => {
    const style = getComputedStyle(button);
    const bounds = button.getBoundingClientRect();
    return {
      focused: document.activeElement === button,
      focusVisible: button.matches(':focus-visible'),
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      clip: style.clip,
      clipPath: style.clipPath,
      outlineStyle: style.outlineStyle,
      outlineWidth: parseFloat(style.outlineWidth),
      width: bounds.width,
      height: bounds.height,
    };
  });
  assert.equal(focus.focused, true, 'Tab must reach the search submit button');
  assert.equal(focus.focusVisible, true);
  assert.notEqual(focus.display, 'none');
  assert.equal(focus.visibility, 'visible');
  assert.equal(focus.opacity, '1');
  assert.equal(focus.clip, 'auto', 'A focused button must not be clipped');
  assert.equal(focus.clipPath, 'none');
  assert.notEqual(focus.outlineStyle, 'none');
  assert.ok(focus.outlineWidth >= 2 && focus.width >= 24 && focus.height >= 24);
  report.checks.push({ name, forwardKey, focus });
  await screenshot(page, name);
  await Promise.all([
    page.waitForURL((url) => url.pathname === '/knowledge' && url.searchParams.get('q') === 'VPN'),
    page.keyboard.press('Enter'),
  ]);
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { name: 'ナレッジを探す', exact: true }).waitFor();
}

async function main() {
  await mkdir(output, { recursive: true });
  const browserType = browserName === 'webkit' ? webkit : chromium;
  browser = await browserType.launch({
    ...(browserName === 'chromium' && process.env.SOLVI_UI_BROWSER_CHANNEL
      ? { channel: process.env.SOLVI_UI_BROWSER_CHANNEL }
      : {}),
  });
  for (const role of roles) {
    report.currentRole = role.code;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      // Only synthetic sign-in/organization selection may write. No business changes.
      await context.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const allowed =
          url.origin === base.origin &&
          (['GET', 'HEAD'].includes(request.method()) ||
            (request.method() === 'POST' &&
              ['/login', '/select-organization'].includes(url.pathname)));
        if (!allowed) {
          report.forbiddenRequests.push({ method: request.method(), path: url.pathname });
          await route.abort();
        } else await route.continue();
      });
      const page = await context.newPage();
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) report.lastPath = new URL(frame.url()).pathname;
      });
      page.setDefaultTimeout(15000);
      await open(page, '/login');
      report.currentStep = 'login';
      await page
        .getByLabel('メールアドレス', { exact: true })
        .fill(`${role.code}@acme.example.test`);
      await page.getByLabel('パスワード', { exact: true }).fill(password);
      const landing = role.inbox ? '/inbox' : role.code === 'auditor' ? '/changes' : '/portal';
      await Promise.all([
        page.waitForURL((url) => [landing, '/select-organization'].includes(url.pathname)),
        page.getByRole('button', { name: 'ログイン', exact: true }).click(),
      ]);
      await page.waitForLoadState('networkidle');
      if (new URL(page.url()).pathname === '/select-organization') {
        report.currentStep = 'select organization';
        await page.getByLabel('サンプル株式会社', { exact: true }).check();
        await Promise.all([
          page.waitForURL((url) => url.pathname === landing),
          page.getByRole('button', { name: 'この組織で続ける', exact: true }).click(),
        ]);
      }

      await open(page, '/portal');
      assert.equal(await page.locator('.fs-rail').count(), 0);
      await axe(page, `${role.code}-portal`);
      const menu = page.locator('.fs-support-menu-panel');
      await page.locator('.fs-support-menu > summary').click();
      const work = (
        await menu.locator('a').evaluateAll((links) => links.map((a) => a.getAttribute('href')))
      ).filter((href) => ['/inbox', '/assets', '/changes'].includes(href));
      assert.deepEqual(work, role.work, `${role.code}: support work links`);
      await screenshot(page, `${role.code}-menu`);
      for (const path of role.work) {
        await navigate(page, menu.locator(`a[href="${path}"]`), path);
        report.checks.push({ name: `${role.code}-work-route`, path });
        await open(page, '/portal');
        await page.locator('.fs-support-menu > summary').click();
      }

      await open(page, '/knowledge');
      assert.equal(await page.locator('.fs-rail').count(), role.staff ? 1 : 0);
      if (!role.staff) {
        await page.locator('.fs-support-menu > summary').click();
        const retained = (
          await menu.locator('a').evaluateAll((links) => links.map((a) => a.getAttribute('href')))
        ).filter((href) => ['/inbox', '/assets', '/changes'].includes(href));
        assert.deepEqual(retained, role.work);
      }
      await axe(page, `${role.code}-knowledge`);

      await open(page, '/portal');
      const card = page.locator('.support-card--approval');
      const destination = role.inbox ? '/inbox' : '/requests?view=mine';
      assert.equal(await card.getAttribute('href'), destination);
      assert.ok(
        (await card.innerText()).includes(role.inbox ? '担当業務を確認する' : '申請状況を確認する'),
      );
      await navigate(page, card, role.inbox ? '/inbox' : '/requests');
      if (role.inbox) {
        await page.getByRole('heading', { name: '業務受信箱', exact: true }).waitFor();
        const approvalCount = page.locator('.inbox-summary p').filter({ hasText: '自分への承認' });
        await approvalCount.waitFor();
        assert.match(await approvalCount.innerText(), /自分への承認\s*\d+件/);
      } else assert.equal(new URL(page.url()).searchParams.get('view'), 'mine');
      report.checks.push({ name: `${role.code}-personal-work-card`, destination });

      if (role.code === 'requester') {
        await searchWithKeyboard(page, 'search-keyboard-desktop');
        await page.setViewportSize({ width: 375, height: 812 });
        await searchWithKeyboard(page, 'search-keyboard-mobile');
        await open(page, '/portal');
        const width = await page.evaluate(() => ({
          body: document.body.scrollWidth,
          viewport: innerWidth,
        }));
        assert.ok(width.body <= width.viewport, 'Mobile portal must not overflow');
        report.checks.push({ name: 'portal-mobile-width', ...width });
        await axe(page, 'requester-portal-mobile');
        await screenshot(page, 'portal-mobile');
      }
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(report.forbiddenRequests, []);
  report.success = true;
}

try {
  await main();
} catch (error) {
  // Do not dump request objects or a filled login form on failure.
  report.failure = String(error.message).replaceAll(password, '<redacted>');
  console.error('SOLVI support UI regression failed; inspect the named checks in summary.json.');
  process.exitCode = 1;
} finally {
  await browser?.close();
  await mkdir(output, { recursive: true });
  await writeFile(
    resolve(output, 'summary.json'),
    JSON.stringify({ ...report, screenshots }, null, 2) + '\n',
  );
  console.log(
    `Support UI: ${report.success ? 'PASS' : 'FAIL'}; ${report.checks.length} checks; ${report.accessibility.length} axe scans`,
  );
}
