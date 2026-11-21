import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as pause } from 'node:timers/promises';
import { chromium, webkit } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import pg from 'pg';
import { createKnowledgeDatabase } from '../../tests/support/knowledge/isolated-knowledge-db';
import { readKnowledgeFixture } from '../../tests/support/knowledge/knowledge-fixture';
import { SessionService } from '../../services/api/src/modules/auth/session.service';

const out = new URL('./', import.meta.url);
const db = await createKnowledgeDatabase();
const owner = new pg.Client({ connectionString: db.adminUrl });
const children = [];
async function port() {
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const p = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return p;
}
function service(args, env) {
  const child = spawn(process.execPath, args, {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    stdio: 'ignore',
  });
  children.push(child);
  return child;
}
async function ready(child, url) {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw Error('Service exited before ready: ' + child.exitCode);
    if (
      await fetch(url).then(
        (r) => r.ok,
        () => false,
      )
    )
      return;
    await pause(250);
  }
  throw Error('Service startup timed out');
}
try {
  await owner.connect();
  const fixture = await readKnowledgeFixture(owner);
  const suite = spawn(
    process.execPath,
    ['node_modules/vitest/vitest.mjs', 'run', 'tests/security/knowledge-pagination.test.ts'],
    {
      env: { ...process.env, DATABASE_URL: db.appUrl, DATABASE_ADMIN_URL: db.adminUrl },
      stdio: 'inherit',
    },
  );
  assert.equal((await once(suite, 'exit'))[0], 0);
  const migration = await readFile(
    new URL('../../db/migrations/0043_knowledge_rich_body.sql', out),
    'utf8',
  );
  const [up, down] = migration.split('-- +migrate up')[1].split('-- +migrate down');
  await owner.query('BEGIN');
  await owner.query(down);
  const legacyBody = '<設定値>\n旧形式';
  const oldId = fixture.ids.base[0];
  await owner.query("SELECT set_config('app.current_org',$1,true)", [fixture.organizationId]);
  await owner.query(
    'INSERT INTO knowledge_version(article_id,organization_id,number,title,body,tags,audience,author_id) SELECT article_id,organization_id,9000,title,$2,tags,audience,author_id FROM knowledge_version WHERE article_id=$1 AND number=1',
    [oldId, legacyBody],
  );
  await owner.query(up);
  const migrated = await owner.query(
    'SELECT body,body_doc_v1 FROM knowledge_version WHERE article_id=$1 AND number=9000',
    [oldId],
  );
  assert.deepEqual(migrated.rows, [{ body: legacyBody, body_doc_v1: null }]);
  await owner.query('ROLLBACK');
  const apiPort = await port();
  const api = 'http://127.0.0.1:' + apiPort;
  const apiEnv = {
    NODE_ENV: 'test',
    API_PORT: String(apiPort),
    API_HOST: '127.0.0.1',
    DATABASE_URL: db.appUrl,
    LOG_LEVEL: 'error',
    S3_ENDPOINT: 'http://127.0.0.1:1',
    S3_REGION: 'local',
    S3_BUCKET_ATTACHMENTS: 'test-attachments',
    S3_BUCKET_AUDIT_ANCHOR: 'test-audit',
    S3_ACCESS_KEY: 'fixture',
    S3_SECRET_KEY: 'fixture',
  };
  const server = service(['--import', 'tsx', 'services/api/src/main.ts'], apiEnv);
  await ready(server, api + '/healthz');
  const webPort = await port();
  const web = 'http://127.0.0.1:' + webPort;
  const next = service(
    [
      'node_modules/next/dist/bin/next',
      'start',
      process.argv[2],
      '-H',
      '127.0.0.1',
      '-p',
      String(webPort),
    ],
    {
      NODE_ENV: 'production',
      API_BASE_URL: api,
      NEXT_TELEMETRY_DISABLED: '1',
    },
  );
  await ready(next, web + '/editor-icons.svg');
  const tokens = {};
  for (const who of ['agent', 'admin', 'requester', 'foreign']) {
    const actor = fixture.actors[who];
    tokens[who] = (
      await new SessionService(owner).issue({
        userId: actor.userId,
        organizationId: actor.organizationId,
        authMethod: 'local',
      })
    ).token;
  }
  async function request(who, path, data) {
    return fetch(api + path, {
      method: data ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', cookie: 'solvi_session=' + tokens[who] },
      ...(data && { body: JSON.stringify(data) }),
    });
  }
  const results = [];
  for (const [engine, driver] of Object.entries({ chromium, webkit })) {
    const browser = await driver.launch(engine === 'chromium' ? { channel: 'chrome' } : {});
    try {
      let ctx, page, area, source, save;
      const issues = [];
      async function checkReader(expected) {
        const content = page.locator('.knowledge-rich-content');
        assert.equal(await content.getByRole('region').getAttribute('tabindex'), '0');
        assert.equal(await content.locator('caption').textContent(), '記事本文の表（ブロック 1）');
        const html = await content.evaluate((el) => {
          const copy = el.cloneNode(true);
          for (const region of copy.querySelectorAll('[role=region]')) {
            const table = region.querySelector('table');
            table.querySelector('caption').remove();
            region.replaceWith(table);
          }
          return copy.innerHTML;
        });
        assert.equal(html, expected);
      }
      const btn = (name) => page.getByRole('button', { name, exact: true });
      async function role(who) {
        if (ctx) {
          await page.waitForLoadState('networkidle');
          await ctx.close();
        }
        ctx = await browser.newContext({ viewport: { width: 1280, height: 950 } });
        await ctx.addCookies([
          { name: 'solvi_session', value: tokens[who], url: web, httpOnly: true },
        ]);
        page = await ctx.newPage();
        page.on('pageerror', (err) => issues.push(err.message));
        page.setDefaultTimeout(12000);
        area = page.locator('.tiptap');
        save = btn('下書きを保存する');
        source = page.getByRole('textbox', { name: 'HTMLソース' });
      }
      await role('agent');
      await page.goto(web + '/knowledge/new');
      await page.locator('#article-title').fill('書式の検証 ' + engine);
      await btn('手順テンプレートを使う').click();
      assert.equal(await area.locator('h2').count(), 3);
      await btn('元に戻す').click();
      await area.click();
      await page.keyboard.type('/');
      await page.getByRole('option', { name: '表', exact: true }).click();
      await area.locator('td').first().click();
      await btn('右に列を追加').click();
      await btn('下に行を追加').click();
      assert.equal(await area.locator('tr').count(), 4);
      await btn('行を削除').click();
      await btn('列を削除').click();
      assert.equal(await area.locator('tr').count(), 3);
      await btn('HTMLソース').click();
      assert.equal(await save.isDisabled(), true);
      const table = (await source.inputValue()).split('</table>')[0] + '</table>';
      await source.fill('<p class="unknown">変更</p>');
      await btn('適用').click();
      assert.equal(await source.inputValue(), '<p class="unknown">変更</p>');
      assert.equal(await save.isDisabled(), true);
      await source.fill(
        '<h2>準備</h2><p>sample</p><ul><li><p>リスト</p></li></ul><pre><code>  a\nb</code></pre>' +
          table,
      );
      await btn('適用').click();
      await area.getByText('sample', { exact: true }).dblclick();
      await btn('選択範囲を太字').click();
      await area.locator('h2').click();
      const handle = btn('5番目のブロックの表を移動');
      await handle.scrollIntoViewIfNeeded();
      const h = await handle.boundingBox();
      await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
      await page.mouse.down();
      await page.mouse.move(h.x + h.width / 2 + 8, h.y + h.height / 2, { steps: 3 });
      const target = await area.locator('h2').boundingBox();
      await page.mouse.move(target.x + 12, target.y + 2, { steps: 10 });
      await page.locator('.drop-line').waitFor();
      await page.mouse.up();
      assert.equal(
        await area.locator(':scope > :first-child').evaluate((el) => el.tagName),
        'TABLE',
      );
      const expected =
        table +
        '<h2>準備</h2><p><strong>sample</strong></p><ul><li><p>リスト</p></li></ul><pre><code>  a\nb</code></pre>';
      for (let i = 0; i < 3; i++) {
        await btn('HTMLソース').click();
        assert.equal(await source.inputValue(), expected);
        await btn('適用').click();
      }
      await page.getByText('公開プレビュー', { exact: true }).click();
      await checkReader(expected);
      await page.getByText('公開プレビュー', { exact: true }).click();
      const accessibility = (
        await new AxeBuilder({ page }).include('.knowledge-rich').analyze()
      ).violations.map((v) => v.id);
      assert.deepEqual(accessibility, []);
      await page
        .locator('.knowledge-rich')
        .screenshot({ path: new URL(engine + '-editor.png', out).pathname });
      await save.click();
      await page.waitForURL(/manage=1.*saved=1/);
      await page.waitForLoadState('networkidle');
      await page.reload();
      await btn('HTMLソース').click();
      assert.equal(await source.inputValue(), expected);
      assert.equal(await btn('レビューへ送る').isDisabled(), true);
      await btn('取消').click();
      const path = new URL(page.url()).pathname;
      const detail = await (await request('agent', path + '?manage=1')).json();
      const json = detail.article.bodyDocV1;
      assert.equal(json.content[0].type, 'table');
      assert.ok(detail.article.body.includes('sample'));
      assert.equal((await request('requester', path)).status, 404);
      assert.equal(
        (
          await request('agent', path + '/save', {
            title: '旧形式',
            body: 'plain',
            audience: 'organization',
            expectedVersion: 1,
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await request('agent', path + '/save', {
            title: '不正',
            bodyDocV1: { type: 'doc', content: [{ type: 'unknown' }] },
            audience: 'organization',
            expectedVersion: 1,
          })
        ).status,
        400,
      );
      await btn('レビューへ送る').click();
      await page.getByRole('heading', { name: 'レビュー対象の内容' }).waitFor();
      await role('admin');
      await page.goto(web + path + '?manage=1');
      await btn('確認した内容を公開する').click();
      await page.getByText('操作対象: 保存済みの版 3', { exact: false }).waitFor();
      await role('requester');
      await page.goto(web + path);
      await checkReader(expected);
      assert.equal((await request('foreign', path)).status, 404);
      const ticket = await request('requester', '/tickets', {
        kind: 'incident',
        subject: '引用検証',
        body: '手順を確認したい',
      });
      assert.equal(ticket.status, 201);
      const ticketId = (await ticket.json()).id;
      const comment = await request('agent', '/tickets/' + ticketId + '/comments', {
        visibility: 'public',
        body: 'この手順を参照してください',
        citation: { articleId: detail.article.id, version: 3 },
      });
      assert.equal(comment.status, 201);
      const commentId = (await comment.json()).id;
      assert.ok(
        (await (await request('requester', '/knowledge?q=sample')).json()).items.some(
          (a) => a.id === detail.article.id,
        ),
      );
      assert.equal(
        (
          await request('agent', path + '/actions', {
            action: 'restore',
            restoreVersion: 1,
            expectedVersion: 3,
          })
        ).status,
        200,
      );
      const restored = (await (await request('agent', path + '?manage=1')).json()).article;
      assert.deepEqual(restored.bodyDocV1, json);
      assert.equal(restored.version, 4);
      const audit = await owner.query(
        "SELECT after_state FROM audit_event WHERE target_type='knowledge_article' AND target_id=$1 ORDER BY (after_state->>'version')::integer",
        [detail.article.id],
      );
      assert.deepEqual(
        audit.rows.map((row) => row.after_state),
        [1, 2, 3, 4].map((version) => ({ version })),
      );
      if (engine === 'chromium') {
        const offPort = await port();
        const off = service(['--import', 'tsx', 'services/api/src/main.ts'], {
          ...apiEnv,
          API_PORT: String(offPort),
          KNOWLEDGE_RICH_WRITES: 'off',
        });
        const url = 'http://127.0.0.1:' + offPort;
        await ready(off, url + '/healthz');
        const headers = {
          cookie: 'solvi_session=' + tokens.agent,
          'Content-Type': 'application/json',
        };
        const read = await (await fetch(url + path + '?manage=1', { headers })).json();
        assert.deepEqual(read.article.bodyDocV1, json);
        assert.equal(
          (
            await fetch(url + path + '/save', {
              headers,
              method: 'POST',
              body: JSON.stringify({
                audience: 'organization',
                title: '保留',
                bodyDocV1: json,
                expectedVersion: 4,
              }),
            })
          ).status,
          409,
        );
      }

      const stale = {
        title: '競合',
        bodyDocV1: json,
        audience: 'organization',
        expectedVersion: 3,
      };
      assert.equal((await request('agent', path + '/save', stale)).status, 409);
      await page.waitForLoadState('networkidle');
      await page.goto(web + '/tickets/' + ticketId + '/citations/' + commentId);
      await checkReader(expected);
      const citation = await (
        await request('requester', '/tickets/' + ticketId + '/comments/' + commentId + '/citation')
      ).json();
      assert.equal(citation.version, 3);
      assert.deepEqual(citation.bodyDocV1, json);

      // A legacy article opens literally; conversion creates a new rich version.
      const legacy = await request('agent', '/knowledge', {
        title: '旧形式',
        body: '入力 <設定値>\n手順',
        audience: 'organization',
      });
      assert.equal(legacy.status, 201);
      const legacyId = (await legacy.json()).id;
      await role('agent');
      await page.goto(web + '/knowledge/' + legacyId + '?manage=1');
      assert.equal(await page.locator('textarea[name=body]').inputValue(), '入力 <設定値>\n手順');
      await btn('書式付き編集に切り替える').click();
      await btn('HTMLソース').click();
      assert.equal(await source.inputValue(), '<p>入力 &lt;設定値&gt;</p><p>手順</p>');
      await btn('取消').click();
      await save.click();
      await page.waitForURL(/saved=1/);
      const legacySnapshots = await owner.query(
        'SELECT number,body,body_doc_v1 IS NULL AS plain FROM knowledge_version WHERE article_id=$1 ORDER BY number',
        [legacyId],
      );
      assert.deepEqual(
        legacySnapshots.rows.map((v) => v.plain),
        [true, false],
      );
      assert.equal(legacySnapshots.rows[0].body, '入力 <設定値>\n手順');
      await owner.query('BEGIN');
      await assert.rejects(owner.query(down), /Rich knowledge versions exist/);
      await owner.query('ROLLBACK');
      const update = {
        bodyDocV1: json,
        audience: 'organization',
        title: '同時編集',
        expectedVersion: 2,
      };
      const savePath = '/knowledge/' + legacyId + '/save';
      const writes = await Promise.all([
        request('agent', savePath, update),
        request('agent', savePath, update),
      ]);
      assert.deepEqual(writes.map((r) => r.status).sort(), [200, 409]);
      assert.equal((await request('requester', savePath, update)).status, 403);
      assert.deepEqual(issues, []);
      results.push({
        engine,
        version: browser.version(),
        htmlRoundTrips: 3,
        publishedVersion: 3,
        restoredVersion: 4,
        citationVersion: 3,
        legacyConversion: true,
        guardedRollback: true,
        axeEditorViolations: accessibility,
        pageErrors: issues,
      });
      console.log(engine + ' passed');
    } finally {
      await browser.close();
    }
  }
  await writeFile(new URL('results.json', out), JSON.stringify(results, null, 2) + '\n');
} finally {
  for (const child of children.reverse())
    if (child.exitCode === null && !child.signalCode) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  await owner.end();
  assert.ok((await db.cleanup()).success);
}
