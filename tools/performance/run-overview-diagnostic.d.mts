import type { CleanupStatus } from './run-baseline.mjs';
export interface OverviewDiagnosticOptions {
  profile: 'smoke' | 'baseline' | 'growth';
  label: 'before' | 'after';
  output?: string;
  'exercise-cleanup'?: boolean;
}
export function parseOverviewArgs(args: string[]): OverviewDiagnosticOptions | { help: true };
export function createProbeCredential(
  runtime: {
    meta: { database: string };
    admin: { query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }> };
    createCredential(account: {
      userId: string;
      subject: string;
      password: string;
    }): Promise<{ ok: boolean }>;
  },
  account: { userId: string; email: string; password: string },
): Promise<void>;
export interface OverviewDiagnosticReport {
  success: boolean;
  allRequestsSucceeded?: boolean;
  cleanup?: CleanupStatus;
  failureCode?: string;
  [key: string]: unknown;
}
export function executeOverviewDiagnostic(
  args: OverviewDiagnosticOptions,
): Promise<OverviewDiagnosticReport>;
