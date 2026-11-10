import type { DiagnosticOptions, DiagnosticReport } from './run-list-diagnostic.mjs';
import type { ListComparisonReport } from './list-load.mjs';

export type DeadlineDiagnosticOptions = DiagnosticOptions;
export interface DeadlineDiagnosticReport {
  schemaVersion: 1;
  workPackage: 'WP-P2-PERF-044';
  label: 'before' | 'after';
  success: boolean;
  allRequestsSucceeded: boolean;
  interrupted?: boolean;
  failureCode?: string;
  startedAt: string;
  finishedAt: string;
  cleanup?: DiagnosticReport['cleanup'];
  comparison?: ListComparisonReport;
  [key: string]: unknown;
}
export function parseDeadlineArgs(
  args: readonly string[],
): DeadlineDiagnosticOptions | { help: true };
export function executeDeadlineDiagnostic(
  args: DeadlineDiagnosticOptions,
): Promise<DeadlineDiagnosticReport>;
