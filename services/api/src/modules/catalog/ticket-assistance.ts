import type pg from 'pg';
import { Problems } from '@solvi/shared';
import { recordAuditEvent } from '../../common/audit/audit.js';
import type { AuthenticatedRequest } from '../auth/auth.routes.js';
import { TicketService } from '../ticket/ticket.service.js';

const suggestionVersion = 1;
const decisions = {
  accepted: 'ai.suggestion.accepted',
  rejected: 'ai.suggestion.rejected',
} as const;

interface AssistanceRequest {
  id: string;
  organization_id: string;
  revision: number;
  state: string;
  title: string;
  item_version: string;
  receipt_id: string | null;
}

async function loadRequest(
  client: pg.PoolClient,
  auth: AuthenticatedRequest,
  ticketId: string,
  lock = false,
) {
  const ticket = await new TicketService(client).findById(auth.authz, ticketId);
  if (ticket.kind !== 'request') return null;
  const { rows } = await client.query<AssistanceRequest>(
    `SELECT q.id, q.organization_id, q.revision, q.state,
            q.snapshot #>> '{item,title}' AS title,
            q.snapshot #>> '{item,version}' AS item_version, receipt.id AS receipt_id
       FROM local_service_request q
       LEFT JOIN local_simulation_receipt receipt
         ON receipt.organization_id = q.organization_id AND receipt.request_id = q.id
      WHERE q.organization_id = $1 AND q.ticket_id = $2
      LIMIT 2${lock ? ' FOR UPDATE OF q' : ''}`,
    [ticket.organizationId, ticket.id],
  );
  if (rows.length > 1) throw Problems.conflict('同じチケットの申請を一意に確認できません');
  return rows[0] ?? null;
}

async function findDecision(client: pg.PoolClient, request: AssistanceRequest) {
  const { rows } = await client.query<{ event_type: string; decided_at: Date }>(
    `SELECT event_type, occurred_at AS decided_at FROM audit_event
      WHERE organization_id = $1 AND target_type = 'service_request' AND target_id = $2
        AND event_type = ANY($3::text[])
        AND after_state->>'requestRevision' = $4
        AND after_state->>'suggestionVersion' = $5
      ORDER BY occurred_at DESC, event_id DESC LIMIT 1`,
    [
      request.organization_id,
      request.id,
      Object.values(decisions),
      String(request.revision),
      String(suggestionVersion),
    ],
  );
  const decision = rows[0];
  if (!decision) return null;
  return {
    kind:
      decision.event_type === decisions.accepted ? ('accepted' as const) : ('rejected' as const),
    decidedAt: decision.decided_at,
  };
}

export async function readTicketAssistance(
  client: pg.PoolClient,
  auth: AuthenticatedRequest,
  ticketId: string,
) {
  const request = await loadRequest(client, auth, ticketId);
  if (!request) return { assistance: null };
  const decision = await findDecision(client, request);
  return {
    assistance: {
      suggestionVersion,
      requestId: request.id,
      requestRevision: request.revision,
      source: { title: request.title, version: Number(request.item_version) },
      canDecide: request.state === 'pending' && decision === null,
      decision,
      receiptId: request.receipt_id,
    },
  };
}

export async function decideTicketAssistance(
  client: pg.PoolClient,
  auth: AuthenticatedRequest,
  ticketId: string,
  choice: { decision: keyof typeof decisions; requestRevision: number; suggestionVersion: number },
) {
  const request = await loadRequest(client, auth, ticketId, true);
  if (!request) throw Problems.notFound('このチケットのAI支援');
  if (
    choice.suggestionVersion !== suggestionVersion ||
    choice.requestRevision !== request.revision
  ) {
    throw Problems.stale('提案の確認に使った版');
  }
  // The request lock serializes decisions for the same revision, including a retry
  // that arrives after approval. New decisions are allowed during approval intake only.
  const existing = await findDecision(client, request);
  if (existing?.kind === choice.decision) return { replayed: true };
  if (existing) throw Problems.conflict('この版の提案は判断済みです');
  if (request.state !== 'pending') throw Problems.conflict('承認待ちの申請で判断を記録できます');

  await recordAuditEvent(client, {
    eventType: decisions[choice.decision],
    organizationId: request.organization_id,
    actorType: 'user',
    actorId: auth.userId,
    targetType: 'service_request',
    targetId: request.id,
    action: choice.decision,
    outcome: 'success',
    afterState: { ticketId, requestRevision: request.revision, suggestionVersion },
  });
  return { replayed: false };
}
