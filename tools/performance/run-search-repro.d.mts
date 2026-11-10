import type { PerformanceProfile, ProfileName } from './profiles.mjs';
import type { FixtureCounts } from './fixture.mjs';
import type { CleanupStatus, FinalizedStatus } from './run-baseline.mjs';
import type { analyzeSearchRepro } from './search-repro-analysis.mjs';

export interface SearchReproOptions {
  profile: ProfileName;
  replica: 1 | 2;
  output?: string;
  'exercise-cleanup'?: boolean;
}

export interface SearchReproDiagnosticReport extends FinalizedStatus {
  schemaVersion: 1;
  workPackage: 'WP-P2-PERF-050';
  startedAt: string;
  finishedAt: string;
  profile: PerformanceProfile;
  replica: 1 | 2;
  measurementScope: 'sql-only';
  capacitySkipped: true;
  capacitySkipReason: 'sql-only-protocol';
  allRequestsSucceeded: false;
  adoptionEstablished: false;
  resourceObservationsComplete: boolean;
  interpretation: {
    model: string;
    protocol: string;
    success: string;
    resources: string;
    history: string;
    limits: string;
  };
  stages: Array<{ stage: string; at: string }>;
  runtime?: Record<string, unknown>;
  dataset?: FixtureCounts;
  fixtureAdjustments?: {
    missingCriticalSlaPolicyRows: number;
    statistics: 'explicit-analyze';
  };
  queryAnalysis?: Awaited<ReturnType<typeof analyzeSearchRepro>>;
  cleanup?: CleanupStatus;
}

export function parseSearchReproArgs(args: readonly string[]): SearchReproOptions | { help: true };
export function executeSearchRepro(args: SearchReproOptions): Promise<SearchReproDiagnosticReport>;
