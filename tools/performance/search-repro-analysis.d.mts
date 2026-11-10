import type { AuthzContext } from '../../services/api/src/common/authz/authz.js';
import type { ListOptions } from '../../services/api/src/modules/ticket/ticket-query.js';
import type { PerformanceFixture } from './fixture.mjs';
import type { AnalysisRuntime, ReadOnlyProof, QueryComparison } from './list-query-analysis.mjs';
import type { SearchCostQuery } from './search-cost-analysis.mjs';

export type ReproCondition = 'rare' | 'zero' | 'rare-state' | 'zero-new' | 'short-new';
export type ReproPhase = 'plain' | 'explain-off' | 'explain-on';
export type ReproSide = 'A' | 'B';
export type ReproOrder = 'AB' | 'BA';
export type ReproParamType =
  | 'null'
  | 'date'
  | 'string'
  | 'number'
  | 'boolean'
  | 'undefined'
  | { type: 'array'; items: ReproParamType[] };
export interface ReproSchedule {
  conditions: ReproCondition[];
  phases: ReproPhase[];
  warmupPairs: 2;
  measuredPairs: Record<ReproPhase, number>;
  orders: ReproOrder[];
}
export interface ReproCpuCounters {
  usage_usec: number;
  user_usec: number;
  system_usec: number;
  nr_periods: number | null;
  nr_throttled: number | null;
  throttled_usec: number | null;
}
export interface ReproIoCounters {
  rbytes: number;
  wbytes: number;
  rios: number;
  wios: number;
}
export type ReproResourceSnapshot =
  | {
      available: true;
      source: 'cgroup-v2';
      capturedAt: string;
      durationMs: number;
      cpu: ReproCpuCounters;
      io: ReproIoCounters;
      devices: number;
    }
  | { available: false; reason: string; capturedAt: string; durationMs: number };
export interface ReproResourceDelta {
  available: boolean;
  reason?:
    'RESOURCE_UNAVAILABLE' | 'COUNTER_REGRESSION' | 'DEVICE_SET_CHANGED' | 'COUNTER_UNAVAILABLE';
  elapsedMs?: number | null;
  cpu?: { [K in keyof ReproCpuCounters]: number | null };
  io?: { [K in keyof ReproIoCounters]: number | null };
}
export interface SearchReproRuntime extends AnalysisRuntime {
  buildLegacySearch048Query(ctx: AuthzContext, options: ListOptions): SearchCostQuery;
  buildLegacySearch049Query(ctx: AuthzContext, options: ListOptions): SearchCostQuery;
  buildTicketListQuery(ctx: AuthzContext, options: ListOptions): SearchCostQuery;
  readDatabaseResources(): Promise<ReproResourceSnapshot>;
}
export interface ReproBinding {
  aSqlSha256: string;
  bSqlSha256: string;
  sqlIdentical: boolean;
  typedParamsEqual: boolean;
  paramTypes: ReproParamType[];
  currentMatchesFixed049: boolean;
  negativeControl: boolean;
}
export interface ReproStructure {
  nodeType: string;
  indexName?: string;
  relationName?: string;
  cteName?: string;
  joinType?: string;
  relationship?: string;
  scanDirection?: string;
  strategy?: string;
  cteProducer?: string;
  subplan?: 'InitPlan' | 'SubPlan';
  children?: ReproStructure[];
}
export interface ReproScanWork {
  scans: number;
  loops: number;
  returnedRows: number;
  visitedRows: number;
  removedRows: number;
}
export interface ReproPlanWork {
  branch: 'prefix' | 'fallback';
  rootBuffers: Record<string, number>;
  probe: ReproScanWork;
  evaluation: ReproScanWork;
  matched: ReproScanWork;
  count: ReproScanWork;
  page: ReproScanWork;
  probeRows: number;
  matchedLoops: number;
  directCountLoops: number;
  stateIndexProbe: boolean;
  pageLookupsBounded: boolean;
}
export interface ReproStatementSample {
  wallMs: number;
  rows?: number;
  total?: number;
  executionMs?: number;
  planningMs?: number;
  structureSha256?: string;
  work?: ReproPlanWork;
}
export interface ReproPair {
  pair: number;
  order: ReproOrder;
  completed: boolean;
  verification: 'native-result' | 'phase-oracle-and-plan';
  A?: ReproStatementSample;
  B?: ReproStatementSample;
  comparison?: QueryComparison;
  stableSnapshot?: boolean;
}
export interface ReproDistribution {
  count: number;
  mean: number;
  median: number;
  min: number;
  max: number;
}
export interface ReproPairSummary {
  A: ReproDistribution;
  B: ReproDistribution;
  pairedDeltaMs: ReproDistribution;
  pairedRatio: ReproDistribution | null;
  ratioUnavailable: number;
  ratioOfMeans: number | null;
  overFivePercent: number;
}
export interface ReproSummary {
  metric: 'client-wall-ms' | 'statement-execution-ms';
  all: ReproPairSummary;
  AB: ReproPairSummary | null;
  BA: ReproPairSummary | null;
}
export interface ReproPhaseReport {
  name: ReproPhase;
  completed: boolean;
  warmup: ReproPair[];
  samples: ReproPair[];
  oracle?: {
    comparison: QueryComparison;
    order: ReproOrder;
    excludedFromMeasurement: true;
    stableSnapshot: boolean;
    expectedPopulation: boolean;
    rows: number;
    total: number;
  };
  summary?: ReproSummary;
}
export interface ReproConditionReport {
  name: ReproCondition;
  completed: boolean;
  phases: ReproPhaseReport[];
  proof?: ReadOnlyProof;
  binding?: ReproBinding;
}
export interface ReproResourceWindow {
  condition: ReproCondition;
  phase: ReproPhase;
  completed: boolean;
  before?: ReproResourceSnapshot;
  after?: ReproResourceSnapshot;
  delta?: ReproResourceDelta;
  measurementWallMs?: number;
}
export interface SearchReproReport {
  completed: boolean;
  equivalent: boolean;
  protocolCompleted: boolean;
  replica?: 1 | 2;
  conditions: ReproConditionReport[];
  readOnlyContexts: Array<{ name: string; proof: ReadOnlyProof }>;
  structures: Record<string, ReproStructure>;
  summary: Array<{
    condition: ReproCondition;
    phases: Array<{ phase: ReproPhase } & ReproSummary>;
  }>;
  adoptionEstablished: false;
  resourceObservations: { complete: boolean; expectedWindows: 15; windows: ReproResourceWindow[] };
  hardCapMs: 360000;
  interpretation: string;
  schedule?: ReproSchedule;
  failureCode?: string;
  elapsedMs: number;
}
export function searchReproSchedule(replica: 1 | 2): ReproSchedule;
export function searchReproBinding(
  a: SearchCostQuery,
  b: SearchCostQuery,
  current: SearchCostQuery,
  negativeControl: boolean,
): ReproBinding;
export function summarizeSearchReproPlan(
  document: unknown,
  returnedRows: number,
): {
  structure: ReproStructure;
  structureSha256: string;
  planningMs: number;
  executionMs: number;
  work: ReproPlanWork;
};
export function sanitizeSearchReproResources(value: unknown): ReproResourceSnapshot;
export function searchReproResourceDelta(
  before: ReproResourceSnapshot,
  after: ReproResourceSnapshot,
): ReproResourceDelta;
export function summarizeSearchReproPairs(samples: ReproPair[], phase: ReproPhase): ReproSummary;
export function analyzeSearchRepro(
  runtime: SearchReproRuntime,
  fixture: PerformanceFixture,
  options: {
    replica: 1 | 2;
    signal?: AbortSignal;
    onProgress?: (stage: string) => void | Promise<void>;
  },
): Promise<SearchReproReport>;
