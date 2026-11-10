import type { PerformanceFixture } from './fixture.mjs';
import type { AuthzContext } from '../../services/api/src/common/authz/authz.js';
import type {
  BuiltQuery,
  ListOptions,
} from '../../services/api/src/modules/ticket/ticket-query.js';

export interface SanitizedPlanNode {
  nodeType: string;
  indexName?: string;
  plannedRows?: number;
  actualRows?: number;
  actualLoops?: number;
  actualStartupMs?: number;
  actualTotalMs?: number;
  rowsRemovedByFilter?: number;
  rowsRemovedByJoinFilter?: number;
  sharedHitBlocks?: number;
  sharedReadBlocks?: number;
  sharedDirtiedBlocks?: number;
  sharedWrittenBlocks?: number;
  tempReadBlocks?: number;
  tempWrittenBlocks?: number;
  sortSpaceKb?: number;
  children?: SanitizedPlanNode[];
}
export interface SanitizedExplain {
  plan: SanitizedPlanNode;
  planningMs: number;
  executionMs: number;
}
export interface QueryResultData {
  rows: Record<string, unknown>[];
  total: number;
}
export interface QueryComparison {
  equal: boolean;
  ids: boolean;
  fullCursor: boolean;
  rawSla: boolean;
  total: boolean;
  fullRows: boolean;
}
export interface AnalysisCase {
  name: string;
  completed: boolean;
  stage:
    | 'context'
    | 'results'
    | 'legacy-list-explain'
    | 'legacy-count-explain'
    | 'candidate-list-explain'
    | 'candidate-count-explain'
    | 'boundary'
    | 'complete';
  legacy: {
    rows?: number;
    total?: number;
    listPlan?: SanitizedExplain;
    countPlan?: SanitizedExplain;
  };
  candidate: {
    rows?: number;
    total?: number;
    listPlan?: SanitizedExplain;
    countPlan?: SanitizedExplain;
  };
  comparison?: QueryComparison & {
    organization: boolean;
    requester: boolean;
    expectedPopulation: boolean;
    nullPlacement?: boolean;
  };
  nullPlacement?: {
    nullRows: number;
    nonNullRows: number;
    wholePopulation: boolean;
    nullsLast: boolean;
  };
}
export interface QueryAnalysisReport {
  completed: boolean;
  equivalent: boolean;
  adoptedCandidate: boolean;
  cases: AnalysisCase[];
  readOnlyContexts: Array<{ name: string; proof: ReadOnlyProof }>;
  writeProbe?: { readOnlyWriteRejected: true; sqlState: '25006' };
  elapsedMs: number;
  failureCode?: string;
  boundary?: QueryComparison & { nonempty: boolean; disjoint: boolean; totalStable: boolean };
  hypothesis?: {
    confirmed: boolean;
    reason: 'ORDERING_INDEX_PLAN_CONFIRMED' | 'ORDERING_INDEX_PLAN_NOT_CONFIRMED';
    legacyNewestSortNodes: number;
    candidateNewestSortNodes: number;
    legacyNewestIndexScan: boolean;
    candidateNewestIndexScan: boolean;
  };
}
export interface AnalysisClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  proof: ReadOnlyProof;
}
export interface ReadOnlyProof {
  role: 'solvi_app';
  superuser: false;
  bypassRls: false;
  ownsTables: false;
  readOnly: true;
  isolationLevel: 'repeatable read';
  rowSecurity: true;
  ticketRlsActive: true;
  ticketRlsForced: true;
  transactionLocalContext: true;
  statementTimeoutMs: 30000;
  queryTimeoutMs: 35000;
  readOnlyWriteRejected: true;
  readOnlyWriteSqlState: '25006';
}
export interface AnalysisRuntime {
  withAppReadOnly<T>(
    context: { organizationId: string; actorId: string },
    callback: (client: AnalysisClient) => Promise<T>,
  ): Promise<T>;
  buildTicketListQuery(ctx: AuthzContext, options: ListOptions): BuiltQuery;
}
export function sanitizeExplain(document: unknown): SanitizedExplain;
export function sanitizeReadOnlyProof(proof: unknown): ReadOnlyProof;
export function createOrderingVariants(built: BuiltQuery): {
  legacy: BuiltQuery;
  candidate: BuiltQuery;
  changed: boolean;
};
export function compareQueryResults(
  legacy: QueryResultData,
  candidate: QueryResultData,
): QueryComparison;
export function runQueryAnalysis(options: {
  runtime: AnalysisRuntime;
  fixture: PerformanceFixture;
  signal?: AbortSignal;
}): Promise<QueryAnalysisReport>;
