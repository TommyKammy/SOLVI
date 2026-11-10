import type { AuthzContext } from '../../services/api/src/common/authz/authz.js';
import type {
  BuiltQuery,
  ListOptions,
} from '../../services/api/src/modules/ticket/ticket-query.js';
import type { PerformanceFixture } from './fixture.mjs';
import type {
  AnalysisRuntime,
  AnalysisClient,
  QueryResultData,
  QueryComparison,
  ReadOnlyProof,
  SanitizedExplain,
} from './list-query-analysis.mjs';
import type { SearchRuntime, SearchCase, SearchAnalysisReport } from './search-analysis.mjs';
import type { DeadlineDisplayPlan } from './deadline-analysis.mjs';

export interface SearchCostQuery extends BuiltQuery {
  combinedSql?: string;
}
export interface SearchCostRuntime extends AnalysisRuntime {
  buildTicketListQuery(ctx: AuthzContext, options: ListOptions): SearchCostQuery;
  buildLegacySearchWorkloadQuery(ctx: AuthzContext, options: ListOptions): BuiltQuery;
}
export interface ScanWork {
  nodeType: string;
  actualLoops: number;
  actualRows: number;
  returnedRows: number;
  visitedRows: number;
}
export interface SearchStatementWork {
  plan: SanitizedExplain;
  resources: {
    sharedHitBlocks: number;
    sharedReadBlocks: number;
    tempReadBlocks: number;
    tempWrittenBlocks: number;
  };
  searchScans: ScanWork[];
  predicateScanNodes: number;
  predicateScannedOnce: boolean;
  predicateRowsVisited: number;
  pageTicketLookups: Array<ScanWork & { uniqueIdLookup: boolean }>;
  pageTicketRows: number;
  pageTicketLookupsBounded: boolean;
  matchedProducers: ScanWork[];
  matchedReaders: ScanWork[];
  materializedOnce: boolean;
  matchedReused: boolean;
  limitBeforeDisplayJoins: boolean;
  userLookupsBounded: boolean;
  displayLookups: DeadlineDisplayPlan['displayLookups'];
}
export interface SearchCostStatement {
  kind: 'list' | 'count' | 'combined';
  completed: boolean;
  wallMs?: number;
  returnedRows?: number;
  work?: SearchStatementWork;
}
export interface SearchCostSample {
  mode?: 'separate' | 'combined';
  order?: Array<'list' | 'count' | 'combined'>;
  statements?: SearchCostStatement[];
  rows?: number;
  total?: number;
  completed?: boolean;
}
export interface SearchCostTerm {
  name: 'short' | 'wide' | 'rare' | 'zero';
  completed: boolean;
  proof?: ReadOnlyProof;
  samples: Array<{
    repetition: number;
    completed: boolean;
    order: Array<'legacy' | 'candidate'>;
    legacy: SearchCostSample;
    candidate: SearchCostSample;
    comparison?: QueryComparison;
    expectedPopulation?: boolean;
  }>;
}
export interface SearchCostAnalysisReport {
  completed: boolean;
  equivalent: boolean;
  cases: Array<
    Omit<SearchCase, 'candidate'> & {
      candidate: Omit<SearchCase['candidate'], 'countPlan'> & {
        referenceCountPlan?: SanitizedExplain;
      };
    }
  >;
  readOnlyContexts: Array<{ name: string; proof: ReadOnlyProof }>;
  unchangedSorts: SearchAnalysisReport['unchangedSorts'];
  diagnostics: SearchCostTerm[];
  semanticExecution?: {
    combinedExecutions: number;
    reusedTotals: number;
    referenceCountPlansAreSeparateDiagnostics: true;
  };
  semanticCompleted?: boolean;
  semanticFailureCode?: string;
  catalog?: {
    searchGinValid: boolean;
    textIlikeLeakproof: boolean;
    workMem: string;
    indexNonuseCauseEstablished: false;
  };
  optimization?: Record<string, boolean>;
  failureCode?: string;
  elapsedMs: number;
}
export function normalizeSearchCombinedRows(rows: unknown, limit: number): QueryResultData;
export function createSearchSemanticRuntime(
  runtime: SearchCostRuntime,
  fixture: PerformanceFixture,
  budget?: () => void,
): {
  runtime: SearchRuntime;
  stats: { combinedExecutions: number; reusedTotals: number };
};
export function summarizeSearchCostPlan(
  document: unknown,
  returnedRows: number,
): SearchStatementWork;
export function isUniqueTicketIdLookup(node: Record<string, unknown>): boolean;
export function measureSearchStatements(options: {
  client: Pick<AnalysisClient, 'query'>;
  built: SearchCostQuery;
  order: Array<'list' | 'count'>;
  sample: SearchCostSample;
  budget?: () => void;
  summarizePlan?: typeof summarizeSearchCostPlan;
}): Promise<QueryResultData>;
export function runSearchCostAnalysis(options: {
  runtime: SearchCostRuntime;
  fixture: PerformanceFixture;
  signal?: AbortSignal;
}): Promise<SearchCostAnalysisReport>;
