import type { PerformanceProfile, ProfileName } from './profiles.mjs';
import type { FixtureCounts } from './fixture.mjs';
import type { WorkloadReport } from './workload.mjs';

export interface BaselineOptions {
  profile: string;
  output?: string;
  /** Internal regression evidence label; the CLI deliberately does not accept this option. */
  workPackage?:
    | 'WP-P2-PERF-041'
    | 'WP-P2-PERF-042'
    | 'WP-P2-PERF-043'
    | 'WP-P2-PERF-044'
    | 'WP-P2-PERF-045'
    | 'WP-P2-PERF-046'
    | 'WP-P2-PERF-047'
    | 'WP-P2-PERF-048'
    | 'WP-P2-PERF-049';
  'exercise-cleanup'?: boolean;
}

export type ParsedArguments =
  | { help: true }
  | {
      help?: false;
      profile: ProfileName;
      output?: string;
      'exercise-cleanup'?: true;
    };

export function parseArgs(args: readonly string[]): ParsedArguments;
export function prepareOutput(
  requested: string | undefined,
  profile: string,
  workPackage?:
    | 'WP-P2-PERF-041'
    | 'WP-P2-PERF-042'
    | 'WP-P2-PERF-043'
    | 'WP-P2-PERF-044'
    | 'WP-P2-PERF-045'
    | 'WP-P2-PERF-046'
    | 'WP-P2-PERF-047'
    | 'WP-P2-PERF-048'
    | 'WP-P2-PERF-049'
    | 'WP-P2-PERF-050'
    | 'WP-P2-PERF-051'
    | 'WP-P2-PERF-053',
): Promise<string>;

export interface DatabaseAggregate {
  connections: number;
  active: number;
  idle_in_transaction: number;
  lock_waiting: number;
}

export interface ObservationClient {
  query(sql: string): Promise<{ rows: readonly DatabaseAggregate[] }>;
}

/** An absent result row has only its timestamp; callers must validate usable samples. */
export type DatabaseObservationSample = { at: string } & Partial<DatabaseAggregate>;

export interface DatabaseObservationReport {
  samples: DatabaseObservationSample[];
  errors: number;
  scope: 'owned database only; one-second aggregate samples';
}

export function observeDatabase(admin: ObservationClient): {
  stop(): Promise<DatabaseObservationReport>;
};

export interface PoolMetrics {
  lines: string[];
  acquisitionCount: number;
  complete: boolean;
}

export function parsePoolMetrics(text: string): PoolMetrics;
export type PoolScrapeResult = { available: false } | ({ available: true } & PoolMetrics);

export interface CleanupStatus {
  success?: boolean;
  failureCode?: string;
  [field: string]: unknown;
}

export interface FinalizableReport {
  success: boolean;
  cleanup?: CleanupStatus;
  failureCode?: string;
}

export interface FinalizedStatus {
  success: boolean;
  interrupted: boolean;
  failureCode?: string;
}

/** Mutates and returns report; success is recomputed after cleanup/interruption. */
export function finalizeReport<T extends FinalizableReport>(
  report: T,
  wasInterrupted: boolean,
): Omit<T, keyof FinalizedStatus> & FinalizedStatus;

/** Preparation failures may leave optional stage results absent. */
export interface BaselineReport extends FinalizedStatus {
  schemaVersion: 1;
  workPackage:
    | 'WP-P2-PERF-041'
    | 'WP-P2-PERF-042'
    | 'WP-P2-PERF-043'
    | 'WP-P2-PERF-044'
    | 'WP-P2-PERF-045'
    | 'WP-P2-PERF-046'
    | 'WP-P2-PERF-047'
    | 'WP-P2-PERF-048'
    | 'WP-P2-PERF-049';
  startedAt: string;
  finishedAt: string;
  profile: PerformanceProfile;
  executionMode: { web: string; api: string; data: string };
  limitations: string[];
  stages: Array<{ stage: string; at: string }>;
  runtime?: Record<string, unknown>;
  dataset?: FixtureCounts;
  workload?: WorkloadReport;
  database?: DatabaseObservationReport;
  independentSessions?: {
    sessions: number;
    users: number;
    active: number;
    expected: number;
    verified: boolean;
  };
  poolBefore?: PoolScrapeResult;
  poolAfter?: PoolScrapeResult;
  cleanup?: CleanupStatus;
}

/** Starts the isolated runtime; output/preparation errors can reject before report creation. */
export function executeBaseline(args: BaselineOptions): Promise<BaselineReport>;
