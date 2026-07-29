import type pg from 'pg';
import { Problems } from '@solvi/shared';
import { GroupService } from './group.service.js';
import type { PoolDenialRecorder } from '../../common/audit/denial-recorder.js';
import type { AuthenticatedRequest } from '../auth/auth.routes.js';

/**
 * 担当グループの管理 (FR-TKT-003 / WP-P2-GRP-015)。
 *
 * **管理する手段を同時に作る。** グループへ振る機能だけを作って
 * 作る手段を用意しないと、新しく構築した環境では誰もグループを作れず、
 * 機能が使えない。シードのデータでしか動かないものは、
 * 「作ったが使えない」状態である。
 *
 * 作る・無効化する・メンバーを入れ替えるのは組織の管理者。
 * 担当者は振るだけで、組織の体制を変えられない。
 */

export interface GroupRouteDeps {
  pool: pg.Pool;
  denialRecorder: PoolDenialRecorder;
}

export class GroupController {
  constructor(private readonly deps: GroupRouteDeps) {}

  private async run<T>(
    auth: AuthenticatedRequest,
    fn: (service: GroupService) => Promise<T>,
  ): Promise<T> {
    const client = await this.deps.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', [
        'app.current_org',
        auth.authz.organizationId,
      ]);
      const out = await fn(new GroupService(client, this.deps.denialRecorder));
      await client.query('COMMIT');
      return out;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 一覧。
   *
   * `?includeInactive=1` で無効化したものも返す。既定に含めないのは、
   * 振り先として使えないものが選択肢に並ぶのを避けるため。
   */
  async list(auth: AuthenticatedRequest, query: URLSearchParams) {
    const includeInactive = query.get('includeInactive') === '1';
    const groups = await this.run(auth, (service) => service.list(auth.authz, includeInactive));
    return {
      status: 200,
      body: {
        items: groups.map((g) => ({
          id: g.id,
          code: g.code,
          name: g.name,
          description: g.description,
          active: g.active,
          memberCount: g.memberCount,
        })),
      },
    };
  }

  /** 本人の所属。「自分のキュー」の絞り込みに使う。 */
  async mine(auth: AuthenticatedRequest) {
    const groups = await this.run(auth, (service) => service.myGroups(auth.authz));
    return {
      status: 200,
      body: { items: groups.map((g) => ({ id: g.id, code: g.code, name: g.name })) },
    };
  }

  async create(auth: AuthenticatedRequest, body: unknown) {
    const record = (typeof body === 'object' && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    const group = await this.run(auth, (service) =>
      service.create(auth.authz, {
        code: typeof record.code === 'string' ? record.code : '',
        name: typeof record.name === 'string' ? record.name : '',
        ...(typeof record.description === 'string' ? { description: record.description } : {}),
      }),
    );
    return { status: 201, body: { id: group.id, code: group.code, name: group.name } };
  }

  /**
   * 有効・無効の切り替え。
   *
   * POST で受ける。削除ではないが**運用に影響する変更**であり、
   * リンクを踏んだだけで起きる経路を作らない。
   */
  async setActive(auth: AuthenticatedRequest, groupId: string, body: unknown) {
    const record = (typeof body === 'object' && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    if (typeof record.active !== 'boolean') {
      throw Problems.validation([{ field: 'active', message: '有効・無効を指定してください' }]);
    }
    await this.run(auth, (service) =>
      service.setActive(auth.authz, groupId, record.active as boolean),
    );
    return { status: 204, body: null };
  }

  async listMembers(auth: AuthenticatedRequest, groupId: string) {
    const members = await this.run(auth, (service) => service.listMembers(auth.authz, groupId));
    return {
      status: 200,
      body: {
        items: members.map((m) => ({
          userId: m.userId,
          displayName: m.displayName,
          addedAt: m.addedAt.toISOString(),
        })),
      },
    };
  }

  async addMember(auth: AuthenticatedRequest, groupId: string, body: unknown) {
    const record = (typeof body === 'object' && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    const userId = typeof record.userId === 'string' ? record.userId.trim() : '';
    if (userId.length === 0) {
      throw Problems.validation([{ field: 'userId', message: '追加する利用者を選んでください' }]);
    }
    await this.run(auth, (service) => service.addMember(auth.authz, groupId, userId));
    return { status: 204, body: null };
  }

  async removeMember(auth: AuthenticatedRequest, groupId: string, body: unknown) {
    const record = (typeof body === 'object' && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    const userId = typeof record.userId === 'string' ? record.userId.trim() : '';
    if (userId.length === 0) {
      throw Problems.validation([{ field: 'userId', message: '外す利用者を選んでください' }]);
    }
    await this.run(auth, (service) => service.removeMember(auth.authz, groupId, userId));
    return { status: 204, body: null };
  }
}
