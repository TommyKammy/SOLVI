import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { UserAdminController } from '../../services/api/src/modules/auth/user-admin.routes.js';
import { UserAdminService } from '../../services/api/src/modules/auth/user-admin.service.js';
import type { AuthenticatedRequest } from '../../services/api/src/modules/auth/auth.routes.js';

const org = '00000000-0000-4000-8000-000000000001';
const actor = '00000000-0000-4000-8000-000000000002';
const target = '00000000-0000-4000-8000-000000000003';
const auth: AuthenticatedRequest = {
  userId: actor,
  sessionId: actor,
  authz: {
    organizationId: org,
    principal: {
      userId: actor,
      status: 'active',
      bindings: [
        { roleCode: 'org_admin', organizationId: org, validFrom: new Date(0), validUntil: null },
      ],
    },
  },
};
const member = {
  id: target,
  display_name: '停止した利用者',
  primary_email: 'synthetic@example.test',
  status: 'deactivated',
  deactivated_at: new Date('2026-10-01Z'),
  role_codes: ['agent', 'requester'],
  temporary_roles: [],
};
function setup(options: { failCount?: boolean; empty?: boolean } = {}) {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('array_remove(array_agg')) return { rows: options.empty ? [] : [member] };
    if (sql.includes('GROUP BY assignee_id')) {
      if (options.failCount) throw new Error('injected count failure');
      return { rows: [{ assignee_id: target, open_tickets: 3 }] };
    }
    return { rows: [] };
  });
  const release = vi.fn();
  const client = { query, release } as unknown as pg.PoolClient;
  const connect = vi.fn(async () => client);
  const controller = new UserAdminController({ pool: { connect } as unknown as pg.Pool });
  return { query, release, client, connect, controller };
}

describe('administrator directory read transaction', () => {
  it('uses one client and one repeatable read snapshot for members and bulk counts', async () => {
    const { controller, query, connect, release } = setup();
    expect(await controller.list(auth)).toEqual({
      status: 200,
      body: {
        items: [
          {
            userId: target,
            displayName: member.display_name,
            email: member.primary_email,
            status: member.status,
            deactivatedAt: member.deactivated_at.toISOString(),
            roleCodes: member.role_codes,
            temporaryRoles: [],
            openTicketCount: 3,
            primaryDepartmentId: null,
            primaryDepartmentName: null,
            managerUserId: null,
            managerDisplayName: null,
            jobTitle: null,
          },
        ],
        profileCompleteness: {
          totalMembers: 0,
          missingManager: 0,
          missingDepartment: 0,
          totalDepartments: 0,
          missingDepartmentHead: 0,
        },
      },
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(query.mock.calls[1]).toEqual([
      'SELECT set_config($1, $2, true)',
      ['app.current_org', org],
    ]);
    expect(query.mock.calls[2]![0]).not.toMatch(/\b(?:FROM|JOIN) ticket\b/);
    expect(query.mock.calls[3]![1]).toEqual([org, [target]]);
    // プロフィール充足率は同じスナップショットで読む(メンバー + 部署の2問い合わせ)。
    expect(query.mock.calls[4]![0]).toContain('missing_manager');
    expect(query.mock.calls[5]![0]).toContain('missing_department_head');
    expect(query.mock.calls[6]![0]).toBe('COMMIT');
    expect(query).toHaveBeenCalledTimes(7);
    expect(release).toHaveBeenCalledOnce();
  });
  it('does not issue bulk SQL for an empty authorized directory', async () => {
    const { client, query } = setup({ empty: true });
    expect(await new UserAdminService(client).listMembers(auth.authz)).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('rolls back and releases on count failure without returning a successful directory', async () => {
    const { controller, query, release } = setup({ failCount: true });
    await expect(controller.list(auth)).rejects.toThrow('injected count failure');
    expect(query.mock.calls.at(-1)![0]).toBe('ROLLBACK');
    expect(query.mock.calls.map(([sql]) => sql)).not.toContain('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });
  it('retains the ordinary writable BEGIN on a rejected mutation', async () => {
    const { controller, query, release } = setup();
    await expect(
      controller.deactivate(auth, actor, { reason: 'security test' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(query.mock.calls[0]![0]).toBe('BEGIN');
    expect(query.mock.calls.at(-1)![0]).toBe('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
  });
});

describe('UserAdmin direct Ticket SQL architecture guard', () => {
  it('accepts the public service and rejects qualified/quoted direct reads or writes in both owned files', () => {
    const root = mkdtempSync(join(tmpdir(), 'solvi-architecture-045-'));
    try {
      const script = join(root, 'tools/check_architecture.mjs');
      mkdirSync(dirname(script), { recursive: true });
      writeFileSync(script, readFileSync(join(process.cwd(), 'tools/check_architecture.mjs')));
      const dir = join(root, 'services/api/src/modules/auth');
      mkdirSync(dir, { recursive: true });
      const cases = [
        [
          'user-admin.service.ts',
          "import { TicketAssignmentReadService } from '../ticket/ticket-assignment-read.service.js';",
          0,
        ],
        [
          'user-admin.service.ts',
          'const sql = `SELECT count(*) FROM ticket WHERE assignee_id=$1`;',
          1,
        ],
        ['user-admin.routes.ts', 'const sql = `SELECT * FROM public."ticket"`;', 1],
        ['user-admin.service.ts', 'const sql = `select * from "public" . "ticket"`;', 1],
        ['user-admin.routes.ts', 'const sql = `UPDATE ticket SET subject=$1`;', 1],
      ] as const;
      for (const [file, source, status] of cases) {
        for (const name of ['user-admin.service.ts', 'user-admin.routes.ts'])
          writeFileSync(join(dir, name), '');
        writeFileSync(join(dir, file), source);
        const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 10000 });
        expect(result.status, result.stdout + result.stderr).toBe(status);
        if (status === 1) expect(result.stderr).toContain('TicketAssignmentReadService');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
