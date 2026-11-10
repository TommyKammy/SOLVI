import type { PerformanceFixture, FixtureActor } from './fixture.mjs';

export type ActorRole = 'requester' | 'agent' | 'admin';
export interface WorkloadProfile {
  name: string;
  users: number;
  tickets: number;
  activeSessions: number;
  roles: Record<ActorRole, number>;
  warmupMs: number;
  durationMs: number;
  thinkTimeMs: number;
  requestTimeoutMs: number;
  seed: number;
}
export interface BaseRoute {
  key: string;
  path: string;
  expectedStatus?: number;
}
export interface ApiRoute extends BaseRoute {
  kind: 'api';
  check(data: unknown): boolean;
}
export interface SsrRoute extends BaseRoute {
  kind: 'ssr';
  heading: string;
  markers?: string[];
}
export type WorkloadRoute = ApiRoute | SsrRoute;
export type SampleOutcome =
  | 'success'
  | 'http_error'
  | 'invalid_response'
  | 'too_large'
  | 'network_error'
  | 'timeout'
  | 'aborted';
export interface SampleValues {
  outcome: SampleOutcome;
  bytes: number;
  durationMs: number;
}
export interface RequestSample extends SampleValues {
  route: string;
  kind: WorkloadRoute['kind'];
  status: number | null;
}
export interface SampleSummary {
  requests: number;
  successes: number;
  failures: number;
  timeouts: number;
  aborted: number;
  failureRate: number | null;
  bytes: number;
  elapsedMs: number;
  rps: number;
  successfulRps: number;
  successfulLatencyMs: Record<'p50' | 'p95' | 'p99' | 'max', number | null>;
  outcomes: Record<SampleOutcome, number>;
}
export interface PhaseSummary extends SampleSummary {
  startedAt: string;
  finishedAt: string;
  byRoute: Array<SampleSummary & { route: string; kind: WorkloadRoute['kind'] }>;
  byTransport: Array<SampleSummary & { kind: WorkloadRoute['kind'] }>;
}
export type WorkloadStage =
  'login' | 'login-complete' | 'warmup' | 'measurement' | 'same-session-diagnostic' | 'complete';
export interface WorkloadReport {
  completed: boolean;
  measurementValid: boolean;
  loginCompleted: number;
  uniqueUsers: number;
  model: string;
  isolation: { checked: number; denied: number };
  failureCode?: string;
  warmup?: PhaseSummary | { requests: 0; failures: 0; timeouts: 0 };
  measurement?: PhaseSummary;
  diagnosticValid?: boolean;
  sameSessionDiagnostic?: SampleSummary & {
    sessionCount: 1;
    parallelRequests: number;
    failureCode?: string;
  };
  missingSuccessfulRoutes?: string[];
}
export type FetchImplementation = (
  input: string,
  init: RequestInit & { signal: AbortSignal },
) => Promise<Response>;

export const MAX_RESPONSE_BYTES: number;
export const MAX_WORKLOAD_MS: number;
export function validateProfile(profile: unknown): WorkloadProfile;
export function assertLoopbackBase(value: string): string;
export function percentile(values: number[], percent: number): number | null;
export function summarizeSamples(samples: SampleValues[], elapsedMs: number): SampleSummary;
export function validateResponse(route: WorkloadRoute, response: Response, text: string): boolean;
export function requestSample(options: {
  base: string;
  route: WorkloadRoute;
  cookie: string;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchImpl?: FetchImplementation;
}): Promise<RequestSample>;
export function actorRoutes(
  actor: Pick<FixtureActor, 'role' | 'ticketId' | 'ticketSubject'>,
  fixture: Pick<PerformanceFixture, 'catalogItemId' | 'serviceRequestId'> & {
    counts: Pick<PerformanceFixture['counts'], 'users' | 'tickets'>;
  },
): WorkloadRoute[];
/** Performs a real local login; the returned credential must never enter reports. */
export function login(
  actor: FixtureActor,
  fixture: Pick<PerformanceFixture, 'organizationId'>,
  apiBase: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string>;
export function runWorkload(options: {
  profile: WorkloadProfile;
  fixture: PerformanceFixture;
  apiBase: string;
  webBase: string;
  onProgress?: (stage: WorkloadStage) => void | Promise<void>;
  signal?: AbortSignal;
}): Promise<WorkloadReport>;
