import type { ProfileName } from './profiles.mjs';
import type { BaselineReport } from './run-baseline.mjs';

export interface DiagnosticOptions {
  profile: ProfileName;
  label: 'before' | 'after';
  output?: string;
  'exercise-cleanup'?: boolean;
}
export function parseDiagnosticArgs(args: readonly string[]): DiagnosticOptions | { help: true };
export function prepareQueryFixture(
  runtime: {
    admin: {
      query(
        sql: string,
        params?: unknown[],
      ): Promise<{
        rows: Array<{ database?: string }>;
        rowCount: number | null;
      }>;
    };
    meta: { database: string };
  },
  fixture: { organizationId: string },
): Promise<{ missingCriticalSlaPolicyRows: number; statistics: 'explicit-analyze' }>;
export interface DiagnosticReport {
  schemaVersion: 1;
  workPackage: 'WP-P2-PERF-042';
  label: 'before' | 'after';
  success: boolean;
  allRequestsSucceeded: boolean;
  interrupted?: boolean;
  failureCode?: string;
  startedAt: string;
  finishedAt: string;
  cleanup?: BaselineReport['cleanup'];
  [key: string]: unknown;
}
export function executeListDiagnostic(args: DiagnosticOptions): Promise<DiagnosticReport>;
