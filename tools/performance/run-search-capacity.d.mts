import type { DiagnosticOptions, DiagnosticReport } from './run-list-diagnostic.mjs';
import type { SearchCapacityReport } from './search-capacity.mjs';
import type { SearchStateApiReport } from './list-load.mjs';
export interface SearchCapacityOptions extends DiagnosticOptions {
  workPackage?: 'WP-P2-PERF-047' | 'WP-P2-PERF-048' | 'WP-P2-PERF-049';
  'sql-only'?: boolean;
  'contract-only'?: boolean;
}
export interface SearchCapacityDiagnosticReport {
  schemaVersion: 1;
  workPackage: 'WP-P2-PERF-047' | 'WP-P2-PERF-048' | 'WP-P2-PERF-049';
  label: 'before' | 'after';
  success: boolean;
  allRequestsSucceeded: boolean;
  measurementScope: 'sql-only' | 'sql-and-contract' | 'sql-and-http';
  capacitySkipped: boolean;
  capacitySkipReason?: 'sql-only-requested' | 'contract-only-requested';
  interrupted?: boolean;
  failureCode?: string;
  startedAt: string;
  finishedAt: string;
  cleanup?: DiagnosticReport['cleanup'];
  capacity?: SearchCapacityReport;
  apiContract?: SearchStateApiReport;
  [key: string]: unknown;
}
export function parseSearchCapacityArgs(
  args: readonly string[],
): SearchCapacityOptions | { help: true };
export function executeSearchCapacity(
  args: SearchCapacityOptions,
): Promise<SearchCapacityDiagnosticReport>;
