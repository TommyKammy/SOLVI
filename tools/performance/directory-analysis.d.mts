import type { AuthzContext } from '../../services/api/src/common/authz/authz.js';
import type { OrganizationMember } from '../../services/api/src/modules/auth/user-admin.service.js';
import type { PerformanceFixture } from './fixture.mjs';
import type { AnalysisClient, ReadOnlyProof, SanitizedExplain } from './list-query-analysis.mjs';

export interface DirectoryReadResult {
  members: OrganizationMember[];
  /** Private, in-memory only. Never include this object in evidence. */
  queries: Array<{ sql: string; params: unknown[] }>;
}
export interface DirectoryRuntime {
  withAppReadOnly<T>(
    context: { organizationId: string; actorId: string },
    callback: (client: AnalysisClient) => Promise<T>,
  ): Promise<T>;
  readDirectoryMembers(
    variant: 'legacy' | 'candidate',
    client: AnalysisClient,
    context: AuthzContext,
  ): Promise<DirectoryReadResult>;
}
export interface DirectoryComparison {
  rows: boolean;
  idsAndOrder: boolean;
  fullFields: boolean;
  equal: boolean;
  expectedPopulation?: boolean;
}
export interface DirectoryWork {
  queryCount: number;
  plans: SanitizedExplain[];
  executionMs: number;
  planningMs: number;
  rootSharedHits: number;
  rootSharedReads: number;
  scanLoops: number;
  scanRowVisits: number;
  aggregateLoops: number;
}
export interface DirectoryCase {
  name: string;
  mode: 'actual-table';
  rlsEvidence: true;
  defenseProbe: boolean;
  completed: boolean;
  stage: string;
  legacy: {
    rows?: number;
    queryCount?: number;
    observed?: Record<string, number>;
    work?: DirectoryWork;
  };
  candidate: {
    rows?: number;
    queryCount?: number;
    observed?: Record<string, number>;
    work?: DirectoryWork;
  };
  comparison?: DirectoryComparison;
  proof?: ReadOnlyProof;
  directoryRls?: Record<string, boolean>;
  sqlChanged?: boolean;
}
export interface DirectoryAnalysisReport {
  completed: boolean;
  equivalent: boolean;
  cases: DirectoryCase[];
  coverage: {
    actualRls: string[];
    separateSecurityTests: string[];
    emptyContextIsDefenseProbe: boolean;
  };
  readOnlyContexts: Array<{
    name: string;
    proof: ReadOnlyProof;
    directoryRls: Record<string, boolean>;
  }>;
  optimization?: {
    queryShapeChanged: boolean;
    legacyQueries: number;
    candidateQueries: number;
    legacyExecutionMs: number;
    candidateExecutionMs: number;
    legacyAggregateLoops: number;
    candidateAggregateLoops: number;
    legacyRootSharedHits: number;
    candidateRootSharedHits: number;
    bulkObserved: boolean;
  };
  failureCode?: string;
  elapsedMs: number;
}
export function canonicalDirectoryMembers(members: OrganizationMember[]): OrganizationMember[];
export function compareDirectoryMembers(
  legacy: OrganizationMember[],
  candidate: OrganizationMember[],
): DirectoryComparison;
export function summarizeDirectoryPlans(documents: unknown[]): DirectoryWork;
export function runDirectoryAnalysis(options: {
  runtime: DirectoryRuntime;
  fixture: PerformanceFixture;
  signal?: AbortSignal;
}): Promise<DirectoryAnalysisReport>;
