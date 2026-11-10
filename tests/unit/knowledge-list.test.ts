import { describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import type { AuthenticatedRequest } from '../../services/api/src/modules/auth/auth.routes.js';
import type { RoleCode } from '../../services/api/src/common/authz/authz.js';
import { KnowledgeController } from '../../services/api/src/modules/knowledge/knowledge.routes.js';
import {
  assertKnowledgeDatabaseUrls,
  seedKnowledgeFixture,
} from '../../evidence/WP-P3-KNWUI-054/20261007/knowledge-fixture.mjs';
import {
  assertCiKnowledgeEndpoints,
  assertOwnedCiDatabase,
  assertInitializingCiDatabase,
  createCiKnowledgeDatabase,
  KNOWLEDGE_CI_PREPARATION_MS,
  KNOWLEDGE_CI_SETUP_HOOK_MS,
  KNOWLEDGE_CI_CLEANUP_HOOK_MS,
} from '../../evidence/WP-P3-KNWUI-054/20261007/ci-knowledge-db.mjs';
import { validateKnowledgeContainer } from '../../evidence/WP-P3-KNWUI-054/20261007/isolated-knowledge-db.mjs';
import {
  buildKnowledgeCountQuery,
  buildKnowledgePageQuery,
  buildKnowledgeNeighborsQuery,
  encodeKnowledgeCursor,
  parseKnowledgeListQuery,
  KNOWLEDGE_CURSOR_MAX_LENGTH,
} from '../../services/api/src/modules/knowledge/knowledge-query.js';

const org = '05400000-0000-4000-8000-000000000001';
const id = '05400000-0000-4000-8000-000000000002';
const other = '05400000-0000-4000-8000-000000000003';
const scope = { organizationId: org, staffVisible: false };
const anchor = { titleMatch: true, updatedAt: '2026-10-07T00:00:00.123456Z', id };
const auth = (role: RoleCode = 'requester'): AuthenticatedRequest => ({
  userId: id,
  sessionId: 'unit-only',
  authz: {
    organizationId: org,
    now: new Date('2026-10-07T00:00:00Z'),
    principal: {
      userId: id,
      status: 'active',
      bindings: [
        {
          roleCode: role,
          organizationId: role.startsWith('platform_') ? null : org,
          validFrom: new Date('2026-01-01Z'),
          validUntil: null,
        },
      ],
    },
  },
});
const parse = (query = '', visibility = scope) =>
  parseKnowledgeListQuery(new URLSearchParams(query), visibility);
const rawCursor = (tuple: unknown) => Buffer.from(JSON.stringify(tuple)).toString('base64url');

// FR-KNW-003 partial: existing literal search semantics; no search-quality acceptance claim.
describe('knowledge list cursor contract', () => {
  it('preserves old defaults, first q/manage and 200 UTF-16 truncation', () => {
    expect(parse()).toMatchObject({ q: '', manage: false, limit: 100, cursor: null });
    const query = new URLSearchParams([
      ['q', ` ${'日'.repeat(201)} `],
      ['q', 'ignored'],
      ['manage', '1'],
      ['manage', '0'],
    ]);
    expect(parseKnowledgeListQuery(query, scope)).toMatchObject({
      q: '日'.repeat(200),
      manage: true,
    });
  });
  it.each(['1', '20', '100'])('accepts bounded limit %s', (limit) =>
    expect(parse(`limit=${limit}`).limit).toBe(Number(limit)),
  );
  it.each(['0', '101', '-1', '1.0', '01', '', 'Infinity', '20x', ' 20', '1e2'])(
    'rejects invalid limit %s',
    (limit) => {
      expect(() => parse(`limit=${encodeURIComponent(limit)}`)).toThrow(
        expect.objectContaining({ status: 400 }),
      );
    },
  );
  it.each([
    'limit=20&limit=20',
    'cursor=x&cursor=x',
    'cursor=',
    'cursor=***',
    'cursor=' + 'a'.repeat(169),
  ])('rejects invalid/duplicate navigation %s', (query) => {
    expect(() => parse(query)).toThrow(expect.objectContaining({ status: 400 }));
  });
  it.each(['next', 'previous'] as const)(
    'round-trips %s without rounding microseconds',
    (direction) => {
      const options = parse('q=検索&limit=20');
      const cursor = encodeKnowledgeCursor(options, anchor, direction);
      expect(parse(`q=検索&limit=20&cursor=${cursor}`).cursor).toEqual({ ...anchor, direction });
      expect(cursor.length).toBeLessThanOrEqual(KNOWLEDGE_CURSOR_MAX_LENGTH);
    },
  );
  it('keeps maximum Japanese query, mode and emitted cursor within existing returnTo bound', () => {
    const q = '日'.repeat(200),
      options = parseKnowledgeListQuery(
        new URLSearchParams({ q, manage: '1', limit: '20' }),
        scope,
      );
    const cursor = encodeKnowledgeCursor(options, { ...anchor, titleMatch: false }, 'previous');
    expect(cursor.length).toBe(168);
    expect(('/knowledge?' + new URLSearchParams({ q, manage: '1', cursor })).length).toBe(1998);
  });
  it.each(['q', 'manage', 'limit', 'organization', 'visibility'])(
    'rejects a cursor after changing %s',
    (field) => {
      const cursor = encodeKnowledgeCursor(parse('q=検索&limit=20'), anchor, 'next');
      const query = new URLSearchParams({ q: '検索', limit: '20', cursor });
      const changed = { ...scope };
      if (field === 'organization') changed.organizationId = other;
      else if (field === 'visibility') changed.staffVisible = true;
      else query.set(field, field === 'q' ? '別' : field === 'manage' ? '1' : '100');
      expect(() => parseKnowledgeListQuery(query, changed)).toThrow(
        expect.objectContaining({ status: 400 }),
      );
    },
  );
  it.each([
    [0, 2],
    [1, 2],
    [2, 'true'],
    [3, '2026-02-30T00:00:00.123456Z'],
    [3, '2026-10-07T24:00:00.123456Z'],
    [3, '2026-10-07T00:00:00.123Z'],
    [3, '0000-01-01T00:00:00.000000Z'],
    [4, "' OR true --"],
    [5, 'x'],
  ])('rejects malformed tuple field %s', (field, value) => {
    const options = parse(),
      tuple: unknown[] = [1, 0, true, anchor.updatedAt, id, options.digest];
    tuple[field as number] = value;
    expect(() => parse(`cursor=${rawCursor(tuple)}`)).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });
  it('rejects additional tuple fields and noncanonical payloads', () => {
    const tuple = [1, 0, true, anchor.updatedAt, id, parse().digest];
    expect(() => parse(`cursor=${rawCursor([...tuple, 'extra'])}`)).toThrow();
    const spaced = Buffer.from(JSON.stringify(tuple).replace(',', ', ')).toString('base64url');
    expect(() => parse(`cursor=${spaced}`)).toThrow();
  });
  it('uses parameters for literal wildcard and SQL-looking input', () => {
    const options = parseKnowledgeListQuery(new URLSearchParams({ q: "%_\\' OR true --" }), scope);
    const query = buildKnowledgePageQuery(options, scope);
    expect(query.params).toEqual(["%\\%\\_\\\\' OR true --%", org, false, 100]);
    expect(query.sql).not.toContain('OR true --');
    expect(query.sql).not.toContain(org);
  });
  it('keeps authorized published/current versions on count, page and neighbors', () => {
    for (const manage of [false, true]) {
      const options = parse(manage ? 'manage=1' : '');
      const queries = [
        buildKnowledgeCountQuery(options, scope),
        buildKnowledgePageQuery(options, scope),
        buildKnowledgeNeighborsQuery(options, scope, anchor, anchor),
      ];
      for (const query of queries) {
        expect(query.sql).toContain('a.organization_id=$2');
        expect(query.sql).toContain(manage ? 'v.number=a.version' : 'v.number=a.published_version');
        if (!manage) {
          expect(query.sql).toContain("a.state <> 'retired'");
          expect(query.sql).toContain("v.audience='organization' OR $3");
          expect(query.sql).not.toContain("a.state='published'");
        }
      }
    }
  });
  it('reverses the keyset direction but never places cursor in count', () => {
    const options = parse();
    options.cursor = { ...anchor, direction: 'previous' };
    const previous = buildKnowledgePageQuery(options, scope);
    expect(previous.sql).toContain('> ($4::boolean, $5::timestamptz, $6::uuid)');
    expect(previous.sql).toContain('a.updated_at ASC, a.id ASC LIMIT $7');
    expect(previous.params).toEqual(['%%', org, false, true, anchor.updatedAt, id, 100]);
    expect(buildKnowledgeCountQuery(options, scope).params).toEqual(['%%', org, false]);
    options.cursor.direction = 'next';
    expect(buildKnowledgePageQuery(options, scope).sql).toContain('< ($4::boolean');
  });
});

function stub(rows: Record<string, unknown>[] = [], failAt?: 'count' | 'page' | 'neighbors') {
  const release = vi.fn();
  const query = vi.fn(async (sql: string) => {
    const kind = sql.startsWith('SELECT count')
      ? 'count'
      : sql.startsWith('SELECT EXISTS')
        ? 'neighbors'
        : sql.startsWith('SELECT a.id')
          ? 'page'
          : null;
    if (kind === failAt) throw new Error('UNIT_DATABASE_FAILURE');
    if (kind === 'count') return { rows: [{ total: '205' }] };
    if (kind === 'page') return { rows: rows.map((row) => ({ ...row })) };
    if (kind === 'neighbors') return { rows: [{ previous: true, next: true }] };
    return { rows: [] };
  });
  const connect = vi.fn(async () => ({ query, release }));
  return {
    controller: new KnowledgeController({ connect } as unknown as pg.Pool),
    query,
    connect,
    release,
  };
}
describe('actual knowledge controller read contract', () => {
  it('keeps original item fields and strips navigation metadata', async () => {
    const original = {
      id,
      state: 'published',
      version: 2,
      publishedVersion: 2,
      contentVersion: 2,
      title: 'title',
      body: 'full body',
      tags: '',
      audience: 'organization',
      versionCreatedAt: new Date('2026-10-07Z'),
    };
    const db = stub([{ ...original, __titleMatch: true, __updatedAt: anchor.updatedAt }]);
    const result = await db.controller.list(auth(), new URLSearchParams());
    expect(result.items).toEqual([original]);
    expect(result.total).toBe(205);
    expect(result.previousCursor).toEqual(expect.any(String));
    expect(result.nextCursor).toEqual(expect.any(String));
    expect(
      db.query.mock.calls.map(([sql]) => sql).filter((sql) => /BEGIN|COMMIT|ROLLBACK/.test(sql)),
    ).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'COMMIT']);
    expect(db.release).toHaveBeenCalledOnce();
  });
  it('reverses a previous page for callers', async () => {
    const db = stub([
      { id, __titleMatch: true, __updatedAt: anchor.updatedAt },
      { id: other, __titleMatch: true, __updatedAt: anchor.updatedAt },
    ]);
    const cursor = encodeKnowledgeCursor(parse(), anchor, 'previous');
    expect(
      (await db.controller.list(auth(), new URLSearchParams({ cursor }))).items.map((r) => r.id),
    ).toEqual([other, id]);
  });
  it('returns actual total for an empty continuation without invented navigation', async () => {
    const db = stub(),
      cursor = encodeKnowledgeCursor(parse(), anchor, 'next');
    expect(await db.controller.list(auth(), new URLSearchParams({ cursor }))).toEqual({
      items: [],
      total: 205,
      previousCursor: null,
      nextCursor: null,
    });
    expect(db.query.mock.calls.some(([sql]) => sql.startsWith('SELECT EXISTS'))).toBe(false);
  });
  it.each(['count', 'page', 'neighbors'] as const)(
    'rolls back and releases on %s failure rather than returning zero',
    async (failAt) => {
      const db = stub([{ id, __titleMatch: true, __updatedAt: anchor.updatedAt }], failAt);
      await expect(db.controller.list(auth(), new URLSearchParams())).rejects.toThrow(
        'UNIT_DATABASE_FAILURE',
      );
      expect(db.query).toHaveBeenCalledWith('ROLLBACK');
      expect(db.query).not.toHaveBeenCalledWith('COMMIT');
      expect(db.release).toHaveBeenCalledOnce();
    },
  );
  it.each(['requester', 'auditor', 'platform_auditor'] as const)(
    'rejects manage for %s before connecting',
    async (role) => {
      const db = stub();
      await expect(
        db.controller.list(auth(role), new URLSearchParams('manage=1')),
      ).rejects.toMatchObject({ status: 403 });
      expect(db.connect).not.toHaveBeenCalled();
    },
  );
  it('rejects expired editor binding and malformed cursor before connecting', async () => {
    const db = stub(),
      expired = auth('agent');
    expired.authz.principal.bindings[0]!.validUntil = expired.authz.now!;
    await expect(
      db.controller.list(expired, new URLSearchParams('manage=1')),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      db.controller.list(auth(), new URLSearchParams('cursor=bad')),
    ).rejects.toMatchObject({ status: 400 });
    expect(db.connect).not.toHaveBeenCalled();
  });
});

describe('knowledge proof fixture target guards without database access', () => {
  const app = 'postgresql://solvi_app:synthetic@127.0.0.1:54329/solvi_wp054_test_123_abcdef01';
  const owner = app.replace('solvi_app', 'solvi_owner');
  it('allows only the matching owned target namespace and roles', () => {
    expect(assertKnowledgeDatabaseUrls(app, owner)).toBe('solvi_wp054_test_123_abcdef01');
  });
  it.each([
    [app.replace('127.0.0.1', 'example.test'), owner],
    [app.replace('54329', '5433'), owner],
    [app.replace('solvi_wp054_test_123_abcdef01', 'solvi'), owner],
    [app, owner.replace('solvi_owner', 'solvi_app')],
    [app, owner.replace('abcdef01', 'abcdef02')],
  ])(
    'refuses mismatched or external fixture targets without echoing credentials',
    (application, administrative) => {
      expect(() => assertKnowledgeDatabaseUrls(application, administrative)).toThrow(
        'KNOWLEDGE_OWNED_DATABASE_REQUIRED',
      );
    },
  );
  it('rechecks actual database identity before performing any write', async () => {
    const query = vi.fn(async () => ({ rows: [{ database: 'solvi', role: 'solvi_owner' }] }));
    await expect(
      seedKnowledgeFixture({ query } as unknown as pg.Client, 'solvi_wp054_test_123_abcdef01'),
    ).rejects.toThrow('KNOWLEDGE_OWNED_DATABASE_REQUIRED');
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]).toEqual([
      'SELECT current_database() AS database, current_user AS role',
    ]);
  });
  it('refuses cancellation before connecting or writing', async () => {
    const query = vi.fn(),
      aborter = new AbortController();
    aborter.abort();
    await expect(
      seedKnowledgeFixture({ query } as unknown as pg.Client, 'solvi_wp054_test_123_abcdef01', {
        signal: aborter.signal,
      }),
    ).rejects.toThrow('KNOWLEDGE_ABORTED');
    expect(query).not.toHaveBeenCalled();
  });
});

describe('CI isolation and stopped-container cleanup guards without starting resources', () => {
  const env = {
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    DATABASE_URL: 'postgres://solvi_app:synthetic@localhost:5432/solvi',
    DATABASE_ADMIN_URL: 'postgres://solvi_owner:synthetic@localhost:5432/solvi',
  };
  it('accepts only the existing explicit CI endpoint contract', () =>
    expect(assertCiKnowledgeEndpoints(env)).toBe(true));
  it.each([
    { CI: 'false' },
    { GITHUB_ACTIONS: 'false' },
    { DATABASE_URL: env.DATABASE_URL.replace('localhost', '127.0.0.1') },
    { DATABASE_URL: env.DATABASE_URL.replace('5432', '5433') },
    { DATABASE_ADMIN_URL: env.DATABASE_ADMIN_URL.replace('/solvi', '/development') },
    { DATABASE_ADMIN_URL: env.DATABASE_ADMIN_URL.replace('solvi_owner:', 'solvi_app:') },
    { DATABASE_URL: env.DATABASE_URL + '?options=-crole=solvi_owner' },
  ])('refuses changed CI flags/endpoints before any connection', (change) => {
    expect(() => assertCiKnowledgeEndpoints({ ...env, ...change })).toThrow(
      'KNOWLEDGE_CI_TARGET_REJECTED',
    );
  });
  const expectedDb = {
    database: 'solvi_wp054_test_123_abcdef01',
    oid: 12345,
    marker: 'WP-P3-KNWUI-054:' + 'a'.repeat(24),
  };
  const db = {
    name: expectedDb.database,
    oid: expectedDb.oid,
    owner: 'solvi_owner',
    marker: expectedDb.marker,
  };
  it('requires exact namespace, OID, owner and comment marker for drop', () =>
    expect(() => assertOwnedCiDatabase(db, expectedDb)).not.toThrow());
  it('keeps preparation and cleanup budgets inside the setup hook', () => {
    expect(KNOWLEDGE_CI_PREPARATION_MS).toBe(120000);
    expect(KNOWLEDGE_CI_SETUP_HOOK_MS).toBeGreaterThan(
      KNOWLEDGE_CI_PREPARATION_MS + KNOWLEDGE_CI_CLEANUP_HOOK_MS,
    );
  });
  it('allows incomplete ownership initialization only for an acknowledged CREATE on the original session', () => {
    const expected = {
      ...expectedDb,
      oid: undefined,
      ownerPid: 123,
      createAcknowledged: true,
      markerConfirmed: false,
    };
    const connection = { database: 'solvi', role: 'solvi_owner', pid: 123 };
    expect(() =>
      assertInitializingCiDatabase({ ...db, marker: null }, expected, connection),
    ).not.toThrow();
    for (const change of [
      { createAcknowledged: false },
      { markerConfirmed: true },
      { ownerPid: 124 },
      { oid: 12346 },
    ])
      expect(() =>
        assertInitializingCiDatabase(
          { ...db, marker: null },
          { ...expected, ...change },
          connection,
        ),
      ).toThrow('KNOWLEDGE_CI_OWNER_MISMATCH');
    expect(() =>
      assertInitializingCiDatabase({ ...db, marker: 'unowned' }, expected, connection),
    ).toThrow('KNOWLEDGE_CI_OWNER_MISMATCH');
  });
  it.each([{ name: 'solvi' }, { oid: 12346 }, { owner: 'postgres' }, { marker: null }])(
    'refuses an unowned CI database %j',
    (change) => {
      expect(() => assertOwnedCiDatabase({ ...db, ...change }, expectedDb)).toThrow(
        'KNOWLEDGE_CI_OWNER_MISMATCH',
      );
    },
  );
  const expectedContainer = {
    containerId: 'a'.repeat(64),
    imageId: 'sha256:' + 'b'.repeat(64),
    name: 'solvi-wp054-db-unit',
    nonce: 'c'.repeat(24),
    port: 54329,
  };
  const container = {
    Id: expectedContainer.containerId,
    Image: expectedContainer.imageId,
    Name: '/' + expectedContainer.name,
    Config: {
      Labels: { 'solvi.work-package': 'WP-P3-KNWUI-054', 'solvi.owner': expectedContainer.nonce },
    },
    HostConfig: {
      Tmpfs: { '/var/lib/postgresql/data': 'rw' },
      PortBindings: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] },
    },
    Mounts: [{ Type: 'tmpfs' }],
    State: { Running: false },
    NetworkSettings: { Ports: { '5432/tcp': null } },
  };
  it('permits owned stopped-container cleanup without a live port mapping', () => {
    expect(validateKnowledgeContainer(container, expectedContainer, true)).toBe(54329);
    expect(() => validateKnowledgeContainer(container, expectedContainer)).toThrow(
      'KNOWLEDGE_DATABASE_NOT_READY',
    );
  });
  it('still refuses changed ownership/storage/bindings during stopped cleanup', () => {
    expect(() =>
      validateKnowledgeContainer({ ...container, Image: 'other' }, expectedContainer, true),
    ).toThrow('KNOWLEDGE_OWNER_MISMATCH');
    expect(() =>
      validateKnowledgeContainer(
        { ...container, Mounts: [{ Type: 'bind' }] },
        expectedContainer,
        true,
      ),
    ).toThrow('KNOWLEDGE_STORAGE_MISMATCH');
    expect(() =>
      validateKnowledgeContainer(
        {
          ...container,
          HostConfig: {
            ...container.HostConfig,
            PortBindings: { '5432/tcp': [{ HostIp: '0.0.0.0' }] },
          },
        },
        expectedContainer,
        true,
      ),
    ).toThrow('KNOWLEDGE_NOT_LOOPBACK');
  });
  it.each(['oid-read', 'comment-write', 'unknown-create'] as const)(
    'recovers or fails closed after %s without actual database access',
    async (failure) => {
      let clients = 0,
        created = false,
        failedOnce = false,
        name = '',
        dropped = false;
      const calls: string[] = [];
      const ownerQuery = async (sql: string) => {
        calls.push(sql);
        if (sql.startsWith('SELECT current_database()'))
          return {
            rows: [{ database: 'solvi', role: 'solvi_owner', owns_database: true, pid: 123 }],
          };
        if (sql.startsWith('CREATE DATABASE')) {
          name = /"(solvi_wp054_test_\d+_[a-f0-9]{8})"/.exec(sql)![1]!;
          created = true;
          if (failure === 'unknown-create') throw new Error('PRIVATE_CREATE_DETAIL');
          return { rows: [] };
        }
        if (sql.startsWith('SELECT d.datname')) {
          if (created && failure === 'oid-read' && !failedOnce) {
            failedOnce = true;
            throw new Error('PRIVATE_OID_DETAIL');
          }
          return {
            rows:
              created && !dropped ? [{ name, oid: 12345, owner: 'solvi_owner', marker: null }] : [],
          };
        }
        if (sql.startsWith('COMMENT ON DATABASE')) throw new Error('PRIVATE_COMMENT_DETAIL');
        if (sql.startsWith('SELECT count(*)::int')) return { rows: [{ n: 0 }] };
        if (sql.startsWith('DROP DATABASE')) {
          dropped = true;
          return { rows: [] };
        }
        throw new Error('UNEXPECTED_UNIT_QUERY');
      };
      const appQuery = async () => ({
        rows: [1, 2].map(() => ({
          database: 'solvi',
          role: 'solvi_app',
          rolsuper: false,
          rolbypassrls: false,
          owns_table: false,
          relrowsecurity: true,
          relforcerowsecurity: true,
          row_security: 'on',
        })),
      });
      const mock = vi.spyOn(pg, 'Client').mockImplementation(function () {
        const owner = clients++ === 0;
        return {
          connect: async () => undefined,
          end: async () => undefined,
          query: owner ? ownerQuery : appQuery,
        } as unknown as pg.Client;
      });
      try {
        let caught: unknown;
        try {
          await createCiKnowledgeDatabase(env);
        } catch (error) {
          caught = error;
        }
        expect(caught).toMatchObject({
          message: 'KNOWLEDGE_CI_PREPARATION_FAILED',
          cleanupReport: {
            success: failure !== 'unknown-create',
            databaseRemoved: failure !== 'unknown-create',
            ownerClosed: true,
            fixtureOwnerClosed: true,
          },
        });
        expect(dropped).toBe(failure !== 'unknown-create');
        expect(calls.filter((sql) => sql.startsWith('DROP DATABASE')).length).toBe(
          failure === 'unknown-create' ? 0 : 1,
        );
      } finally {
        mock.mockRestore();
      }
    },
  );
});
