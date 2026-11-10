import { describe, expect, it } from 'vitest';
import type { OrganizationMember } from '../../services/api/src/modules/auth/user-admin.service.js';
import type { PerformanceFixture } from '../../tools/performance/fixture.mjs';
import type {
  AnalysisClient,
  ReadOnlyProof,
} from '../../tools/performance/list-query-analysis.mjs';
import {
  canonicalDirectoryMembers,
  compareDirectoryMembers,
  runDirectoryAnalysis,
  summarizeDirectoryPlans,
  type DirectoryRuntime,
} from '../../tools/performance/directory-analysis.mjs';

const id = (n: number) => `04500000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const org = id(1),
  control = id(2),
  admin = id(3),
  controlAdmin = id(4);
const member = (n: number, displayName = 'PRIVATE-NAME'): OrganizationMember => ({
  userId: id(n),
  displayName,
  email: 'PRIVATE-EMAIL',
  status: 'active',
  deactivatedAt: null,
  roleCodes: ['org_admin', 'requester'],
  temporaryRoles: [],
  openTicketCount: 2,
});
const fixture = {
  organizationId: org,
  controlOrganizationId: control,
  actors: [{ role: 'admin', userId: admin }],
  counts: { users: 2, controlUsers: 1 },
} as PerformanceFixture;
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
const rawPlan = (loops = 1) => [
  {
    Plan: {
      'Node Type': 'Aggregate',
      'Actual Loops': loops,
      'Shared Hit Blocks': 10,
      Filter: 'PRIVATE-SQL-PREDICATE',
      Plans: [
        {
          'Node Type': 'Seq Scan',
          'Actual Loops': 1,
          'Actual Rows': 2,
          'Shared Hit Blocks': 10,
          'Relation Name': 'private-table',
        },
      ],
    },
    'Execution Time': 3,
    'Planning Time': 1,
  },
];

function fakeRuntime(
  options: {
    before?: boolean;
    badProof?: boolean;
    badRls?: boolean;
    wrongCount?: boolean;
    failLater?: boolean;
    failBulkPlan?: boolean;
    error?: string;
    badBinding?: boolean;
  } = {},
): DirectoryRuntime {
  const contexts = new WeakMap<object, string>();
  const rows = (organization: string) =>
    organization === org
      ? [member(3, 'A'), member(5, 'B')]
      : organization === control
        ? [member(4)]
        : [];
  return {
    async withAppReadOnly(context, callback) {
      const client: AnalysisClient = {
        proof: options.badProof
          ? ({ ...proof, readOnly: false } as unknown as ReadOnlyProof)
          : proof,
        async query(sql, params = []) {
          if (options.error) throw new Error(options.error);
          if (sql.includes('row_security_active'))
            return {
              rows: [
                {
                  users_active: !options.badRls,
                  bindings_active: true,
                  users_forced: true,
                  bindings_forced: true,
                },
              ],
            };
          if (sql.includes('SELECT rb.user_id'))
            return {
              rows: [
                {
                  user_id: context.organizationId === org ? admin : controlAdmin,
                  organization_id: context.organizationId,
                  code: 'org_admin',
                  status: options.badBinding ? 'deactivated' : 'active',
                  valid_from: new Date(0),
                  valid_until: null,
                },
              ],
            };
          if (sql.includes('SELECT DISTINCT u.id'))
            return {
              rows: (params[0] === context.organizationId ? rows(context.organizationId) : []).map(
                (r) => ({ id: r.userId }),
              ),
            };
          if (sql.startsWith('EXPLAIN')) {
            if (options.failLater && context.organizationId === control)
              throw new Error('PRIVATE-DRIVER-ERROR');
            if (options.failBulkPlan && sql.endsWith('SELECT bulk'))
              throw new Error('PRIVATE-BULK-DRIVER-ERROR');
            return { rows: [{ 'QUERY PLAN': rawPlan(sql.includes('legacy') ? 4000 : 1) }] };
          }
          throw new Error('unexpected fake query');
        },
      };
      contexts.set(client, context.organizationId);
      try {
        return await callback(client);
      } finally {
        contexts.delete(client);
      }
    },
    async readDirectoryMembers(variant, client, context) {
      const result =
        contexts.get(client) === context.organizationId ? rows(context.organizationId) : [];
      if (options.wrongCount && variant === 'candidate' && result[0])
        result[0].openTicketCount += 1;
      return {
        members: result,
        queries: [
          { sql: `SELECT ${options.before ? 'legacy' : variant}`, params: ['PRIVATE-PARAM'] },
          ...(variant === 'candidate' && !options.before && result.length
            ? [{ sql: 'SELECT bulk', params: [result.map((r) => r.userId)] }]
            : []),
        ],
      };
    },
  };
}

describe('private directory comparison and plan evidence', () => {
  it('normalizes only role-set ordering and equal-key row ties while preserving every field', () => {
    const first = member(3),
      second = member(5);
    first.temporaryRoles = [
      {
        roleCode: 'requester',
        validUntil: '2027-01-01T00:00:00.000Z',
        daysRemaining: 88,
        expiringSoon: false,
      },
      {
        roleCode: 'org_admin',
        validUntil: '2027-01-01T00:00:00.000Z',
        daysRemaining: 88,
        expiringSoon: false,
      },
    ];
    const candidate = structuredClone([second, first]);
    candidate[1]!.roleCodes.reverse();
    candidate[1]!.temporaryRoles.reverse();
    expect(compareDirectoryMembers([first, second], candidate).equal).toBe(true);
    candidate[1]!.email = 'different';
    expect(compareDirectoryMembers([first, second], candidate).fullFields).toBe(false);
    expect(
      compareDirectoryMembers([member(3, 'A'), member(5, 'B')], [member(5, 'B'), member(3, 'A')])
        .idsAndOrder,
    ).toBe(false);
  });
  it('does not normalize away wrong counts, status, absent fields, duplicate IDs or timestamp types', () => {
    const one = member(3),
      other = { ...one, openTicketCount: 0 };
    expect(compareDirectoryMembers([one], [other]).equal).toBe(false);
    expect(() => canonicalDirectoryMembers([one, one])).toThrow('DIRECTORY_ROWS_INVALID');
    for (const altered of [
      { ...one, openTicketCount: -1 },
      { ...one, openTicketCount: '2' },
      { ...one, extra: 'unexpected' },
      { ...one, deactivatedAt: '2026-10-05T00:00:00Z' },
    ])
      expect(() => canonicalDirectoryMembers([altered as OrganizationMember])).toThrow(
        'DIRECTORY_ROWS_INVALID',
      );
  });
  it('sums separate statement time and root buffers without leaking plan conditions', () => {
    const work = summarizeDirectoryPlans([rawPlan(4000), rawPlan(1)]);
    expect(work).toMatchObject({
      queryCount: 2,
      executionMs: 6,
      planningMs: 2,
      rootSharedHits: 20,
      aggregateLoops: 4001,
      scanRowVisits: 4,
    });
    expect(JSON.stringify(work)).not.toContain('PRIVATE');
    expect(JSON.stringify(work)).not.toContain('private-table');
    expect(() => summarizeDirectoryPlans([])).toThrow('DIRECTORY_PLAN_INVALID');
  });
  it('compares four actual contexts, captures strict directory RLS proof and keeps security boundary claims separate', async () => {
    const result = await runDirectoryAnalysis({ runtime: fakeRuntime(), fixture });
    expect(result).toMatchObject({
      completed: true,
      equivalent: true,
      optimization: { legacyQueries: 1, candidateQueries: 2, bulkObserved: true },
    });
    expect(result.cases).toHaveLength(4);
    expect(result.readOnlyContexts).toHaveLength(5);
    expect(
      result.cases
        .slice(2)
        .every((c) => c.defenseProbe && c.legacy.rows === 0 && c.candidate.rows === 0),
    ).toBe(true);
    expect(result.coverage.separateSecurityTests).toContain('deactivation-rollback');
    const text = JSON.stringify(result);
    for (const secret of ['PRIVATE', org, control, admin, 'SELECT legacy', 'SELECT bulk'])
      expect(text).not.toContain(secret);
  });
  it('accepts unchanged before SQL without claiming a bulk optimization', async () => {
    const result = await runDirectoryAnalysis({ runtime: fakeRuntime({ before: true }), fixture });
    expect(result.completed).toBe(true);
    expect(result.equivalent).toBe(true);
    expect(result.optimization?.bulkObserved).toBe(false);
  });
  it('keeps completed collection distinct from unequal DTOs', async () => {
    const result = await runDirectoryAnalysis({
      runtime: fakeRuntime({ wrongCount: true }),
      fixture,
    });
    expect(result.completed).toBe(true);
    expect(result.equivalent).toBe(false);
    expect(result.cases[0]!.comparison?.fullFields).toBe(false);
  });
  it('preserves earlier comparisons and stage when a later EXPLAIN fails without raw errors', async () => {
    const result = await runDirectoryAnalysis({
      runtime: fakeRuntime({ failLater: true }),
      fixture,
    });
    expect(result.completed).toBe(false);
    expect(result.cases[0]!.completed).toBe(true);
    expect(result.cases[1]).toMatchObject({ stage: 'legacy-plans', completed: false });
    expect(result.failureCode).toBe('DIRECTORY_ANALYSIS_FAILED');
    expect(JSON.stringify(result)).not.toContain('PRIVATE-DRIVER');
  });
  it('retains the first candidate plan when its second statement fails', async () => {
    const result = await runDirectoryAnalysis({
      runtime: fakeRuntime({ failBulkPlan: true }),
      fixture,
    });
    expect(result.completed).toBe(false);
    expect(result.equivalent).toBe(false);
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0]).toMatchObject({
      stage: 'candidate-plans',
      completed: false,
      comparison: { equal: true },
      legacy: { queryCount: 1, work: { queryCount: 1, executionMs: 3 } },
      candidate: { queryCount: 2, work: { queryCount: 1, executionMs: 3 } },
    });
    expect(result.cases[0]!.candidate.work!.plans).toHaveLength(1);
    expect(result.failureCode).toBe('DIRECTORY_ANALYSIS_FAILED');
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|private-table|SELECT/);
  });
  it.each([{ badProof: true }, { badRls: true }, { badBinding: true }])(
    'fails closed for invalid proof/binding %j',
    async (options) => {
      const result = await runDirectoryAnalysis({ runtime: fakeRuntime(options), fixture });
      expect(result.completed).toBe(false);
      expect(result.equivalent).toBe(false);
    },
  );
  it('refuses cancellation and missing expected population rather than a vacuous all-pass', async () => {
    const controller = new AbortController();
    controller.abort();
    const stopped = await runDirectoryAnalysis({
      runtime: fakeRuntime(),
      fixture,
      signal: controller.signal,
    });
    expect(stopped.failureCode).toBe('DIRECTORY_ANALYSIS_ABORTED');
    const missing = await runDirectoryAnalysis({
      runtime: fakeRuntime(),
      fixture: { ...fixture, counts: { ...fixture.counts, users: 0 } },
    });
    expect(missing.failureCode).toBe('DIRECTORY_POPULATION_INVALID');
  });
  it('never exposes even an uppercase error disguised as a diagnostic code', async () => {
    const result = await runDirectoryAnalysis({
      runtime: fakeRuntime({ error: 'DIRECTORY_PRIVATE_SECRET' }),
      fixture,
    });
    expect(result.failureCode).toBe('DIRECTORY_ANALYSIS_FAILED');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SECRET');
  });
});
