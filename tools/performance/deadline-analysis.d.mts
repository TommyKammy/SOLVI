import type { PerformanceFixture } from './fixture.mjs';
import type {
  AnalysisRuntime,
  ReadOnlyProof,
  QueryComparison,
  QueryResultData,
  SanitizedExplain,
} from './list-query-analysis.mjs';
import type { AuthzContext } from '../../services/api/src/common/authz/authz.js';
import type {
  BuiltQuery,
  ListOptions,
} from '../../services/api/src/modules/ticket/ticket-query.js';

export interface DeadlineRuntime extends AnalysisRuntime {
  buildLegacyTicketListQuery(context: AuthzContext, options: ListOptions): BuiltQuery;
}
export interface DeadlineContracts {
  countSql: boolean;
  countParams: boolean;
  params: boolean;
  limit: boolean;
}
export interface DeadlineDisplayPlan {
  plan: SanitizedExplain;
  displayLookups: Array<{
    alias: 'assignee' | 'requester' | 'assignee_group';
    scans: Array<{ nodeType: string; actualLoops: number; actualRows: number; totalRows: number }>;
    observed: boolean;
    totalLoops: number;
    totalRows: number;
  }>;
  boundedByReturnedRows: boolean;
  limitBeforeDisplayJoins: boolean;
  userLookupsBoundedByReturnedRows: boolean;
}
export interface DeadlineBoundary {
  tickets: Array<Record<string, unknown>>;
  policies: Array<Record<string, unknown>>;
  users: Array<Record<string, unknown>>;
  groups: Array<Record<string, unknown>>;
  expected: Array<{
    id: string;
    remainingSeconds: number | null;
    elapsed: number;
    requesterId: string;
    assigneeName: string | null;
    requesterName: string;
    groupName: string | null;
  }>;
}
export interface DeadlineCase {
  name: string;
  mode: 'actual-table' | 'synthetic-cte';
  rlsEvidence: boolean;
  stage: string;
  completed: boolean;
  proof?: ReadOnlyProof;
  contract?: DeadlineContracts;
  sqlChanged?: boolean;
  legacy: {
    rows?: number;
    total?: number;
    listPlan?: SanitizedExplain;
    countPlan?: SanitizedExplain;
    displayJoins?: DeadlineDisplayPlan;
  };
  candidate: {
    rows?: number;
    total?: number;
    listPlan?: SanitizedExplain;
    countPlan?: SanitizedExplain;
    displayJoins?: DeadlineDisplayPlan;
  };
  comparison?: QueryComparison & {
    organization: boolean;
    requester: boolean;
    expectedPopulation: boolean;
    boundary?: boolean;
  };
}
export interface DeadlineAnalysisReport {
  completed: boolean;
  equivalent: boolean;
  cases: DeadlineCase[];
  readOnlyContexts: Array<{ name: string; proof: ReadOnlyProof }>;
  unchangedSorts: Array<DeadlineContracts & { name: string; sql: boolean }>;
  cursorRejections: Array<{ direction: 'asc' | 'desc'; legacy: boolean; candidate: boolean }>;
  projection?: {
    sqlChanged: boolean;
    bounded: boolean;
    legacyBounded: boolean;
    limitBeforeDisplayJoins: boolean;
    userLookupsReduced: boolean;
    fiftyRowComparison: Array<{ name: string; legacyUserRows: number; candidateUserRows: number }>;
    confirmed: boolean;
  };
  elapsedMs: number;
  failureCode?: string;
}
export function compareDeadlineContracts(
  legacy: BuiltQuery,
  candidate: BuiltQuery,
): DeadlineContracts;
export function compareDeadlineResults(
  legacy: QueryResultData,
  candidate: QueryResultData,
): QueryComparison;
export function summarizeDeadlinePlan(document: unknown, returnedRows: number): DeadlineDisplayPlan;
export function validateDeadlineResult(
  rows: unknown,
  total: unknown,
  limit: number,
): QueryResultData;
export function prepareDeadlineBoundary(fixture: PerformanceFixture): DeadlineBoundary;
export function buildDeadlineBoundaryQuery(
  built: { sql: string; params: unknown[] },
  boundary: DeadlineBoundary,
): { sql: string; params: unknown[] };
export function checkDeadlineBoundary(
  result: QueryResultData,
  boundary: DeadlineBoundary,
  options: { direction: 'asc' | 'desc'; limit: number; requesterId?: string; empty?: boolean },
): boolean;
export function runDeadlineAnalysis(options: {
  runtime: DeadlineRuntime;
  fixture: PerformanceFixture;
  signal?: AbortSignal;
}): Promise<DeadlineAnalysisReport>;
