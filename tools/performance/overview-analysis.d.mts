import type { PerformanceFixture } from './fixture.mjs';
import type { AnalysisRuntime, ReadOnlyProof, SanitizedExplain } from './list-query-analysis.mjs';
import type { AuthzContext } from '../../services/api/src/common/authz/authz.js';
import type {
  OverviewOptions,
  TicketOverviewQuery,
} from '../../services/api/src/modules/ticket/overview-query.js';

export type OverviewMetric = 'open' | 'unassigned' | 'mine' | 'pending' | 'breached' | 'critical';
export type OverviewCounts = Record<OverviewMetric, number>;
export const OVERVIEW_METRICS: readonly OverviewMetric[];
export interface OverviewRuntime extends AnalysisRuntime {
  buildTicketOverviewQuery(context: AuthzContext, options: OverviewOptions): TicketOverviewQuery;
}
export interface OverviewEdgeTicket {
  organization_id: string;
  requester_id: string;
  state: string;
  priority: string;
  assignee_id: string | null;
  assignee_group_id: string | null;
  sla_elapsed_seconds: number;
  clock_age_seconds: number | null;
}
export interface OverviewEdgeCase {
  name: string;
  tickets: OverviewEdgeTicket[];
  policies: Array<{
    organization_id: string;
    priority: string;
    response_target_minutes: number;
    resolution_target_minutes: number;
  }>;
  expected: OverviewCounts;
}
export interface OverviewComparison {
  equal: boolean;
  metrics: Record<OverviewMetric, boolean>;
  expectedPopulation: boolean;
}
export interface OverviewAnalysisCase {
  name: string;
  mode: 'actual-table' | 'synthetic-cte';
  /** Only actual-table cases establish data isolation; CTE rows have no table RLS. */
  rlsEvidence: boolean;
  apiComparable: boolean;
  actorRole: 'agent' | 'admin';
  /** Only synthetic group identifiers, for matching the real API under the same actor. */
  options?: OverviewOptions;
  stage: string;
  completed: boolean;
  proof?: ReadOnlyProof;
  membershipCount?: number;
  legacy: {
    counts: Partial<OverviewCounts>;
    plans: Partial<Record<OverviewMetric, SanitizedExplain>>;
  };
  aggregate: { counts?: OverviewCounts; plan?: SanitizedExplain };
  comparison?: OverviewComparison;
}
export interface OverviewAnalysisReport {
  completed: boolean;
  equivalent: boolean;
  cases: OverviewAnalysisCase[];
  readOnlyContexts: Array<{ name: string; proof: ReadOnlyProof }>;
  elapsedMs: number;
  failureCode?: string;
}
export function sanitizeOverviewCounts(value: unknown): OverviewCounts;
export function compareOverviewCounts(
  legacy: unknown,
  aggregate: unknown,
  expected?: OverviewCounts,
): OverviewComparison;
export function prepareOverviewCases(options: {
  fixture: PerformanceFixture;
  runtime?: OverviewRuntime;
}): OverviewEdgeCase[];
export function buildOverviewEdgeQuery(
  built: TicketOverviewQuery,
  edge: OverviewEdgeCase,
): TicketOverviewQuery;
export function runOverviewAnalysis(options: {
  runtime: OverviewRuntime;
  fixture: PerformanceFixture;
  signal?: AbortSignal;
}): Promise<OverviewAnalysisReport>;
