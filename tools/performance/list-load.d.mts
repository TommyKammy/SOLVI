import type { FixtureActor, PerformanceFixture } from './fixture.mjs';
import type { RequestSample, SampleSummary, WorkloadProfile } from './workload.mjs';

export interface Histogram {
  count: number;
  sumMs: number;
  buckets: Array<{ le: string; count: number }>;
}
export interface PoolConnections {
  total: number;
  idle: number;
  waiting: number;
  inUse: number;
}
export interface PoolSnapshot {
  valid: boolean;
  acquisitions: Record<'success' | 'failure', Histogram>;
  connections: PoolConnections;
}
export interface PoolDelta {
  valid: boolean;
  success: Histogram;
  failure: Histogram;
}
export function scrapePool(base: string, signal: AbortSignal): Promise<PoolSnapshot>;
export function drain(
  runtime: { metricsBase: string },
  signal: AbortSignal,
): Promise<{ drained: boolean; waitedMs: number; snapshot?: PoolSnapshot }>;
export interface QueryClient {
  query(config: {
    text: string;
    values: unknown[];
    query_timeout: number;
  }): Promise<{ rows: Record<string, unknown>[] }>;
}
export interface ComparisonRuntime {
  apiBase: string;
  metricsBase: string;
  admin: QueryClient;
}
export interface SessionVerification {
  expected: number;
  sessions: number;
  distinctSessions: number;
  principals: number;
  activeMatching: number;
  verified: boolean;
}
export interface BurstReport extends SampleSummary {
  planned: number;
  sent: number;
  completed: number;
  unsent: number;
  unfinished: number;
  maxInFlight: number;
  inFlight: number;
  statusCounts: Record<string, number>;
  /** Includes HTTP/DTO/transport failures, timeouts and aborted requests. */
  unsuccessful: number;
  timing: Array<{
    index: number;
    plannedAtMs: number;
    sentAtMs: number;
    latenessMs: number;
    completedAtMs: number | null;
  }>;
  latenessMs: { p50: number | null; p95: number | null; max: number | null };
}
export interface GaugeSample {
  atMs: number;
  connections: PoolConnections;
}
export interface DrainReport {
  drained: boolean;
  waitedMs: number;
  snapshot?: PoolSnapshot | GaugeSample;
}
export interface ObservationReport {
  poolIntervalMs: 250;
  databaseIntervalMs: 500;
  pool: GaugeSample[];
  database: Array<{
    atMs: number;
    connections: number;
    active: number;
    idleInTransaction: number;
    lockWaiting: number;
  }>;
  poolErrors: number;
  databaseErrors: number;
}
export function observePhase(
  runtime: ComparisonRuntime,
  signal: AbortSignal,
  start: number,
): Promise<{ pool: GaugeSample[]; stop(): Promise<ObservationReport> }>;
export interface ComparisonPhase {
  index: number;
  mode: 'A' | 'B';
  sessionCount: number;
  startedAt: string;
  finishedAt?: string;
  observationValid: boolean;
  failureCode?: string;
  poolBefore?: PoolSnapshot;
  poolAfter?: PoolSnapshot;
  poolDelta?: PoolDelta;
  burst?: BurstReport;
  drain?: DrainReport;
  observations?: ObservationReport;
}
export interface ListComparisonReport {
  comparisonCompleted: boolean;
  allRequestsSucceeded: boolean;
  model: string;
  interpretation: string;
  loginCompleted: number;
  phases: ComparisonPhase[];
  principal?: { role: 'agent'; count: 1; organizationCount: 1 };
  route?: { key: string; path: string };
  schedule?: Array<'A' | 'B'>;
  requestsPerPhase?: number;
  plannedArrivalOffsetsMs?: number[];
  hardCapMs?: number;
  sessionVerification?: SessionVerification;
  initialDrain?: DrainReport;
  failureCode?: string;
  deadlineContract?: {
    limit: 50;
    sort: string;
    states: string[];
    scope: 'organization';
    total: number;
    clock: string;
  };
  searchContract?: {
    keyword: string;
    limit: 50;
    sort: string;
    scope: 'organization';
    total: number;
    oracle: string;
    clock: string;
  };
  apiContractValid?: boolean;
  apiProbes?: {
    completed: boolean;
    valid: boolean;
    failureCode?: string;
    cases: Array<{ key: string; expectedStatus: number; valid: boolean; sample: RequestSample }>;
  };
  probeDrain?: DrainReport;
}
export const MAX_COMPARISON_MS: number;
export const DEADLINE_LIST_PATH: string;
export const SEARCH_KEYWORD: string;
export const SEARCH_LIST_PATH: string;
export function verifySearchApiContract(
  runtime: ComparisonRuntime,
  fixture: PerformanceFixture,
  profile: WorkloadProfile,
  cookie: string,
  signal: AbortSignal,
): Promise<NonNullable<ListComparisonReport['apiProbes']>>;
export interface SearchStateApiReport {
  completed: boolean;
  valid: boolean;
  capacityMeasured: false;
  population?: {
    organizationState: number;
    requesterState: number;
    multiState: number;
    empty: number;
  };
  cases: NonNullable<ListComparisonReport['apiProbes']>['cases'];
  drain?: DrainReport;
  failureCode?: string;
}
export function runSearchStateApiContract(options: {
  runtime: ComparisonRuntime & { meta: { workPackage: string } };
  fixture: PerformanceFixture;
  profile: WorkloadProfile;
  signal?: AbortSignal;
}): Promise<SearchStateApiReport>;
export function validateSearchResponse(
  data: unknown,
  expected: {
    scope: 'organization' | 'own';
    total: number;
    keyword: string;
    ids: readonly string[];
    cursor: { id: string; createdAt: string } | null;
  },
): boolean;
export function validateDeadlineResponse(
  data: unknown,
  expected: {
    scope: 'organization' | 'own';
    total: number;
    allowedIds?: ReadonlySet<string>;
    nullSla?: boolean;
  },
): boolean;
export function parsePoolSnapshot(text: string): PoolSnapshot;
export function poolDifference(before: PoolSnapshot, after: PoolSnapshot): PoolDelta;
export function verifySessions(
  admin: QueryClient,
  actor: Pick<FixtureActor, 'userId'>,
  fixture: Pick<PerformanceFixture, 'organizationId'>,
  cookies: string[],
  signal: AbortSignal,
): Promise<SessionVerification>;
export function runBurst(options: {
  count: number;
  send(index: number): Promise<RequestSample>;
  signal: AbortSignal;
  now?(): number;
}): Promise<BurstReport>;
export interface ListComparisonOptions {
  runtime: ComparisonRuntime;
  fixture: PerformanceFixture;
  profile: WorkloadProfile;
  signal?: AbortSignal;
  onProgress?(stage: string): void | Promise<void>;
}
export function runListComparison(options: ListComparisonOptions): Promise<ListComparisonReport>;
export function runDeadlineComparison(
  options: ListComparisonOptions,
): Promise<ListComparisonReport>;
export function runSearchComparison(options: ListComparisonOptions): Promise<ListComparisonReport>;
