/* global document, window */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { people, baseMembers, groupId, addUserId, longName, writeSequence, failureDetail } from '../evidence/WP-P2-GRPPEND-092/20261010/fixture-api.mjs';

export const groupMembershipPendingCases = Array.from({ length: 20 }, (_, i) => 'C' + String(i + 1).padStart(2, '0'));
const detailPath = '/ops/groups/' + groupId;
const parent = '/ops/groups?q=group&state=active&page=2';
const conditions = { q: '合成', filter: 'available', page: '2', returnTo: parent };
const statusText = (operation) => operation === 'add' ? 'グループに追加しています。完了するまでお待ちください。' : 'グループから外しています。完了するまでお待ちください。';
const pendingCase = (index) => 'C' + String(index * 2 + 5).padStart(2, '0');
const outcomeCase = (index) => 'C' + String(index * 2 + 6).padStart(2, '0');

export function waitForNativeCompletion({ context, page, request, item, signal }) {
  let settled = false, timer, resolve;
  const promise = new Promise((done) => { resolve = done; });
  const cleanup = () => {
    clearTimeout(timer);
    context.off('requestfinished', onRequest);
    context.off('requestfailed', onRequest);
    context.off('close', close);
    page?.off('close', close);
    signal?.removeEventListener('abort', close);
  };
  const settle = (reason) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolve(reason);
  };
  const notify = () => {
    if (item.failed === true || item.responseFinished === 'failed') settle('failed');
    else if (item.completed === true && item.responseFinished === 'complete') settle('settled');
  };
  const onRequest = (observed) => { if (observed === request) notify(); };
  const close = () => { settle('closed'); };
  context.on('requestfinished', onRequest);
  context.on('requestfailed', onRequest);
  context.on('close', close);
  page?.on('close', close);
  signal?.addEventListener('abort', close, { once: true });
  timer = setTimeout(() => { settle('deadline'); }, 30000);
  if (signal?.aborted || page?.isClosed()) close();
  else notify();
  return { promise, notify, close };
}

export async function runGroupMembershipPendingChecks({ baseURL, outputDirectory, control, observations, assertOwned, signal, diagnostic = null, onStage = () => {} }) {
  assert.ok([null, 'omit-extra-enter', 'omit-pending-capture', 'full-chromium', 'original-reader', 'existing-chromium149', 'existing-chrome154', 'all-original-reader'].includes(diagnostic));
  const allReaderMeasurement = diagnostic === 'all-original-reader';
  const origin = new URL(baseURL).origin;
  assert.equal(new URL(baseURL).hostname, '127.0.0.1');
  assert.ok(!['', '3000', '3001'].includes(new URL(baseURL).port));
  const report = { workPackage: 'WP-P2-GRPPEND-092', baselineRevision: 'c0763f91237e4153c0f7eea05341e7a80cde6065', diagnostic, acceptanceEligible: diagnostic === null, success: false, checks: [], screenshots: [], accessibility: [], details: [], stages: [], navigation: [], lifecycle: [], documentRequests: [], network: { nonReadCount: 0, unknownReads: 0, foreign: 0, downloads: 0, prefetchAttempts: 0, prefetchBlocked: 0, allowedWrites: [] }, browserClosed: false, contextClosed: false };
  await mkdir(outputDirectory, { recursive: true });
  let browser, context, page, contextClose, browserClose, currentCase, expectedIndex = null, checkpoint = 'setup';
  const pending = new Map(), classifiedWrites = new WeakMap();
  const nativeWaits = new WeakMap(), classifiedRequests = new WeakMap(), ownedNativeWaits = new Set();
  const startedAt = Date.now();
  report.protocol = [];
  report.originalReaders = [];
  report.observerGates = [];
  report.semanticMeasurementComplete = false;
  const originalReaderPages = new WeakMap();
  const stage = (name) => { checkpoint = name; report.stages.push({ stage: name, elapsedMs: Date.now() - startedAt }); onStage(name); };
  const live = async () => { assert.ok(!signal?.aborted); await assertOwned(); assert.ok(!signal?.aborted); };
  const closeOwned = async () => {
    for (const wait of ownedNativeWaits) wait.close();
    stage('browser-context-close');
    const results = [];
    if (context) results.push(...await Promise.allSettled([contextClose ??= context.close().then(() => { report.contextClosed = true; })]));
    if (browser) results.push(...await Promise.allSettled([browserClose ??= browser.close().then(() => { report.browserClosed = true; })]));
    return results;
  };
  const interrupt = () => { void closeOwned(); };
  signal?.addEventListener('abort', interrupt, { once: true });
  const main = () => page.locator('main');
  const selection = () => page.locator('#member-id');
  const addForm = () => selection().locator('xpath=ancestor::form');
  const removeForm = (id) => main().locator('ul.groups form').filter({ has: page.locator('input[type="hidden"][name="userId"][value="' + id + '"]') });
  const addButton = () => addForm().getByRole('button', { name: '選んだ在籍者を追加する', exact: true });
  const ready = async () => {
    await main().locator('h1').first().waitFor();
    await page.waitForFunction(() => Array.from(document.querySelectorAll('main form')).every((f) => !f.hasAttribute('inert')));
  };
  const open = async (settings = {}, width = 1280) => {
    await live();
    control(settings);
    if (page) await page.close();
    page = await context.newPage();
    const protocol = await context.newCDPSession(page);
    const protocolWrites = new Map();
    protocol.on('Network.requestWillBeSent', (event) => {
      if (event.request.method === 'POST' && new URL(event.request.url).origin === origin && new URL(event.request.url).pathname === detailPath) {
        const item = { index: expectedIndex, requestStage: checkpoint, dataLength: 0, encodedDataLength: 0, terminal: null };
        report.protocol.push(item);
        protocolWrites.set(event.requestId, item);
      }
    });
    protocol.on('Network.dataReceived', (event) => {
      const item = protocolWrites.get(event.requestId);
      if (item) { item.dataLength += event.dataLength; item.encodedDataLength += event.encodedDataLength; }
    });
    protocol.on('Network.loadingFinished', (event) => {
      const item = protocolWrites.get(event.requestId);
      if (item) Object.assign(item, { terminal: 'finished', terminalStage: checkpoint, terminalEncodedDataLength: event.encodedDataLength });
    });
    protocol.on('Network.loadingFailed', (event) => {
      const item = protocolWrites.get(event.requestId);
      if (item) Object.assign(item, { terminal: 'failed', terminalStage: checkpoint, canceled: event.canceled === true, errorCode: event.errorText.includes('ERR_ABORTED') ? 'ABORTED' : 'FAILED' });
    });
    await protocol.send('Network.enable');
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame() || !frame.url().startsWith(origin)) return;
      const url = new URL(frame.url());
      const query = Object.fromEntries([...url.searchParams].filter(([key]) => ['q', 'filter', 'page', 'returnTo', 'notice', 'error'].includes(key)));
      report.navigation.push({ stage: checkpoint, elapsedMs: Date.now() - startedAt, detailPath: url.pathname === detailPath, query });
    });
    await page.setViewportSize({ width, height: 900 });
    page.on('download', () => report.network.downloads++);
    await page.goto(origin + detailPath + '?' + new URLSearchParams(conditions), { waitUntil: 'networkidle' });
    await ready();
  };
  const assertQuery = (extra = {}) => assert.deepEqual(Object.fromEntries(new URL(page.url()).searchParams), { ...conditions, ...extra });
  const count = async () => main().locator('ul.groups > li').count();
  const overflow = async () => {
    const value = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
    assert.ok(value <= 0, 'WP092_OVERFLOW');
    return 0;
  };
  const nativeValue = async (form) => form.evaluate((f) => ({ userId: new FormData(f).get('userId'), entries: Array.from(new FormData(f).entries()).filter(([key]) => key === 'userId').length }));
  const activeFocus = async (form) => form.evaluate((f) => ({ tag: document.activeElement?.tagName ?? null, sameForm: f.contains(document.activeElement), formIsSubmittedForm: document.activeElement?.form === f }));
  const idle = async () => {
    assert.equal(await addForm().locator('fieldset').evaluate((e) => e.disabled), false);
    assert.equal(await selection().isDisabled(), false);
    assert.equal(await addButton().isDisabled(), false);
    assert.equal(await main().locator('fieldset[disabled]').count(), 0);
    assert.equal(await main().locator('fieldset [role="status"]').count(), 0);
    assert.equal(await selection().inputValue(), '');
    assertQuery();
  };
  const capture = async (id) => {
    await live();
    stage(id + '-screenshot');
    const filename = id + '.png';
    await page.screenshot({ path: join(outputDirectory, filename), fullPage: true });
    const bytes = await readFile(join(outputDirectory, filename));
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    report.screenshots.push({ case: id, path: filename, sha256: createHash('sha256').update(bytes).digest('hex') });
    stage(id + '-axe');
    const a = await new AxeBuilder({ page }).analyze();
    report.accessibility.push({ case: id, violations: a.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })), incomplete: a.incomplete.map((v) => ({ id: v.id, nodes: v.nodes.length })) });
    assert.equal(a.violations.length, 0, 'WP092_AXE_VIOLATIONS');
    assert.equal(a.incomplete.length, 0, 'WP092_AXE_INCOMPLETE');
  };
  const check = async (id, fn) => {
    currentCase = id;
    stage(id);
    try {
      await live(); await fn();
      if (!(diagnostic === 'omit-pending-capture' && writeSequence.some((_, index) => id === pendingCase(index)))) await capture(id);
      const unresolved = allReaderMeasurement && report.observerGates.some((gate) => gate.case === id && !gate.passed);
      report.checks.push(unresolved ? { case: id, passed: false, semanticPassed: true, failure: 'STRICT_NATIVE_OBSERVER_UNMET', checkpoint: id + '-await-native-finish' } : { case: id, passed: true });
    }
    catch (error) {
      report.checks.push({ case: id, passed: false, checkpoint, failure: error?.name === 'AssertionError' ? 'ASSERTION' : error?.name === 'TimeoutError' ? 'TIMEOUT' : 'CHECK_FAILURE', invariant: typeof error?.message === 'string' && /^WP092_[A-Z_]+$/.test(error.message) ? error.message : null });
      throw error;
    }
  };
  try {
    const fullChromium = ['full-chromium', 'original-reader', 'all-original-reader'].includes(diagnostic);
    const existing149 = diagnostic === 'existing-chromium149';
    const existing154 = diagnostic === 'existing-chrome154';
    const existingExecutable = chromium.executablePath().replace('/chromium-1234/', '/chromium-1228/');
    if (existing149) { assert.notEqual(existingExecutable, chromium.executablePath()); report.browserExecutable = existingExecutable; }
    if (existing154) report.browserExecutable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    browser = await chromium.launch({ headless: true, ...(existing154 ? { channel: 'chrome' } : existing149 ? { executablePath: existingExecutable } : fullChromium ? { channel: 'chromium' } : {}) });
    report.browserVersion = browser.version();
    if (existing149) assert.equal(report.browserVersion, '149.0.7827.55');
    if (existing154) assert.equal(report.browserVersion, '154.0.8037.98');
    report.browserMode = existing154 ? 'existing-chrome154-new-headless' : existing149 ? 'existing-chromium149-new-headless' : fullChromium ? 'chromium-new-headless' : 'chromium-headless-shell';
    await live();
    context = await browser.newContext({ serviceWorkers: 'block' });
    await context.addCookies([{ name: 'solvi_session_wp092_synthetic', value: 'org_admin', url: origin }]);
    await context.exposeBinding('wp092Lifecycle', (source, event) => {
      if (source.page === page && source.frame === page.mainFrame() && ['document-load', 'pagehide'].includes(event)) report.lifecycle.push({ event, stage: checkpoint, elapsedMs: Date.now() - startedAt });
    });
    await context.addInitScript(() => {
      void window.wp092Lifecycle('document-load');
      window.addEventListener('pagehide', () => { void window.wp092Lifecycle('pagehide'); });
    });
    if (['original-reader', 'all-original-reader'].includes(diagnostic)) {
      await context.exposeBinding('wp092Reader', (source, counters) => {
        if (source.page !== page || source.frame !== page.mainFrame()) return;
        let item = originalReaderPages.get(source.page);
        if (!item) { item = { index: expectedIndex }; originalReaderPages.set(source.page, item); report.originalReaders.push(item); }
        Object.assign(item, counters, { stage: checkpoint, elapsedMs: Date.now() - startedAt });
      });
      await context.addInitScript((path) => {
        const originalFetch = window.fetch;
        window.fetch = function (...args) {
          const matches = args[1]?.method === 'POST' && new URL(args[0], window.location.href).pathname === path;
          const result = Reflect.apply(originalFetch, this, args);
          if (!matches) return result;
          return result.then((response) => {
            if (!response.body) return response;
            const stream = response.body, originalGetReader = stream.getReader;
            const counters = { getReaderCalls: 0, reads: 0, bytes: 0, done: false, error: false, cancelCalls: 0 };
            window.wp092ReaderCounters = counters;
            const emit = () => { void window.wp092Reader({ ...counters }).catch(() => {}); };
            stream.getReader = function (...readerArgs) {
              const reader = Reflect.apply(originalGetReader, this, readerArgs);
              counters.getReaderCalls++; emit();
              const originalRead = reader.read, originalCancel = reader.cancel;
              reader.read = function (...readArgs) {
                return Reflect.apply(originalRead, this, readArgs).then((value) => { counters.reads++; counters.bytes += value.value?.byteLength ?? 0; counters.done ||= value.done; emit(); return value; }, (error) => { counters.error = true; emit(); throw error; });
              };
              reader.cancel = function (...cancelArgs) { counters.cancelCalls++; emit(); return Reflect.apply(originalCancel, this, cancelArgs); };
              return reader;
            };
            return response;
          });
        };
      }, detailPath);
    }
    context.on('request', (request) => {
      if (request.isNavigationRequest() && request.resourceType() === 'document' && request.frame() === page?.mainFrame()) report.documentRequests.push({ stage: checkpoint, elapsedMs: Date.now() - startedAt, method: request.method(), detailPath: new URL(request.url()).pathname === detailPath });
    });
    context.on('response', (response) => {
      const item = pending.get(response.request());
      if (item) {
        item.status = response.status();
        item.responseStartedAtStage = checkpoint;
        const type = response.headers()['content-type'] ?? '';
        item.responseType = type.startsWith('text/x-component') ? 'rsc' : type.startsWith('text/plain') ? 'plain' : 'other';
        item.redirectTargetMatchesDetail = (response.headers()['x-action-redirect'] ?? '').includes(detailPath);
        item.responseFinished = 'pending';
        const recordFinished = (state) => {
          if (item.failed !== true && item.responseFinished === 'pending') item.responseFinished = state;
          nativeWaits.get(response.request())?.notify();
        };
        void response.finished().then((error) => { recordFinished(error ? 'failed' : 'complete'); }, () => { recordFinished('failed'); });
      }
    });
    context.on('requestfailed', (request) => { const item = classifiedWrites.get(request); if (item) { item.failed = true; item.failureStage = checkpoint; item.failureCode = request.failure()?.errorText.includes('ERR_ABORTED') ? 'ABORTED' : 'FAILED'; } });
    context.on('requestfinished', (request) => { const item = pending.get(request); if (item) { item.completed = true; item.finishedStage = checkpoint; pending.delete(request); } });
    await context.route('**/*', async (route) => {
      const request = route.request(), url = new URL(request.url()), headers = request.headers();
      const prefetch = Boolean(headers['next-router-prefetch'] || headers.purpose === 'prefetch');
      if (url.origin !== origin) { report.network.foreign++; return route.abort(); }
      if (!['GET', 'HEAD'].includes(request.method())) {
        const expected = writeSequence[expectedIndex];
        if (request.method() === 'POST' && expected && expectedIndex === report.network.allowedWrites.length && currentCase === pendingCase(expectedIndex) && url.pathname === detailPath && !prefetch && typeof headers['next-action'] === 'string' && headers['next-action'].length > 0) {
          let native;
          try {
            const response = new Response(request.postDataBuffer(), { headers: { 'content-type': headers['content-type'] } });
            const form = await response.formData();
            const entries = [...form.entries()].filter(([key]) => /(?:^|_)userId$/.test(key));
            native = { userId: entries.length === 1 ? entries[0][1] : null, entries: entries.length };
          } catch { native = { userId: null, entries: 0 }; }
          if (native.entries !== 1 || native.userId !== expected.userId) { report.network.nonReadCount++; return route.abort(); }
          const item = { index: expectedIndex, case: currentCase, method: 'POST', path: url.pathname, query: url.search, actualNextAction: true, nativeFormData: native, status: null, completed: false, responseFinished: 'pending' };
          report.network.allowedWrites.push(item);
          pending.set(request, item);
          classifiedWrites.set(request, item);
          classifiedRequests.set(item, request);
          return route.continue();
        }
        report.network.nonReadCount++;
        return route.abort();
      }
      if (prefetch) { report.network.prefetchAttempts++; report.network.prefetchBlocked++; return route.abort(); }
      if (!url.pathname.startsWith('/_next/') && ![detailPath, '/ops/groups', '/favicon.ico'].includes(url.pathname)) { report.network.unknownReads++; return route.abort(); }
      return route.continue();
    });
    await check('C01', async () => {
      await open();
      await idle();
      assert.equal(await count(), 20);
      assert.equal(await main().locator('time').first().getAttribute('datetime'), baseMembers[0].addedAt);
      assert.equal(await main().locator('ul.groups form').count(), 20);
      assert.equal(await selection().locator('option').count(), 4);
      report.details.push({ case: 'C01', memberCount: 20, width: 1280, statusAbsent: true });
    });
    await check('C02', async () => {
      await open({ long: true }, 390);
      await idle();
      assert.equal(await count(), 20);
      assert.ok((await main().innerText()).includes(longName));
      report.details.push({ case: 'C02', memberCount: 20, width: 390, overflow: await overflow(), longConfirmed: true, statusAbsent: true });
    });
    await check('C03', async () => {
      await open();
      await addButton().click();
      assert.equal(await selection().evaluate((e) => e.validity.valueMissing), true);
      assert.equal(await selection().evaluate((e) => document.activeElement === e), true);
      assert.equal(report.network.allowedWrites.length, 0);
      assert.equal(observations().writes.length, 0);
      await idle();
      report.details.push({ case: 'C03', nativeInvalid: true, focused: true, nextPosts: 0, apiPosts: 0 });
    });
    await check('C04', async () => {
      await open();
      await page.locator('label[for=member-id]').click();
      await page.keyboard.press('Escape');
      await page.keyboard.press('a');
      assert.equal(await selection().inputValue(), addUserId, 'WP092_NATIVE_KEYBOARD_VALUE');
      await page.keyboard.press('Tab');
      const focus = await addButton().evaluate((e) => ({ focused: document.activeElement === e, outlineStyle: window.getComputedStyle(e).outlineStyle, outlineWidth: window.getComputedStyle(e).outlineWidth }));
      assert.equal(focus.focused, true);
      assert.equal(focus.outlineStyle, 'solid');
      assert.ok(parseFloat(focus.outlineWidth) > 0);
      assert.deepEqual(await nativeValue(addForm()), { userId: addUserId, entries: 1 });
      assert.equal(report.network.allowedWrites.length, 0);
      assert.equal(observations().writes.length, 0);
      report.details.push({ case: 'C04', selectedUserId: addUserId, focus, nextPosts: 0, apiPosts: 0 });
    });
    for (const [index, expected] of writeSequence.entries()) {
      let form, button, detail, finished;
      const beforeCount = index === 1 ? 21 : 20;
      await check(pendingCase(index), async () => {
        await open({ long: index >= 6 }, index >= 6 ? 390 : 1280);
        assert.equal(await count(), beforeCount);
        const before = observations();
        assert.equal(before.writes.length, index);
        const person = people.find((p) => p.userId === expected.userId);
        assert.ok(person);
        let eligibility;
        if (expected.operation === 'add') {
          assert.equal(person.status, 'active');
          assert.equal(before.currentMemberIds.includes(expected.userId), false);
          const option = selection().locator('option[value="' + expected.userId + '"]');
          assert.equal(await option.count(), 1);
          assert.equal(await option.evaluate((e) => e.disabled), false);
          await selection().selectOption(expected.userId);
          form = addForm();
          button = addButton();
          eligibility = { active: true, inRoster: false, onCurrentPage: true, optionEnabled: true };
        } else {
          assert.equal(before.currentMemberIds.includes(expected.userId), true);
          form = removeForm(expected.userId);
          assert.equal(await form.count(), 1);
          assert.equal(await form.locator('input[type="hidden"][name="userId"]').inputValue(), expected.userId);
          assert.equal(await form.locator('fieldset input[type="hidden"]').count(), 0);
          button = form.getByRole('button', { name: 'このグループから外す', exact: true });
          eligibility = { inRoster: true, renderedHiddenUserId: expected.userId, hiddenOutsideFieldset: true };
        }
        const beforeNative = await nativeValue(form);
        assert.deepEqual(beforeNative, { userId: expected.userId, entries: 1 });
        expectedIndex = index;
        stage(currentCase + '-initial-submit');
        await button.click();
        stage(currentCase + '-wait-api-received');
        const received = await control({ waitForReceived: index });
        assert.deepEqual(received.apiBody, { userId: expected.userId });
        assert.equal(received.bodyValid, true);
        stage(currentCase + '-wait-react-pending');
        await form.locator('fieldset[disabled]').waitFor();
        assert.equal(await button.isDisabled(), true);
        assert.equal(await form.getByRole('status').innerText(), statusText(expected.operation));
        assert.equal(await form.getByRole('status').count(), 1);
        const actualValue = expected.operation === 'add' ? await selection().inputValue() : await form.locator('input[type="hidden"][name="userId"]').inputValue();
        assert.equal(actualValue, expected.userId);
        if (expected.operation === 'add') assert.equal(await selection().isDisabled(), true);
        assert.equal(await main().locator('fieldset[disabled]').count(), 1);
        const othersEnabled = await main().locator('form fieldset').evaluateAll((sets) => sets.filter((e) => !e.disabled).length);
        assert.ok(othersEnabled >= 20, 'WP092_OTHER_FORMS_INDEPENDENT');
        if (expected.operation === 'remove') assert.equal(await addButton().isDisabled(), false);
        stage(currentCase + '-normal-extra-click-enter');
        await button.scrollIntoViewIfNeeded();
        const box = await button.boundingBox();
        assert.ok(box);
        const focusBeforeExtraClick = await activeFocus(form);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        const focusBeforeExtraEnter = await activeFocus(form);
        if (diagnostic !== 'omit-extra-enter') await page.keyboard.press('Enter');
        const focusAfterExtraEnter = await activeFocus(form);
        assert.equal(report.network.allowedWrites.length, index + 1);
        assert.equal(report.network.nonReadCount, 0);
        assert.equal(observations().writes.length, index + 1);
        assert.equal(observations().writes[index].completed, false);
        assert.equal(observations().pendingResponses, 1);
        const nativeNext = report.network.allowedWrites[index].nativeFormData;
        assert.deepEqual(nativeNext, beforeNative);
        detail = { index, operation: expected.operation, expectedStatus: expected.status, expectedUserId: expected.userId, pendingCase: pendingCase(index), outcomeCase: outcomeCase(index), memberCounts: [beforeCount], eligibility, beforeNative, nativeNext, apiBody: received.apiBody, pendingValue: actualValue, statusText: statusText(expected.operation), fieldsetDisabled: true, controlDisabled: true, otherFormsEnabled: othersEnabled, normalExtraClick: true, normalExtraEnter: diagnostic !== 'omit-extra-enter', focusBeforeExtraClick, focusBeforeExtraEnter, focusAfterExtraEnter, additionalNextPosts: 0, additionalApiPosts: 0, width: index >= 6 ? 390 : 1280 };
        if (index >= 6) { detail.overflowPending = await overflow(); assert.ok((await main().innerText()).includes(longName)); detail.longConfirmed = true; }
        report.details.push(detail);
      });
      await check(outcomeCase(index), async () => {
        detail.requestFinishedListenerBeforeRelease = true;
        const next = report.network.allowedWrites[index];
        const request = classifiedRequests.get(next);
        assert.ok(request, 'WP092_NATIVE_REQUEST_IDENTITY');
        assert.equal(classifiedWrites.get(request), next, 'WP092_NATIVE_REQUEST_IDENTITY');
        const wait = waitForNativeCompletion({ context, page, request, item: next, signal });
        nativeWaits.set(request, wait);
        ownedNativeWaits.add(wait);
        finished = wait.promise.then((reason) => {
          next.nativeWait = reason;
          nativeWaits.delete(request);
          classifiedRequests.delete(next);
          ownedNativeWaits.delete(wait);
          return reason === 'settled';
        });
        stage(currentCase + '-release');
        control({ release: index });
        stage(currentCase + '-await-redirect');
        await page.waitForURL((url) => expected.status === 204 ? url.searchParams.get('notice') === (expected.operation === 'add' ? 'added' : 'removed') : url.searchParams.get('error') === failureDetail(expected.operation, expected.status));
        stage(currentCase + '-await-network-idle');
        await page.waitForLoadState('networkidle');
        stage(currentCase + '-await-ready');
        await ready();
        stage(currentCase + '-await-native-finish');
        const nativeFinished = await finished;
        assert.equal(next.status, 303, 'WP092_NATIVE_NEXT_STATUS');
        const observerGate = { index, case: currentCase, passed: nativeFinished && next.completed && next.responseFinished === 'complete' && next.failed !== true, requestFinished: nativeFinished, preCloseNative: structuredClone(next) };
        report.observerGates.push(observerGate);
        if (allReaderMeasurement) {
          await page.waitForFunction(() => window.wp092ReaderCounters?.done || window.wp092ReaderCounters?.error || window.wp092ReaderCounters?.cancelCalls > 0);
          const reader = originalReaderPages.get(page), protocol = report.protocol.find((item) => item.index === index);
          assert.ok(reader && protocol);
          assert.equal(reader.getReaderCalls, 1);
          assert.equal(reader.done, true);
          assert.equal(reader.error, false);
          assert.equal(reader.cancelCalls, 0);
          assert.ok(reader.bytes > 0);
          assert.equal(reader.bytes, protocol.dataLength);
          detail.originalReader = structuredClone(reader);
          detail.observerGate = observerGate;
        } else {
          assert.equal(nativeFinished, true, 'WP092_NATIVE_NEXT_FINISH');
          assert.equal(next.completed, true);
          assert.equal(next.responseFinished, 'complete');
          assert.notEqual(next.failed, true);
        }
        const after = observations(), write = after.writes[index];
        assert.equal(write.completed, true);
        assert.equal(write.status, expected.status);
        assert.equal(write.released, true);
        assert.equal(after.pendingResponses, 0);
        assert.equal(after.writes.length, index + 1);
        assert.equal(report.network.allowedWrites.length, index + 1);
        const expectedCount = index === 0 ? 21 : 20;
        assert.equal(await count(), expectedCount);
        assert.equal(after.currentMemberIds.length, expectedCount);
        if (expected.status !== 204) {
          assertQuery({ error: failureDetail(expected.operation, expected.status) });
          assert.ok((await main().getByRole('alert').innerText()).includes(failureDetail(expected.operation, expected.status)));
          if (expected.operation === 'remove') assert.equal(await removeForm(expected.userId).count(), 1);
        } else {
          const notice = expected.operation === 'add' ? 'added' : 'removed';
          assertQuery({ notice });
          assert.ok((await main().innerText()).includes(expected.operation === 'add' ? 'メンバーの追加を受け付けました。所属済みの人は重複して追加されません。' : 'このグループからメンバーを外しました。'));
        }
        assert.equal(await main().locator('fieldset[disabled]').count(), 0);
        assert.equal(await main().locator('fieldset [role="status"]').count(), 0);
        assert.equal(await selection().isDisabled(), false);
        assert.equal(await addButton().isDisabled(), false);
        assert.equal(await selection().inputValue(), '');
        assert.ok(await main().locator('ul.groups button').evaluateAll((buttons) => buttons.every((button) => !button.matches(':disabled'))));
        detail.memberCounts.push(expectedCount);
        Object.assign(detail, { releasedIndex: index, nextStatus: next.status, nextCompleted: next.completed, nextResponseFinished: next.responseFinished, apiCompleted: write.completed, apiStatus: write.status, contextKept: true, controlsReenabled: true, pendingStatusGone: true, existingPlaceholder: true, pendingAfter: after.pendingResponses, automaticallyResent: false });
        if (index >= 6) detail.overflowOutcome = await overflow();
        expectedIndex = null;
      });
    }
    assert.deepEqual(report.checks.map((c) => c.case), groupMembershipPendingCases);
    assert.ok(report.checks.every((c) => c.passed || (allReaderMeasurement && c.semanticPassed)));
    assert.equal(report.screenshots.length, diagnostic === 'omit-pending-capture' ? 12 : 20);
    assert.equal(report.accessibility.length, diagnostic === 'omit-pending-capture' ? 12 : 20);
    for (const key of ['nonReadCount', 'unknownReads', 'foreign', 'downloads']) assert.equal(report.network[key], 0);
    assert.equal(report.network.allowedWrites.length, 8);
    if (allReaderMeasurement) {
      assert.equal(report.observerGates.length, 8);
      assert.ok(report.network.allowedWrites.every((w) => w.actualNextAction && w.status === 303));
      report.unresolvedNativePending = pending.size;
    } else {
      assert.ok(report.network.allowedWrites.every((w) => w.completed && w.actualNextAction && w.status === 303 && w.responseFinished === 'complete' && w.failed !== true));
      assert.equal(pending.size, 0);
    }
    assert.equal(report.network.prefetchAttempts, report.network.prefetchBlocked);
    const final = observations();
    assert.equal(final.unexpectedMutations, 0);
    assert.equal(final.unknownReads, 0);
    assert.equal(final.heldResponses, 8);
    assert.equal(final.releasedResponses, 8);
    assert.equal(final.pendingResponses, 0);
    assert.equal(final.pendingWaiters, 0);
    assert.equal(final.pendingTimers, 0);
    assert.ok(final.writes.every((w) => w.received && w.bodyValid && w.completed && w.released && !w.destroyed));
    report.semanticMeasurementComplete = allReaderMeasurement;
    report.success = !allReaderMeasurement;
  } catch {
    report.success = false;
    report.preCloseDiagnostic = { case: currentCase, checkpoint, query: page && !page.isClosed() ? Object.fromEntries(new URL(page.url()).searchParams) : null, nextWrites: structuredClone(report.network.allowedWrites), fixture: { received: observations().writes.filter((w) => w.received).length, completed: observations().writes.filter((w) => w.completed).length, pendingResponses: observations().pendingResponses } };
    report.preCloseDiagnostic.rendered = page && !page.isClosed() ? await page.evaluate(() => ({ rosterCount: document.querySelectorAll('main ul.groups > li').length, disabledFieldsets: document.querySelectorAll('main form fieldset[disabled]').length, pendingStatusCount: document.querySelectorAll('main form fieldset [role="status"]').length, selectValue: document.querySelector('#member-id')?.value ?? null })).catch(() => ({ available: false })) : null;
  }
  finally {
    signal?.removeEventListener('abort', interrupt);
    const closed = await closeOwned();
    report.closeResults = closed.map((r) => r.status);
    if (closed.some((r) => r.status === 'rejected') || !report.contextClosed || !report.browserClosed) report.success = false;
    await writeFile(join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  return report;
}
