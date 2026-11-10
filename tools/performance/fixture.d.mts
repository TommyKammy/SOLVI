import type { ActorRole, WorkloadProfile } from './workload.mjs';

export interface FixtureActor {
  userId: string;
  email: string;
  role: ActorRole;
  ticketId: string;
  ticketSubject: string;
  /** Non-enumerable; only supplied to the real local login request. */
  readonly password: string;
}
export interface FixtureCounts {
  users: number;
  tickets: number;
  usersByStatus: Array<{ status: string; n: number }>;
  roles: Array<{ code: string; n: number }>;
  states: Array<{ state: string; n: number }>;
  priorities: Array<{ priority: string; n: number }>;
  assignment: Array<{ unassigned: boolean; ungrouped: boolean; n: number }>;
  groups: number;
  memberships: number;
  comments: number;
  catalog: number;
  approvals: number;
  credentials: number;
  readReceipts: number;
  attachments: number;
  controlUsers: number;
  controlTickets: number;
}
export interface PerformanceFixture {
  organizationId: string;
  controlOrganizationId: string;
  controlTicketId: string;
  catalogItemId: string;
  serviceRequestId: string;
  counts: FixtureCounts;
  /** Non-enumerable; omitted from fixture report JSON. */
  readonly actors: FixtureActor[];
}
export interface FixtureAdminClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
export function seedFixture(
  admin: FixtureAdminClient,
  profile: WorkloadProfile,
  options: {
    createCredential: (params: {
      userId: string;
      password: string;
      subject: string;
    }) => Promise<{ ok: true } | { ok: false; reason?: string }>;
    databaseName: string;
  },
): Promise<PerformanceFixture>;
