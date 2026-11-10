import type { PerformanceFixture } from './fixture.mjs';
import type { AnalysisRuntime, QueryComparison, ReadOnlyProof } from './list-query-analysis.mjs';

export interface SearchIndexPlanNode {
  nodeType: string;
  indexName?: string;
  relationName?: string;
  cteName?: string;
  cteProducer?: string;
  relationship?: string;
  joinType?: string;
  scanDirection?: string;
  subplan?: string;
  plannedRows: number;
  startupCost: number;
  totalCost: number;
  actualRows?: number;
  actualLoops?: number;
  removedByFilter?: number;
  removedByIndexRecheck?: number;
  exactHeapBlocks?: number;
  lossyHeapBlocks?: number;
  children?: SearchIndexPlanNode[];
}
export interface SearchIndexScan {
  nodeType: string;
  indexName?: string;
  searchPredicate: boolean;
  loops?: number;
  returnedRows?: number;
  visitedRows?: number;
  removedByFilter?: number;
  removedByIndexRecheck?: number;
  exactHeapBlocks?: number;
  lossyHeapBlocks?: number;
}
export interface SearchIndexPlan {
  executed: boolean;
  plan: SearchIndexPlanNode;
  indexes: string[];
  searchGinPlanned: boolean;
  searchGinExecuted: boolean | null;
  ticketScans: SearchIndexScan[];
  eligibilityEstablished: false;
  planningMs?: number;
  executionMs?: number;
  rootBuffers?: Record<string, number>;
}
export type SearchIndexSettings = Record<
  'seqscan' | 'indexscan' | 'bitmapscan' | 'jit' | 'row_security',
  'on' | 'off'
>;
export interface SearchIndexSemanticCase {
  name: string;
  completed: boolean;
  proof?: ReadOnlyProof;
  binding?: { listSha256: string; countSha256: string; combinedSha256: string };
  comparison?: QueryComparison;
  rows?: number;
  total?: number;
  organization?: boolean;
  requester?: boolean;
  expectedPopulation?: boolean;
}
export interface SearchIndexCondition extends SearchIndexSemanticCase {
  normal: Partial<Record<'count' | 'combined', SearchIndexPlan>>;
  discouragedSequentialScan: Partial<Record<'count' | 'combined', SearchIndexPlan>>;
  setting: {
    before?: SearchIndexSettings;
    during?: SearchIndexSettings;
    after?: SearchIndexSettings;
    restored: boolean;
  };
  failureCode?: string;
}
export interface SearchIndexReport {
  completed: boolean;
  equivalent: boolean;
  protocolCompleted: boolean;
  catalogComplete: boolean;
  restorationVerified: boolean;
  adoptionEstablished: false;
  interpretation: string;
  conditions: SearchIndexCondition[];
  boundaries: SearchIndexSemanticCase[];
  equalityControls: Array<{
    name: string;
    completed: boolean;
    rows?: number;
    plan?: SearchIndexPlan;
  }>;
  catalog: Partial<
    Record<'environment' | 'index' | 'operator', Record<string, string | number | boolean | null>>
  >;
  readOnlyContexts: Array<{ name: string; proof: ReadOnlyProof; autocloseDisabled?: true }>;
  hardCapMs: 360000;
  elapsedMs: number;
  failureCode?: string;
}
export function sanitizeSearchIndexCatalog(
  kind: 'environment' | 'index' | 'operator',
  rows: unknown,
): Record<string, string | number | boolean | null>;
export function summarizeSearchIndexPlan(document: unknown, executed: boolean): SearchIndexPlan;
export function analyzeSearchIndex(
  runtime: AnalysisRuntime,
  fixture: PerformanceFixture,
  options?: {
    signal?: AbortSignal;
    onProgress?: (stage: string) => void | Promise<void>;
  },
): Promise<SearchIndexReport>;
