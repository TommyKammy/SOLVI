import type { AuthzContext } from '../../services/api/src/common/authz/authz.js';
import type {
  BuiltQuery,
  ListOptions,
} from '../../services/api/src/modules/ticket/ticket-query.js';
import type { PerformanceFixture } from './fixture.mjs';
import type {
  AnalysisRuntime,
  QueryResultData,
  QueryComparison,
  ReadOnlyProof,
  SanitizedExplain,
} from './list-query-analysis.mjs';
import type {
  DeadlineBoundary,
  DeadlineContracts,
  DeadlineDisplayPlan,
} from './deadline-analysis.mjs';

export const SEARCH_KEYWORD: string;
export interface SearchRuntime extends AnalysisRuntime {
  buildLegacySearchQuery(context: AuthzContext, options: ListOptions): BuiltQuery;
}
export interface SearchBoundary extends Omit<DeadlineBoundary, 'expected'> {
  expected: Array<
    Omit<DeadlineBoundary['expected'][number], 'requesterName'> & { requesterName: string | null }
  >;
}
export interface SearchCaseSide {
  rows?: number;
  total?: number;
  listPlan?: SanitizedExplain;
  countPlan?: SanitizedExplain;
  displayJoins?: DeadlineDisplayPlan;
}
export interface SearchCase {
  name: string;
  mode: 'actual-table' | 'synthetic-cte';
  rlsEvidence: boolean;
  completed: boolean;
  stage: string;
  proof?: ReadOnlyProof;
  contract?: DeadlineContracts;
  sqlChanged?: boolean;
  legacy: SearchCaseSide;
  candidate: SearchCaseSide;
  comparison?: QueryComparison & {
    organization: boolean;
    requester: boolean;
    expectedPopulation: boolean;
    boundary: boolean;
  };
  pagination?: {
    next?: Record<string, boolean>;
    lastAnchor?: Record<string, boolean>;
    terminal?: Record<string, boolean>;
  };
}
export interface SearchAnalysisReport {
  completed: boolean;
  equivalent: boolean;
  cases: SearchCase[];
  readOnlyContexts: Array<{ name: string; proof: ReadOnlyProof }>;
  unchangedSorts: Array<DeadlineContracts & { name: string; sql: boolean }>;
  optimization?: {
    comparisons: Array<{
      name: string;
      legacyUserRows: number;
      candidateUserRows: number;
      legacyListMs: number;
      candidateListMs: number;
      legacyCountMs: number;
      candidateCountMs: number;
    }>;
    sqlChanged: boolean;
    limitBeforeDisplayJoins: boolean;
    userLookupsBounded: boolean;
    userLookupsReduced: boolean;
    confirmed: boolean;
  };
  elapsedMs: number;
  failureCode?: string;
}
export function compareSearchContracts(
  legacy: BuiltQuery,
  candidate: BuiltQuery,
): DeadlineContracts;
export function compareSearchResults(
  legacy: QueryResultData,
  candidate: QueryResultData,
): QueryComparison;
export function summarizeSearchPlan(document: unknown, returnedRows: number): DeadlineDisplayPlan;
export function prepareSearchBoundary(fixture: PerformanceFixture): SearchBoundary;
export function checkSearchBoundary(
  result: QueryResultData,
  boundary: SearchBoundary,
  options: {
    keyword?: string;
    direction: 'asc' | 'desc';
    limit: number;
    requesterId?: string;
    cursorId?: string;
  },
): boolean;
export function runSearchAnalysis(options: {
  runtime: SearchRuntime;
  fixture: PerformanceFixture;
  signal?: AbortSignal;
}): Promise<SearchAnalysisReport>;
