import type { PerformanceFixture } from './fixture.mjs';
import type { WorkloadProfile, RequestSample } from './workload.mjs';
import type { AnalysisRuntime, ReadOnlyProof } from './list-query-analysis.mjs';
import type {
  ComparisonRuntime,
  ComparisonPhase,
  ListComparisonReport,
  SessionVerification,
  DrainReport,
} from './list-load.mjs';

export type SearchTermKey = 'short' | 'wide' | 'rare' | 'zero';
export const MAX_SEARCH_CAPACITY_MS: 600000;
export const SEARCH_TERMS: ReadonlyArray<Readonly<{ key: SearchTermKey; keyword: string | null }>>;
export interface SearchCapacityRuntime extends ComparisonRuntime {
  withAppReadOnly: AnalysisRuntime['withAppReadOnly'];
}
export interface SearchCapacityStep {
  pass: 'ascending' | 'descending';
  count: number;
  term: SearchTermKey;
}
export interface SearchCapacityReport {
  completed: boolean;
  allRequestsSucceeded: boolean;
  apiContractValid: boolean;
  model: string;
  interpretation: string;
  loginCompleted: number;
  hardCapMs: number;
  phases: Array<Omit<ComparisonPhase, 'mode'> & SearchCapacityStep>;
  preflight: Array<{ term: SearchTermKey; sample: RequestSample; valid: boolean }>;
  schedule?: SearchCapacityStep[];
  scope?: string;
  plannedRequests?: number;
  bindingProof?: ReadOnlyProof;
  oracleProof?: ReadOnlyProof;
  searchContracts?: Array<{
    term: SearchTermKey;
    total: number;
    limit: 50;
    scope: 'organization';
    sort: string;
  }>;
  sessionVerification?: SessionVerification;
  apiProbes?: ListComparisonReport['apiProbes'];
  initialDrain?: DrainReport;
  failureCode?: string;
  elapsedMs: number;
}
export function searchCapacitySchedule(profile: WorkloadProfile): SearchCapacityStep[];
export function searchCapacityPath(keyword: string): string;
export function discoverSearchTerms(
  runtime: Pick<SearchCapacityRuntime, 'withAppReadOnly'>,
  fixture: PerformanceFixture,
  signal?: AbortSignal,
): Promise<{ terms: Array<{ key: SearchTermKey; keyword: string }>; proof: ReadOnlyProof }>;
export function runSearchCapacity(options: {
  runtime: SearchCapacityRuntime;
  fixture: PerformanceFixture;
  profile: WorkloadProfile;
  signal?: AbortSignal;
  onProgress?: (stage: string) => void | Promise<void>;
}): Promise<SearchCapacityReport>;
