import type pg from 'pg';
import { z } from 'zod';

export interface OperationSessionInput {
  sessionId: string;
  userId: string;
  organizationId: string;
}
export type OperationSessionValidation =
  | { valid: true }
  | {
      valid: false;
      reason: 'session_invalid' | 'organization_changed' | 'user_inactive' | 'role_invalid';
    };

/** ADR0040: current operation authority, without a token lookup or idle extension.
 * The caller supplies the authenticated session ID and an existing org transaction.
 * This does not prove cancellation on an A -> B -> A organization round trip.
 */
export class OperationSessionService {
  constructor(
    private readonly client: pg.PoolClient | pg.Client,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async validate(
    input: OperationSessionInput,
    options: { lock?: boolean } = {},
  ): Promise<OperationSessionValidation> {
    const uuid = z.string().uuid();
    if (
      ![input.sessionId, input.userId, input.organizationId].every(
        (value) => uuid.safeParse(value).success,
      )
    )
      return { valid: false, reason: 'session_invalid' };
    let now = this.now();
    if (!Number.isFinite(now.getTime())) return { valid: false, reason: 'session_invalid' };
    const { rows } = await this.client.query<{
      organization_id: string | null;
      issued_at: Date;
      absolute_expires_at: Date;
      idle_expires_at: Date;
      revoked_at: Date | null;
      user_status: string;
      allowed: boolean;
    }>(
      `SELECT s.organization_id, s.issued_at, s.absolute_expires_at,
              s.idle_expires_at, s.revoked_at, u.status AS user_status,
              EXISTS (
                SELECT 1 FROM role_binding rb JOIN role r ON r.id=rb.role_id
                 WHERE rb.user_id=s.user_id AND rb.organization_id=$3::uuid
                   AND r.code='org_admin' AND rb.valid_from <= $4
                   AND (rb.valid_until IS NULL OR rb.valid_until > $4)
              ) AS allowed
         FROM session s JOIN app_user u ON u.id=s.user_id
        WHERE s.id=$1::uuid AND s.user_id=$2::uuid${options.lock ? ' FOR SHARE OF s,u' : ''}`,
      [input.sessionId, input.userId, input.organizationId, now],
    );
    const row = rows[0];
    // Write/worker transactions may hold authority stable until their commit.
    // No auth data is modified. GET remains usable inside a READ ONLY transaction.
    let allowed = row?.allowed === true;
    if (options.lock && row) {
      const bindings = await this.client.query<{
        valid_from: Date;
        valid_until: Date | null;
      }>(
        `SELECT rb.valid_from,rb.valid_until
           FROM role_binding rb JOIN role r ON r.id=rb.role_id
          WHERE rb.user_id=$1::uuid AND rb.organization_id=$2::uuid
            AND r.code='org_admin' FOR SHARE OF rb`,
        [input.userId, input.organizationId],
      );
      // Both SELECTs can wait on concurrent revocation. Evaluate time afterwards.
      now = this.now();
      allowed = bindings.rows.some(
        (binding) =>
          binding.valid_from instanceof Date &&
          Number.isFinite(binding.valid_from.getTime()) &&
          binding.valid_from <= now &&
          (binding.valid_until === null ||
            (binding.valid_until instanceof Date &&
              Number.isFinite(binding.valid_until.getTime()) &&
              binding.valid_until > now)),
      );
    }
    const date = (value: unknown): value is Date =>
      value instanceof Date && Number.isFinite(value.getTime());
    if (
      rows.length !== 1 ||
      !row ||
      !Number.isFinite(now.getTime()) ||
      row.revoked_at !== null ||
      !date(row.issued_at) ||
      !date(row.absolute_expires_at) ||
      !date(row.idle_expires_at) ||
      row.issued_at > now ||
      row.absolute_expires_at <= now ||
      row.idle_expires_at <= now ||
      row.idle_expires_at > row.absolute_expires_at
    )
      return { valid: false, reason: 'session_invalid' };
    if (row.organization_id !== input.organizationId)
      return { valid: false, reason: 'organization_changed' };
    if (row.user_status !== 'active') return { valid: false, reason: 'user_inactive' };
    if (!allowed) return { valid: false, reason: 'role_invalid' };
    return { valid: true };
  }
}
