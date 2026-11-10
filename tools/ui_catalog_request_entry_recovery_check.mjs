/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import { access, chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
const root = fileURLToPath(new URL('../', import.meta.url));
const evidenceRoot = resolve(root, 'evidence/WP-P2-CATREQ-079');
const returnPath = '/catalog?' + new URLSearchParams({ q: '合成' });
const itemId = '07900000-0000-4000-8000-000000000010';
const organizationId = '07900000-0000-4000-8000-000000000001';
const userId = '07900000-0000-4000-8000-000000000002';
const approverId = '07900000-0000-4000-8000-000000000003';
const entry = (from = returnPath, id = itemId) =>
  '/catalog/' +
  encodeURIComponent(id) +
  (from ? '?' + new URLSearchParams({ returnTo: from }) : '');
const faultModes = [
  '400',
  '401',
  '403',
  '404',
  '500',
  '503',
  'network',
  'body_cut',
  'invalid_json',
  '403_body_cut',
  '404_body_cut',
];
const expectedChecks = 31;
export async function runCatalogRequestEntryRecoveryChecks({
  baseURL,
  outputDirectory,
  control,
  candidateReads,
  allReads,
  assertOwned,
  signal,
}) {
  const target = new URL(baseURL),
    output = resolve(outputDirectory),
    within = relative(evidenceRoot, output);
  assert.ok(
    target.protocol === 'http:' &&
      target.hostname === '127.0.0.1' &&
      target.port &&
      !['3000', '3001'].includes(target.port) &&
      target.pathname === '/' &&
      !target.username &&
      !target.password &&
      !target.search &&
      !target.hash,
  );
  assert.ok(within && !within.startsWith('..') && !isAbsolute(within));
  assert.equal(await realpath(dirname(output)), dirname(output));
  for (const cb of [control, candidateReads, allReads, assertOwned])
    assert.equal(typeof cb, 'function');
  await access(chromium.executablePath());
  await mkdir(output, { mode: 0o700 });
  const report = {
    workPackage: 'WP-P2-CATREQ-079',
    model: 'Real copied production Next.js with loopback synthetic API and synthetic session.',
    actualPublicCatalogRendererTested: true,
    actualFormRendererTested: true,
    formSubmissionTested: false,
    realAuthorizationTested: false,
    realDatabaseTested: false,
    productionAcceptance: false,
    checks: [],
    screenshots: [],
    axe: [],
    browserRequests: { nonReadCount: 0, methods: {}, downloads: 0, unknownReads: 0 },
    prefetch: { attempted: 0, blocked: 0, forwarded: 0, pathnameCounts: {}, headerKinds: {} },
    cleanup: { browserClosed: false },
    success: false,
  };
  let browser,
    context,
    page,
    step = 'initial';
  const live = async () => {
    assert.ok(!signal?.aborted);
    await assertOwned();
    assert.ok(!signal?.aborted);
  };
  const main = () => page.locator('main');
  const retry = () => main().getByRole('link', { name: '再取得する', exact: true });
  const back = () => main().getByRole('link', { name: '元の画面へ戻る', exact: true });
  const scenario = async (next) => {
    await live();
    await control(next);
  };
  const open = async (path) => {
    step = 'document';
    await live();
    await page.goto(target.origin + path, { waitUntil: 'domcontentloaded' });
    await main().getByRole('heading', { level: 1 }).waitFor();
  };
  async function noSensitiveFields() {
    assert.equal(await main().locator('form').count(), 0);
    assert.ok(!/PRIVATE_WP079|合成公開サービス|合成承認者|07900000/.test(await main().innerText()));
  }
  async function rejected(status = '503') {
    step = 'fixed-failure';
    await main()
      .getByRole('heading', { level: 1, name: '申請画面を表示できません', exact: true })
      .waitFor();
    const message = status.startsWith('401')
      ? 'ログイン状態を確認できませんでした。ログインし直してから、もう一度お試しください。'
      : status.startsWith('403')
        ? 'このサービスを表示する権限がありません。選択中の組織を確認するか、管理者にご相談ください。'
        : status.startsWith('404')
          ? '現在サービスカタログを利用できません。時間をおいて、もう一度お試しください。'
          : status === '400'
            ? 'サービスの取得条件を確認できませんでした。カタログから選び直してください。'
            : '一時的に申請画面を読み込めませんでした。時間をおいて、もう一度お試しください。';
    assert.equal(await main().getByRole('alert').innerText(), message);
    await noSensitiveFields();
    assert.equal(await retry().getAttribute('href'), entry());
    assert.equal(await back().getAttribute('href'), returnPath);
  }
  async function successful(variant = 'fixed') {
    step = 'normal';
    await main()
      .getByRole('heading', { name: '合成公開サービス', level: 1, exact: true })
      .waitFor();
    assert.ok((await main().innerText()).includes('公開版2の申請入力を確認する合成の説明です。'));
    assert.ok((await main().innerText()).includes('ローカル模擬申請です。'));
    await page.waitForFunction(() => {
      const f = document.querySelector('main form');
      return (
        f &&
        !f.hasAttribute('inert') &&
        f.getAttribute('aria-busy') === 'false' &&
        f.querySelector('[name="idempotencyKey"]')?.value
      );
    });
    const form = main().locator('form');
    assert.equal(await form.count(), 1);
    assert.equal(await form.locator('[name="itemId"]').inputValue(), itemId);
    assert.equal(await form.locator('[name="itemVersion"]').inputValue(), '2');
    assert.equal(await form.locator('[name="expectedVersion"]').inputValue(), '1');
    assert.equal(
      await form.locator('[name="formScope"]').inputValue(),
      organizationId + ':' + userId,
    );
    assert.match(
      await form.locator('[name="idempotencyKey"]').inputValue(),
      /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i,
    );
    assert.equal(await form.locator('[name="reason"]').inputValue(), '');
    assert.equal(await form.locator('[name="reason"]').getAttribute('maxlength'), '120');
    assert.ok(await form.locator('[name="reason"]').evaluate((n) => n.required));
    assert.equal(await form.locator('[name="durationDays"]').inputValue(), '7');
    assert.deepEqual(await form.locator('[name="durationDays"] option').allTextContents(), [
      '7日',
      '30日',
    ]);
    const legacy = variant.startsWith('legacy');
    const unavailable = [
      'fixed-missing-other',
      'fixed-missing-empty',
      'fixed-self',
      'legacy-empty',
    ].includes(variant);
    if (legacy) {
      const select = form.locator('select[name="approverId"]');
      assert.equal(await select.inputValue(), '');
      assert.ok(await select.evaluate((n) => n.required));
      assert.deepEqual(
        await select.locator('option').allTextContents(),
        variant === 'legacy-empty'
          ? ['承認者を選んでください']
          : ['承認者を選んでください', '合成承認者A', '合成承認者B'],
      );
    } else {
      assert.equal(await form.locator('select[name="approverId"]').count(), 0);
      assert.equal(
        await form.locator('input[type="hidden"][name="approverId"]').inputValue(),
        variant === 'fixed-self' ? userId : approverId,
      );
      assert.ok(
        (await form.innerText()).includes(
          unavailable ? '現在依頼できる承認者がいません' : '合成承認者A',
        ),
      );
    }
    assert.equal(
      await form.getByRole('button', { name: '申請する（模擬）', exact: true }).isDisabled(),
      unavailable,
    );
    assert.equal(await form.getByRole('alert').count(), unavailable ? 1 : 0);
    if (unavailable)
      assert.equal(
        await form.getByRole('alert').innerText(),
        '現在選べる承認者がいません。管理者へご連絡ください。',
      );
    if (variant === 'fields') {
      for (const [key, tag, required, max] of [
        ['purpose', 'INPUT', true, '100'],
        ['detail', 'TEXTAREA', false, '500'],
        ['location', 'SELECT', true, null],
        ['consent', 'INPUT', true, null],
      ]) {
        const el = form.locator('[name="value:' + key + '"]');
        assert.equal(await el.evaluate((n) => n.tagName), tag);
        assert.equal(await el.evaluate((n) => n.required), required);
        if (max) assert.equal(await el.getAttribute('maxlength'), max);
        if (key === 'consent') {
          assert.equal(await el.isChecked(), false);
          assert.equal(await form.locator('[name="checkbox:consent"]').inputValue(), '1');
        } else assert.equal(await el.inputValue(), '');
      }
      assert.deepEqual(await form.locator('[name="value:location"] option').allTextContents(), [
        '選んでください',
        '東京',
        '大阪',
      ]);
    } else assert.equal(await form.locator('[name^="value:"]').count(), 0);
    assert.equal(
      await page.evaluate(
        () => Object.keys(sessionStorage).filter((k) => k.includes('request:new:')).length,
      ),
      0,
    );
    return {
      realFormReady: true,
      publicVersion: 2,
      expectedVersion: 1,
      idempotencyKeyUuid: true,
      scopePreserved: true,
      variant,
      submitDisabled: unavailable,
      submitted: false,
      draftSaved: false,
    };
  }
  async function native(link, path, keyboard = false) {
    step = 'native-GET';
    assert.equal(await link.evaluate((n) => n.tagName), 'A');
    assert.equal(await link.getAttribute('href'), path);
    const request = page.waitForRequest(
      (r) => r.isNavigationRequest() && r.method() === 'GET' && r.url() === target.origin + path,
    );
    await Promise.all([request, keyboard ? page.keyboard.press('Enter') : link.click()]);
    await page.waitForURL(target.origin + path, { waitUntil: 'domcontentloaded' });
    await main().getByRole('heading', { level: 1 }).waitFor();
    assert.equal(page.url(), target.origin + path);
  }
  async function shot(name) {
    step = 'capture';
    await live();
    const filename = name + '.png';
    await page.screenshot({ path: resolve(output, filename), fullPage: true });
    await chmod(resolve(output, filename), 0o600);
    report.screenshots.push(filename);
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    report.axe.push({
      state: name,
      violations: result.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.length,
      })),
    });
    assert.equal(result.violations.length, 0);
  }
  async function check(name, task) {
    try {
      await live();
      const detail = await task();
      report.checks.push({ name, passed: true, ...detail });
    } catch {
      report.checks.push({ name, passed: false, step });
    }
  }
  let cancellation = Promise.resolve();
  const onAbort = () => {
    cancellation = Promise.allSettled([
      Promise.resolve().then(() => context?.close()),
      Promise.resolve().then(() => browser?.close()),
    ]).then(() => undefined);
  };
  try {
    await live();
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    context.on('request', (request) => {
      const method = request.method();
      if (!['GET', 'HEAD'].includes(method)) {
        report.browserRequests.nonReadCount++;
        const key = ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)
          ? method
          : 'OTHER';
        report.browserRequests.methods[key] = (report.browserRequests.methods[key] ?? 0) + 1;
      }
    });
    await context.route('**/*', async (route) => {
      const request = route.request(),
        u = new URL(request.url()),
        h = request.headers();
      if (!['GET', 'HEAD'].includes(request.method())) return route.abort('blockedbyclient');
      if (u.origin !== target.origin) {
        report.browserRequests.unknownReads++;
        return route.abort('blockedbyclient');
      }
      if (
        h['next-router-prefetch'] === '1' ||
        /prefetch/.test(h.purpose ?? h['sec-purpose'] ?? '')
      ) {
        report.prefetch.attempted++;
        report.prefetch.blocked++;
        const knownPaths = new Set([
          '/portal',
          '/catalog',
          '/catalog/manage',
          '/knowledge',
          '/requests',
          '/assets',
          '/changes',
          '/inbox',
          '/ops',
          '/ops/overview',
          '/ops/users',
          '/ops/groups',
          '/ops/notifications',
          '/settings/notifications',
        ]);
        const path = knownPaths.has(u.pathname)
          ? u.pathname
          : u.pathname === '/catalog/' + itemId
            ? '/catalog/[itemId]'
            : 'other';
        report.prefetch.pathnameCounts[path] = (report.prefetch.pathnameCounts[path] ?? 0) + 1;
        for (const key of ['next-router-prefetch', 'purpose', 'sec-purpose']) {
          if (key === 'next-router-prefetch' ? h[key] === '1' : /prefetch/.test(h[key] ?? ''))
            report.prefetch.headerKinds[key] = (report.prefetch.headerKinds[key] ?? 0) + 1;
        }
        return route.abort('blockedbyclient');
      }
      if (
        !/^\/(?:catalog(?:\/.*)?|portal|api\/draft-scope|_next\/.*|favicon.ico)$/.test(u.pathname)
      ) {
        report.browserRequests.unknownReads++;
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    const role = async (value) =>
      context.addCookies([
        {
          name: 'solvi_session_wp079_synthetic',
          value,
          url: target.origin,
          httpOnly: true,
          sameSite: 'Lax',
        },
      ]);
    await role('requester');
    page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('download', () => report.browserRequests.downloads++);
    signal?.addEventListener('abort', onAbort, { once: true });
    for (const actor of ['requester', 'approver', 'agent', 'org_admin']) {
      await role(actor);
      await check('normal-' + actor, async () => {
        await scenario({});
        await open(entry());
        const detail = await successful();
        await shot('normal-' + actor);
        return detail;
      });
    }
    await role('requester');
    for (const variant of [
      'fixed-missing-other',
      'fixed-missing-empty',
      'fixed-self',
      'legacy',
      'legacy-empty',
      'fields',
    ]) {
      await check('normal-' + variant, async () => {
        await scenario({ variant });
        await open(entry());
        const detail = await successful(variant);
        await shot('normal-' + variant);
        return detail;
      });
    }
    for (const mode of faultModes) {
      await check('failure-recovery-' + mode, async () => {
        await scenario({ mode });
        await open(entry());
        await rejected(mode);
        await shot('failure-' + mode);
        await scenario({});
        const before = candidateReads().length;
        await native(retry(), entry());
        await successful();
        assert.ok(candidateReads().length > before);
        assert.ok(
          candidateReads()
            .slice(before)
            .every((x) => x.query === ''),
        );
        return { nativeDocumentGet: true, apiReadsIncreased: true, recoveredActualForm: true };
      });
    }
    await check('healthy-item-absent', async () => {
      await scenario({ empty: true });
      await open(entry());
      await main()
        .getByRole('heading', { name: 'お探しの画面は見つかりませんでした', exact: true })
        .waitFor();
      await noSensitiveFields();
      assert.equal(await retry().count(), 0);
      await shot('healthy-item-absent');
    });
    for (const [name, label, path, heading, from] of [
      ['origin', '元の画面へ戻る', returnPath, 'サービスカタログ', returnPath],
      ['fallback', 'カタログへ戻る', '/catalog', 'サービスカタログ', null],
      ['portal', 'ポータルへ戻る', '/portal', 'あなたのITサポート', returnPath],
    ]) {
      await check('native-' + name, async () => {
        await scenario({ mode: '503' });
        await open(entry(from));
        await noSensitiveFields();
        await scenario({});
        const before = allReads().length;
        await native(main().getByRole('link', { name: label, exact: true }), path);
        await main().getByRole('heading', { name: heading, exact: true, level: 1 }).waitFor();
        assert.ok(allReads().length > before);
        if (name === 'origin')
          assert.equal(await main().locator('input[name="q"]').inputValue(), '合成');
        if (name === 'portal')
          for (const route of ['catalog', 'requests', 'tickets'])
            assert.ok(
              allReads()
                .slice(before)
                .some((x) => x.route === route),
            );
        await shot('native-' + name);
        return { nativeDocumentGet: true, apiReadsIncreased: true };
      });
    }
    for (const [name, query] of [
      ['unsafe', 'returnTo=https%3A%2F%2Fexample.invalid&saved=1&unknown=PRIVATE'],
      ['plural', 'returnTo=%2Fcatalog&returnTo=%2Fportal&updated=1&unknown=PRIVATE'],
    ]) {
      await check(name, async () => {
        await scenario({ mode: '503' });
        await open(entry(null) + '?' + query);
        await noSensitiveFields();
        assert.equal(await retry().getAttribute('href'), entry(null));
        assert.equal(await back().count(), 0);
        await shot(name);
      });
    }
    await check('non-uuid-id-is-fixed-read', async () => {
      await scenario({ mode: '503' });
      const before = candidateReads().length;
      await open(entry(returnPath, 'legacy-code'));
      await noSensitiveFields();
      assert.equal(await retry().getAttribute('href'), entry(returnPath, 'legacy-code'));
      assert.ok(candidateReads().length > before);
      assert.ok(
        candidateReads()
          .slice(before)
          .every((x) => x.query === ''),
      );
      await shot('non-uuid-id');
      return { fixedCatalogReadOnly: true, noIdAuthorizationClaim: true };
    });
    await check('keyboard-visible-focus-enter', async () => {
      await scenario({ mode: '503' });
      await open(entry());
      await rejected();
      let focused = false;
      for (let i = 0; i < 40 && !focused; i++) {
        await page.keyboard.press('Tab');
        focused = await retry().evaluate((n) => n === document.activeElement);
      }
      assert.ok(focused);
      const focus = await retry().evaluate((n) => {
        const s = getComputedStyle(n);
        return {
          visible: n.matches(':focus-visible'),
          outline: s.outlineStyle,
          width: s.outlineWidth,
          shadow: s.boxShadow,
        };
      });
      assert.ok(
        focus.visible &&
          ((focus.outline !== 'none' && parseFloat(focus.width) > 0) || focus.shadow !== 'none'),
      );
      await shot('keyboard-before-enter');
      await scenario({});
      const before = candidateReads().length;
      await native(retry(), entry(), true);
      await successful();
      assert.ok(candidateReads().length > before);
      return { tabFocusVisible: true, nativeDocumentGet: true };
    });
    for (const mode of ['503', 'normal'])
      await check('mobile-' + mode, async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        await scenario({ mode, variant: 'fields' });
        await open(entry());
        if (mode === 'normal') await successful('fields');
        else await rejected();
        const dimensions = await page.evaluate(() => ({
          width: document.documentElement.clientWidth,
          scroll: document.documentElement.scrollWidth,
        }));
        assert.ok(dimensions.scroll <= dimensions.width);
        await shot('mobile-' + mode);
        return dimensions;
      });
  } catch {
    report.failureCode = signal?.aborted ? 'CATALOG_UI_ABORTED' : 'CATALOG_UI_FAILURE';
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await cancellation;
    try {
      await browser?.close();
      report.cleanup.browserClosed = true;
    } catch {
      report.cleanup.browserClosed = false;
    }
    report.success =
      !signal?.aborted &&
      !report.failureCode &&
      report.checks.length === expectedChecks &&
      report.checks.every((x) => x.passed) &&
      report.browserRequests.nonReadCount === 0 &&
      report.browserRequests.downloads === 0 &&
      report.browserRequests.unknownReads === 0 &&
      report.cleanup.browserClosed;
    await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  }
  if (signal?.aborted) throw new Error('CATALOG_UI_ABORTED');
  return report;
}
