import type { DiagnosticOptions, DiagnosticReport } from './run-list-diagnostic.mjs';
import type { DirectoryComparisonReport, DirectoryStateReport } from './directory-load.mjs';
export interface DirectoryDiagnosticOptions extends DiagnosticOptions {
  'security-checks'?: true;
}
export interface DirectorySecurityReport {
  completed: boolean;
  success: boolean;
  testFiles: { passed: number; failed: number };
  tests: { passed: number; failed: number; pending: number };
  failureCode?: string;
}
export interface DirectoryDiagnosticReport {
  schemaVersion: 1;
  workPackage: 'WP-P2-PERF-045';
  label: 'before' | 'after';
  success: boolean;
  allRequestsSucceeded: boolean;
  interrupted?: boolean;
  failureCode?: string;
  startedAt: string;
  finishedAt: string;
  cleanup?: DiagnosticReport['cleanup'];
  comparison?: DirectoryComparisonReport;
  securityChecks?: DirectorySecurityReport;
  stateProbes?: DirectoryStateReport;
  [key: string]: unknown;
}
export function parseDirectoryArgs(
  args: readonly string[],
): DirectoryDiagnosticOptions | { help: true };
export function executeDirectoryDiagnostic(
  args: DirectoryDiagnosticOptions,
): Promise<DirectoryDiagnosticReport>;
