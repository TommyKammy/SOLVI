import type { AuthzContext } from '../../services/api/src/common/authz/authz.js';
import type {
  BuiltQuery,
  ListOptions,
} from '../../services/api/src/modules/ticket/ticket-query.js';
import type {
  AnalysisClient,
  QueryComparison,
  ReadOnlyProof,
  SanitizedExplain,
} from './list-query-analysis.mjs';

export type StaticActorKey =
  'agent' | 'requester' | 'other-requester' | 'foreign' | 'deactivated' | 'expired' | 'revoked';
export type StaticContextKey = StaticActorKey | 'actor-missing';
export interface StaticFixture {
  organizationId: string;
  controlOrganizationId: string;
  actors: Record<StaticActorKey, { userId: string; context: AuthzContext }>;
  groups: [string, string];
  counts: Record<string, unknown>;
}
export interface StaticCorpus {
  documents: Array<string | null>;
  keywords: string[];
  additionalPairs: Array<{ document: string; keyword: string }>;
}
export type StaticProgress =
  | 'static-start'
  | 'static-catalog'
  | 'static-corpus'
  | 'static-native'
  | 'static-boundary'
  | 'static-plans'
  | 'static-complete'
  | 'static-failed';
export interface StaticPattern {
  eligible: boolean;
  literal: string | null;
  reason: 'empty' | 'grammar' | 'literal';
}
export interface StaticProjectionComparison {
  pairs: number;
  trueRows: number;
  nullRows: number;
  falseNegatives: number;
  mismatches: number;
  candidateUsed: boolean;
  requiredCandidate: boolean;
  equal: boolean;
}
export interface StaticStatement {
  sql: string;
  params: unknown[];
  limit: number;
  candidateUsed: boolean;
  sqlHash: string;
}
export interface StaticScan {
  nodeType: string;
  indexName: string | null;
  rows: number;
  loops: number;
  returnedRows: number;
  visitedRows: number;
  tokenEquality: boolean;
  uniqueIdLookup: boolean;
}
export interface StaticPlan {
  plan: SanitizedExplain;
  rootBuffers: Record<string, number>;
  postingScans: StaticScan[];
  ticketScans: StaticScan[];
  postingIndexExecuted: boolean;
  postingVisitedRows: number;
  ticketVisitedRows: number;
}
export interface SearchStaticReport {
  completed: boolean;
  equivalent: boolean;
  protocolCompleted: boolean;
  catalogComplete: boolean;
  indexProofComplete: boolean;
  authorizationAdoption: false;
  adoptionEstablished: false;
  catalog?: Record<string, boolean | number | string>;
  generatedColumnMatches?: boolean;
  slaBoundary?: {
    missingPolicyRows: number;
    tiedRows: number;
    nativeNullPreserved: true;
    idTieOrder: true;
  };
  corpus: {
    matrixPairs: number;
    additionalPairs: number;
    boundaryPairs: number;
    cases: Array<{
      label: string;
      kind: 'matrix' | 'additional' | 'boundary';
      completed: boolean;
      tokenCount?: number;
      preprocessingMs?: number;
      fallback?: string;
      comparison?: StaticProjectionComparison;
    }>;
  };
  nativeCases: Array<{
    label: string;
    key: StaticActorKey;
    completed: boolean;
    tokenCount?: number;
    candidateUsed?: boolean;
    preprocessingMs?: number;
    statementHashes?: { legacy: string; candidate: string };
    comparison?: QueryComparison;
    rows?: number;
    total?: number;
    organization?: boolean;
    requester?: boolean;
  }>;
  boundaries: Array<{
    key: StaticContextKey;
    completed: boolean;
    httpAuthenticationProven: false;
    tickets?: number;
    postings?: number;
    foreignTickets?: number;
    foreignPostings?: number;
    otherRequesterTickets?: number;
    requesterIsolationAdopted?: false;
  }>;
  plans: Array<{
    label: string;
    completed: boolean;
    preprocessingMs: number;
    tokenCount: number;
    candidateUsed: boolean;
    candidateIds?: number | null;
    legacy?: StaticPlan;
    candidate?: StaticPlan;
    requiredIndex?: boolean;
    indexProven?: boolean;
    ticketReevaluationBounded?: boolean;
  }>;
  readOnlyContexts: Array<{
    key: StaticContextKey;
    stage: string;
    proof: ReadOnlyProof;
    autocloseDisabled: true;
  }>;
  elapsedMs: number;
  failureCode?: string;
}
export function escapeStaticKeyword(keyword: string): string | null;
export function parseStaticPattern(pattern: unknown): StaticPattern;
export function sanitizeStaticCatalog(rows: unknown): Record<string, boolean | number | string>;
export function buildStaticStatement(
  built: BuiltQuery,
  options: ListOptions,
  organizationId: string,
  tokens?: Buffer[],
): StaticStatement;
export function summarizeStaticPlan(document: unknown): StaticPlan;
export function proveStaticNarrowing(plan: StaticPlan, candidateIds: number): boolean;
export function compareStaticProjection(
  rows: unknown,
  expectedRows: number,
  requiredCandidate: boolean,
  usedCandidate: boolean,
): StaticProjectionComparison;
export function analyzeSearchStatic(options: {
  withReadOnly<T>(
    key: StaticContextKey,
    callback: (client: AnalysisClient) => Promise<T>,
  ): Promise<T>;
  buildTicketListQuery(ctx: AuthzContext, options: ListOptions): BuiltQuery;
  fixture: StaticFixture;
  corpus: StaticCorpus;
  signal?: AbortSignal;
  onProgress?: (stage: StaticProgress) => void;
}): Promise<SearchStaticReport>;
