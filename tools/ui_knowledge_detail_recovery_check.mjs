/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import { access, chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
const root = fileURLToPath(new URL('../', import.meta.url));
const evidenceRoot = resolve(root, 'evidence/WP-P3-KNWDET-080');
const returnPath = '/knowledge?' + new URLSearchParams({ q: '合成' });
const itemId = '08000000-0000-4000-8000-000000000010';
const entry = (manage = false, from = returnPath, id = itemId) => {
  const q = new URLSearchParams();
  if (manage) q.set('manage', '1');
  if (from) q.set('returnTo', from);
  return '/knowledge/' + encodeURIComponent(id) + (q.size ? '?' + q.toString() : '');
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
const expectedChecks = 33;
export async function runKnowledgeDetailRecoveryChecks({
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
    workPackage: 'WP-P3-KNWDET-080',
    model: 'Real copied production Next.js with loopback synthetic API and synthetic session.',
    actualKnowledgeRendererTested: true,
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
    assert.ok(
      !/PRIVATE_WP080|合成の最新編集記事|合成の旧公開記事|合成文字列|08000000/.test(
        await main().innerText(),
      ),
    );
  }
  async function rejected(status = '503', manage = false) {
    step = 'fixed-failure';
    await main()
      .getByRole('heading', { level: 1, name: '記事を表示できません', exact: true })
      .waitFor();
    const message = status.startsWith('401')
      ? 'ログイン状態を確認できませんでした。ログインし直してから、もう一度お試しください。'
      : status.startsWith('403')
        ? 'この記事を表示する権限がありません。選択中の組織を確認するか、管理者にご相談ください。'
        : status === '400'
          ? '記事の指定が正しくありません。記事一覧から開き直してください。'
          : '一時的に記事を読み込めませんでした。時間をおいて、もう一度お試しください。';
    assert.equal(await main().getByRole('alert').innerText(), message);
    await noSensitiveFields();
    assert.equal(await retry().getAttribute('href'), entry(manage));
    assert.equal(await back().getAttribute('href'), returnPath);
  }
  async function successful({
    manage = false,
    state = 'draft',
    actor = 'requester',
    audience = 'organization',
    saved = false,
  } = {}) {
    step = 'normal';
    await main()
      .getByRole('heading', {
        name: manage ? '合成の最新編集記事' : '合成の旧公開記事',
        level: 1,
        exact: true,
      })
      .waitFor();
    const text = await main().innerText();
    assert.ok(
      text.includes(
        '版 ' + (manage ? 7 : 2) + ' · ' + (audience === 'staff' ? '担当者限定' : '組織内'),
      ),
    );
    assert.equal(await main().getByRole('status').count(), saved ? 1 : 0);
    assert.equal(await main().locator('script').count(), 0);
    if (!manage) {
      assert.equal(await main().locator('form').count(), 0);
      assert.ok((await main().locator('article').innerText()).includes('公開版2の手順です。'));
      assert.ok(
        (await main().locator('article').innerText()).includes('<script>合成文字列</script>'),
      );
      assert.ok(text.includes('合成, 手順'));
      const inquiry = new URL(
        await main()
          .getByRole('link', { name: '問い合わせてください', exact: true })
          .getAttribute('href'),
        target,
      );
      assert.equal(inquiry.pathname, '/tickets/new');
      assert.equal(inquiry.searchParams.get('kind'), 'incident');
    } else {
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('main form')].length > 0 &&
          [...document.querySelectorAll('main form')].every(
            (f) => !f.hasAttribute('inert') && f.getAttribute('aria-busy') === 'false',
          ),
      );
      const editor = ['draft', 'published'].includes(state);
      assert.equal(await main().locator('form').count(), editor ? 2 : 1);
      const values = await main()
        .locator('input[name="expectedVersion"]')
        .evaluateAll((ns) => ns.map((n) => n.value));
      assert.deepEqual(values, editor ? ['7', '7'] : ['7']);
      if (editor) {
        for (const [name, value, max] of [
          ['title', '合成の最新編集記事', '200'],
          [
            'body',
            '編集版7の手順です。\n<script>合成文字列</script>を文章として表示します。',
            '20000',
          ],
          ['tags', '合成, 手順', '500'],
        ]) {
          const el = main().locator('[name="' + name + '"]');
          assert.equal(await el.inputValue(), value);
          assert.equal(await el.getAttribute('maxlength'), max);
        }
        assert.equal(await main().locator('[name="audience"]').inputValue(), audience);
        assert.ok(
          await main()
            .locator('[name="title"]')
            .evaluate((n) => n.required),
        );
        assert.ok(
          await main()
            .locator('[name="body"]')
            .evaluate((n) => n.required),
        );
        assert.equal(
          await main().getByRole('button', { name: '下書きを保存する', exact: true }).isDisabled(),
          false,
        );
      } else {
        assert.equal(await main().locator('[name="title"]').count(), 0);
        assert.ok((await main().locator('article').innerText()).includes('編集版7の手順です。'));
      }
      const canPublish = ['org_admin', 'platform_admin'].includes(actor);
      for (const [action, count] of [
        ['review', state === 'draft' ? 1 : 0],
        ['publish', state === 'review' && canPublish ? 1 : 0],
        ['retire', state !== 'retired' && canPublish ? 1 : 0],
        ['restore', 1],
      ])
        assert.equal(
          await main()
            .locator('button[name="action"][value="' + action + '"]')
            .count(),
          count,
        );
      assert.deepEqual(await main().locator('#restore-version option').allTextContents(), [
        '版 7: 合成の最新編集記事',
        '版 2: 合成の旧公開記事',
      ]);
      assert.deepEqual(
        await main()
          .locator('#restore-version option')
          .evaluateAll((ns) => ns.map((n) => n.value)),
        ['7', '2'],
      );
      assert.equal(
        await main()
          .getByRole('link', { name: '利用者に公開している版を見る', exact: true })
          .count(),
        state === 'retired' ? 0 : 1,
      );
    }
    return {
      manage,
      state: manage ? state : 'published',
      contentVersion: manage ? 7 : 2,
      actualFormReady: manage,
      submitted: false,
      dateRendered: false,
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
          : u.pathname === '/knowledge/' + itemId
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
          '/knowledge',
          '/knowledge/' + itemId,
          '/knowledge/invalid',
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
          name: 'solvi_session_wp080_synthetic',
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
    for (const [actor, audience] of [
      ['requester', 'organization'],
      ['agent', 'staff'],
    ]) {
      await role(actor);
      await check('public-' + actor, async () => {
        await scenario({ audience });
        await open(entry());
        const d = await successful({ audience });
        await shot('public-' + actor);
        return d;
      });
    }
    for (const actor of ['agent', 'org_admin'])
      for (const state of ['draft', 'review', 'published', 'retired']) {
        await role(actor);
        await check('manage-' + actor + '-' + state, async () => {
          await scenario({ state, audience: 'staff' });
          await open(entry(true) + '&saved=1');
          const d = await successful({
            manage: true,
            state,
            actor,
            audience: 'staff',
            saved: true,
          });
          await shot('manage-' + actor + '-' + state);
          return d;
        });
      }
    await role('requester');
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
        await main()
          .getByRole('heading', { name: 'お探しの画面は見つかりませんでした', exact: true })
          .waitFor();
        await noSensitiveFields();
        assert.equal(await retry().count(), 0);
        await shot('not-found-' + mode);
      });
    await role('agent');
    await check('manage-recovery-query', async () => {
      await scenario({ mode: '503' });
      await open(entry(true) + '&saved=1&unknown=PRIVATE');
      await rejected('503', true);
      await shot('manage-recovery-query');
      await scenario({});
      const before = candidateReads().length;
      await native(retry(), entry(true));
      await successful({ manage: true, actor: 'agent' });
      assert.ok(
        candidateReads()
          .slice(before)
          .every((x) => x.query === 'manage=1'),
      );
      assert.ok(candidateReads().length > before);
    });
    await role('requester');
    await check('ineffective-manage', async () => {
      await scenario({ mode: '503' });
      await open(entry(true));
      await rejected();
      assert.equal(candidateReads().at(-1).query, '');
      await shot('ineffective-manage');
    });
    for (const [name, path, label, heading, manage, from] of [
      ['origin', returnPath, '元の画面へ戻る', 'ナレッジを探す', false, returnPath],
      ['fallback', '/knowledge', '記事一覧へ戻る', 'ナレッジを探す', false, null],
      ['manage-fallback', '/knowledge?manage=1', '記事一覧へ戻る', 'ナレッジの管理', true, null],
      ['portal', '/portal', 'ポータルへ戻る', 'あなたのITサポート', false, returnPath],
    ])
      await check('native-' + name, async () => {
        await role(manage ? 'agent' : 'requester');
        await scenario({ mode: '503' });
        await open(entry(manage, from));
        await noSensitiveFields();
        await scenario({});
        const before = allReads().length;
        await native(main().getByRole('link', { name: label, exact: true }), path);
        await main().getByRole('heading', { level: 1, name: heading, exact: true }).waitFor();
        assert.ok(allReads().length > before);
        if (name === 'origin')
          assert.equal(await main().locator('input[name="q"]').inputValue(), '合成');
        await shot('native-' + name);
        return { nativeDocumentGet: true, apiReadsIncreased: true };
      });
    await role('requester');
    for (const [name, query] of [
      ['unsafe', 'returnTo=https%3A%2F%2Fexample.invalid&saved=1&unknown=PRIVATE'],
      ['plural', 'returnTo=%2Fknowledge&returnTo=%2Fportal&manage=1&manage=1'],
    ])
      await check(name, async () => {
        await scenario({ mode: '503' });
        await open(entry(false, null) + '?' + query);
        await noSensitiveFields();
        assert.equal(await retry().getAttribute('href'), entry(false, null));
        assert.equal(await back().count(), 0);
        await shot(name);
      });
    await check('invalid-id-no-api', async () => {
      await scenario({ mode: '503' });
      const before = candidateReads().length;
      await open(entry(false, returnPath, 'invalid'));
      await noSensitiveFields();
      assert.equal(await retry().count(), 0);
      assert.equal(candidateReads().length, before);
      await shot('invalid-id');
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
    report.failureCode = signal?.aborted ? 'KNOWLEDGE_UI_ABORTED' : 'KNOWLEDGE_UI_FAILURE';
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
  if (signal?.aborted) throw new Error('KNOWLEDGE_UI_ABORTED');
  return report;
}
