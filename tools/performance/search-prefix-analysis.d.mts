import type { AuthzContext } from '../../services/api/src/common/authz/authz.js';
import type { ListOptions } from '../../services/api/src/modules/ticket/ticket-query.js';
import type { PerformanceFixture } from './fixture.mjs';
import type { QueryComparison, ReadOnlyProof, SanitizedExplain } from './list-query-analysis.mjs';
import type { SearchBoundary, SearchCase, SearchAnalysisReport } from './search-analysis.mjs';
import type {
  SearchCostQuery,
  SearchCostRuntime,
  SearchCostSample,
  SearchCostStatement,
  SearchStatementWork,
} from './search-cost-analysis.mjs';

export interface SearchPrefixRuntime extends SearchCostRuntime {
  buildLegacySearchPrefixQuery(ctx: AuthzContext, options: ListOptions): SearchCostQuery;
}
export interface SearchStatePrefixRuntime extends SearchPrefixRuntime {
  buildLegacySearch048Query(ctx: AuthzContext, options: ListOptions): SearchCostQuery;
}
export interface PrefixScanWork {
  nodeType: string;
  rows: number;
  loops: number;
  returnedRows: number;
  visitedRows: number;
  uniqueIdLookup: boolean;
}
export interface PrefixPlan {
  present: boolean;
  expectedPrefix: boolean | null;
  shapeMatchesExpectation: boolean;
  ctes: Record<
    'probe_keys' | 'probe_evaluation' | 'probe_status' | 'matched' | 'counted',
    {
      producers: PrefixScanWork[];
      ticketScans: PrefixScanWork[];
    }
  >;
  branch: 'absent' | 'prefix' | 'fallback' | 'unproven';
  matchedLoops: number;
  directCountLoops: number;
  probeRows: number;
  probeVisitedRows: number;
  evaluationVisitedRows: number;
  stateProbe?: {
    scans: Array<
      PrefixScanWork & {
        indexName:
          'ticket_list_state_idx' | 'ticket_list_org_idx' | 'ticket_list_requester_idx' | null;
        orderedIndexScan: boolean;
        organizationEquality: boolean;
        stateEquality: boolean;
        removedRows: number;
        heapFetches: number;
      }
    >;
    orderedStateIndex: boolean;
    visitsBounded: boolean;
  };
  pageTicketScans: PrefixScanWork[];
  pageUniqueLookupsBounded: boolean;
  displayLookupsBounded: boolean;
  tempReadBlocks: number;
  tempWrittenBlocks: number;
}
export interface PrefixDefinition {
  name: string;
  boundary: SearchBoundary;
  ctx: AuthzContext;
  own: boolean;
  terminal: boolean;
  cursorIndex?: number;
  options: ListOptions;
}
export interface PrefixSample extends Omit<SearchCostSample, 'statements'> {
  branchMatchesExpected?: boolean;
  statements?: Array<
    Omit<SearchCostStatement, 'work'> & { work?: SearchStatementWork & { prefix: PrefixPlan } }
  >;
}
export type PrefixVariant = 'original046' | 'prior047' | 'candidate';
export type StatePrefixVariant = PrefixVariant | 'prior048';
export interface PrefixCostTerm {
  name: string;
  completed: boolean;
  proof?: ReadOnlyProof;
  samples: Array<
    Partial<Record<StatePrefixVariant, PrefixSample>> & {
      repetition: number;
      order: StatePrefixVariant[];
      completed: boolean;
      comparisons?: {
        prior: QueryComparison;
        candidate: QueryComparison;
        prior048?: QueryComparison;
      };
      expectedPopulation?: boolean;
    }
  >;
}
export interface PrefixAssessment {
  terms: Array<{
    name: string;
    averagesMs: Record<PrefixVariant, number>;
    withinBounds: boolean;
    versus046: number | null;
    versus047: number | null;
  }>;
  meetsSqlCriteria: boolean;
  adoptionEstablished: false;
  interpretation: string;
}
type ReferenceCaseSide = Omit<SearchCase['candidate'], 'countPlan'> & {
  referenceCountPlan?: SanitizedExplain;
};
export interface PrefixReferenceEvidence {
  comparisons048?: Array<{ contextIndex: number; comparison: QueryComparison; statements: 1 }>;
  unchanged048?: Array<{ eligible: boolean; equal: boolean }>;
  coverage: Array<{
    contextIndex: number;
    expectedDistinctQueries: number;
    comparedDistinctQueries: number;
    complete: boolean;
  }>;
  comparisons: Array<{
    contextIndex: number;
    comparison: QueryComparison;
    originalStatements: 2;
    priorStatements: 1;
  }>;
  plans: Array<{ contextIndex: number; plan: PrefixPlan }>;
}
export interface SearchPrefixReport {
  completed: boolean;
  equivalent: boolean;
  cases: Array<
    Omit<SearchCase, 'candidate' | 'legacy'> & {
      legacy: ReferenceCaseSide;
      candidate: ReferenceCaseSide;
    }
  >;
  readOnlyContexts: Array<{ name: string; proof: ReadOnlyProof }>;
  unchangedSorts: SearchAnalysisReport['unchangedSorts'];
  reference046Comparisons: PrefixReferenceEvidence['comparisons'];
  referenceCoverage?: PrefixReferenceEvidence['coverage'];
  semanticBranchPlans: PrefixReferenceEvidence['plans'];
  semanticExecution?: {
    combinedExecutions: number;
    reusedTotals: number;
    legacyIs047: true;
    additionalSameSnapshotReferenceIs046: true;
    referenceCountPlansAreSeparateDiagnostics: true;
  };
  semanticFailureCode?: string;
  expectedReferenceComparisons?: number;
  prefixCases: Array<{
    name: string;
    mode: 'synthetic-cte';
    rlsEvidence: false;
    completed: boolean;
    sides: Partial<Record<StatePrefixVariant, PrefixSample>>;
    proof?: ReadOnlyProof;
    expected?: { total: number; rows: number; usable: boolean; prefixRows: number };
    comparisons?: {
      prior: QueryComparison;
      candidate: QueryComparison;
      prior048?: QueryComparison;
    };
    expectedValues?: boolean;
    branchApplicable?: boolean;
    branchMatchesExpected?: boolean;
    statePrefixEligible?: boolean;
    statePrefixPresent?: boolean;
    unchangedFrom048?: boolean;
  }>;
  diagnostics: PrefixCostTerm[];
  filterDiagnostics: PrefixCostTerm[];
  optimization?: Record<string, boolean>;
  assessment?: PrefixAssessment;
  filterAssessment?: PrefixFilterAssessment;
  failureCode?: string;
  elapsedMs: number;
}
export function summarizePrefixPlan(
  document: unknown,
  returnedRows: number,
  expectedPrefix?: boolean,
  profile?: '048' | '049',
): PrefixPlan;
export function createPrefixReferenceRuntime(
  runtime: SearchPrefixRuntime | SearchStatePrefixRuntime,
  fixture: PerformanceFixture,
  budget?: () => void,
  profile?: '048' | '049',
): {
  runtime: SearchCostRuntime;
  evidence: PrefixReferenceEvidence;
};
export function preparePrefixCases(
  fixture: PerformanceFixture,
  profile?: '048' | '049',
): PrefixDefinition[];
export function prefixBoundaryExpectation(
  definition: PrefixDefinition,
  createdAt: string,
  profile?: '048' | '049',
): {
  total: number;
  ids: string[];
  usable: boolean;
  prefixRows: number;
};
export function assessPrefixCosts(diagnostics: PrefixCostTerm[]): PrefixAssessment;
export interface PrefixFilterAssessment {
  terms: Array<
    Omit<PrefixAssessment['terms'][number], 'withinBounds'> & {
      observations: Array<{
        repetition: number;
        original046Ms: number;
        candidateMs: number;
        deltaMs: number;
        over046ByFivePercent: boolean;
      }>;
      repetitionsOver046ByFivePercent: number;
    }
  >;
  requiresAdoptionHold: boolean;
  repeatedRegressionDefinition: string;
  adoptionEstablished: false;
}
export function assessPrefixFilters(diagnostics: PrefixCostTerm[]): PrefixFilterAssessment;
export function samplePrefixPlansValid(
  sample:
    | {
        statements?: Array<{
          completed?: boolean;
          work?: {
            prefix?: Pick<PrefixPlan, 'expectedPrefix' | 'shapeMatchesExpectation' | 'branch'>;
          };
        }>;
      }
    | undefined,
): boolean;
export function analyzeSearchPrefix(
  runtime: SearchPrefixRuntime,
  fixture: PerformanceFixture,
  signal?: AbortSignal,
): Promise<SearchPrefixReport>;

export interface StatePrefixCostTerm {
  name: string;
  averagesMs: Record<StatePrefixVariant, number>;
  observations: Array<{
    repetition: number;
    executionMs: Record<StatePrefixVariant, number>;
    delta046Ms: number;
    delta048Ms: number;
    over048ByFivePercent: boolean;
  }>;
  versus046: number | null;
  versus047: number | null;
  versus048: number | null;
  delta046Ms: number;
  delta048Ms: number;
  withinBounds: boolean;
  repetitionsOver048ByFivePercent: number;
}
export interface StatePrefixAssessment {
  primary: {
    terms: StatePrefixCostTerm[];
    meetsSqlCriteria: boolean;
    stateWithinBounds: boolean;
    adoptionEstablished: false;
    interpretation: string;
  };
  filters: {
    terms: StatePrefixCostTerm[];
    requiresAdoptionHold: boolean;
    repeatedRegressionDefinition: string;
    adoptionEstablished: false;
  };
}
export function assessStatePrefixCosts(
  diagnostics: PrefixCostTerm[],
  filterDiagnostics: PrefixCostTerm[],
): StatePrefixAssessment;
export interface SearchStatePrefixReport extends Omit<
  SearchPrefixReport,
  'assessment' | 'filterAssessment'
> {
  reference048Comparisons?: PrefixReferenceEvidence['comparisons048'];
  unchanged048?: PrefixReferenceEvidence['unchanged048'];
  assessment?: StatePrefixAssessment['primary'];
  filterAssessment?: StatePrefixAssessment['filters'];
}
export function analyzeSearchStatePrefix(
  runtime: SearchStatePrefixRuntime,
  fixture: PerformanceFixture,
  signal?: AbortSignal,
): Promise<SearchStatePrefixReport>;
