import assert from 'node:assert/strict';
import { createServer } from 'node:http';

export const articleId = '08300000-0000-4000-8000-000000000010';
export const savedValues = {
  title: '合成記事の編集',
  body: '保存済みの手順です。\n<script>文章</script>',
  tags: '合成, 手順',
  audience: 'organization',
};
export const editedValues = {
  title: '変更した合成記事',
  body: '変更した手順です。\n追記を保存します。',
  tags: '変更, 合成',
  audience: 'staff',
};
const org = '08300000-0000-4000-8000-000000000001';
const user = '08300000-0000-4000-8000-000000000002';
const states = ['draft', 'review', 'published', 'retired'];
const modes = ['normal', '400', '409', '503', 'delay_success', 'delay_failure'];
const initial = (state = 'draft') => ({
  id: articleId,
  ...savedValues,
  state,
  version: 9,
  contentVersion: 9,
  publishedVersion: 2,
  versionCreatedAt: '2026-10-10T01:00:00.000Z',
});
const initialVersions = () => [
  { number: 9, title: savedValues.title, createdAt: '2026-10-10T01:00:00.000Z' },
  ...[7, 6].map((number) => ({
    number,
    title: '同じ長い記事タイトルで版の作成日時を確認する合成検証記事',
    createdAt: `2026-10-${number === 7 ? '09' : '08'}T01:00:00.000Z`,
  })),
  { number: 2, title: '公開中の版2の記事', createdAt: '2026-10-01T01:00:00.000Z' },
];

export async function createKnowledgeEditFixture({ signal }) {
  let article = initial(),
    versions = initialVersions(),
    mode = 'normal',
    permit = null,
    closed = false;
  const timers = new Set(),
    releases = new Map(),
    requests = [],
    writes = [];
  const safe = {
    unexpectedMutations: 0,
    unknownReads: 0,
    authReads: 0,
    notificationReads: 0,
    browserSessionSeen: false,
    rejectedWrites: [],
  };
  const json = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const problem = (res, status) =>
    json(res, status, {
      status,
      title: status === 400 ? '入力を確認してください' : '合成の保存失敗です',
      ...(status === 400
        ? { errors: [{ field: 'title', message: 'タイトルを確認してください' }] }
        : {}),
    });
  const server = createServer(async (req, res) => {
    if (signal?.aborted) return res.destroy();
    const url = new URL(req.url, 'http://127.0.0.1');
    const role = req.headers.cookie
      ?.split(';')
      .map((x) => x.trim())
      .find((x) => /^solvi_session_wp083_synthetic=(requester|agent|org_admin)$/.test(x))
      ?.split('=')[1];
    if (role) safe.browserSessionSeen = true;
    if (req.method === 'POST') {
      const route =
        url.pathname === `/knowledge/${articleId}/save`
          ? 'save'
          : url.pathname === `/knowledge/${articleId}/actions`
            ? 'review'
            : url.pathname === '/knowledge'
              ? 'create'
              : null;
      if (
        !route ||
        permit !== route ||
        url.search ||
        !['agent', 'org_admin'].includes(role) ||
        req.headers['content-type'] !== 'application/json'
      ) {
        safe.unexpectedMutations++;
        return problem(res, 405);
      }
      permit = null;
      let body;
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 30000) throw new Error('BODY_LIMIT');
          chunks.push(chunk);
        }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        safe.unexpectedMutations++;
        return problem(res, 400);
      }
      const expectedKeys =
        route === 'create'
          ? ['audience', 'body', 'tags', 'title']
          : route === 'save'
            ? ['audience', 'body', 'expectedVersion', 'tags', 'title']
            : ['action', 'expectedVersion', 'restoreVersion'];
      const valid =
        body &&
        typeof body === 'object' &&
        !Array.isArray(body) &&
        JSON.stringify(Object.keys(body).sort()) === JSON.stringify(expectedKeys) &&
        (route === 'create' || body.expectedVersion === article.version) &&
        (route === 'review'
          ? body.action === 'review' && body.restoreVersion === versions[0].number
          : Object.entries(editedValues).every(
              ([key, value]) =>
                body[key] === (key === 'body' ? value.replace(/\n/g, '\r\n') : value),
            ));
      if (!valid) {
        safe.rejectedWrites.push({
          route,
          keySet: JSON.stringify(Object.keys(body ?? {}).sort()) === JSON.stringify(expectedKeys),
          versionValid: route === 'create' || body?.expectedVersion === article.version,
          fields: Object.fromEntries(
            Object.entries(editedValues).map(([key, value]) => [
              key,
              { string: typeof body?.[key] === 'string', exact: body?.[key] === value },
            ]),
          ),
          bodyOnlyNewlineMismatch:
            typeof body?.body === 'string' &&
            body.body.replace(/\r\n/g, '\n') === editedValues.body,
          lfCount: typeof body?.body === 'string' ? (body.body.match(/\n/g) ?? []).length : null,
          crlfCount:
            typeof body?.body === 'string' ? (body.body.match(/\r\n/g) ?? []).length : null,
        });
        safe.unexpectedMutations++;
        return problem(res, 400);
      }
      const selectedMode = mode;
      const record = {
        sequence: writes.length + 1,
        route,
        bodyValid: true,
        allFourFields: route !== 'review',
        storedBodyUsesTransportCRLF: route !== 'review' && body.body.includes('\r\n'),
        expectedVersionValid: route === 'create' || body.expectedVersion === article.version,
        status: null,
        completed: false,
      };
      writes.push(record);
      const finish = () => {
        if (closed || signal?.aborted || res.destroyed) return;
        const status =
          selectedMode === 'delay_failure'
            ? 503
            : /^\d+$/.test(selectedMode)
              ? Number(selectedMode)
              : route === 'create'
                ? 201
                : 200;
        record.status = status;
        record.completed = true;
        if (status !== 200 && status !== 201) return problem(res, status);
        article = {
          ...article,
          ...(route === 'review'
            ? {}
            : { title: body.title, body: body.body, tags: body.tags, audience: body.audience }),
          version: route === 'create' ? 1 : article.version + 1,
          contentVersion: route === 'create' ? 1 : article.version + 1,
          state: route === 'review' ? 'review' : 'draft',
          ...(route === 'create' ? { publishedVersion: null } : {}),
          versionCreatedAt: '2026-10-10T02:00:00.000Z',
        };
        versions = [
          {
            number: article.contentVersion,
            title: article.title,
            createdAt: article.versionCreatedAt,
          },
          ...(route === 'create' ? [] : versions),
        ];
        return json(res, status, { id: articleId, version: article.version });
      };
      if (selectedMode.startsWith('delay_')) {
        const timer = setTimeout(() => {
          timers.delete(timer);
          releases.delete(timer);
          record.status = 503;
          record.completed = true;
          record.releaseControlled = false;
          if (!res.destroyed) problem(res, 503);
        }, 30000);
        timers.add(timer);
        releases.set(timer, () => {
          record.releaseControlled = true;
          finish();
        });
      } else finish();
      return;
    }
    if (req.method !== 'GET') {
      safe.unexpectedMutations++;
      return problem(res, 405);
    }
    if (url.pathname === '/auth/me' || url.pathname === '/auth/organizations') {
      safe.authReads++;
      if (!role) return problem(res, 401);
      return json(
        res,
        200,
        url.pathname === '/auth/me'
          ? { userId: user, organizationId: org, roles: [{ roleCode: role, organizationId: org }] }
          : {
              selected: org,
              organizations: [{ id: org, code: 'synthetic', name: '合成検証組織' }],
            },
      );
    }
    if (url.pathname === '/notifications') {
      safe.notificationReads++;
      return json(res, 200, {
        items: [],
        counts: { all: 0, pending: 0, sent: 0, failed: 0 },
        total: 0,
        previousCursor: null,
        nextCursor: null,
        deliveryMode: 'recording',
      });
    }
    if (url.pathname === `/knowledge/${articleId}` || url.pathname === '/knowledge') {
      const manage = url.searchParams.get('manage') === '1';
      if (!role || (manage && !['agent', 'org_admin'].includes(role))) return problem(res, 403);
      requests.push({
        sequence: requests.length + 1,
        route: url.pathname === '/knowledge' ? 'list' : 'detail',
        manage,
        method: 'GET',
      });
      if (!manage && (article.state === 'retired' || article.publishedVersion === null))
        return problem(res, 404);
      const visible = manage
        ? article
        : {
            ...article,
            title: '公開中の版2の記事',
            body: '公開中の版2の本文です。',
            audience: 'organization',
            tags: '公開',
            state: 'published',
            version: 2,
            contentVersion: 2,
            versionCreatedAt: '2026-10-01T01:00:00.000Z',
          };
      return json(
        res,
        200,
        url.pathname === '/knowledge'
          ? { items: [visible], total: 1, previousCursor: null, nextCursor: null }
          : { article: visible, versions: manage ? versions : [] },
      );
    }
    safe.unknownReads++;
    return problem(res, 404);
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string' && address.address === '127.0.0.1');
  const port = address.port;
  return {
    baseURL: `http://127.0.0.1:${port}`,
    port,
    assertOwned() {
      const a = server.address();
      assert.ok(
        !closed &&
          server.listening &&
          a &&
          typeof a !== 'string' &&
          a.port === port &&
          a.address === '127.0.0.1',
      );
    },
    control(next) {
      if (next?.release === true) {
        assert.deepEqual(Object.keys(next), ['release']);
        assert.equal(releases.size, 1);
        for (const [timer, release] of releases) {
          clearTimeout(timer);
          timers.delete(timer);
          releases.delete(timer);
          release();
        }
        return;
      }
      assert.ok(
        next &&
          typeof next === 'object' &&
          Object.keys(next).every((key) => ['state', 'mode', 'permit', 'reset'].includes(key)),
      );
      assert.ok(
        states.includes(next.state ?? 'draft') &&
          modes.includes(next.mode ?? 'normal') &&
          [null, 'save', 'review', 'create'].includes(next.permit ?? null),
      );
      assert.ok(next.reset === undefined || typeof next.reset === 'boolean');
      if (next.reset !== false) {
        article = initial(next.state ?? 'draft');
        versions = initialVersions();
      }
      mode = next.mode ?? 'normal';
      permit = next.permit ?? null;
    },
    detailReads: () => requests.filter((x) => x.route === 'detail').map((x) => ({ ...x })),
    allReads: () => requests.map((x) => ({ ...x })),
    summary: () => ({
      ...safe,
      writes: writes.map((x) => ({ ...x })),
      allowedWrites: writes.length,
      requests: requests.map((x) => ({ ...x })),
    }),
    async close() {
      if (!closed) {
        closed = true;
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        releases.clear();
        server.closeAllConnections();
        await new Promise((done) => server.close(done));
      }
      return { closed: !server.listening, pendingTimers: timers.size, databaseStarted: false };
    },
  };
}
