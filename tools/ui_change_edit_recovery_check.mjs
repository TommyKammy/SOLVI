/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import { access, chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidenceRoot = resolve(root, 'evidence/WP-P2-CHGEDIT-076');
const ticketId = '07600000-0000-4000-8000-000000000010';
const assetId = '07600000-0000-4000-8000-000000000020';
const userId = '07600000-0000-4000-8000-000000000002';
const approverId = '07600000-0000-4000-8000-000000000003';
const otherId = '07600000-0000-4000-8000-000000000004';
const id = '07600000-0000-4000-8000-000000000006';
const detailPath = '/changes/' + id;
const entryPath = detailPath + '/edit';
const returnPath = '/changes?' + new URLSearchParams({ q: '合成', state: 'review', page: '2' });
const createPath = (from = returnPath) =>
  entryPath + (from ? '?' + new URLSearchParams({ returnTo: from }) : '');
const candidateQuery = new URLSearchParams({ ticketId, assetIds: assetId }).toString();
const expectedChecks = 63;
const primaryMissing = [
  '400',
  '401',
  '403',
  '404',
  '409',
  '401_body_cut',
  '403_body_cut',
  '404_body_cut',
];
const primaryFaults = ['500', '503', 'network', 'body_cut', 'invalid_json'];
const candidateFaults = [
  '400',
  '401',
  '403',
  '404',
  '500',
  '503',
  'network',
  'body_cut',
  'invalid_json',
  '401_body_cut',
  '403_body_cut',
  '404_body_cut',
];
const errorMessage = '入力候補を取得できませんでした。時間をおいて、もう一度お試しください。';
export async function runChangeEditRecoveryChecks({
  baseURL,
  outputDirectory,
  control,
  candidateReads,
  allReads,
  assertOwned,
  signal,
}) {
  const target = new URL(baseURL);
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
  for (const callback of [control, candidateReads, allReads, assertOwned])
    assert.equal(typeof callback, 'function');
  const output = resolve(outputDirectory);
  const within = relative(evidenceRoot, output);
  assert.ok(within && !within.startsWith('..') && !isAbsolute(within));
  assert.equal(await realpath(dirname(output)), dirname(output));
  await access(chromium.executablePath());
  if (signal?.aborted) throw new Error('CHANGE_UI_ABORTED');
  await mkdir(output, { mode: 0o700 });
  const report = {
    workPackage: 'WP-P2-CHGEDIT-076',
    model: 'Real copied production Next.js with loopback synthetic API and synthetic session.',
    actualChangeEditRendererTested: true,
    candidateRetrievalOnly: false,
    primaryAndCandidateReadRecovery: true,
    actualFormRendererTested: true,
    realApprovalDecisionTested: false,
    realChangeCommandExecutionTested: false,
    formSubmissionTested: false,
    realAuthorizationTested: false,
    realDatabaseTested: false,
    productionAcceptance: false,
    startedAt: new Date().toISOString(),
    checks: [],
    screenshots: [],
    axe: [],
    browserRequests: { nonReadCount: 0, methods: {}, downloads: 0 },
    prefetch: { attempted: 0, blocked: 0, forwarded: 0 },
    cleanup: { browserClosed: false },
    success: false,
  };
  let browser, context, page;
  let step = 'initial';
  let mode = {
    detail: 'normal',
    candidates: 'normal',
    view: 'draft',
    people: 'normal',
    relationship: 'creator',
  };
  let cancellation = Promise.resolve();
  const onBrowserRequest = (request) => {
    const method = request.method();
    if (method === 'GET' || method === 'HEAD') return;
    report.browserRequests.nonReadCount++;
    const key = ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE'].includes(method)
      ? method
      : 'OTHER';
    report.browserRequests.methods[key] = (report.browserRequests.methods[key] ?? 0) + 1;
  };
  const onAbort = () => {
    cancellation = Promise.allSettled([
      Promise.resolve().then(() => context?.close()),
      Promise.resolve().then(() => browser?.close()),
    ]).then(() => undefined);
  };
  const live = async () => {
    if (signal?.aborted) throw new Error('CHANGE_UI_ABORTED');
    await assertOwned();
    if (signal?.aborted) throw new Error('CHANGE_UI_ABORTED');
  };
  const scenario = async (next) => {
    await live();
    await control(next);
    mode = {
      detail: 'normal',
      candidates: 'normal',
      view: 'draft',
      people: 'normal',
      relationship: 'creator',
      ...next,
    };
  };
  const main = () => page.locator('main');
  const retry = () => main().getByRole('link', { name: '再取得する', exact: true });
  const back = () => main().getByRole('link', { name: '元の画面へ戻る', exact: true });
  async function open(path = createPath()) {
    step = 'open-document';
    await live();
    await page.goto(target.origin + path, { waitUntil: 'domcontentloaded' });
    step = 'open-heading';
    await main().getByRole('heading', { level: 1 }).waitFor();
  }

  async function successful() {
    step = 'success-heading';
    await main()
      .getByRole('heading', { name: 'CHG-076 · 計画を見直す', level: 1, exact: true })
      .waitFor();
    step = 'success-form-ready';
    await page.waitForFunction(() => {
      const main = document.querySelector('main'),
        form = main?.querySelector('form');
      return (
        main?.querySelectorAll('form').length === 1 &&
        main.querySelectorAll('[inert]').length === 0 &&
        form?.getAttribute('aria-busy') === 'false' &&
        !form.hasAttribute('inert')
      );
    });
    const form = main().locator('form');
    const creationKey = await form.locator('input[name="creationKey"]').inputValue();
    const commandKey = await form.locator('input[name="commandKey"]').inputValue();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    assert.match(creationKey, uuid);
    assert.match(commandKey, uuid);
    assert.notEqual(creationKey, commandKey);
    assert.equal(await form.locator('input[name="expectedVersion"]').inputValue(), '7');
    assert.equal(
      await form.locator('input[name="snapshotHash"],input[name="approvalId"]').count(),
      0,
    );
    for (const [name, value] of Object.entries({
      title: '合成の変更計画',
      purpose: '合成の目的',
      impact: '合成の影響',
      implementationPlan: '合成の実施計画',
      testPlan: '合成のテスト計画',
      backoutPlan: '合成の切戻し計画',
      reason: '',
      plannedStart: '2100-10-10T09:00',
      plannedEnd: '2100-10-10T10:00',
    }))
      assert.equal(await form.locator('[name="' + name + '"]').inputValue(), value);
    assert.equal(await form.locator('select[name="risk"]').inputValue(), 'medium');
    assert.equal(await form.locator('select[name="ticketId"]').inputValue(), ticketId);
    assert.equal(
      await form.locator('select[name="ownerId"]').inputValue(),
      mode.relationship === 'owner' ? otherId : userId,
    );
    assert.equal(await form.locator('select[name="approverId"]').inputValue(), approverId);
    assert.equal(await form.locator('select[name="ticketId"] option').count(), 2);
    const boxes = form.locator('input[name="assetIds"]');
    assert.equal(await boxes.count(), 1);
    const selectedAssets = await boxes.evaluateAll((nodes) =>
      nodes.filter((n) => n.checked).map((n) => n.value),
    );
    assert.deepEqual(selectedAssets, [assetId]);
    assert.equal(await boxes.first().isDisabled(), false);
    if (mode.people === 'minimal') {
      const currentAsset = await boxes.first().locator('..').innerText();
      assert.ok(currentAsset.includes('版4'));
      assert.ok(currentAsset.includes('廃止'));
    }
    if (['minimal', 'inactive'].includes(mode.people)) {
      assert.ok(
        (await form.locator('select[name="ownerId"] option:checked').innerText()).includes(
          '現在は担当対象外',
        ),
      );
      assert.ok(
        (await form.locator('select[name="approverId"] option:checked').innerText()).includes(
          '現在は承認対象外',
        ),
      );
    }
    assert.equal(
      await form
        .getByRole('button', { name: '計画を保存し再承認の準備をする', exact: true })
        .count(),
      1,
    );
    assert.equal(
      await form.getByRole('link', { name: 'キャンセルして戻る', exact: true }).count(),
      1,
    );
    assert.equal(await retry().count(), 0);
    return {
      actualFormReady: true,
      expectedVersion: '7',
      creationKeyIsUuid: true,
      commandKeyIsUuid: true,
      selectedTicket: ticketId,
      selectedAssets,
      snapshotFieldsPreserved: true,
      jstDatesPreserved: true,
      reasonEmpty: true,
      people: mode.people,
      relationship: mode.relationship,
      formSubmitted: false,
    };
  }
  async function noSensitiveFields() {
    assert.equal(
      await main().locator('form, input, select, textarea, button, dl, table, details').count(),
      0,
    );
    const text = await main().innerText();
    for (const value of [
      id,
      ticketId,
      assetId,
      'WP076_PRIVATE_PROBLEM_MARKER',
      'CHG-076',
      'TKT-076',
      'AST-076',
      '合成の目的',
      '合成担当者',
      '合成の対象資産',
      '変更と履歴を保存しました',
    ])
      assert.equal(text.includes(value), false);
  }
  async function rejected(status = '503', kind = 'options') {
    step = 'failure-boundary';
    await main()
      .getByRole('heading', {
        name: kind === 'plan' ? '変更計画を読み込めませんでした' : '入力候補を読み込めませんでした',
        level: 1,
        exact: true,
      })
      .waitFor();
    const message =
      kind === 'plan'
        ? '変更計画を取得できませんでした。時間をおいて、もう一度お試しください。'
        : status === '400'
          ? '入力候補を取得できませんでした。変更計画や変更一覧から開き直してください。'
          : status.startsWith('401')
            ? 'ログイン状態を確認できませんでした。ログインし直してから、もう一度お試しください。'
            : status.startsWith('403')
              ? '入力候補を取得できませんでした。操作中の組織と編集権限を確認してください。'
              : status.startsWith('404')
                ? '入力候補を取得できませんでした。対象の現在の内容を変更計画で確認してください。'
                : errorMessage;
    assert.equal(await main().getByRole('alert').innerText(), message);
    await noSensitiveFields();
    assert.equal(await retry().getAttribute('href'), createPath());
    assert.equal(await back().getAttribute('href'), returnPath);
    assert.equal(
      await main().getByRole('link', { name: '変更一覧へ戻る', exact: true }).getAttribute('href'),
      '/changes',
    );
    assert.equal(
      await main().getByRole('link', { name: 'ポータルへ戻る', exact: true }).getAttribute('href'),
      '/portal',
    );
  }
  async function missing() {
    step = 'existing-not-found';
    await main()
      .getByRole('heading', { name: 'お探しの画面は見つかりませんでした', exact: true })
      .waitFor();
    assert.ok(
      (await main().innerText()).includes(
        'URLが変わったか、閲覧できる範囲の外にある可能性があります。',
      ),
    );
    assert.equal(await retry().count(), 0);
    await noSensitiveFields();
  }
  async function nativeNavigation(link, path, keyboard = false) {
    step = 'native-anchor';
    assert.equal(await link.evaluate((node) => node.tagName), 'A');
    assert.equal(await link.getAttribute('href'), path);
    assert.equal(new URL(path, target).origin, target.origin);
    const navigation = page.waitForRequest(
      (request) =>
        request.isNavigationRequest() &&
        request.method() === 'GET' &&
        request.url() === target.origin + path,
    );
    await Promise.all([navigation, keyboard ? page.keyboard.press('Enter') : link.click()]);
    step = 'native-heading';
    await page.waitForURL(target.origin + path, { waitUntil: 'domcontentloaded' });
    await main().getByRole('heading', { level: 1 }).waitFor();
    assert.equal(page.url(), target.origin + path);
  }
  async function freshNavigation(keyboard = false) {
    const primaryBefore = allReads().filter((r) => r.route === 'detail').length,
      before = candidateReads().length;
    await nativeNavigation(retry(), createPath(), keyboard);
    const fields = await successful();
    const fresh = candidateReads().slice(before);
    assert.ok(fresh.length > 0);
    assert.ok(fresh.every((r) => r.query === candidateQuery));
    assert.ok(allReads().filter((r) => r.route === 'detail').length > primaryBefore);
    return {
      nativeDocumentGet: true,
      primaryReadsIncreased: true,
      candidateReadsIncreased: true,
      sameEditPath: true,
      returnToRetained: true,
      ...fields,
    };
  }
  async function shot(name) {
    step = 'capture';
    await live();
    const filename = name + '.png';
    const image = resolve(output, filename);
    await page.screenshot({ path: image, fullPage: true });
    await chmod(image, 0o600);
    report.screenshots.push(filename);
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const violations = result.violations.map((item) => ({
      id: item.id,
      impact: item.impact,
      count: item.nodes.length,
    }));
    report.axe.push({ state: name, violations });
    await writeFile(resolve(output, name + '-axe.json'), JSON.stringify(result, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    assert.equal(violations.length, 0);
  }
  async function geometry() {
    return page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    }));
  }
  async function check(name, run) {
    await live();
    const reads = allReads().length;
    try {
      const details = await run();
      report.checks.push({
        name,
        passed: true,
        mode: { ...mode },
        details: details ?? null,
        apiReads: allReads().length - reads,
      });
    } catch {
      report.checks.push({
        name,
        passed: false,
        mode: { ...mode },
        failureCode: 'CHECK_FAILED',
        stage: step,
      });
    }
  }
  try {
    await live();
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    context.on('request', onBrowserRequest);
    await context.route('**/*', async (route) => {
      const request = route.request(),
        headers = request.headers();
      const isPrefetch =
        headers['next-router-prefetch'] === '1' ||
        /prefetch/.test(headers.purpose ?? headers['sec-purpose'] ?? '');
      if (isPrefetch) {
        report.prefetch.attempted++;
        report.prefetch.blocked++;
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    await context.addCookies([
      {
        name: 'solvi_session_wp076_synthetic',
        value: 'agent',
        url: target.origin,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('download', () => report.browserRequests.downloads++);
    signal?.addEventListener('abort', onAbort, { once: true });
    const role = async (value) =>
      context.addCookies([
        {
          name: 'solvi_session_wp076_synthetic',
          value,
          url: target.origin,
          httpOnly: true,
          sameSite: 'Lax',
        },
      ]);
    for (const actor of ['agent', 'org_admin', 'platform_admin']) {
      await role(actor);
      for (const view of ['draft', 'review', 'approved', 'rejected', 'scheduled'])
        await check('normal-' + actor + '-' + view, async () => {
          await scenario({ view });
          await open();
          const fields = await successful();
          assert.ok(
            candidateReads()
              .slice(-1)
              .every((r) => r.query === candidateQuery),
          );
          await shot('normal-' + actor + '-' + view);
          return { ...fields, role: actor, state: view };
        });
    }
    await role('agent');
    for (const [name, settings] of [
      ['agent-owner', { relationship: 'owner' }],
      ['minimum-current-targets', { people: 'minimal' }],
      ['inactive-people-fallback', { people: 'inactive' }],
    ])
      await check(name, async () => {
        await role(settings.people ? 'platform_admin' : 'agent');
        await scenario(settings);
        await open();
        const fields = await successful();
        await shot(name);
        return fields;
      });
    for (const [name, actor, settings] of [
      ['agent-nonowner', 'agent', { relationship: 'nonowner' }],
      ['auditor-review', 'auditor', { view: 'review' }],
      ['named-approver-review', 'approver', { view: 'review' }],
      ...['in_progress', 'completed', 'failed', 'cancelled'].map((view) => [
        'terminal-' + view,
        'agent',
        { view },
      ]),
    ])
      await check('nonedit-' + name, async () => {
        await role(actor);
        await scenario(settings);
        const before = candidateReads().length;
        await open();
        await missing();
        assert.equal(candidateReads().length, before);
        await shot('nonedit-' + name);
        return { candidateReadsZero: true, editDeniedBeforeCandidates: true };
      });
    await role('agent');
    for (const detail of primaryMissing)
      await check('primary-notfound-' + detail, async () => {
        await scenario({ detail });
        const before = candidateReads().length;
        await open();
        await missing();
        assert.equal(candidateReads().length, before);
        await shot('primary-notfound-' + detail);
        return { candidateReadsZero: true, existingNotFound: true };
      });
    for (const detail of primaryFaults)
      await check('primary-failure-' + detail, async () => {
        await scenario({ detail });
        const before = candidateReads().length;
        await open();
        await rejected(detail, 'plan');
        assert.equal(candidateReads().length, before);
        await shot('primary-failure-' + detail);
        return { candidateReadsZero: true, primaryFailure: true };
      });
    for (const candidates of candidateFaults)
      await check('candidate-failure-' + candidates, async () => {
        await scenario({ candidates });
        await open();
        await rejected(candidates);
        await shot('candidate-failure-' + candidates);
        return { candidateFailureVisible: true, notFound: false };
      });
    for (const targetKind of ['plan', 'options'])
      await check('native-retry-' + targetKind, async () => {
        await scenario(targetKind === 'plan' ? { detail: '503' } : { candidates: '503' });
        await open();
        await rejected('503', targetKind);
        await scenario({});
        const details = await freshNavigation();
        await shot('native-retry-' + targetKind);
        return details;
      });
    await check('keyboard-retry', async () => {
      await scenario({ candidates: '503' });
      await open();
      await rejected();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Tab');
      for (let n = 0; n < 24; n++) {
        if (await retry().evaluate((node) => node === document.activeElement)) break;
        await page.keyboard.press('Tab');
      }
      assert.equal(await retry().evaluate((node) => node === document.activeElement), true);
      const focus = await retry().evaluate((node) => {
        const style = getComputedStyle(node);
        return {
          outline: style.outlineStyle,
          width: style.outlineWidth,
          shadow: style.boxShadow,
          visible: node.matches(':focus-visible'),
        };
      });
      assert.ok(focus.visible);
      assert.ok(
        (focus.outline !== 'none' && parseFloat(focus.width) > 0) || focus.shadow !== 'none',
      );
      await shot('keyboard-focus');
      await scenario({});
      const details = await freshNavigation(true);
      return { ...details, focus, tabFocusedRetry: true, enterNativeGet: true };
    });
    for (const destination of ['from-list', 'detail-fallback', 'list', 'portal'])
      await check('native-exit-' + destination, async () => {
        await scenario({ detail: '503' });
        await open(destination === 'detail-fallback' ? createPath(null) : createPath());
        const path =
          destination === 'from-list'
            ? returnPath
            : destination === 'detail-fallback'
              ? detailPath
              : destination === 'list'
                ? '/changes'
                : '/portal';
        const label =
          destination === 'from-list'
            ? '元の画面へ戻る'
            : destination === 'detail-fallback'
              ? '変更計画へ戻る'
              : destination === 'list'
                ? '変更一覧へ戻る'
                : 'ポータルへ戻る';
        await scenario({});
        const before = allReads().length;
        await nativeNavigation(main().getByRole('link', { name: label, exact: true }), path);
        assert.ok(allReads().length > before);
        const freshReads = allReads().slice(before);
        if (destination === 'from-list' || destination === 'list') {
          const query = new URL(path, target).searchParams.toString();
          assert.ok(
            freshReads.some((request) => request.route === 'list' && request.query === query),
          );
        } else if (destination === 'detail-fallback') {
          assert.ok(freshReads.some((request) => request.route === 'detail'));
        } else {
          for (const route of ['tickets', 'requests', 'catalog'])
            assert.ok(freshReads.some((request) => request.route === route));
        }
        await shot('native-exit-' + destination);
        return {
          nativeDocumentGet: true,
          apiReadsIncreased: true,
          target: path,
          readsAdded: allReads().length - before,
          expectedApiRoutesRead: true,
          actualApiRoutes: freshReads.map((request) => ({
            route: request.route,
            query: request.query,
          })),
        };
      });
    await check('unsafe-return', async () => {
      await scenario({ candidates: '503' });
      await open(createPath('https://invalid.example/changes'));
      assert.equal(await retry().getAttribute('href'), entryPath);
      assert.equal(await back().count(), 0);
      assert.equal(
        await main()
          .getByRole('link', { name: '変更計画へ戻る', exact: true })
          .getAttribute('href'),
        detailPath,
      );
      await noSensitiveFields();
      await shot('unsafe-return');
      return { unsafeDropped: true };
    });
    await check('plural-return', async () => {
      await scenario({ candidates: '503' });
      await open(entryPath + '?returnTo=%2Fchanges&returnTo=%2Fportal&unknown=PRIVATE');
      assert.equal(await retry().getAttribute('href'), entryPath);
      assert.equal(await back().count(), 0);
      await noSensitiveFields();
      await shot('plural-return');
      return { pluralDropped: true };
    });
    await check('flash-and-user-seeds', async () => {
      await scenario({ candidates: '503' });
      await open(
        entryPath +
          '?' +
          new URLSearchParams({
            returnTo: returnPath + '&saved=true&created=true&updated=true',
            saved: 'true',
            ticketId: 'PRIVATE',
            assetIds: 'PRIVATE',
            unknown: 'PRIVATE',
          }),
      );
      assert.equal(await retry().getAttribute('href'), createPath());
      assert.equal(candidateReads().at(-1).query, candidateQuery);
      await noSensitiveFields();
      await shot('flash-and-user-seeds');
      return { flashOmitted: true, seedsIgnored: true };
    });
    await check('invalid-id', async () => {
      await scenario({});
      const before = allReads().filter((r) => r.route === 'detail').length;
      await open('/changes/not-a-uuid/edit');
      await missing();
      assert.equal(allReads().filter((r) => r.route === 'detail').length, before);
      await shot('invalid-id');
      return { primaryFetchZero: true, retryZero: true };
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await check('mobile-failure-390', async () => {
      await scenario({ candidates: '503' });
      await open();
      await rejected();
      const layout = await geometry();
      assert.equal(layout.pageOverflow, false);
      await shot('mobile-failure-390');
      return layout;
    });
    await check('mobile-normal-390', async () => {
      await scenario({ view: 'approved' });
      await open();
      const fields = await successful(),
        layout = await geometry();
      await shot('mobile-normal-390');
      return { ...layout, ...fields, successfulLayoutRedesignTested: false };
    });
  } catch {
    report.failureCode = signal?.aborted ? 'CHANGE_UI_ABORTED' : 'CHANGE_UI_RUN_FAILED';
  } finally {
    await cancellation;
    try {
      await browser?.close();
      report.cleanup.browserClosed = true;
    } catch {
      report.cleanup.browserClosed = false;
    }
    signal?.removeEventListener('abort', onAbort);
    context?.off('request', onBrowserRequest);
    if (signal?.aborted) report.failureCode = 'CHANGE_UI_ABORTED';
    report.finishedAt = new Date().toISOString();
    report.success =
      !signal?.aborted &&
      !report.failureCode &&
      report.checks.length === expectedChecks &&
      report.checks.every((item) => item.passed) &&
      report.browserRequests.nonReadCount === 0 &&
      report.browserRequests.downloads === 0 &&
      report.cleanup.browserClosed;
    writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  }
  if (signal?.aborted) throw new Error('CHANGE_UI_ABORTED');
  return report;
}
