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

  /**
   * 役割を与える (WP-P1-IDM-015)。
   *
   * **これまで役割を配る経路が無かった。** シードとSQLでしか付けられず、
   * 新しく構築した環境では誰にも権限を与えられなかった。
   * [[WP-P2-GRP-015]] で「機能を作るとき、それを管理する手段を同時に作る」と
   * 決めた原則(DL-022)が、役割そのものには適用されていなかった。
   */
  /**
   * 利用者を作る (WP-P1-IDM-016)。
   *
   * **作るだけで、入れるようにはしない。** 資格情報の設定は
   * `create_local_user` が別に行う([[WP-P1-IDM-012]])。
   */
  async createUser(auth: AuthenticatedRequest, body: unknown) {
    const record = (typeof body === 'object' && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    const result = await this.run(auth, (service) =>
      service.createUser(auth.authz, {
        email: typeof record.email === 'string' ? record.email : '',
        displayName: typeof record.displayName === 'string' ? record.displayName : '',
        roleCode: typeof record.roleCode === 'string' ? record.roleCode : '',
        reason: typeof record.reason === 'string' ? record.reason : '',
      }),
    );
    return { status: 201, body: { userId: result.userId } };
  }

  async grantRole(auth: AuthenticatedRequest, userId: string, body: unknown) {
    const record = (typeof body === 'object' && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    const roleCode = typeof record.roleCode === 'string' ? record.roleCode : '';
    const reason = typeof record.reason === 'string' ? record.reason : '';
    const validUntil = readValidUntil(record.validUntil);

    await this.run(auth, (service) =>
      service.grantRole(auth.authz, userId, roleCode, { validUntil, reason }),
    );
    return { status: 204, body: null };
  }

  async revokeRole(auth: AuthenticatedRequest, userId: string, body: unknown) {
    const record = (typeof body === 'object' && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    const roleCode = typeof record.roleCode === 'string' ? record.roleCode : '';
    const reason = typeof record.reason === 'string' ? record.reason : '';

    await this.run(auth, (service) => service.revokeRole(auth.authz, userId, roleCode, reason));
    return { status: 204, body: null };
  }

  async reactivate(auth: AuthenticatedRequest, userId: string, body: unknown) {
    const reason = readReason(body);
    await this.run(auth, (service) => service.reactivate(auth.authz, userId, reason));
    return { status: 204, body: null };
  }
}

/**
 * 期限の読み取り (FR-IDM-006)。
 *
 * **日付だけを受け取る。** 時刻まで指定させると、
 * 「その日いっぱい使える」つもりの人が朝で切られる。
 * 指定された日の終わりまでを有効とする。
 */
function readValidUntil(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw Problems.validation([
      { field: 'validUntil', message: '期限は YYYY-MM-DD で入力してください' },
    ]);
  }
  const parsed = new Date(`${value}T23:59:59.999Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw Problems.validation([{ field: 'validUntil', message: '期限の日付が正しくありません' }]);
  }
  return parsed;
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
