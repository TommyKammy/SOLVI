import type { DiagnosticOptions, DiagnosticReport } from './run-list-diagnostic.mjs';
import type { ListComparisonReport } from './list-load.mjs';

export type SearchDiagnosticOptions = DiagnosticOptions;
export interface SearchDiagnosticReport {
  schemaVersion: 1;
  workPackage: 'WP-P2-PERF-046';
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
export function parseSearchArgs(args: readonly string[]): SearchDiagnosticOptions | { help: true };
export function executeSearchDiagnostic(
  args: SearchDiagnosticOptions,
): Promise<SearchDiagnosticReport>;
