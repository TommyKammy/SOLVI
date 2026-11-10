import { describe, expect, it, vi } from 'vitest';
import { buildListQuery } from '../../services/api/src/modules/ticket/ticket-query.js';
import type { AuthzContext } from '../../services/api/src/common/authz/authz.js';
import type {
  AnalysisClient,
  ReadOnlyProof,
} from '../../tools/performance/list-query-analysis.mjs';
import {
  analyzeSearchStatic,
  buildStaticStatement,
  compareStaticProjection,
  escapeStaticKeyword,
  parseStaticPattern,
  proveStaticNarrowing,
  sanitizeStaticCatalog,
  summarizeStaticPlan,
  type StaticContextKey,
  type StaticCorpus,
  type StaticFixture,
} from '../../tools/performance/search-static-analysis.mjs';

const id = (n: number) => `05300000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const context = (n: number, org = 100): AuthzContext => ({
  organizationId: id(org),
  now: new Date('2026-10-07T00:00:00Z'),
  principal: {
    userId: id(n),
    status: 'active',
    bindings: [
      {
        roleCode: n === 1 ? 'agent' : 'requester',
        organizationId: id(org),
        validFrom: new Date(0),
        validUntil: null,
      },
    ],
  },
});
const fixture: StaticFixture = {
  organizationId: id(100),
  controlOrganizationId: id(101),
  groups: [id(201), id(202)],
  counts: {},
  actors: {
    agent: { context: context(1), userId: id(1) },
    requester: { context: context(2), userId: id(2) },
    'other-requester': { context: context(3), userId: id(3) },
    foreign: { context: context(4, 101), userId: id(4) },
    deactivated: { context: context(5), userId: id(5) },
    expired: { context: context(6), userId: id(6) },
    revoked: { context: context(7), userId: id(7) },
  },
};
const corpus: StaticCorpus = {
  documents: Array.from({ length: 32 }, () => 'PRIVATE-document'),
  keywords: Array.from({ length: 32 }, () => 'PRIVATE-keyword'),
  additionalPairs: Array.from({ length: 10 }, () => ({
    document: 'PRIVATE-document',
    keyword: 'PRIVATE-keyword',
  })),
};
const proof: ReadOnlyProof = {
  role: 'solvi_app',
  superuser: false,
  bypassRls: false,
  ownsTables: false,
  readOnly: true,
  isolationLevel: 'repeatable read',
  rowSecurity: true,
  ticketRlsActive: true,
  ticketRlsForced: true,
  transactionLocalContext: true,
  statementTimeoutMs: 30000,
  queryTimeoutMs: 35000,
  readOnlyWriteRejected: true,
  readOnlyWriteSqlState: '25006',
};
const catalog = () => ({
  version: 160006,
  version_hash: 'a'.repeat(32),
  utf8: true,
  icu: true,
  locale: true,
  version_matches: true,
  deterministic: true,
  default_collation: true,
  generated: true,
  bytea_token: true,
  posting_rls: true,
  posting_force_rls: true,
  posting_rls_active: true,
  posting_nonowner: true,
  posting_select: true,
  posting_select_only: true,
  posting_index: true,
  autoclose_disabled: true,
  seqscan_enabled: true,
});
const plan = (scan: Record<string, unknown> = {}) => [
  {
    'Planning Time': 0.1,
    'Execution Time': 0.2,
    Plan: {
      'Node Type': 'Aggregate',
      'Actual Rows': 1,
      'Actual Loops': 1,
      'Shared Hit Blocks': 10,
      'Shared Read Blocks': 2,
      'Temp Read Blocks': 0,
      'Temp Written Blocks': 0,
      Plans: [
        {
          'Node Type': 'Index Only Scan',
          'Index Name': 'search_posting_token_idx',
          'Relation Name': 'search_posting',
          Schema: 'perf053',
          'Actual Rows': 1,
          'Actual Loops': 1,
          'Index Cond':
            "((organization_id = 'PRIVATE-org'::uuid) AND (token = ANY ('PRIVATE-token'::bytea[])))",
          Filter: 'PRIVATE-body',
          Output: ['PRIVATE-value'],
          'Shared Hit Blocks': 10,
          ...scan,
        },
      ],
    },
  },
];

describe('WP053 literal preprocessing and standalone three-valued oracle', () => {
  it('matches JS trim and escapes literal wildcard and escape characters without folding', () => {
    expect(escapeStaticKeyword('\u00a0 AİB%_\\ \u2003')).toBe('%AİB\\%\\_\\\\%');
    expect(escapeStaticKeyword('\u00a0\u2003')).toBeNull();
    expect(escapeStaticKeyword(' x\ny ')).toBe('%x\ny%');
  });
  it('parses already-PG-folded Unicode and escapes without code-unit slicing', () => {
    expect(parseStaticPattern('%aİb\\%\\_\\\\😀e\u0301%')).toEqual({
      eligible: true,
      literal: 'aİb%_\\😀e\u0301',
      reason: 'literal',
    });
    expect(parseStaticPattern('%é%').literal).toBe('é');
    expect(parseStaticPattern('%e\u0301%').literal).toBe('e\u0301');
    expect(parseStaticPattern('%%')).toEqual({ eligible: true, literal: '', reason: 'literal' });
    expect(parseStaticPattern(null)).toEqual({ eligible: false, literal: null, reason: 'empty' });
  });
  it.each(['a', '%', '%a%b%', '%a_b%', '%a\\q%', '%abc\\%', '%a\u0000b%', '%a\ud800b%', 17])(
    'falls back on unknown grammar %j',
    (value) => {
      expect(parseStaticPattern(value)).toEqual({
        eligible: false,
        literal: null,
        reason: 'grammar',
      });
    },
  );
  it('detects false-negative candidates and requires actual candidate use for the Unicode additions', () => {
    expect(
      compareStaticProjection([{ position: 1, oracle: true, candidate: false }], 1, true, true),
    ).toMatchObject({ equal: false, falseNegatives: 1, mismatches: 1 });
    expect(
      compareStaticProjection([{ position: 1, oracle: true, candidate: true }], 1, true, false)
        .equal,
    ).toBe(false);
    expect(
      compareStaticProjection([{ position: 1, oracle: true, candidate: true }], 1, true, true)
        .equal,
    ).toBe(true);
  });
  it('preserves SQL NULL separately from false and empty-keyword true', () => {
    expect(
      compareStaticProjection(
        [
          { position: 1, oracle: null, candidate: false },
          { position: 2, oracle: false, candidate: true },
          { position: 3, oracle: true, candidate: true },
        ],
        3,
        false,
        true,
      ),
    ).toMatchObject({ equal: true, pairs: 3, nullRows: 1, trueRows: 1 });
    expect(() =>
      compareStaticProjection(
        [{ position: 1, oracle: undefined, candidate: false }],
        1,
        false,
        true,
      ),
    ).toThrow('STATIC_RESULT_INVALID');
    expect(() =>
      compareStaticProjection([{ position: 2, oracle: true, candidate: true }], 1, false, true),
    ).toThrow('STATIC_RESULT_INVALID');
  });
});

describe('WP053 unchanged compiled native query adapter', () => {
  it.each(['asc', 'desc'] as const)(
    'keeps every legacy statement and parameter inside one ordered native %s query',
    (direction) => {
      const options = {
        filter: { keyword: 'PRIVATE-keyword', state: ['new' as const] },
        sort: { column: 'created_at' as const, direction },
        limit: 50,
      };
      const built = buildListQuery(context(1), options);
      const token = Buffer.from('PRIVATE-token');
      const before = structuredClone(built);
      const candidate = buildStaticStatement(built, options, id(100), [token]);
      expect(candidate.sql).toContain(built.combinedSql);
      expect(candidate.sql).toContain('SELECT source.* FROM public.ticket source');
      expect(candidate.sql).toContain('posting.token=ANY(');
      expect(candidate.sql).toContain('HAVING count(*)=cardinality(');
      expect(candidate.sql).toContain('ticket AS NOT MATERIALIZED');
      expect(candidate.sql).not.toContain('PRIVATE-keyword');
      expect(candidate.sql).not.toContain('PRIVATE-token');
      expect(candidate.params).toEqual([...built.params, id(100), [token]]);
      expect(
        candidate.sql.endsWith(
          `ORDER BY created_at ${direction.toUpperCase()}, id ${direction.toUpperCase()}`,
        ),
      ).toBe(true);
      expect(built).toEqual(before);
      expect(candidate.sqlHash).toMatch(/^[a-f0-9]{64}$/);
    },
  );
  it('retains count-before-cursor, empty sentinel, and raw microsecond cursor', () => {
    const options = {
      filter: { keyword: 'needle' },
      cursor: { createdAt: '2026-10-07 00:00:00.123456+00', id: id(10) },
      limit: 1,
    };
    const built = buildListQuery(context(2), options);
    const wrapped = buildStaticStatement(built, options, id(100), [Buffer.from('nee')]);
    expect(wrapped.params).toContain(options.cursor.createdAt);
    expect(built.countParams).not.toContain(options.cursor.createdAt);
    expect(wrapped.sql).toContain(built.combinedSql);
    expect(wrapped.sql).toContain('__solvi_total');
  });
  it('combines non-keyword and deadline list/count without JSON or dropping fields', () => {
    for (const options of [
      { filter: { keyword: ' ' } },
      {
        filter: { keyword: 'static' },
        sort: { column: 'deadline' as const, direction: 'asc' as const },
      },
    ]) {
      const built = buildListQuery(context(1), options);
      expect(built.combinedSql).toBeUndefined();
      const wrapped = buildStaticStatement(built, options, id(100));
      expect(wrapped.sql).toContain(built.sql);
      expect(wrapped.sql).toContain(built.countSql);
      expect(wrapped.sql).toContain('LEFT JOIN LATERAL');
      expect(wrapped.sql).toContain('static_page.*');
      expect(wrapped.sql).not.toMatch(/json|to_char/i);
      expect(wrapped.candidateUsed).toBe(false);
    }
  });
  it('rejects duplicate tokens rather than silently requiring duplicate posting rows', () => {
    const options = { filter: { keyword: 'aaaaaaaaaaaaaaaa' } };
    const built = buildListQuery(context(2), options);
    expect(() =>
      buildStaticStatement(built, options, id(100), [Buffer.from('aaa'), Buffer.from('aaa')]),
    ).toThrow('STATIC_QUERY_INVALID');
  });
  it('rejects changed bind prefixes, unknown sorts and statement text outside the fixed reader shape', () => {
    const built = buildListQuery(context(1), { filter: { keyword: 'static' } });
    expect(() => buildStaticStatement({ ...built, countParams: ['bad'] }, {}, id(100))).toThrow(
      'STATIC_QUERY_INVALID',
    );
    expect(() =>
      buildStaticStatement(built, { sort: { column: 'number', direction: 'asc' } }, id(100)),
    ).toThrow('STATIC_QUERY_INVALID');
    expect(() =>
      buildStaticStatement({ ...built, combinedSql: 'SELECT 1; SELECT 2' }, {}, id(100)),
    ).toThrow('STATIC_QUERY_INVALID');
  });
});

describe('WP053 catalog and physical posting evidence', () => {
  it('requires the actual ICU database version, deterministic default collation, and read-only posting boundary', () => {
    expect(sanitizeStaticCatalog([catalog()])).toMatchObject({
      version: 160006,
      collationVersionHash: 'a'.repeat(32),
      posting_select_only: true,
    });
    for (const field of [
      'locale',
      'icu',
      'version_matches',
      'deterministic',
      'default_collation',
      'bytea_token',
      'posting_index',
      'posting_select_only',
      'posting_nonowner',
      'posting_rls_active',
    ])
      expect(() => sanitizeStaticCatalog([{ ...catalog(), [field]: false }])).toThrow(
        'STATIC_CATALOG_INVALID',
      );
    expect(() => sanitizeStaticCatalog([{ ...catalog(), version: 160007 }])).toThrow(
      'STATIC_CATALOG_INVALID',
    );
    expect(() =>
      sanitizeStaticCatalog([{ ...catalog(), version_hash: 'PRIVATE-version' }]),
    ).toThrow('STATIC_CATALOG_INVALID');
  });
  it('proves executed token equality even when the index returns zero rows and preserves root buffers only', () => {
    const result = summarizeStaticPlan(plan({ 'Actual Rows': 0 }));
    expect(result.postingIndexExecuted).toBe(true);
    expect(result.postingVisitedRows).toBe(0);
    expect(result.rootBuffers['Shared Hit Blocks']).toBe(10);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|Index Cond|Filter|Output/);
  });
  it('does not call an unused branch, org-only lookup or token residual filter a token index proof', () => {
    expect(summarizeStaticPlan(plan({ 'Actual Loops': 0 })).postingIndexExecuted).toBe(false);
    expect(
      summarizeStaticPlan(
        plan({ 'Index Cond': "organization_id = 'PRIVATE'", Filter: "token = 'PRIVATE'" }),
      ).postingIndexExecuted,
    ).toBe(false);
    expect(
      summarizeStaticPlan(plan({ 'Node Type': 'Seq Scan', 'Index Name': undefined }))
        .postingIndexExecuted,
    ).toBe(false);
  });
  it('counts removed tuples and repeated loops instead of only returned rows', () => {
    const result = summarizeStaticPlan(
      plan({ 'Actual Rows': 1, 'Actual Loops': 2, 'Rows Removed by Filter': 99 }),
    );
    expect(result.postingVisitedRows).toBe(200);
  });
  it('bounds ticket reevaluation by candidate IDs using only actual existing unique-ID indexes', () => {
    const ticketPlan = (change: Record<string, unknown> = {}) =>
      summarizeStaticPlan(
        plan({
          'Relation Name': 'ticket',
          Schema: 'public',
          'Node Type': 'Index Scan',
          'Index Name': 'ticket_pkey',
          'Index Cond': '(id = candidate.ticket_id)',
          ...change,
        }),
      );
    expect(proveStaticNarrowing(ticketPlan(), 1)).toBe(true);
    expect(proveStaticNarrowing(ticketPlan({ 'Index Name': 'ticket_id_org_asset_key' }), 1)).toBe(
      true,
    );
    expect(proveStaticNarrowing(ticketPlan({ 'Index Name': 'ticket_list_org_idx' }), 1)).toBe(
      false,
    );
    expect(
      proveStaticNarrowing(
        ticketPlan({ 'Index Cond': '(organization_id = candidate.organization_id)' }),
        1,
      ),
    ).toBe(false);
    expect(
      proveStaticNarrowing(
        ticketPlan({
          'Node Type': 'Seq Scan',
          'Index Name': undefined,
          'Rows Removed by Filter': 2047,
        }),
        1,
      ),
    ).toBe(false);
    expect(proveStaticNarrowing(ticketPlan({ 'Actual Loops': 2 }), 1)).toBe(false);
    expect(proveStaticNarrowing(ticketPlan({ 'Actual Loops': 0, 'Actual Rows': 0 }), 0)).toBe(true);
    expect(proveStaticNarrowing(ticketPlan({ 'Actual Loops': 1, 'Actual Rows': 0 }), 0)).toBe(
      false,
    );
  });
  it.each([
    { 'Node Type': 'UNKNOWN' },
    { 'Index Name': 'PRIVATE_index' },
    { 'Relation Name': 'PRIVATE_table' },
    { 'Parent Relationship': 'UNKNOWN' },
    { 'CTE Name': 'PRIVATE_cte' },
    { Schema: 'secret' },
    { 'Actual Loops': -1 },
  ])('rejects unknown plan metadata without publishing it %j', (change) => {
    expect(() => summarizeStaticPlan(plan(change))).toThrow();
  });
});

describe('WP053 partial reporting and private-input failures', () => {
  const reader =
    (query: AnalysisClient['query']) =>
    async <T>(_key: StaticContextKey, callback: (client: AnalysisClient) => Promise<T>) =>
      callback({ query, proof });
  it('stops before any SQL when aborted and preserves both adoption gates as false', async () => {
    const abort = new AbortController();
    abort.abort();
    const query = vi.fn<AnalysisClient['query']>();
    const result = await analyzeSearchStatic({
      withReadOnly: reader(query),
      buildTicketListQuery: buildListQuery,
      fixture,
      corpus,
      signal: abort.signal,
    });
    expect(result).toMatchObject({
      completed: false,
      equivalent: false,
      protocolCompleted: false,
      authorizationAdoption: false,
      adoptionEstablished: false,
      failureCode: 'STATIC_ABORTED',
    });
    expect(query).not.toHaveBeenCalled();
  });
  it('rejects metadata before processing private corpus and preserves a safe proof', async () => {
    const query = vi.fn<AnalysisClient['query']>(async (sql) =>
      sql.includes(' AS disabled')
        ? { rows: [{ disabled: true }] }
        : { rows: [{ ...catalog(), locale: false }] },
    );
    const result = await analyzeSearchStatic({
      withReadOnly: reader(query),
      buildTicketListQuery: buildListQuery,
      fixture,
      corpus,
    });
    expect(result.failureCode).toBe('STATIC_CATALOG_INVALID');
    expect(result.readOnlyContexts).toHaveLength(1);
    expect(result.corpus.cases).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('keeps the active corpus case and catalog when a query fails without leaking error or parameters', async () => {
    const query = vi.fn<AnalysisClient['query']>(async (sql) => {
      if (sql.includes(' AS disabled')) return { rows: [{ disabled: true }] };
      if (sql.includes('server_version_num')) return { rows: [catalog()] };
      throw new Error('PRIVATE-database-url PRIVATE-token PRIVATE-query');
    });
    const progress: string[] = [];
    const result = await analyzeSearchStatic({
      withReadOnly: reader(query),
      buildTicketListQuery: buildListQuery,
      fixture,
      corpus,
      onProgress: (stage) => progress.push(stage),
    });
    expect(result).toMatchObject({
      completed: false,
      catalogComplete: true,
      failureCode: 'STATIC_DIAGNOSTIC_FAILED',
    });
    expect(result.corpus.cases).toEqual([{ label: 'matrix-1', kind: 'matrix', completed: false }]);
    expect(progress).toEqual(['static-start', 'static-catalog', 'static-failed']);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('uses SQL character windows and dedup for long repeated text, and rejects non-bytea preprocessing output', async () => {
    const query = vi.fn<AnalysisClient['query']>(async (sql) => {
      if (sql.includes(' AS disabled')) return { rows: [{ disabled: true }] };
      if (sql.includes('server_version_num')) return { rows: [catalog()] };
      if (sql.startsWith('SELECT lower(')) return { rows: [{ pattern: '%aaaaaaaaaaaaaaaa%' }] };
      if (sql.includes('SELECT DISTINCT convert_to'))
        return { rows: [{ token: 'PRIVATE-token-string' }] };
      throw new Error('unexpected');
    });
    const result = await analyzeSearchStatic({
      withReadOnly: reader(query),
      buildTicketListQuery: buildListQuery,
      fixture,
      corpus,
    });
    expect(result.failureCode).toBe('STATIC_TOKEN_INVALID');
    const tokenSql = query.mock.calls.find(([sql]) =>
      sql.includes('SELECT DISTINCT convert_to'),
    )?.[0];
    expect(tokenSql).toContain('char_length($1::text)-2');
    expect(tokenSql).toContain('least(8,');
    expect(tokenSql).toContain('floor(position.i::numeric');
    expect(tokenSql).toContain('ORDER BY token');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('uses a non-reserved SQL character-position alias in the actual corpus projection', async () => {
    let projectionSql = '';
    const query = vi.fn<AnalysisClient['query']>(async (sql) => {
      if (sql.includes(' AS disabled')) return { rows: [{ disabled: true }] };
      if (sql.includes('server_version_num')) return { rows: [catalog()] };
      if (sql.startsWith('SELECT lower(')) return { rows: [{ pattern: '%abc%' }] };
      if (sql.includes('SELECT DISTINCT convert_to'))
        return { rows: [{ token: Buffer.from('abc') }] };
      projectionSql = sql;
      throw new Error('bounded projection stop');
    });
    await analyzeSearchStatic({
      withReadOnly: reader(query),
      buildTicketListQuery: buildListQuery,
      fixture,
      corpus,
    });
    expect(projectionSql).toContain('position(n)');
    expect(projectionSql).toContain('position.n');
    expect(projectionSql).not.toContain('position(offset)');
  });
});
