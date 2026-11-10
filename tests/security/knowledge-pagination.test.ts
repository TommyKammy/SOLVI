import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { runWithContext, newContext } from '@solvi/shared';
import { KnowledgeController } from '../../services/api/src/modules/knowledge/knowledge.routes.js';
import {
  encodeKnowledgeCursor,
  parseKnowledgeListQuery,
} from '../../services/api/src/modules/knowledge/knowledge-query.js';
import {
  assertKnowledgeDatabaseUrls,
  readKnowledgeFixture,
  type KnowledgeFixture,
} from '../../evidence/WP-P3-KNWUI-054/20261007/knowledge-fixture.mjs';
import {
  createCiKnowledgeDatabase,
  KNOWLEDGE_CI_SETUP_HOOK_MS,
  KNOWLEDGE_CI_CLEANUP_HOOK_MS,
} from '../../evidence/WP-P3-KNWUI-054/20261007/ci-knowledge-db.mjs';

let admin: pg.Client;
let pool: pg.Pool;
let fixture: KnowledgeFixture;
let controller: KnowledgeController;
let ciDatabase: Awaited<ReturnType<typeof createCiKnowledgeDatabase>> | undefined;
type Actor = keyof KnowledgeFixture['actors'];
const request = (actor: Actor, q = '', limit = 20, cursor?: string, manage = false) =>
  controller.list(
    fixture.actors[actor].auth,
    new URLSearchParams({
      q,
      limit: String(limit),
      ...(cursor ? { cursor } : {}),
      ...(manage ? { manage: '1' } : {}),
    }),
  );

beforeAll(async () => {
  try {
    // Existing CI runs every security suite against its service database. Use a
    // separately owned database there; never add fixtures to shared CI `solvi`.
    if (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true')
      ciDatabase = await createCiKnowledgeDatabase();
    const appUrl = ciDatabase?.appUrl ?? process.env.DATABASE_URL;
    const adminUrl = ciDatabase?.adminUrl ?? process.env.DATABASE_ADMIN_URL;
    const database = assertKnowledgeDatabaseUrls(appUrl ?? '', adminUrl ?? '');
    admin = new pg.Client({
      connectionString: adminUrl,
      statement_timeout: 10000,
      query_timeout: 12000,
    });
    await admin.connect();
    expect(
      (await admin.query('SELECT current_database() AS database, current_user AS role')).rows[0],
    ).toEqual({ database, role: 'solvi_owner' });
    pool = new pg.Pool({
      connectionString: appUrl,
      max: 3,
      statement_timeout: 10000,
      query_timeout: 12000,
    });
    const proof = (
      await pool.query(
        `SELECT current_database() AS database,current_user AS role,r.rolsuper,r.rolbypassrls,c.relname,c.relowner=r.oid AS owns_table,c.relrowsecurity,c.relforcerowsecurity,current_setting('row_security') AS row_security FROM pg_roles r CROSS JOIN pg_class c WHERE r.rolname=current_user AND c.oid IN ('knowledge_article'::regclass,'knowledge_version'::regclass) ORDER BY c.relname`,
      )
    ).rows;
    expect(proof).toHaveLength(2);
    for (const row of proof)
      expect(row).toMatchObject({
        database,
        role: 'solvi_app',
        rolsuper: false,
        rolbypassrls: false,
        owns_table: false,
        relrowsecurity: true,
        relforcerowsecurity: true,
        row_security: 'on',
      });
    fixture = await readKnowledgeFixture(admin);
    controller = new KnowledgeController(pool);
  } catch {
    throw new Error('KNOWLEDGE_ISOLATED_SETUP_FAILED');
  }
}, KNOWLEDGE_CI_SETUP_HOOK_MS);
afterAll(async () => {
  const closed = await Promise.allSettled([pool?.end(), admin?.end()]);
  const cleanup = await ciDatabase?.cleanup();
  expect(closed.every((result) => result.status === 'fulfilled')).toBe(true);
  if (cleanup) expect(cleanup.success).toBe(true);
}, KNOWLEDGE_CI_CLEANUP_HOOK_MS);

// The old public query is the independent ordering/DTO oracle, without its LIMIT 100.
async function legacy(q: string, staff = false) {
  const pattern = `%${q
    .trim()
    .slice(0, 200)
    .replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('app.current_org',$1,true)", [fixture.organizationId]);
    return (
      await client.query(
        `SELECT a.id,'published' AS state,v.number AS version,a.published_version AS "publishedVersion",v.number AS "contentVersion",v.title,v.body,v.tags,v.audience,v.created_at AS "versionCreatedAt"
      FROM knowledge_article a JOIN knowledge_version v ON v.article_id=a.id AND v.organization_id=a.organization_id WHERE a.organization_id=$2 AND v.number=a.published_version AND a.state <> 'retired' AND (v.audience='organization' OR $3) AND (v.title ILIKE $1 OR v.body ILIKE $1 OR v.tags ILIKE $1) ORDER BY (v.title ILIKE $1) DESC,a.updated_at DESC,a.id DESC`,
        [pattern, fixture.organizationId, staff],
      )
    ).rows;
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

// FR-KNW-002 / NFR-SEC-001 / NFR-SEC-006: real API authorization and independent RLS.
describe('WP054 real Controller and forced RLS knowledge pagination', () => {
  it.each([1, 20, 100])(
    'visits all 205 results forward/back with exact totals and old rank at limit %s',
    async (limit) => {
      const expected = await legacy(fixture.search.base);
      expect(expected).toHaveLength(205);
      const pages: Awaited<ReturnType<typeof request>>[] = [];
      let cursor: string | undefined;
      do {
        const page = await request('requester', fixture.search.base, limit, cursor);
        expect(page.total).toBe(205);
        expect(page.items.length).toBeGreaterThan(0);
        expect(page.items.length).toBeLessThanOrEqual(limit);
        expect(page.previousCursor === null).toBe(pages.length === 0);
        pages.push(page);
        cursor = page.nextCursor ?? undefined;
        if (pages.length > 205) throw new Error('KNOWLEDGE_PAGE_DID_NOT_ADVANCE');
      } while (cursor);
      const all = pages.flatMap((page) => page.items);
      expect(all).toEqual(expected);
      expect(new Set(all.map((item) => item.id)).size).toBe(205);
      let previous = pages.at(-1)!.previousCursor;
      for (let index = pages.length - 2; index >= 0; index--) {
        expect(previous).not.toBeNull();
        const page = await request('requester', fixture.search.base, limit, previous!);
        expect(page.items).toEqual(pages[index]!.items);
        expect(page.total).toBe(205);
        previous = page.previousCursor;
      }
      expect(previous).toBeNull();
      expect((await request('requester', fixture.search.base, limit)).items).toEqual(
        pages[0]!.items,
      );
    },
    60000,
  );
  it('preserves default100 and all original item fields/body for existing callers', async () => {
    const result = await controller.list(
      fixture.actors.requester.auth,
      new URLSearchParams({ q: fixture.search.base }),
    );
    expect(result.items).toEqual((await legacy(fixture.search.base)).slice(0, 100));
    expect(result.total).toBe(205);
    expect(result.items[0]!.body.length).toBeGreaterThan(300);
  });
  it('preserves tied IDs and sub-millisecond values in actual DB cursors', async () => {
    const first = await request('requester', fixture.search.base, 1);
    const tuple = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8'));
    const raw = (
      await admin.query(
        `SELECT to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stamp FROM knowledge_article WHERE id=$1`,
        [first.items[0]!.id],
      )
    ).rows[0].stamp;
    expect(tuple[3]).toBe(raw);
    expect(tuple[3]).toMatch(/\.000\d{3}Z$/);
    expect(tuple[3]).not.toMatch(/\.000000Z$/);
  });
  it.each(['検索', '本文後方一致', '分類タグ', '%_\\', '<script>', '日本語手順'])(
    'keeps literal title/body/tags search: %s',
    async (q) => {
      const result = await request('requester', q, 100);
      const expected = await legacy(q);
      expect(result.total).toBe(expected.length);
      expect(result.items).toEqual(expected.slice(0, 100));
    },
  );
  it('returns real total for empty continuation and zero for unmatched query', async () => {
    const query = new URLSearchParams({ q: fixture.search.base, limit: '20' });
    const options = parseKnowledgeListQuery(query, {
      organizationId: fixture.organizationId,
      staffVisible: false,
    });
    const cursor = encodeKnowledgeCursor(
      options,
      { titleMatch: false, updatedAt: '0001-01-01T00:00:00.000000Z', id: fixture.ids.base[0]! },
      'next',
    );
    expect(await request('requester', fixture.search.base, 20, cursor)).toEqual({
      items: [],
      total: 205,
      previousCursor: null,
      nextCursor: null,
    });
    expect(await request('requester', 'WP054不存在語')).toEqual({
      items: [],
      total: 0,
      previousCursor: null,
      nextCursor: null,
    });
  });
  it('keeps old published content/audience after a newer staff draft and excludes private states', async () => {
    const publicArticle = (await request('requester', fixture.search.published)).items[0]!;
    expect(publicArticle).toMatchObject({
      id: fixture.ids.publishedDraft,
      state: 'published',
      version: 1,
      publishedVersion: 1,
      contentVersion: 1,
      audience: 'organization',
      body: '保持される公開本文',
    });
    expect((await request('requester', fixture.search.unpublished)).total).toBe(0);
    expect(
      (await request('agent', fixture.search.unpublished, 20, undefined, true)).items[0],
    ).toMatchObject({
      id: fixture.ids.publishedDraft,
      state: 'draft',
      contentVersion: 2,
      audience: 'staff',
    });
    expect((await request('requester')).total).toBe(fixture.counts.public);
    expect((await request('agent')).total).toBe(fixture.counts.staff);
    expect((await request('agent', '', 20, undefined, true)).total).toBe(fixture.counts.manage);
    for (const articleId of [
      fixture.ids.staff,
      fixture.ids.draft,
      fixture.ids.retired,
      fixture.ids.foreign,
    ])
      await expect(
        controller.detail(fixture.actors.requester.auth, articleId, false),
      ).rejects.toMatchObject({ status: 404 });
    expect(
      (await controller.detail(fixture.actors.requester.auth, fixture.ids.publishedDraft, false))
        .article,
    ).toEqual(publicArticle);
  });
  it('rejects requester/expired manage and changed condition or visibility cursors', async () => {
    for (const actor of ['requester', 'expired'] as const)
      await expect(request(actor, '', 20, undefined, true)).rejects.toMatchObject({ status: 403 });
    expect((await request('expired')).total).toBe(fixture.counts.public);
    const page = await request('agent', '', 20);
    await expect(request('requester', '', 20, page.nextCursor!)).rejects.toMatchObject({
      status: 400,
    });
    await expect(request('agent', '別', 20, page.nextCursor!)).rejects.toMatchObject({
      status: 400,
    });
    await expect(request('agent', '', 100, page.nextCursor!)).rejects.toMatchObject({
      status: 400,
    });
    await expect(request('foreign', '', 20, page.nextCursor!)).rejects.toMatchObject({
      status: 400,
    });
    expect((await request('foreign')).items.map((r) => r.id)).toEqual([fixture.ids.foreign]);
  });
  it('enforces actual RLS independently of API predicates', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SELECT set_config('app.current_org',$1,true)", [
        fixture.controlOrganizationId,
      ]);
      expect(
        (await client.query('SELECT id FROM knowledge_article WHERE id=$1', [fixture.ids.base[0]]))
          .rows,
      ).toEqual([]);
      expect(
        (
          await client.query('SELECT title FROM knowledge_version WHERE article_id=$1', [
            fixture.ids.base[0],
          ])
        ).rows,
      ).toEqual([]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
  it('uses one read-only repeatable snapshot even if publication visibility changes between count and page', async () => {
    const before = await legacy(fixture.search.base),
      target = before[0]!.id;
    let changed = false;
    const wrapped = {
      connect: async () => {
        const client = await pool.connect();
        return {
          release: () => client.release(),
          query: async (sql: string, params?: unknown[]) => {
            const result = await client.query(sql, params);
            if (sql.startsWith('SELECT count') && !changed) {
              expect(
                (
                  await client.query(
                    "SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only",
                  )
                ).rows[0],
              ).toEqual({ isolation: 'repeatable read', read_only: 'on' });
              await admin.query("UPDATE knowledge_article SET state='retired' WHERE id=$1", [
                target,
              ]);
              changed = true;
            }
            return result;
          },
        };
      },
    } as unknown as pg.Pool;
    try {
      const result = await new KnowledgeController(wrapped).list(
        fixture.actors.requester.auth,
        new URLSearchParams({ q: fixture.search.base, limit: '20' }),
      );
      expect(changed).toBe(true);
      expect(result.total).toBe(205);
      expect(result.items).toEqual(before.slice(0, 20));
      const subsequent = await request('requester', fixture.search.base);
      expect(subsequent.total).toBe(204);
      expect(subsequent.items.some((item) => item.id === target)).toBe(false);
    } finally {
      if (changed)
        await admin.query(
          "UPDATE knowledge_article SET state='published' WHERE id=$1 AND state='retired'",
          [target],
        );
    }
  });
  it('keeps version immutability and existing audited save transaction', async () => {
    const target = fixture.ids.draft;
    const saved = await runWithContext(newContext(), () =>
      controller.save(fixture.actors.agent.auth, target, {
        expectedVersion: 1,
        title: '監査保存回帰',
        body: '合成回帰本文',
        tags: '',
        audience: 'organization',
      }),
    );
    expect(saved.version).toBe(2);
    expect((await request('requester', '監査保存回帰')).total).toBe(0);
    expect(
      Number(
        (
          await admin.query(
            "SELECT count(*) AS n FROM audit_event WHERE target_id=$1 AND action='article.saved'",
            [target],
          )
        ).rows[0].n,
      ),
    ).toBe(1);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_org',$1,true)", [fixture.organizationId]);
      await expect(
        client.query("UPDATE knowledge_version SET title='forbidden' WHERE article_id=$1", [
          target,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
