import type pg from 'pg';
import { Problems } from '@solvi/shared';
import {
  UserAdminService,
  type MemberFilters,
  type ProfileUpdateInput,
} from './user-admin.service.js';
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
    readOnly = false,
  ): Promise<T> {
    const client = await this.deps.pool.connect();
    try {
      await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
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

  async list(auth: AuthenticatedRequest, query?: Record<string, string | string[] | undefined>) {
    const filters = parseMemberFilters(query ?? {});
    const result = await this.run(
      auth,
      async (service) => ({
        members: await service.listMembers(auth.authz, filters),
        completeness: await service.profileCompleteness(auth.authz),
      }),
      true,
    );
    return {
      status: 200,
      body: {
        items: result.members.map((m) => ({
          userId: m.userId,
          displayName: m.displayName,
          email: m.email,
          status: m.status,
          deactivatedAt: m.deactivatedAt?.toISOString() ?? null,
          roleCodes: m.roleCodes,
          temporaryRoles: m.temporaryRoles,
          openTicketCount: m.openTicketCount,
          primaryDepartmentId: m.primaryDepartmentId,
          primaryDepartmentName: m.primaryDepartmentName,
          managerUserId: m.managerUserId,
          managerDisplayName: m.managerDisplayName,
          jobTitle: m.jobTitle,
        })),
        profileCompleteness: result.completeness,
      },
    };
  }

  /**
   * 組織プロフィールの取得 (FR-IDM-014)。
   *
   * 閲覧範囲の判定はサービス層(API層)が行う。範囲外は 404。
   */
  async getProfile(auth: AuthenticatedRequest, userId: string) {
    const profile = await this.run(auth, (service) => service.getProfile(auth.authz, userId), true);
    return { status: 200, body: { profile } };
  }

  /**
   * 組織プロフィールの更新 (FR-IDM-011 / FR-IDM-013)。
   *
   * 本文は閉じた項目だけを受け付ける。`organization_id` などの混入は
   * 値を読む前に拒否する(TL-03 / 脅威 T-03)。
   */
  async updateProfile(auth: AuthenticatedRequest, userId: string, body: unknown) {
    const input = readProfileUpdate(body);
    const profile = await this.run(auth, (service) =>
      service.updateProfile(auth.authz, userId, input),
    );
    return { status: 200, body: { profile } };
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

const MEMBER_FILTER_KEYS = new Set(['departmentId', 'managerUserId', 'jobTitle']);
const PROFILE_KEYS = new Set([
  'primaryDepartmentId',
  'managerUserId',
  'jobTitle',
  'location',
  'employeeId',
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 利用者一覧の絞り込みを読み取る (WP-P4-IDM-013 §6)。
 *
 * **知らないキーは拒否する。** とくに `organization_id` は、値を採用しないだけでなく
 * 要求そのものを 400 にする(指定できると思わせない)。
 */
export function parseMemberFilters(
  query: Record<string, string | string[] | undefined>,
): MemberFilters {
  for (const key of Object.keys(query)) {
    if (!MEMBER_FILTER_KEYS.has(key)) {
      throw Problems.validation([{ field: key, message: 'この条件は指定できません' }]);
    }
  }
  const readId = (key: string): string | null => {
    const value = query[key];
    if (value === undefined || value === '') return null;
    if (typeof value !== 'string' || !UUID_RE.test(value)) {
      throw Problems.validation([{ field: key, message: 'IDの形式が正しくありません' }]);
    }
    return value.toLowerCase();
  };
  const jobTitleValue = query.jobTitle;
  if (jobTitleValue !== undefined && typeof jobTitleValue !== 'string') {
    throw Problems.validation([{ field: 'jobTitle', message: '文字列で入力してください' }]);
  }
  const jobTitle = (jobTitleValue ?? '').trim();
  if (jobTitle.length > 200) {
    throw Problems.validation([{ field: 'jobTitle', message: '200文字以内で入力してください' }]);
  }
  return {
    departmentId: readId('departmentId'),
    managerUserId: readId('managerUserId'),
    jobTitle: jobTitle.length > 0 ? jobTitle : null,
  };
}

/**
 * プロフィール更新の本文を読み取る。
 *
 * 値の意味(部署の有効性・上長の所属)はサービス層が再検証する。
 * ここでは型と、指定できる項目だけを確定する。
 */
export function readProfileUpdate(body: unknown): ProfileUpdateInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw Problems.validation([{ field: 'body', message: '要求の形式が正しくありません' }]);
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!PROFILE_KEYS.has(key)) {
      throw Problems.validation([{ field: key, message: 'この項目は指定できません' }]);
    }
  }
  const out: ProfileUpdateInput = {};
  for (const key of ['primaryDepartmentId', 'managerUserId'] as const) {
    if (Object.hasOwn(record, key)) {
      out[key] = readNullableId(record[key], key);
    }
  }
  for (const key of ['jobTitle', 'location', 'employeeId'] as const) {
    if (Object.hasOwn(record, key)) {
      out[key] = readNullableText(record[key], key);
    }
  }
  return out;
}

function readNullableId(value: unknown, field: string): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw Problems.validation([{ field, message: 'IDの形式が正しくありません' }]);
  }
  return value.toLowerCase();
}

function readNullableText(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw Problems.validation([{ field, message: '文字列で入力してください' }]);
  }
  return value;
}
