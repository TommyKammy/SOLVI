import type pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../../services/api/src/modules/auth/auth.routes';
import {
  decideTicketAssistance,
  readTicketAssistance,
} from '../../services/api/src/modules/catalog/ticket-assistance';

const doubles = vi.hoisted(() => ({
  ticket: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('../../services/api/src/modules/ticket/ticket.service.js', () => ({
  TicketService: class {
    findById = doubles.ticket;
  },
}));
vi.mock('../../services/api/src/common/audit/audit.js', () => ({
  recordAuditEvent: doubles.audit,
}));

const organizationId = '05100000-0000-4000-8000-000000000010';
const ticketId = '05100000-0000-4000-8000-000000000020';
const requestId = '05100000-0000-4000-8000-000000000030';
const userId = '05100000-0000-4000-8000-000000000040';
const auth = { authz: { organizationId }, userId } as AuthenticatedRequest;
const choice = { decision: 'accepted', requestRevision: 5, suggestionVersion: 1 } as const;

function database({
  state = 'pending',
  kind,
}: { state?: string; kind?: 'accepted' | 'rejected' } = {}) {
  const occurred = new Date('2026-11-19T12:00:00Z');
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes('FROM local_service_request')
      ? [
          {
            id: requestId,
            organization_id: organizationId,
            revision: 5,
            state,
            title: '合成申請',
            item_version: '3',
            receipt_id: null,
          },
        ]
      : kind
        ? [{ event_type: 'ai.suggestion.' + kind, decided_at: occurred }]
        : [],
  }));
  return { client: { query } as unknown as pg.PoolClient, query, occurred };
}

beforeEach(() => {
  doubles.ticket.mockReset().mockResolvedValue({ organizationId, id: ticketId, kind: 'request' });
  doubles.audit.mockReset();
});

describe('ticket assistance preview', () => {
  it('uses the authorized ticket, retained catalog version, and current request revision', async () => {
    const { client, query, occurred } = database({ kind: 'accepted' });
    expect(await readTicketAssistance(client, auth, ticketId)).toEqual({
      assistance: {
        suggestionVersion: 1,
        requestId,
        requestRevision: 5,
        source: { title: '合成申請', version: 3 },
        canDecide: false,
        decision: { kind: 'accepted', decidedAt: occurred },
        receiptId: null,
      },
    });
    expect(doubles.ticket).toHaveBeenCalledWith(auth.authz, ticketId);
    expect(query.mock.calls[0]?.[0]).toContain('q.organization_id = $1 AND q.ticket_id = $2');
    expect(doubles.audit).not.toHaveBeenCalled();
  });

  it('does not use approval storage for an incident', async () => {
    const { client, query } = database();
    doubles.ticket.mockResolvedValueOnce({ organizationId, id: ticketId, kind: 'incident' });
    expect(await readTicketAssistance(client, auth, ticketId)).toEqual({ assistance: null });
    expect(query).not.toHaveBeenCalled();
  });

  it('serializes the decision on the request and appends only identifiers and versions', async () => {
    const { client, query } = database();
    expect(await decideTicketAssistance(client, auth, ticketId, choice)).toEqual({
      replayed: false,
    });
    expect(query.mock.calls[0]?.[0]).toContain('FOR UPDATE OF q');
    expect(doubles.audit).toHaveBeenCalledOnce();
    expect(doubles.audit).toHaveBeenCalledWith(client, {
      eventType: 'ai.suggestion.accepted',
      organizationId,
      actorType: 'user',
      actorId: userId,
      targetType: 'service_request',
      targetId: requestId,
      action: 'accepted',
      outcome: 'success',
      afterState: { ticketId, requestRevision: 5, suggestionVersion: 1 },
    });
  });

  it('replays the recorded decision without appending another event after approval', async () => {
    const { client } = database({ kind: 'accepted', state: 'approved' });
    expect(await decideTicketAssistance(client, auth, ticketId, choice)).toEqual({
      replayed: true,
    });
    expect(doubles.audit).not.toHaveBeenCalled();
  });

  it.each([
    [database({ kind: 'rejected' }), choice],
    [database({ state: 'approved' }), choice],
    [database(), { ...choice, requestRevision: 4 }],
    [database(), { ...choice, suggestionVersion: 2 }],
  ])(
    'rejects conflicting, late, and stale decisions without appending a record',
    async ({ client }, input) => {
      await expect(decideTicketAssistance(client, auth, ticketId, input)).rejects.toThrow();
      expect(doubles.audit).not.toHaveBeenCalled();
    },
  );
});
