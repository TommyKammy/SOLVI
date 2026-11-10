/* global document, getComputedStyle, innerWidth, window */
// WP-P2-UIX-039: live authoring and non-writing input trials against local synthetic data.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

const base = new URL(process.env.SOLVI_UI_BASE ?? 'http://127.0.0.1:3000');
assert.ok(
  base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname),
  'Only the local synthetic SOLVI environment is supported',
);
const password = process.env.SOLVI_SMOKE_PASSWORD;
assert.ok(password, 'SOLVI_SMOKE_PASSWORD is required');
const browserName = process.env.SOLVI_UI_BROWSER ?? 'chromium';
assert.ok(['chromium', 'webkit'].includes(browserName), 'Unsupported browser');
const output = resolve(process.env.SOLVI_UI_OUT ?? `evidence/WP-P2-UIX-039/browser/${browserName}`);
const ownDraftId = process.env.SOLVI_UI_OWN_DRAFT_ID;
const resumeSaved = process.env.SOLVI_UI_RESUME_SAVED === '1';
assert.ok(!resumeSaved || ownDraftId, 'Resuming requires the owned synthetic draft ID');
assert.ok(!ownDraftId || /^[0-9a-f-]{36}$/i.test(ownDraftId), 'Invalid synthetic draft ID');
const marker = process.env.SOLVI_UI_OWN_DRAFT_TITLE ?? `UI039-SYN-${Date.now()}`;
assert.match(marker, /^UI039-SYN-\d+$/, 'Only synthetic UI039 draft titles are supported');
const savePath = ownDraftId ? `/catalog/manage/${ownDraftId}` : '/catalog/manage/new';
const sample = 'UI039-PREVIEW-ONLY';
const description = '合成データによるPC貸与フォームの表示・入力試験です。実機の貸出は行いません。';
const report = {
  workPackage: 'WP-P2-UIX-039',
  browser: browserName,
  syntheticTitle: marker,
  success: false,
  checks: [],
  screenshots: [],
  accessibility: [],
  network: { authWrites: 0, draftAttempts: 0, draftWrites: 0, blocked: [] },
};
let browser,
  context,
  page,
  authenticated = false,
  allowDraftSave = false,
  releaseDraftSave;
let capturedSave, saveArrived;
let saveValidated = false;
const saveArrivedPromise = new Promise((done) => {
  saveArrived = done;
});
const saveReleasePromise = new Promise((done) => {
  releaseDraftSave = done;
});
const editor = () => page.locator('form:has(#catalog-title)');
const trial = () => page.getByRole('form', { name: '編集中フォームの入力試験', exact: true });
const live = () => page.locator('#catalog-live-preview');
const feedback = () => trial().getByRole('status');
const fields = async () => JSON.parse(await editor().locator('[name="fields"]').inputValue());
const businessWrites = () => report.network.draftWrites + report.network.blocked.length;

async function check(name, run) {
  report.currentStep = name;
  try {
    await run();
    report.checks.push({ name, passed: true });
  } catch (error) {
    report.checks.push({ name, passed: false });
    throw error;
  }
}

async function within(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not arrive within 15 seconds`)),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function open(path) {
  await page.goto(new URL(path, base).href, { waitUntil: 'networkidle' });
  await page.locator('main h1').first().waitFor();
}

async function screenshot(name) {
  await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true });
  report.screenshots.push(`${name}.png`);
}

async function axe(name) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const violations = result.violations.map((issue) => ({
    id: issue.id,
    impact: issue.impact,
    targets: issue.nodes.map((node) => node.target),
  }));
  report.accessibility.push({ name, violations });
  assert.deepEqual(violations, [], `axe: ${name}`);
}

async function uniqueIds() {
  const duplicates = await page.evaluate(() => {
    const ids = [...document.querySelectorAll('[id]')].map((node) => node.id);
    return [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  });
  assert.deepEqual(duplicates, [], 'Preview and editor IDs must be unique');
}

async function editorData() {
  return editor().evaluate((form) =>
    [...new FormData(form).entries()].filter(
      ([key, value]) => !key.startsWith('$ACTION') && typeof value === 'string',
    ),
  );
}

async function previewNoWrites(run) {
  const before = businessWrites();
  await run();
  // Give any accidentally scheduled server action an opportunity to reach the guard.
  await page.waitForTimeout(150);
  assert.equal(businessWrites(), before, 'Input trials must send no business writes');
}

async function testInput() {
  await trial().getByRole('button', { name: '入力を試す', exact: true }).click();
  await feedback().waitFor();
}

async function fillSamples() {
  await trial().getByLabel('利用する理由（必須）', { exact: true }).fill(sample);
  await trial().getByLabel('希望する利用日数（必須）', { exact: true }).selectOption('30');
  const definition = await fields();
  for (const field of definition) {
    const control = trial().getByLabel(`${field.label}（${field.required ? '必須' : '任意'}）`, {
      exact: true,
    });
    if (field.type === 'select') await control.selectOption(field.options[0]);
    else if (field.type === 'checkbox') await control.check();
    else await control.fill(field.maxLength < sample.length ? '合成' : sample);
  }
}

async function focusFromKeyboard() {
  const forwardKey = browserName === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab';
  const title = page.locator('#catalog-title');
  await title.focus();
  await page.keyboard.press(forwardKey);
  const focus = await page.locator('#catalog-description').evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      focused: document.activeElement === node,
      visible: node.matches(':focus-visible'),
      outline: style.outlineStyle,
      outlineWidth: parseFloat(style.outlineWidth),
      boxShadow: style.boxShadow,
    };
  });
  assert.equal(focus.focused, true, 'Keyboard must move from service name to description');
  assert.equal(focus.visible, true);
  assert.ok(
    (focus.outline !== 'none' && focus.outlineWidth >= 2) ||
      (focus.boxShadow !== 'none' && focus.boxShadow.includes('3px')),
    'Keyboard focus must have a visible outline or the established 3px field focus ring',
  );
  report.keyboard = { forwardKey, ...focus };
}

async function openSavedEditor() {
  const summary = page.getByText('下書きの項目と承認者を編集する', { exact: true });
  if (!(await summary.locator('..').evaluate((details) => details.open))) await summary.click();
  await page.locator('#catalog-title').waitFor({ state: 'visible' });
}

async function dirtySavedDraftGuard() {
  await openSavedEditor();
  await page.locator('#catalog-title').fill(`${marker}-UNSAVED`);
  assert.equal(await trial().getByRole('heading', { level: 3 }).innerText(), `${marker}-UNSAVED`);
  assert.equal(await page.locator('#preview h3').innerText(), marker);
  const publication = page.locator('section[aria-label="カタログの編集と公開"] > form');
  assert.equal(await publication.locator('[name="state"][value="published"]').isDisabled(), true);
  await publication.evaluate((form) => {
    form.requestSubmit(form.querySelector('[name="state"][value="published"]'));
    form.requestSubmit();
  });
  await page.waitForTimeout(150);
  assert.equal(report.network.draftWrites, 1);
  assert.deepEqual(report.network.blocked, []);
  await open(`/catalog/manage/${report.createdDraftId}`);
  assert.ok((await page.locator('main').innerText()).includes(marker));
  assert.equal((await page.locator('main').innerText()).includes(`${marker}-UNSAVED`), false);
  assert.match(
    await page.locator('main > p.notice').innerText(),
    /^非公開: 新規申請を受け付けていません/,
  );
}

async function main() {
  await mkdir(output, { recursive: true });
  browser = await (browserName === 'webkit' ? webkit : chromium).launch(
    browserName === 'chromium' ? { channel: process.env.SOLVI_UI_BROWSER_CHANNEL ?? 'chrome' } : {},
  );
  report.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === base.origin && ['GET', 'HEAD'].includes(request.method()))
      return route.continue();
    if (
      url.origin === base.origin &&
      request.method() === 'POST' &&
      ['/login', '/select-organization'].includes(url.pathname)
    ) {
      report.network.authWrites++;
      return route.continue();
    }
    if (
      url.origin === base.origin &&
      request.method() === 'POST' &&
      url.pathname === savePath &&
      allowDraftSave &&
      report.network.draftAttempts === 0
    ) {
      report.network.draftAttempts++;
      // Keep only the known editor fields in memory. Never persist the wire body or cookies.
      const wire = await new Request(request.url(), {
        method: 'POST',
        headers: { 'content-type': request.headers()['content-type'] },
        body: request.postDataBuffer(),
      }).formData();
      report.wireKeys = [...wire.keys()];
      const allowed =
        /^(code|creationKey|expectedVersion|returnTo|title|description|targetLabel|allowedDurations|maxReasonLength|approverId|fields|fields\.\d+\.(key|label|type|maxLength|options))$/;
      capturedSave = [...wire.entries()]
        .map(([key, value]) => [key.replace(/^_?\d+_/, ''), value])
        .filter(([key, value]) => allowed.test(key) && typeof value === 'string');
      saveArrived();
      await saveReleasePromise;
      if (saveValidated) {
        report.network.draftWrites++;
        return route.continue();
      }
      return route.abort();
    }
    report.network.blocked.push({ method: request.method(), path: url.pathname });
    return route.abort();
  });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  await open('/login');
  await page.getByLabel('メールアドレス', { exact: true }).fill('org_admin@acme.example.test');
  await page.getByLabel('パスワード', { exact: true }).fill(password);
  await Promise.all([
    page.waitForURL((url) => ['/inbox', '/select-organization'].includes(url.pathname)),
    page.getByRole('button', { name: 'ログイン', exact: true }).click(),
  ]);
  await page.waitForLoadState('networkidle');
  if (new URL(page.url()).pathname === '/select-organization') {
    await page.getByLabel('サンプル株式会社', { exact: true }).check();
    await Promise.all([
      page.waitForURL((url) => url.pathname === '/inbox'),
      page.getByRole('button', { name: 'この組織で続ける', exact: true }).click(),
    ]);
  }
  authenticated = true;
  if (resumeSaved) {
    const prior = JSON.parse(await readFile(resolve(output, 'summary.json'), 'utf8'));
    assert.equal(prior.createdDraftId, ownDraftId);
    assert.equal(prior.syntheticTitle, marker);
    assert.equal(prior.network.draftWrites, 1);
    assert.equal(prior.savedPayload?.previewSamplesExcluded, true);
    assert.equal(prior.checks.find((item) => item.name.startsWith('One synthetic'))?.passed, true);
    report.checks = prior.checks.filter((item) => item.passed);
    report.accessibility = prior.accessibility;
    report.screenshots = prior.screenshots.filter((name) => name !== 'failure.png');
    report.keyboard = prior.keyboard;
    report.mobileWidth = prior.mobileWidth;
    report.previewBusinessWrites = prior.previewBusinessWrites;
    report.savedPayload = prior.savedPayload;
    report.createdDraftId = ownDraftId;
    report.reconciliation = prior.reconciliation;
    report.network.draftWrites = prior.network.draftWrites;
    report.network.draftAttempts = prior.network.draftAttempts;
    report.resume = {
      earlierVerifiedSaves: 1,
      additionalBusinessWrites: 0,
      reason:
        'Read-only completion after the harness opened the editor before the final saved redirect',
    };
    await open(savePath);
    await check('Own saved draft dirty publication guard; saved content is unchanged', async () =>
      previewNoWrites(dirtySavedDraftGuard),
    );
    assert.deepEqual(report.network.blocked, []);
    report.success = true;
    return;
  }
  await open('/catalog/manage/new');
  await editor().waitFor();

  let originalCode, expectedFields;
  await check('PC template and automatic immutable code', async () => {
    originalCode = await editor().locator('[name="code"]').inputValue();
    assert.match(originalCode, /^service-[0-9a-f-]{36}$/i);
    assert.equal(await editor().locator('input[name="code"]:not([type="hidden"])').count(), 0);
    await page.locator('#catalog-template').selectOption('local-pc-loan');
    await page.getByRole('button', { name: '選んだテンプレートを入力する', exact: true }).click();
    assert.equal(await editor().locator('[name="code"]').inputValue(), originalCode);
    assert.equal(await page.locator('#catalog-title').inputValue(), 'PC貸与申請');
    assert.equal((await fields()).length, 6);
    const approver = await page
      .locator('#catalog-approver option')
      .evaluateAll((options) => options.find((option) => option.value)?.value);
    assert.ok(approver, 'A synthetic approver must be available');
    await page.locator('#catalog-approver').selectOption(approver);
    await page.locator('#catalog-title').fill(marker);
    await page.locator('#catalog-description').fill(description);
    assert.equal(await trial().getByRole('heading', { level: 3 }).innerText(), marker);
    assert.ok((await trial().innerText()).includes(description));
  });

  await check('Four sections preserve values and focus their headings', async () => {
    const before = await editorData();
    for (const id of [
      'catalog-basic-settings',
      'catalog-question-settings',
      'catalog-approval-settings',
      'catalog-save-review',
    ]) {
      await page.locator(`nav[aria-label="サービス作成の手順"] a[href="#${id}"]`).click();
      assert.equal(
        await page.locator(`#${id}`).evaluate((node) => document.activeElement === node),
        true,
      );
      assert.equal(await page.locator(`#${id}`).isVisible(), true);
    }
    assert.deepEqual(await editorData(), before);
    assert.equal(
      await editor().evaluate((form) =>
        form.contains(document.querySelector('#catalog-live-preview')),
      ),
      false,
    );
    assert.equal(
      await trial().evaluate((form) => form.parentElement.closest('form') === null),
      true,
    );
  });

  await check('Reorder and remove retain field keys and editor payload', async () => {
    const initial = await fields();
    await page.getByRole('button', { name: '申請項目を追加する', exact: true }).click();
    await page.locator('#field-label-6').fill('補足事項（合成）');
    await page.locator('#field-type-6').selectOption('textarea');
    await page.locator('#field-limit-6').fill('100');
    const withTextarea = await fields();
    const extra = withTextarea[6];
    await page.getByRole('button', { name: '項目7を上へ', exact: true }).click();
    assert.deepEqual(await fields(), [...initial.slice(0, 5), extra, initial[5]]);
    await page.getByRole('button', { name: '申請項目を追加する', exact: true }).click();
    await page.locator('#field-label-7').fill('除去する合成質問');
    await page.getByRole('button', { name: '項目8を下書きから外す', exact: true }).click();
    expectedFields = [...initial.slice(0, 5), extra, initial[5]];
    assert.deepEqual(await fields(), expectedFields);
    const payload = new Map(await editorData());
    expectedFields.forEach((field, index) =>
      assert.equal(payload.get(`fields.${index}.key`), field.key),
    );
    assert.equal(
      await trial().locator('textarea').count(),
      2,
      'Reason and added long text must be present',
    );
    assert.equal(await trial().locator('input[type="text"]').count(), 3);
    assert.equal(await trial().locator('select').count(), 3);
    assert.equal(await trial().locator('input[type="checkbox"]').count(), 1);
    await uniqueIds();
  });

  await check('Required and checkbox trial feedback sends zero writes', async () =>
    previewNoWrites(async () => {
      await testInput();
      assert.ok((await feedback().innerText()).includes('利用する理由を入力してください。'));
      assert.ok((await feedback().innerText()).includes('利用部署を入力してください。'));
      assert.ok((await feedback().innerText()).includes('確認してチェックしてください。'));
      assert.equal(await feedback().evaluate((node) => document.activeElement === node), true);
      assert.ok((await trial().locator('[aria-invalid="true"]').count()) >= 6);
    }),
  );

  await check('Length, duration and select candidate feedback sends zero writes', async () =>
    previewNoWrites(async () => {
      await fillSamples();
      await page.locator('#catalog-reason-limit').fill('5');
      await page.locator('#field-limit-0').fill('5');
      await page.locator('#field-limit-5').fill('5');
      await page.locator('#catalog-days').fill('1,2');
      await page.locator('#field-options-1').fill('別の合成候補A\n別の合成候補B');
      assert.equal(
        await trial()
          .getByLabel(`${expectedFields[1].label}（必須）`, { exact: true })
          .inputValue(),
        '',
        'A sample outside the updated candidate list must be cleared',
      );
      await testInput();
      const text = await feedback().innerText();
      assert.ok(text.includes('利用する理由は5文字以内にしてください。'));
      assert.ok(text.includes('設定された利用日数から選んでください。'));
      assert.ok(text.includes('利用部署の候補または文字数を確認してください。'));
      assert.ok(text.includes(`${expectedFields[1].label}を入力してください。`));
      assert.ok(text.includes('補足事項（合成）の候補または文字数を確認してください。'));
      await screenshot('trial-validation-desktop');
      await page.locator('#catalog-reason-limit').fill('2000');
      await page.locator('#field-limit-0').fill(String(expectedFields[0].maxLength));
      await page.locator('#field-limit-5').fill(String(expectedFields[5].maxLength));
      await page.locator('#catalog-days').fill('7,30,90,180');
      await page.locator('#field-options-1').fill(expectedFields[1].options.join('\n'));
      assert.deepEqual(await fields(), expectedFields);
    }),
  );

  await check('Enter and reset are local; samples do not enter editing FormData', async () =>
    previewNoWrites(async () => {
      await fillSamples();
      const before = await editorData();
      assert.equal(
        before.some(([, value]) => value.includes(sample)),
        false,
      );
      const department = trial().getByLabel('利用部署（必須）', { exact: true });
      await department.press('Enter');
      await feedback().waitFor();
      assert.equal(
        (await feedback().innerText()).trim(),
        '入力を確認しました。申請は送信されません。',
      );
      assert.deepEqual(await editorData(), before);
      await trial().getByRole('button', { name: '試験入力をクリアする', exact: true }).click();
      assert.equal(
        await trial().getByLabel('利用する理由（必須）', { exact: true }).inputValue(),
        '',
      );
      assert.equal(await trial().getByRole('checkbox').isChecked(), false);
      assert.equal(await feedback().count(), 0);
      assert.deepEqual(await editorData(), before);
      await fillSamples();
      await testInput();
      assert.equal(
        (await feedback().innerText()).trim(),
        '入力を確認しました。申請は送信されません。',
      );
      report.previewBusinessWrites = businessWrites();
      assert.equal(report.previewBusinessWrites, 0);
    }),
  );

  await check('Changing a question type discards incompatible trial values', async () =>
    previewNoWrites(async () => {
      const key = expectedFields[0].key;
      await page.locator('#field-type-0').selectOption('checkbox');
      const checkbox = trial().getByLabel('利用部署（必須）', { exact: true });
      assert.equal(await checkbox.isChecked(), false);
      assert.equal((await fields())[0].key, key);
      await testInput();
      assert.ok(
        (await feedback().innerText()).includes('利用部署を確認してチェックしてください。'),
      );
      await checkbox.check();
      await page.locator('#field-type-0').selectOption('text');
      assert.equal(await trial().getByLabel('利用部署（必須）', { exact: true }).inputValue(), '');
      await page.locator('#field-limit-0').fill(String(expectedFields[0].maxLength));
      assert.deepEqual(await fields(), expectedFields);
      await fillSamples();
      await testInput();
      assert.equal(
        (await feedback().innerText()).trim(),
        '入力を確認しました。申請は送信されません。',
      );
    }),
  );

  await check('Desktop keyboard, unique IDs and WCAG 2.2', async () => {
    await focusFromKeyboard();
    await uniqueIds();
    await axe('new-draft-desktop-1440');
    await screenshot('new-draft-desktop-1440');
    await page.evaluate(() => {
      document.activeElement?.blur();
      document.querySelector('#catalog-live-preview').scrollTop = 0;
      window.scrollTo(0, 0);
    });
    await page.screenshot({ path: resolve(output, 'new-draft-desktop-viewport.png') });
    report.screenshots.push('new-draft-desktop-viewport.png');
  });
  await check('Mobile 375px layout and WCAG 2.2', async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    const width = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: innerWidth,
    }));
    assert.ok(width.document <= width.viewport, '375px authoring must not overflow horizontally');
    report.mobileWidth = width;
    await focusFromKeyboard();
    await axe('new-draft-mobile-375');
    await screenshot('new-draft-mobile-375');
    await live().scrollIntoViewIfNeeded();
    await screenshot('new-draft-mobile-preview');
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await check(
    'One synthetic nonpublic draft save; pending trial isolation and wire payload',
    async () => {
      if (ownDraftId) {
        await open(savePath);
        assert.match(
          await page.locator('main > p.notice').innerText(),
          /^非公開: 新規申請を受け付けていません/,
        );
        const summary = page.getByText('下書きの項目と承認者を編集する', { exact: true });
        if (!(await summary.locator('..').evaluate((details) => details.open)))
          await summary.click();
        assert.equal(await page.locator('#catalog-title').inputValue(), marker);
        const savedFields = await fields();
        assert.deepEqual(
          savedFields.map(({ key: _key, ...field }) => field),
          expectedFields.map(({ key: _key, ...field }) => field),
          'The reconciled draft must contain the same synthetic question definitions',
        );
        expectedFields = savedFields;
        originalCode = await editor().locator('[name="code"]').inputValue();
        assert.match(originalCode, /^service-[0-9a-f-]{36}$/i);
        await fillSamples();
        await testInput();
        report.reconciliation = {
          reusedCreatedDraft: ownDraftId,
          initialCreationCount: 1,
          diagnosticProbeReachedServer: false,
          currentSave: 'one update of the same synthetic nonpublic draft',
        };
      }
      const expected = new Map(await editorData());
      assert.equal(expected.get('title'), marker);
      allowDraftSave = true;
      await page
        .getByRole('button', { name: '下書きを保存してプレビューする', exact: true })
        .click({ noWaitAfter: true });
      await within(saveArrivedPromise, 'Synthetic draft save');
      try {
        assert.equal(
          await trial().getByRole('button', { name: '入力を試す', exact: true }).isDisabled(),
          true,
        );
        assert.equal(
          await editor().evaluate((form) =>
            [...form.querySelectorAll('input:not([type="hidden"]),select,textarea,button')].every(
              (node) => node.matches(':disabled'),
            ),
          ),
          true,
        );
        if (ownDraftId) {
          assert.equal(
            await page
              .locator(
                'section[aria-label="カタログの編集と公開"] > form [name="state"][value="published"]',
              )
              .isDisabled(),
            true,
          );
        }
        assert.equal(report.network.draftAttempts, 1);
        assert.ok(capturedSave.length > 0, 'Server action must contain editor fields');
        const submitted = new Map(capturedSave);
        for (const [key, value] of expected) {
          // Native multipart serialization canonicalizes textarea newlines to CRLF.
          assert.equal(
            submitted.get(key)?.replaceAll('\r\n', '\n'),
            value.replaceAll('\r\n', '\n'),
            `Save wire field ${key}`,
          );
        }
        assert.equal(
          capturedSave.some(([, value]) => value.includes(sample)),
          false,
          'Preview samples must not be saved',
        );
        assert.equal(submitted.get('code'), originalCode);
        assert.deepEqual(JSON.parse(submitted.get('fields')), expectedFields);
        report.savedPayload = {
          automaticCodePreserved: true,
          fields: expectedFields.length,
          stableFieldKeys: true,
          previewSamplesExcluded: true,
        };
        saveValidated = true;
      } finally {
        releaseDraftSave();
      }
      await page.waitForURL(
        (url) =>
          /^\/catalog\/manage\/[0-9a-f-]{36}$/.test(url.pathname) &&
          url.searchParams.get('saved') === '1',
      );
      allowDraftSave = false;
      await page.waitForLoadState('networkidle');
      report.createdDraftId = new URL(page.url()).pathname.split('/').at(-1);
      assert.ok((await page.locator('main').innerText()).includes(marker));
      assert.match(
        await page.locator('main > p.notice').innerText(),
        /^非公開: 新規申請を受け付けていません/,
      );
      const summary = page.getByText('下書きの項目と承認者を編集する', { exact: true });
      if (!(await summary.locator('..').evaluate((details) => details.open))) await summary.click();
      assert.equal(await page.locator('#catalog-title').inputValue(), marker);
      assert.deepEqual(await fields(), expectedFields);
      await uniqueIds();
      assert.equal(
        await page.locator('#preview').count(),
        1,
        'Saved preview must remain available',
      );
      await axe('saved-draft-editor-and-previews');
      await screenshot('saved-synthetic-draft');
    },
  );

  await check('Own saved draft dirty publication guard; saved content is unchanged', async () =>
    previewNoWrites(dirtySavedDraftGuard),
  );
  assert.equal(report.network.draftWrites, 1);
  assert.deepEqual(report.network.blocked, []);
  report.success = true;
}

try {
  await main();
} catch (error) {
  report.failure = String(error?.message ?? 'Unknown failure')
    .replaceAll(password, '<redacted>')
    .slice(0, 1500);
  // Never capture a login form or print wire requests, credentials, or cookies.
  if (authenticated && page && !page.isClosed()) await screenshot('failure').catch(() => {});
  process.exitCode = 1;
} finally {
  releaseDraftSave?.();
  await context?.close();
  await browser?.close();
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(
    `Catalog authoring: ${report.success ? 'PASS' : 'FAIL'}; ${report.checks.length} checks; ${report.accessibility.length} axe scans; ${report.network.draftWrites} synthetic draft saves`,
  );
}
