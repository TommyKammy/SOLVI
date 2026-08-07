import type pg from 'pg';
import { Problems } from '@solvi/shared';
import { UserAdminService } from './user-admin.service.js';
import type { AuthenticatedRequest } from './auth.routes.js';

/**
 * 在籍者の管理 (FR-IDM-007 / WP-P1-IDM-011)。
 *
 * 停止・復帰は組織の管理者だけが行う。
 * **停止は本人の業務を止める操作**であり、理由を必須にする。
 */

export interface UserAdminRouteDeps {
  pool: pg.Pool;
}

export class UserAdminController {
  constructor(private readonly deps: UserAdminRouteDeps) {}

  private async run<T>(
    auth: AuthenticatedRequest,
    fn: (service: UserAdminService) => Promise<T>,
  ): Promise<T> {
    const client = await this.deps.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', [
        'app.current_org',
        auth.authz.organizationId,
      ]);
      const out = await fn(new UserAdminService(client));
      await client.query('COMMIT');
      return out;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async list(auth: AuthenticatedRequest) {
    const members = await this.run(auth, (service) => service.listMembers(auth.authz));
    return {
      status: 200,
      body: {
        items: members.map((m) => ({
          userId: m.userId,
          displayName: m.displayName,
          email: m.email,
          status: m.status,
          deactivatedAt: m.deactivatedAt?.toISOString() ?? null,
          roleCodes: m.roleCodes,
          temporaryRoles: m.temporaryRoles,
          openTicketCount: m.openTicketCount,
        })),
      },
    };
  }

  /**
   * 停止。
   *
   * POST で受ける。停止は取り消せる操作だが、**その場でセッションが切れる**。
   * リンクを踏んだだけで起きる経路を作らない。
   */
  async deactivate(auth: AuthenticatedRequest, userId: string, body: unknown) {
    const reason = readReason(body);
    const result = await this.run(auth, (service) =>
      service.deactivate(auth.authz, userId, reason),
    );
    return {
      status: 200,
      body: {
        revokedSessions: result.revokedSessions,
        // **残っている担当を返す。** 止めたあとで気付けるようにする。
        openTicketCount: result.openTicketCount,
      },
    };
  }

  async reactivate(auth: AuthenticatedRequest, userId: string, body: unknown) {
    const reason = readReason(body);
    await this.run(auth, (service) => service.reactivate(auth.authz, userId, reason));
    return { status: 204, body: null };
  }
}

function readReason(body: unknown): string {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const reason = typeof record.reason === 'string' ? record.reason : '';
  // 長さと空の判定はサービス層が持つ。ここで二重に持つと片方だけ直る。
  if (typeof record.reason !== 'string' && record.reason !== undefined) {
    throw Problems.validation([{ field: 'reason', message: '理由を入力してください' }]);
  }
  return reason;
}
