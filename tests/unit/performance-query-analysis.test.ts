import { describe, expect, it } from 'vitest';
import { buildListQuery } from '../../services/api/src/modules/ticket/ticket-query.js';
import type { AuthzContext } from '../../services/api/src/common/authz/authz.js';
import {
  compareQueryResults,
  createOrderingVariants,
  sanitizeExplain,
  runQueryAnalysis,
  sanitizeReadOnlyProof,
  type AnalysisClient,
} from '../../tools/performance/list-query-analysis.mjs';
import type { PerformanceFixture } from '../../tools/performance/fixture.mjs';

const context: AuthzContext = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  principal: {
    userId: '00000000-0000-4000-8000-000000000002',
    status: 'active',
    bindings: [
      {
        roleCode: 'agent',
        organizationId: '00000000-0000-4000-8000-000000000001',
        validFrom: new Date(0),
        validUntil: null,
      },
    ],
  },
};

describe('ticket query analysis boundaries', () => {
  it('requires complete application-role, read-only, RLS and bounded-query proof and strips identifiers', () => {
    const proof = {
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
    expect(
      sanitizeReadOnlyProof({ ...proof, connection: 'private-url', organizationId: 'private-id' }),
    ).toEqual(proof);
    for (const changed of [
      { superuser: true },
      { bypassRls: true },
      { ownsTables: true },
      { readOnly: false },
      { rowSecurity: false },
      { ticketRlsActive: false },
      { isolationLevel: 'read committed' },
      { statementTimeoutMs: 0 },
      { readOnlyWriteRejected: false },
      { readOnlyWriteSqlState: '42501' },
    ])
      expect(() => sanitizeReadOnlyProof({ ...proof, ...changed })).toThrow(
        'QUERY_READ_ONLY_PROOF_INVALID',
      );
    expect(() => sanitizeReadOnlyProof({ role: 'solvi_app' })).toThrow(
      'QUERY_READ_ONLY_PROOF_INVALID',
    );
  });
  it('keeps plan structure, numerical evidence and index names while removing all predicates and data', () => {
    const clean = sanitizeExplain([
      {
        Plan: {
          'Node Type': 'Limit',
          'Actual Rows': 50,
          'Actual Loops': 1,
          'Actual Total Time': 1.25,
          Output: ['private-body'],
          Filter: 'private-organization-id',
          Plans: [
            {
              'Node Type': 'Index Scan',
              'Index Name': 'ticket_list_org_idx',
              'Shared Hit Blocks': 12,
              'Shared Read Blocks': 2,
              'Index Cond': 'private-email@example.test',
              'Sort Key': ['private-secret'],
              'Rows Removed by Filter': 3,
            },
          ],
        },
        'Planning Time': 0.5,
        'Execution Time': 1.5,
        Query: 'private SQL',
        Settings: { authorization: 'private-token' },
      },
    ]);
    expect(clean).toEqual({
      plan: {
        nodeType: 'Limit',
        actualRows: 50,
        actualLoops: 1,
        actualTotalMs: 1.25,
        children: [
          {
            nodeType: 'Index Scan',
            indexName: 'ticket_list_org_idx',
            sharedHitBlocks: 12,
            sharedReadBlocks: 2,
            rowsRemovedByFilter: 3,
          },
        ],
      },
      planningMs: 0.5,
      executionMs: 1.5,
    });
    expect(JSON.stringify(clean)).not.toContain('private');
  });

  it('rejects absent, nonfinite, unexpected and excessively nested plans', () => {
    const valid = { Plan: { 'Node Type': 'Result' }, 'Planning Time': 0, 'Execution Time': 0 };
    for (const value of [
      null,
      [],
      [{ ...valid, 'Execution Time': Infinity }],
      [{ ...valid, Plan: { 'Node Type': 'secret' } }],
      [{ ...valid, Plan: { 'Node Type': 'Index Scan', 'Index Name': 'private@example.test' } }],
    ])
      expect(() => sanitizeExplain(value)).toThrow('QUERY_PLAN_INVALID');
    let nested: Record<string, unknown> = { 'Node Type': 'Result' };
    for (let n = 0; n < 66; n += 1) nested = { 'Node Type': 'Result', Plans: [nested] };
    expect(() => sanitizeExplain([{ ...valid, Plan: nested }])).toThrow('QUERY_PLAN_INVALID');
  });

  it('changes only created-at NULL order and preserves all parameters, authorization, filters and count', () => {
    const built = buildListQuery(context, {
      filter: { keyword: 'value NULLS LAST', unassignedOnly: true },
      cursor: {
        createdAt: '2026-10-04 00:00:00.123456+00',
        id: '00000000-0000-4000-8000-000000000004',
      },
    });
    const variants = createOrderingVariants(built);
    expect(variants.changed).toBe(true);
    expect(variants.legacy.sql).toContain('ORDER BY t.created_at DESC NULLS LAST, t.id DESC');
    expect(variants.candidate.sql).toBe(
      variants.legacy.sql.replace(
        'ORDER BY t.created_at DESC NULLS LAST, t.id DESC',
        'ORDER BY t.created_at DESC, t.id DESC',
      ),
    );
    expect(variants.candidate.params).toEqual(built.params);
    expect(variants.candidate.countSql).toBe(built.countSql);
    expect(variants.candidate.countParams).toEqual(built.countParams);
    expect(createOrderingVariants(variants.candidate)).toEqual(variants);
  });

  it('preserves deadline NULLS LAST and refuses unsupported or additional statements', () => {
    const built = buildListQuery(context, { sort: { column: 'deadline', direction: 'asc' } });
    const variants = createOrderingVariants(built);
    expect(variants.changed).toBe(false);
    expect(variants.candidate.sql).toBe(built.sql);
    for (const changed of [
      { ...built, sql: built.sql + '; SELECT 1' },
      { ...built, sql: built.sql.replace('remaining_seconds ASC', 't.priority ASC') },
      { ...built, sql: built.sql.replace('t.id ASC', 't.id DESC') },
      { ...built, countSql: built.countSql + '; SELECT 1' },
    ])
      expect(() => createOrderingVariants(changed)).toThrow('QUERY_VARIANT_REJECTED');
  });

  it('detects order, microsecond cursor, raw SLA, body and total differences separately', () => {
    const row = {
      id: 'a',
      cursor_created_at: '2026-10-04 00:00:00.123456+00',
      remaining_seconds: '-1',
      sla_elapsed_now: '1201',
      body: 'synthetic',
    };
    const original = { rows: [row, { ...row, id: 'b' }], total: 3 };
    expect(compareQueryResults(original, structuredClone(original)).equal).toBe(true);
    expect(
      compareQueryResults(original, { ...original, rows: [...original.rows].reverse() }),
    ).toMatchObject({ equal: false, ids: false });
    expect(
      compareQueryResults(original, {
        ...original,
        rows: [{ ...row, cursor_created_at: '2026-10-04 00:00:00.123+00' }, original.rows[1]!],
      }),
    ).toMatchObject({ equal: false, ids: true, fullCursor: false });
    expect(
      compareQueryResults(original, {
        ...original,
        rows: [{ ...row, remaining_seconds: null }, original.rows[1]!],
      }),
    ).toMatchObject({ equal: false, rawSla: false });
    expect(
      compareQueryResults(original, {
        ...original,
        rows: [{ ...row, body: 'different' }, original.rows[1]!],
      }),
    ).toMatchObject({ equal: false, fullRows: false });
    expect(compareQueryResults(original, { ...original, total: 2 })).toMatchObject({
      equal: false,
      total: false,
    });
  });

  it('reports cancellation and driver failures without exposing exception details', async () => {
    const fixture: PerformanceFixture = {
      organizationId: 'synthetic-org',
      controlOrganizationId: 'synthetic-control',
      controlTicketId: 'synthetic-control-ticket',
      catalogItemId: 'synthetic-catalog',
      serviceRequestId: 'synthetic-request',
      actors: ['agent', 'requester'].map((role) => ({
        userId: role,
        email: 'synthetic@example.test',
        password: 'unused',
        role: role as 'agent' | 'requester',
        ticketId: 'unused',
        ticketSubject: 'unused',
      })),
      counts: {
        users: 120,
        tickets: 2400,
        usersByStatus: [],
        roles: [],
        states: [],
        priorities: [],
        assignment: [],
        groups: 2,
        memberships: 1,
        comments: 0,
        catalog: 1,
        approvals: 1,
        credentials: 12,
        readReceipts: 0,
        attachments: 0,
        controlUsers: 1,
        controlTickets: 1,
      },
    };
    let calls = 0;
    const runtime = {
      buildTicketListQuery: buildListQuery,
      async withAppReadOnly<T>(): Promise<T> {
        calls += 1;
        throw new Error('private driver params and password');
      },
    };
    const cancelled = await runQueryAnalysis({ runtime, fixture, signal: AbortSignal.abort() });
    expect(cancelled).toMatchObject({
      completed: false,
      equivalent: false,
      adoptedCandidate: false,
      failureCode: 'QUERY_ANALYSIS_ABORTED',
    });
    expect(calls).toBe(0);
    const failed = await runQueryAnalysis({ runtime, fixture });
    expect(failed).toMatchObject({
      completed: false,
      equivalent: false,
      adoptedCandidate: false,
      failureCode: 'QUERY_ANALYSIS_FAILED',
    });
    expect(calls).toBe(1);
    expect(JSON.stringify(failed)).not.toContain('private');
  });

  it('preserves result comparisons and earlier plans when a later EXPLAIN fails', async () => {
    const fixture: PerformanceFixture = {
      organizationId: 'synthetic-org',
      controlOrganizationId: 'synthetic-control',
      controlTicketId: 'synthetic-control-ticket',
      catalogItemId: 'synthetic-catalog',
      serviceRequestId: 'synthetic-request',
      actors: ['agent', 'requester'].map((role) => ({
        userId: role,
        email: 'synthetic@example.test',
        password: 'unused',
        role: role as 'agent' | 'requester',
        ticketId: 'unused',
        ticketSubject: 'unused',
      })),
      counts: {
        users: 120,
        tickets: 2400,
        usersByStatus: [],
        roles: [],
        states: [],
        priorities: [],
        assignment: [],
        groups: 2,
        memberships: 1,
        comments: 0,
        catalog: 1,
        approvals: 1,
        credentials: 12,
        readReceipts: 0,
        attachments: 0,
        controlUsers: 1,
        controlTickets: 1,
      },
    };
    const proof = sanitizeReadOnlyProof({
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
    });
    let explains = 0;
    const client: AnalysisClient = {
      proof,
      async query(sql) {
        if (sql.includes('FROM role_binding rb'))
          return {
            rows: [
              { user_id: 'agent', code: 'agent' },
              { user_id: 'requester', code: 'requester' },
            ],
          };
        if (sql.startsWith('SELECT id FROM assignment_group')) return { rows: [{ id: 'group' }] };
        if (sql.startsWith('EXPLAIN')) {
          explains += 1;
          if (explains === 2) throw new Error('private SQL parameters');
          return {
            rows: [
              {
                'QUERY PLAN': [
                  {
                    Plan: { 'Node Type': 'Limit', 'Actual Rows': 1 },
                    'Planning Time': 0.1,
                    'Execution Time': 2,
                  },
                ],
              },
            ],
          };
        }
        if (sql.startsWith('SELECT count')) return { rows: [{ total: 2400 }] };
        return {
          rows: [
            {
              id: 'ticket',
              organization_id: fixture.organizationId,
              requester_id: 'requester',
              cursor_created_at: '2026-10-04 00:00:00.123456+00',
              sla_elapsed_now: '1200',
              remaining_seconds: '60',
              response_target_minutes: 15,
              resolution_target_minutes: 21,
              sla_elapsed_seconds: 0,
              sla_clock_started_at: new Date('2026-10-04T00:00:00Z'),
            },
          ],
        };
      },
    };
    const runtime = {
      buildTicketListQuery: buildListQuery,
      async withAppReadOnly<T>(
        _context: { organizationId: string; actorId: string },
        callback: (value: AnalysisClient) => Promise<T>,
      ) {
        return callback(client);
      },
    };
    const report = await runQueryAnalysis({ runtime, fixture });
    expect(report).toMatchObject({
      completed: false,
      equivalent: false,
      adoptedCandidate: false,
      failureCode: 'QUERY_ANALYSIS_FAILED',
    });
    expect(report.cases).toHaveLength(1);
    expect(report.cases[0]).toMatchObject({
      name: 'staff-newest',
      completed: false,
      stage: 'legacy-count-explain',
      legacy: {
        rows: 1,
        total: 2400,
        listPlan: { plan: { nodeType: 'Limit', actualRows: 1 }, executionMs: 2 },
      },
      candidate: { rows: 1, total: 2400 },
      comparison: { equal: true },
    });
    expect(report.cases[0]?.legacy.countPlan).toBeUndefined();
    expect(report.cases[0]?.candidate.listPlan).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain('private');
  });
});
