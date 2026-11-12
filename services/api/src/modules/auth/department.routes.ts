import type pg from 'pg';
import { Problems } from '@solvi/shared';
import { DepartmentService } from './department.service.js';
import type { AuthenticatedRequest } from './auth.routes.js';

/**
 * 部署・部署長の経路 (WP-P4-IDM-013)。
 *
 * 認可 → 同一組織・有効なレコードの再検証 → 更新 → 監査(同一トランザクション)
 * の順で処理する。監査の書込みに失敗すれば、部署の変更もコミットされない。
 */

export interface DepartmentRouteDeps {
  pool: pg.Pool;
}

export class DepartmentController {
  constructor(private readonly deps: DepartmentRouteDeps) {}

  private async run<T>(
    auth: AuthenticatedRequest,
    fn: (service: DepartmentService) => Promise<T>,
    readOnly = false,
  ): Promise<T> {
    const client = await this.deps.pool.connect();
    try {
      await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
      await client.query('SELECT set_config($1, $2, true)', [
        'app.current_org',
        auth.authz.organizationId,
      ]);
      const out = await fn(new DepartmentService(client));
      await client.query('COMMIT');
      return out;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async tree(auth: AuthenticatedRequest) {
    const items = await this.run(auth, (service) => service.listTree(auth.authz), true);
    return { status: 200, body: { items } };
  }

  async members(auth: AuthenticatedRequest, departmentId: string) {
    const items = await this.run(
      auth,
      (service) => service.listMembers(auth.authz, departmentId),
      true,
    );
    return { status: 200, body: { items } };
  }

  async create(auth: AuthenticatedRequest, body: unknown) {
    const input = readCreate(body);
    const department = await this.run(auth, (service) => service.create(auth.authz, input));
    return { status: 201, body: { department } };
  }

  async edit(auth: AuthenticatedRequest, departmentId: string, body: unknown) {
    const input = readEdit(body);
    const department = await this.run(auth, (service) =>
      service.edit(auth.authz, departmentId, input),
    );
    return { status: 200, body: { department } };
  }

  async deactivate(auth: AuthenticatedRequest, departmentId: string) {
    const department = await this.run(auth, (service) =>
      service.deactivate(auth.authz, departmentId),
    );
    return { status: 200, body: { department } };
  }

  async assignHead(auth: AuthenticatedRequest, departmentId: string, body: unknown) {
    const input = readHead(body);
    const head = await this.run(auth, (service) =>
      service.assignHead(auth.authz, departmentId, input),
    );
    return { status: 201, body: { head } };
  }

  async endHead(auth: AuthenticatedRequest, departmentId: string, body: unknown) {
    const input = readHeadEnd(body);
    const head = await this.run(auth, (service) =>
      service.endHead(auth.authz, departmentId, input),
    );
    return { status: 200, body: { head } };
  }
}

const CREATE_KEYS = new Set(['code', 'name', 'parentId']);
const EDIT_KEYS = new Set(['code', 'name', 'parentId']);
const HEAD_KEYS = new Set(['userId']);
const HEAD_END_KEYS = new Set(['validUntil']);

/**
 * 本文のキーを閉じた集合に限定する (TL-03 / 脅威 T-03)。
 * `organization_id` や `approverId` の混入は、値を見る前に拒否する。
 */
function readRecord(body: unknown, allowed: ReadonlySet<string>): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw Problems.validation([{ field: 'body', message: '要求の形式が正しくありません' }]);
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw Problems.validation([{ field: key, message: 'この項目は指定できません' }]);
    }
  }
  return record;
}

function readCreate(body: unknown): { code: string; name: string; parentId?: string | null } {
  const record = readRecord(body, CREATE_KEYS);
  const out: { code: string; name: string; parentId?: string | null } = {
    code: readString(record.code, 'code'),
    name: readString(record.name, 'name'),
  };
  if (Object.hasOwn(record, 'parentId')) out.parentId = readNullableId(record.parentId, 'parentId');
  return out;
}

function readEdit(body: unknown): { code?: string; name?: string; parentId?: string | null } {
  const record = readRecord(body, EDIT_KEYS);
  const out: { code?: string; name?: string; parentId?: string | null } = {};
  if (Object.hasOwn(record, 'code')) out.code = readString(record.code, 'code');
  if (Object.hasOwn(record, 'name')) out.name = readString(record.name, 'name');
  if (Object.hasOwn(record, 'parentId')) out.parentId = readNullableId(record.parentId, 'parentId');
  return out;
}

function readHead(body: unknown): { userId: string } {
  const record = readRecord(body, HEAD_KEYS);
  return { userId: readString(record.userId, 'userId') };
}

function readHeadEnd(body: unknown): { validUntil: Date | null } {
  const record = readRecord(body, HEAD_END_KEYS);
  if (!Object.hasOwn(record, 'validUntil') || record.validUntil === null) {
    return { validUntil: null };
  }
  const value = record.validUntil;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw Problems.validation([
      { field: 'validUntil', message: '終了日は YYYY-MM-DD で入力してください' },
    ]);
  }
  const parsed = new Date(`${value}T23:59:59.999Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw Problems.validation([{ field: 'validUntil', message: '終了日の日付が正しくありません' }]);
  }
  return { validUntil: parsed };
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw Problems.validation([{ field, message: '文字列で入力してください' }]);
  }
  return value;
}

function readNullableId(value: unknown, field: string): string | null {
  if (value === null) return null;
  const id = readString(value, field).trim();
  if (id.length === 0) return null;
  return id;
}
