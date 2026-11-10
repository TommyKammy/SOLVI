/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import { access, chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
const root = fileURLToPath(new URL('../', import.meta.url));
const evidenceRoot = resolve(root, 'evidence/WP-P2-CATENTRY-077');
const returnPath = '/catalog?' + new URLSearchParams({ q: '合成' });
const entry = (kind, from = returnPath) =>
  '/catalog/manage' +
  (kind === 'new' ? '/new' : '') +
  (from ? '?' + new URLSearchParams({ returnTo: from }) : '');
const faultModes = [
  '400',
  '401',
  '500',
  '503',
  'network',
  'body_cut',
  'invalid_json',
  '401_body_cut',
];
const expectedChecks = 47;
export async function runCatalogEntryRecoveryChecks({
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
    workPackage: 'WP-P2-CATENTRY-077',
    model: 'Real copied production Next.js with loopback synthetic API and synthetic session.',
    actualCatalogManagementRendererTested: true,
    actualFormRendererTested: true,
    formSubmissionTested: false,
    realAuthorizationTested: false,
    realDatabaseTested: false,
    productionAcceptance: false,
    checks: [],
    screenshots: [],
    axe: [],
    browserRequests: { nonReadCount: 0, methods: {}, downloads: 0 },
    prefetch: { attempted: 0, blocked: 0, forwarded: 0 },
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
      !/PRIVATE_WP077|合成下書きサービス|合成承認者|a-draft|07700000/.test(
        await main().innerText(),
      ),
    );
  }
  async function rejected(kind, status = '503') {
    step = 'fixed-failure';
    await main()
      .getByRole('heading', {
        level: 1,
        name:
          kind === 'manage'
            ? 'カタログ管理を読み込めませんでした'
            : '承認者の候補を読み込めませんでした',
        exact: true,
      })
      .waitFor();
    const subject = kind === 'manage' ? 'カタログ管理' : '承認者の候補';
    const message = status.startsWith('401')
      ? 'ログイン状態を確認できませんでした。ログインし直してから、もう一度お試しください。'
      : status === '400'
        ? `${subject}を取得できませんでした。元の画面や${kind === 'manage' ? 'カタログ' : 'カタログ管理'}から開き直してください。`
        : `${subject}を取得できませんでした。時間をおいて、もう一度お試しください。`;
    assert.equal(await main().getByRole('alert').innerText(), message);
    await noSensitiveFields();
    assert.equal(await retry().getAttribute('href'), entry(kind));
    assert.equal(await back().getAttribute('href'), returnPath);
  }
  async function successful(kind, empty = false, noApprovers = false) {
    step = 'normal';
    await main()
      .getByRole('heading', {
        level: 1,
        name: kind === 'manage' ? 'カタログ管理' : 'サービスを作成する',
        exact: true,
      })
      .waitFor();
    if (kind === 'manage') {
      assert.equal(
        await main().getByRole('link', { name: 'サービスを作成する', exact: true }).count(),
        1,
      );
      const rows = await main().locator('li.attachment').allTextContents();
      if (empty) {
        assert.equal(rows.length, 0);
        assert.ok(
          (await main().innerText()).includes(
            'まだサービスがありません。最初の下書きを作成してください。',
          ),
        );
      } else {
        assert.equal(rows.length, 3);
        assert.ok(
          rows[0].includes('合成下書きサービス') &&
            rows[0].includes('非公開') &&
            rows[0].includes('a-draft'),
        );
        assert.ok(
          rows[1].includes('合成公開サービス') &&
            rows[1].includes('公開中（版1）') &&
            !rows[1].includes('未公開の変更あり'),
        );
        assert.ok(
          rows[2].includes('合成未公開変更サービス') &&
            rows[2].includes('未公開の変更あり') &&
            rows[2].includes('下書き版2'),
        );
      }
      assert.equal(await main().locator('form').count(), 0);
      return { listLabelsAndOrderPreserved: true, empty };
    }
    assert.ok(
      (await main().innerText()).includes(
        'ローカルの模擬申請専用です。下書きは利用者のカタログに表示しません。',
      ),
    );
    await page.waitForFunction(() => {
      const f = document.querySelector('main form');
      return (
        f &&
        !f.hasAttribute('inert') &&
        f.getAttribute('aria-busy') === 'false' &&
        f.querySelector('[name="creationKey"]')?.value
      );
    });
    const form = main().locator('form');
    assert.equal(await form.count(), 1);
    const key = await form.locator('[name="creationKey"]').inputValue();
    assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.equal(await form.locator('[name="expectedVersion"]').inputValue(), '1');
    assert.equal(await form.locator('[name="fields"]').inputValue(), '[]');
    for (const field of ['code', 'title', 'description', 'approverId'])
      assert.equal(await form.locator(`[name="${field}"]`).inputValue(), '');
    for (const [field, value] of [
      ['targetLabel', '検証用アクセス'],
      ['allowedDurations', '1, 7, 30'],
      ['maxReasonLength', '2000'],
    ])
      assert.equal(await form.locator(`[name="${field}"]`).inputValue(), value);
    assert.deepEqual(
      await form.locator('[name="approverId"] option').allTextContents(),
      noApprovers
        ? ['同じ組織の承認者を選ぶ']
        : ['同じ組織の承認者を選ぶ', '合成承認者A', '合成承認者B'],
    );
    const save = form.getByRole('button', { name: '下書きを保存してプレビューする', exact: true });
    assert.equal(await save.isDisabled(), noApprovers);
    assert.equal(await form.getByRole('alert').count(), noApprovers ? 1 : 0);
    if (noApprovers)
      assert.equal(
        await form.getByRole('alert').innerText(),
        '有効な承認者がいません。現在の組織の承認者設定を確認してください。',
      );
    return {
      realFormReady: true,
      creationKeyLexicalUuid: true,
      expectedVersion: 1,
      fields: [],
      defaultsAndApproversPreserved: true,
      noApprovers,
      saveDisabled: noApprovers,
      submitted: false,
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
  const onAbort = () => {
    void context?.close();
    void browser?.close();
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
      const h = route.request().headers();
      if (
        h['next-router-prefetch'] === '1' ||
        /prefetch/.test(h.purpose ?? h['sec-purpose'] ?? '')
      ) {
        report.prefetch.attempted++;
        report.prefetch.blocked++;
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    const role = async (value) =>
      context.addCookies([
        {
          name: 'solvi_session_wp077_synthetic',
          value,
          url: target.origin,
          httpOnly: true,
          sameSite: 'Lax',
        },
      ]);
    await role('org_admin');
    page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('download', () => report.browserRequests.downloads++);
    signal?.addEventListener('abort', onAbort, { once: true });
    for (const actor of ['org_admin', 'platform_admin']) {
      await role(actor);
      for (const [kind, empty, noApprovers] of [
        ['manage', false, false],
        ['manage', true, false],
        ['new', false, false],
        ['new', false, true],
      ])
        await check(
          `normal-${actor}-${kind}-${empty ? 'empty' : noApprovers ? 'no-approvers' : 'ready'}`,
          async () => {
            await scenario({ empty, noApprovers });
            await open(entry(kind));
            const fields = await successful(kind, empty, noApprovers);
            await shot(
              `normal-${actor}-${kind}-${empty ? 'empty' : noApprovers ? 'no-approvers' : 'ready'}`,
            );
            return fields;
          },
        );
    }
    await role('org_admin');
    for (const kind of ['manage', 'new']) {
      for (const mode of faultModes)
        await check(`${kind}-failure-${mode}`, async () => {
          await scenario({ mode });
          await open(entry(kind));
          await rejected(kind, mode);
          await shot(`${kind}-failure-${mode}`);
        });
      for (const mode of ['403', '404', '403_body_cut', '404_body_cut'])
        await check(`${kind}-not-found-${mode}`, async () => {
          await scenario({ mode });
          await open(entry(kind));
          await main()
            .getByRole('heading', { name: 'お探しの画面は見つかりませんでした', exact: true })
            .waitFor();
          assert.equal(await retry().count(), 0);
          await noSensitiveFields();
          await shot(`${kind}-not-found-${mode}`);
        });
      await check(`${kind}-native-retry`, async () => {
        await scenario({ mode: '503' });
        await open(entry(kind));
        await rejected(kind);
        await scenario({});
        const before = candidateReads().length;
        await native(retry(), entry(kind));
        const fields = await successful(kind);
        assert.ok(candidateReads().length > before);
        assert.ok(
          candidateReads()
            .slice(before)
            .every((x) => x.query === ''),
        );
        await shot(`${kind}-native-retry`);
        return { nativeDocumentGet: true, apiReadsIncreased: true, ...fields };
      });
      for (const [name, label, path, expected] of [
        ['origin', '元の画面へ戻る', returnPath, 'サービスカタログ'],
        [
          'fallback',
          kind === 'manage' ? '利用者のカタログへ戻る' : 'カタログ管理へ戻る',
          kind === 'manage' ? '/catalog' : '/catalog/manage',
          kind === 'manage' ? 'サービスカタログ' : 'カタログ管理',
        ],
        ['portal', 'ポータルへ戻る', '/portal', 'あなたのITサポート'],
      ])
        await check(`${kind}-native-${name}`, async () => {
          await scenario({ mode: '503' });
          await open(entry(kind));
          await rejected(kind);
          await scenario({});
          const before = allReads().length;
          await native(main().getByRole('link', { name: label, exact: true }), path);
          await main().getByRole('heading', { name: expected, exact: true, level: 1 }).waitFor();
          assert.ok(allReads().length > before);
          if (name === 'portal')
            assert.ok(
              allReads()
                .slice(before)
                .some((x) => x.route === 'tickets') &&
                allReads()
                  .slice(before)
                  .some((x) => x.route === 'requests') &&
                allReads()
                  .slice(before)
                  .some((x) => x.route === 'catalog'),
            );
          await shot(`${kind}-native-${name}`);
          return { nativeDocumentGet: true, apiReadsIncreased: true };
        });
      for (const [name, query] of [
        ['unsafe', 'returnTo=https%3A%2F%2Fexample.invalid&created=1&saved=1&unknown=PRIVATE'],
        ['plural', 'returnTo=%2Fcatalog&returnTo=%2Fportal&updated=1&unknown=PRIVATE'],
      ])
        await check(`${kind}-${name}`, async () => {
          await scenario({ mode: '503' });
          await open(entry(kind, null) + '?' + query);
          await noSensitiveFields();
          assert.equal(await retry().getAttribute('href'), entry(kind, null));
          assert.equal(await back().count(), 0);
          await shot(`${kind}-${name}`);
        });
    }
    await check('keyboard-visible-focus-enter', async () => {
      await scenario({ mode: '503' });
      await open(entry('new'));
      await rejected('new');
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
      await native(retry(), entry('new'), true);
      await successful('new');
      assert.ok(candidateReads().length > before);
      return { tabFocusVisible: true, nativeDocumentGet: true, apiReadsIncreased: true };
    });
    for (const [kind, mode] of [
      ['manage', '503'],
      ['new', 'normal'],
    ])
      await check(`mobile-${kind}-${mode}`, async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        await scenario({ mode });
        await open(entry(kind));
        if (mode === 'normal') await successful(kind);
        else await rejected(kind);
        const dimensions = await page.evaluate(() => ({
          width: document.documentElement.clientWidth,
          scroll: document.documentElement.scrollWidth,
        }));
        assert.ok(dimensions.scroll <= dimensions.width);
        await shot(`mobile-${kind}-${mode}`);
        return dimensions;
      });
  } catch {
    report.failureCode = signal?.aborted ? 'CATALOG_UI_ABORTED' : 'CATALOG_UI_FAILURE';
  } finally {
    try {
      await browser?.close();
      report.cleanup.browserClosed = true;
    } catch {
      report.cleanup.browserClosed = false;
    }
    signal?.removeEventListener('abort', onAbort);
    report.success =
      !signal?.aborted &&
      !report.failureCode &&
      report.checks.length === expectedChecks &&
      report.checks.every((x) => x.passed) &&
      report.browserRequests.nonReadCount === 0 &&
      report.browserRequests.downloads === 0 &&
      report.cleanup.browserClosed;
    await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  }
  if (signal?.aborted) throw new Error('CATALOG_UI_ABORTED');
  return report;
}
