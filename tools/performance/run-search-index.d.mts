import type { PerformanceProfile, ProfileName } from './profiles.mjs';
import type { FixtureCounts } from './fixture.mjs';
import type { CleanupStatus, FinalizedStatus } from './run-baseline.mjs';
import type { analyzeSearchIndex } from './search-index-analysis.mjs';

export interface SearchIndexOptions {
  profile: ProfileName;
  output?: string;
  'exercise-cleanup'?: boolean;
}

export interface SearchIndexDiagnosticReport extends FinalizedStatus {
  schemaVersion: 1;
  workPackage: 'WP-P2-PERF-051';
  startedAt: string;
  finishedAt: string;
  profile: PerformanceProfile;
  measurementScope: 'sql-and-catalog';
  capacitySkipped: true;
  capacitySkipReason: 'sql-only-protocol';
  allRequestsSucceeded: false;
  adoptionEstablished: false;
  catalogComplete: boolean;
  restorationVerified: boolean;
  interpretation: {
    model: string;
    protocol: string;
    success: string;
    catalog: string;
    controls: string;
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
  queryAnalysis?: Awaited<ReturnType<typeof analyzeSearchIndex>>;
  cleanup?: CleanupStatus;
}

export function parseSearchIndexArgs(args: readonly string[]): SearchIndexOptions | { help: true };
export function executeSearchIndex(args: SearchIndexOptions): Promise<SearchIndexDiagnosticReport>;
