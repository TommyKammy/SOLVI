import type {
  ListComparisonOptions,
  ListComparisonReport,
  ComparisonRuntime,
  DrainReport,
} from './list-load.mjs';
import type { PerformanceFixture } from './fixture.mjs';

/** Internal reference values; never serialized into evidence. */
export interface DirectoryExpectation {
  members: Map<
    string,
    {
      displayName: string;
      email: string;
      status: 'active' | 'deactivated';
      deactivatedAt: string | null;
      roleCodes: string[];
      temporaryRoles: Array<{ roleCode: string; validUntil: string }>;
    }
  >;
  order: Array<{ status: 'active' | 'deactivated'; displayName: string }>;
}
export interface DirectoryComparisonReport extends Omit<
  ListComparisonReport,
  'principal' | 'deadlineContract'
> {
  principal?: { role: 'org_admin'; count: 1; organizationCount: 1 };
  directoryContract?: { members: number; path: '/users'; roster: string; countEquivalence: string };
}
export const DIRECTORY_LIST_PATH: '/users';
export function readDirectoryExpectation(
  runtime: ComparisonRuntime,
  fixture: PerformanceFixture,
  signal: AbortSignal,
): Promise<DirectoryExpectation>;
export function validateDirectoryResponse(data: unknown, expected: DirectoryExpectation): boolean;
export function runDirectoryComparison(
  options: ListComparisonOptions,
): Promise<DirectoryComparisonReport>;
export interface DirectoryStateReport {
  completed: boolean;
  valid: boolean;
  cases: NonNullable<ListComparisonReport['apiProbes']>['cases'];
  timing: string;
  measuredFixtureUsers: number;
  postPreparationRosterUsers?: number;
  preparation?: {
    organizationMembershipAdded: number;
    administratorBindingsExpired: number;
    platformBindingsAdded?: number;
    usersDeactivated?: number;
  };
  drain?: DrainReport;
  failureCode?: string;
}
export function runDirectoryStateProbes(
  options: Omit<ListComparisonOptions, 'runtime' | 'onProgress'> & {
    runtime: ComparisonRuntime & { meta: { database: string } };
  },
): Promise<DirectoryStateReport>;
