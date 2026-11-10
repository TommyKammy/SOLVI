/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import { access, chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
const root = fileURLToPath(new URL('../', import.meta.url));
const evidenceRoot = resolve(root, 'evidence/WP-P3-CITDET-081');
const ticketId = '08100000-0000-4000-8000-00000000001a';
const commentId = '08100000-0000-4000-8000-00000000001b';
const articleId = '08100000-0000-4000-8000-00000000001c';
const parentPath = '/requests?' + new URLSearchParams({ q: '合成' });
const returnPath = '/tickets/' + ticketId + '?' + new URLSearchParams({ returnTo: parentPath });
const rawReturnPath =
  '/tickets/' + ticketId + '?returnTo=' + encodeURIComponent('/requests?q=合成');
const entry = (from = returnPath, ticket = ticketId, comment = commentId) => {
  const q = new URLSearchParams();
  if (from) q.set('returnTo', from);
  return (
    '/tickets/' +
    encodeURIComponent(ticket) +
    '/citations/' +
    encodeURIComponent(comment) +
    (q.size ? '?' + q.toString() : '')
  );
};
const faultModes = [
  '400',
  '401',
  '403',
  '500',
  '503',
  'network',
  'body_cut',
  'invalid_json',
  '403_body_cut',
];
const expectedChecks = 32;
export async function runCitationDetailRecoveryChecks({
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
    workPackage: 'WP-P3-CITDET-081',
    model: 'Real copied production Next.js with loopback synthetic API and synthetic session.',
    actualCitationRendererTested: true,
    actualTicketExitRendererTested: true,
    actualFormRendererTested: false,
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
    assert.ok(
      !/PRIVATE_WP081|合成の引用版記事|引用版1の手順|合成文字列|08100000/.test(
        await main().innerText(),
      ),
    );
  }
  async function rejected(status = '503') {
    step = 'fixed-failure';
    await main()
      .getByRole('heading', { level: 1, name: '引用記事を表示できません', exact: true })
      .waitFor();
    const message = status.startsWith('401')
      ? 'ログイン状態を確認できませんでした。ログインし直してから、もう一度お試しください。'
      : status.startsWith('403')
        ? '引用記事を表示する権限がありません。選択中の組織を確認するか、管理者にご相談ください。'
        : status === '400'
          ? '引用記事の指定が正しくありません。問い合わせから開き直してください。'
          : '一時的に引用記事を読み込めませんでした。時間をおいて、もう一度お試しください。';
    assert.equal(await main().getByRole('alert').innerText(), message);
    await noSensitiveFields();
    assert.equal(await retry().getAttribute('href'), entry());
    assert.equal(await back().getAttribute('href'), returnPath);
  }
  async function successful(actor = 'requester', from = returnPath) {
    step = 'normal';
    await main()
      .getByRole('heading', { name: '合成の引用版記事', level: 1, exact: true })
      .waitFor();
    const text = await main().innerText();
    assert.ok(text.includes('返信で引用した版 1'));
    assert.ok(text.includes('記事の最新の版とは異なる場合があります。'));
    assert.equal(await main().locator('form').count(), 0);
    assert.equal(await main().locator('script').count(), 0);
    assert.ok((await main().locator('article').innerText()).includes('引用版1の手順です。'));
    assert.ok(
      (await main().locator('article').innerText()).includes('<script>合成文字列</script>'),
    );
    assert.ok(!text.includes('現在公開版2の手順です。'));
    const current = new URL(
      await main()
        .getByRole('link', { name: '現在公開されている記事を確認する', exact: true })
        .getAttribute('href'),
      target,
    );
    assert.equal(current.origin, target.origin);
    assert.equal(current.pathname, '/knowledge/' + articleId);
    assert.equal(current.searchParams.get('returnTo'), entry(from));
    const ticketBack = new URL(
      await main()
        .getByRole('link', { name: from ? '元の画面へ戻る' : '問い合わせへ戻る', exact: true })
        .getAttribute('href'),
      target,
    );
    assert.equal(ticketBack.origin, target.origin);
    assert.equal(
      ticketBack.pathname,
      '/' + (from || actor === 'requester' ? 'tickets' : 'ops') + '/' + ticketId,
    );
    assert.equal(ticketBack.searchParams.get('returnTo'), from ? parentPath : null);
    return {
      citationVersion: 1,
      publishedPointerFixture: 2,
      currentPublicAvailabilityTested: false,
      immutableRenderer: true,
      submitted: false,
    };
  }
  async function hidden() {
    await main()
      .getByRole('heading', { name: 'お探しの画面は見つかりませんでした', exact: true })
      .waitFor();
    await noSensitiveFields();
    assert.equal(await retry().count(), 0);
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
          : u.pathname === '/knowledge/' + articleId
            ? '/knowledge/[id]'
            : 'other';
        report.prefetch.pathnameCounts[path] = (report.prefetch.pathnameCounts[path] ?? 0) + 1;
        for (const key of ['next-router-prefetch', 'purpose', 'sec-purpose']) {
          if (key === 'next-router-prefetch' ? h[key] === '1' : /prefetch/.test(h[key] ?? ''))
            report.prefetch.headerKinds[key] = (report.prefetch.headerKinds[key] ?? 0) + 1;
        }
        return route.abort('blockedbyclient');
      }
      if (
        ![
          '/tickets/' + ticketId + '/citations/' + commentId,
          '/tickets/' + ticketId.toUpperCase() + '/citations/' + commentId,
          '/tickets/safe-ticket/citations/safe-comment',
          '/tickets/' + ticketId,
          '/ops/' + ticketId,
          '/knowledge/' + articleId,
          '/portal',
          '/api/draft-scope',
          '/favicon.ico',
        ].includes(u.pathname) &&
        !u.pathname.startsWith('/_next/')
      ) {
        report.browserRequests.unknownReads++;
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    const role = async (value) =>
      context.addCookies([
        {
          name: 'solvi_session_wp081_synthetic',
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
    for (const actor of ['requester', 'agent', 'org_admin']) {
      await role(actor);
      await check('normal-' + actor, async () => {
        await scenario({});
        await open(entry(null));
        const d = await successful(actor, null);
        await shot('normal-' + actor);
        return d;
      });
    }
    await role('requester');
    for (const visibility of ['retired', 'staff', 'internal'])
      await check('requester-hidden-' + visibility, async () => {
        await scenario({ visibility });
        await open(entry());
        await hidden();
        await shot('requester-hidden-' + visibility);
        return { syntheticVisibilityProjectionOnly: true };
      });
    await role('agent');
    for (const visibility of ['retired', 'internal'])
      await check('staff-history-' + visibility, async () => {
        await scenario({ visibility });
        await open(entry());
        const d = await successful('agent');
        await shot('staff-history-' + visibility);
        return { ...d, syntheticVisibilityProjectionOnly: true };
      });
    await role('requester');
    await check('current-public-version', async () => {
      await scenario({});
      await open(entry());
      await successful();
      const href = await main()
        .getByRole('link', { name: '現在公開されている記事を確認する', exact: true })
        .getAttribute('href');
      const before = allReads().length;
      await open(href);
      await main().getByRole('heading', { name: '合成の現在公開記事', exact: true }).waitFor();
      assert.ok((await main().locator('article').innerText()).includes('現在公開版2の手順です。'));
      assert.ok(!(await main().innerText()).includes('引用版1の手順です。'));
      assert.ok(
        allReads()
          .slice(before)
          .some((x) => x.route === 'article'),
      );
      await shot('current-public-version');
      return { citationVersion: 1, currentPublishedVersion: 2, actualDocumentGet: true };
    });
    for (const mode of faultModes)
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
        return { nativeDocumentGet: true, apiReadsIncreased: true };
      });
    for (const mode of ['404', '404_body_cut'])
      await check('not-found-' + mode, async () => {
        await scenario({ mode });
        await open(entry());
        await hidden();
        await shot('not-found-' + mode);
      });
    await check('retry-query-allowlist', async () => {
      await scenario({ mode: '503' });
      await open(entry(rawReturnPath) + '&saved=1&manage=1&unknown=PRIVATE');
      await rejected();
      const canonicalRetry = new URL(await retry().getAttribute('href'), target);
      assert.equal(canonicalRetry.pathname, `/tickets/${ticketId}/citations/${commentId}`);
      assert.equal(canonicalRetry.searchParams.get('returnTo'), returnPath);
      const canonicalTicket = new URL(canonicalRetry.searchParams.get('returnTo'), target);
      assert.equal(canonicalTicket.pathname, '/tickets/' + ticketId);
      assert.equal(canonicalTicket.searchParams.get('returnTo'), parentPath);
      assert.equal(
        new URL(canonicalTicket.searchParams.get('returnTo'), target).searchParams.get('q'),
        '合成',
      );
      await shot('retry-query-allowlist');
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
    });
    for (const [name, actor, path, label, heading, from] of [
      ['origin', 'requester', returnPath, '元の画面へ戻る', '合成の問い合わせ', returnPath],
      [
        'requester-ticket',
        'requester',
        '/tickets/' + ticketId,
        '問い合わせへ戻る',
        '合成の問い合わせ',
        null,
      ],
      ['staff-ticket', 'agent', '/ops/' + ticketId, '問い合わせへ戻る', '合成の問い合わせ', null],
      ['portal', 'requester', '/portal', 'ポータルへ戻る', 'あなたのITサポート', returnPath],
    ])
      await check('native-' + name, async () => {
        await role(actor);
        await scenario({ mode: '503' });
        await open(entry(from));
        await noSensitiveFields();
        await scenario({});
        const before = allReads().length;
        await native(main().getByRole('link', { name: label, exact: true }), path);
        await main().getByRole('heading', { level: 1, name: heading, exact: true }).waitFor();
        assert.ok(allReads().length > before);
        await shot('native-' + name);
        return {
          nativeDocumentGet: true,
          apiReadsIncreased: true,
          actualExitRenderer: true,
          submitted: false,
        };
      });
    await role('requester');
    for (const [name, query] of [
      ['unsafe', 'returnTo=https%3A%2F%2Fexample.invalid&saved=1&unknown=PRIVATE'],
      ['plural', 'returnTo=%2Fknowledge&returnTo=%2Fportal'],
    ])
      await check(name, async () => {
        await scenario({ mode: '503' });
        await open(entry(null) + '?' + query);
        await noSensitiveFields();
        assert.equal(await retry().getAttribute('href'), entry(null));
        assert.equal(await back().count(), 0);
        assert.equal(
          await main()
            .getByRole('link', { name: '問い合わせへ戻る', exact: true })
            .getAttribute('href'),
          '/tickets/' + ticketId,
        );
        await shot(name);
      });
    for (const [name, ticket, comment, apiRoute] of [
      ['nonuuid-authoritative-404', 'safe-ticket', 'safe-comment', 'nonuuid'],
      ['uppercase-authoritative-404', ticketId.toUpperCase(), commentId, 'uppercase'],
    ])
      await check(name, async () => {
        await scenario({});
        const before = allReads().length;
        await open(entry(null, ticket, comment));
        await hidden();
        assert.ok(
          allReads()
            .slice(before)
            .some((x) => x.route === apiRoute),
        );
        await shot(name);
        return { reachedAuthoritativeHttp: true, inputCasePreserved: true };
      });
    await check('keyboard-focus-enter', async () => {
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
      await shot('keyboard-focus');
      await scenario({});
      const before = candidateReads().length;
      await native(retry(), entry(), true);
      await successful();
      assert.ok(candidateReads().length > before);
      return { nativeDocumentGet: true, tabFocusVisible: true };
    });
    for (const mode of ['503', 'normal'])
      await check('mobile-' + mode, async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        await scenario({ mode });
        await open(entry());
        if (mode === 'normal') await successful();
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
    report.failureCode = signal?.aborted ? 'CITATION_UI_ABORTED' : 'CITATION_UI_FAILURE';
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
  if (signal?.aborted) throw new Error('CITATION_UI_ABORTED');
  return report;
}
