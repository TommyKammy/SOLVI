/**
 * WP-P4-APR-011: 全ステップ承認の実行前検証 assertApprovalComplete。
 *
 * 合成データのみ。実PostgreSQLでの検証は tests/security/approval-assertion.test.ts。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type pg from 'pg';
import type { Logger } from '@solvi/shared';
import {
  assertApprovalComplete,
  checkApprovalComplete,
  type ApprovalFailure,
} from '../../services/api/src/modules/catalog/approval-assertion';
import { canonical, hash } from '../../services/api/src/modules/catalog/snapshot-hash';
import { CatalogController } from '../../services/api/src/modules/catalog/catalog.routes';
import { TicketService } from '../../services/api/src/modules/ticket/ticket.service';
import { CollaborationService } from '../../services/api/src/modules/ticket/collaboration.service';
import type { AuthenticatedRequest } from '../../services/api/src/modules/auth/auth.routes';

const org = '11111111-1111-4111-8111-111111111111';
const requester = '33333333-3333-4333-8333-333333333333';
const approver = '44444444-4444-4444-8444-444444444444';
const otherApprover = '88888888-8888-4888-8888-888888888888';
const agentId = '22222222-2222-4222-8222-222222222222';
const itemId = '55555555-5555-4555-8555-555555555555';
const requestId = '66666666-6666-4666-8666-666666666666';
const approvalId = '99999999-9999-4999-8999-999999999999';
const ticketId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('snapshot-hash 固定ベクトル(抽出前の実装の出力と一致する)', () => {
  const snapshot = {
    item: {
      id: itemId,
      version: 2,
      title: '合成 VPN',
      definition: {
        mode: 'local_simulation',
        action: 'simulate.access_grant',
        targetLabel: '検証用',
        allowedDurations: [1, 7],
        maxReasonLength: 2000,
        approval: { mode: 'fixed', approverId: approver },
        checklist: [{ key: 'prepare', label: '準備', required: true }],
      },
    },
    inputs: {
      reason: '合成: "引用" \\ ✓',
      durationDays: 7,
      values: { b: true, a: ['x', 'y'], n: 1.5, z: null },
    },
    requesterId: requester,
  };
  it('canonical はキーを整列し、配列の順序を保つ', () => {
    expect(canonical(snapshot)).toBe(
      '{"inputs":{"durationDays":7,"reason":"合成: \\"引用\\" \\\\ ✓","values":{"a":["x","y"],"b":true,"n":1.5,"z":null}},"item":{"definition":{"action":"simulate.access_grant","allowedDurations":[1,7],"approval":{"approverId":"44444444-4444-4444-8444-444444444444","mode":"fixed"},"checklist":[{"key":"prepare","label":"準備","required":true}],"maxReasonLength":2000,"mode":"local_simulation","targetLabel":"検証用"},"id":"55555555-5555-4555-8555-555555555555","title":"合成 VPN","version":2},"requesterId":"33333333-3333-4333-8333-333333333333"}',
    );
    expect(canonical([3, { b: 1, a: [] }])).toBe('[3,{"a":[],"b":1}]');
  });
  it('hash は抽出前と1ビットも変わらない', () => {
    expect(hash(snapshot)).toBe('53aa4eb3668f042862504ba1fbc07198665ba95a4a81ca0139521fde5e426ca6');
    expect(hash({})).toBe('44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
    expect(hash('x')).toBe('ba2df4903a2c14e86dc3bcca58911b44ac1d2514b7227bf6eb08cfb978f55a1b');
  });
  it('キーの並びが違っても同じ値になる', () => {
    expect(hash({ a: 1, b: { c: 2, d: 3 } })).toBe(hash({ b: { d: 3, c: 2 }, a: 1 }));
  });
});

type Approval = {
  id: string;
  request_id: string;
  approver_id: string;
  state: string;
  snapshot_hash: string;
  revision: number;
  expires_at: Date;
  decided_at: Date | null;
};
const definition = (fixed = true) => ({
  mode: 'local_simulation' as const,
  action: 'simulate.access_grant',
  targetLabel: '合成対象',
  allowedDurations: [7],
  maxReasonLength: 2000,
  ...(fixed ? { approval: { mode: 'fixed', approverId: approver } } : {}),
  checklist: [{ key: 'prepare', label: '準備確認', required: true }],
});

function database({ fixed = true } = {}) {
  const snapshot = {
    item: { id: itemId, version: 1, title: '合成', definition: definition(fixed) },
    inputs: { reason: '合成', durationDays: 7 },
    requesterId: requester,
  };
  const request = {
    id: requestId,
    organization_id: org,
    requester_id: requester,
    ticket_id: ticketId,
    version: 3,
    revision: 1,
    state: 'approved',
    snapshot,
    snapshot_hash: hash(snapshot),
    current_approval_id: approvalId,
  };
  const approvals: Approval[] = [
    {
      id: approvalId,
      request_id: requestId,
      approver_id: approver,
      state: 'approved',
      snapshot_hash: request.snapshot_hash,
      revision: 1,
      expires_at: new Date(Date.now() + 3_600_000),
      decided_at: new Date(Date.now() - 60_000),
    },
  ];
  const state = {
    revisionHash: request.snapshot_hash,
    progress: null as null | object,
    omit: [] as string[],
  };
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || sql.includes('set_config'))
      return { rows: [], rowCount: 0 };
    if (sql.includes('SELECT * FROM local_service_request'))
      return { rows: [request], rowCount: 1 };
    if (sql.includes("a.state<>'invalidated'")) {
      const rows = approvals
        .filter((a) => a.revision === params[2] && a.state !== 'invalidated')
        .map((a) => ({ ...a, revision_hash_ok: state.revisionHash === params[3] }))
        .map((a) => {
          const copy: Record<string, unknown> = { ...a };
          for (const key of state.omit) delete copy[key];
          return copy;
        });
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('SELECT * FROM local_request_approval')) {
      const rows = approvals.filter((a) => a.id === params[0]);
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('FROM local_request_approval a JOIN local_request_revision')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('FROM local_request_checklist_progress'))
      return {
        rows: state.progress ? [state.progress] : [],
        rowCount: state.progress ? 1 : 0,
      };
    if (sql.includes('FROM local_simulation_receipt')) return { rows: [], rowCount: 0 };
    if (sql.includes('SELECT id,display_name FROM app_user')) return { rows: [], rowCount: 0 };
    if (
      sql.includes('SELECT display_name AS name FROM app_user') ||
      sql.includes('FROM assignment_group')
    )
      return { rows: [], rowCount: 0 };
    if (sql.includes('SELECT DISTINCT u.id')) return { rows: [], rowCount: 0 };
    if (/^(INSERT|UPDATE)/.test(sql.trim())) return { rows: [], rowCount: 1 };
    throw new Error('Unhandled approval-assertion test query: ' + sql.slice(0, 70));
  });
  const client = { query, release: vi.fn() } as unknown as pg.PoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
  return { request, approvals, state, query, client, pool };
}
const params = { organizationId: org, requestId };
const row = (db: ReturnType<typeof database>) => db.approvals[0]!;

describe('assertApprovalComplete: 成功', () => {
  it.each([true, false])('固定承認者あり=%s の1段承認が通り、承認行を返す', async (fixed) => {
    const db = database({ fixed });
    await expect(assertApprovalComplete(db.client, params)).resolves.toEqual([
      { approvalId, approverId: approver },
    ]);
    expect(await checkApprovalComplete(db.client, params)).toEqual({
      ok: true,
      steps: [{ approvalId, approverId: approver }],
    });
  });
  it('承認者の現在の有効性は検査しない(所属・ロールの照会を行わない)', async () => {
    const db = database();
    await assertApprovalComplete(db.client, params);
    expect(db.query.mock.calls.some(([sql]) => sql.includes('SELECT DISTINCT u.id'))).toBe(false);
    expect(db.query.mock.calls.some(([sql]) => sql.includes('role_binding'))).toBe(false);
    expect(db.query.mock.calls.some(([sql]) => sql.includes('app_user'))).toBe(false);
  });
});

describe('assertApprovalComplete: 拒否(409)', () => {
  const cases: [string, ApprovalFailure, (db: ReturnType<typeof database>) => void][] = [
    [
      '申請が approved でない(pending)',
      'request_not_approved',
      (db) => (db.request.state = 'pending'),
    ],
    [
      '申請が invalidated(取消・変更後)',
      'request_not_approved',
      (db) => (db.request.state = 'invalidated'),
    ],
    ['申請が completed', 'request_not_approved', (db) => (db.request.state = 'completed')],
    ['承認行が pending', 'approval_not_approved', (db) => (row(db).state = 'pending')],
    ['承認行が rejected', 'approval_not_approved', (db) => (row(db).state = 'rejected')],
    [
      '現在の版に有効な承認行が2行ある',
      'approval_row_count',
      (db) => db.approvals.push({ ...row(db), id: otherApprover, approver_id: otherApprover }),
    ],
    [
      'current_approval_id が承認行と一致しない',
      'approval_not_current',
      (db) => (db.request.current_approval_id = otherApprover),
    ],
    [
      '現在の版に有効な承認行がない(全て invalidated)',
      'no_current_approval',
      (db) => (row(db).state = 'invalidated'),
    ],
    ['期限切れ', 'approval_expired', (db) => (row(db).expires_at = new Date(Date.now() - 1000))],
    [
      'decided_at が期限より後',
      'decided_after_expiry',
      (db) => (row(db).decided_at = new Date(row(db).expires_at.getTime() + 1000)),
    ],
    [
      'approved なのに decided_at がない',
      'decided_after_expiry',
      (db) => (row(db).decided_at = null),
    ],
    [
      '申請の snapshot_hash と承認行が不一致',
      'snapshot_hash_mismatch',
      (db) => (row(db).snapshot_hash = '0'.repeat(64)),
    ],
    [
      'snapshot本文を改変して再計算値と不一致',
      'snapshot_tampered',
      (db) => (db.request.snapshot.inputs.reason = '承認後の改変'),
    ],
    [
      '版(local_request_revision)の snapshot_hash と不一致',
      'revision_hash_mismatch',
      (db) => (db.state.revisionHash = '1'.repeat(64)),
    ],
    [
      'revision が申請と承認行で不一致(版を取り違えた承認行は有効行にならない)',
      'no_current_approval',
      (db) => (row(db).revision = 2),
    ],
    [
      '固定承認者が承認行の承認者と不一致',
      'fixed_approver_mismatch',
      (db) => (row(db).approver_id = otherApprover),
    ],
    [
      '申請者=承認者',
      'self_approval',
      (db) => {
        row(db).approver_id = requester;
        db.request.snapshot.item.definition = definition(false);
        db.request.snapshot_hash = hash(db.request.snapshot);
        row(db).snapshot_hash = db.request.snapshot_hash;
        db.state.revisionHash = db.request.snapshot_hash;
      },
    ],
  ];
  it.each(cases)('%s', async (_name, reason, mutate) => {
    const db = database();
    mutate(db);
    expect(await checkApprovalComplete(db.client, params)).toEqual({ ok: false, reason });
    await expect(assertApprovalComplete(db.client, params)).rejects.toMatchObject({ status: 409 });
  });
  it('応答に内部状態(ID・hash値)を含めず、詳細な理由はログにだけ残す', async () => {
    const db = database();
    row(db).approver_id = otherApprover;
    const warn = vi.fn();
    const error = await assertApprovalComplete(db.client, params, {
      warn,
    } as unknown as Logger).catch((e: unknown) => e as { detail?: string; message?: string });
    const text = JSON.stringify(error) + String((error as Error).message);
    for (const secret of [approver, otherApprover, requester, approvalId, db.request.snapshot_hash])
      expect(text).not.toContain(secret);
    expect(warn).toHaveBeenCalledWith(
      'catalog.approval.incomplete',
      expect.objectContaining({ reason: 'fixed_approver_mismatch' }),
    );
  });
  it('申請が存在しなければ拒否する', async () => {
    const db = database();
    db.query.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));
    await expect(checkApprovalComplete(db.client, params)).resolves.toEqual({
      ok: false,
      reason: 'request_not_found',
    });
  });
});

describe('fail closed: 検証に必要な列が欠けた行は通さない', () => {
  it.each([
    ['revision_hash_ok', 'revision_hash_mismatch'],
    ['decided_at', 'decided_after_expiry'],
    ['expires_at', 'approval_expired'],
  ] as const)('%s が無い承認行は %s で拒否する', async (column, reason) => {
    const db = database();
    db.state.omit = [column];
    expect(await checkApprovalComplete(db.client, params)).toEqual({ ok: false, reason });
    await expect(assertApprovalComplete(db.client, params)).rejects.toMatchObject({ status: 409 });
  });
});

describe('ADR-0023 §7 承認者の現在の有効性を要求しない', () => {
  it('承認者が無効でも、承認済みなら検証は通る(照会自体をしない)', async () => {
    const db = database();
    // 以前は validateApprover が「現在有効な承認者」を再照会し、無効なら403で止めていた。
    await expect(assertApprovalComplete(db.client, params)).resolves.toHaveLength(1);
  });
});

const actor = (role: 'agent' | 'requester'): AuthenticatedRequest => ({
  userId: role === 'agent' ? agentId : requester,
  sessionId: itemId,
  authz: {
    organizationId: org,
    principal: {
      userId: role === 'agent' ? agentId : requester,
      status: 'active',
      bindings: [
        {
          roleCode: role,
          organizationId: org,
          validFrom: new Date(Date.now() - 60000),
          validUntil: null,
        },
      ],
    },
  },
});
const storage = {} as ConstructorParameters<typeof CatalogController>[1];
// 検証関数の最初の照会(ロック用の FOR UPDATE ではない申請の読み取り)で、呼び出しを数える
const isAssertionQuery = ([sql]: [string, ...unknown[]]) =>
  sql.includes('SELECT * FROM local_service_request') && !sql.includes('FOR UPDATE');

describe('3つの呼び出し箇所すべてが検証を通る', () => {
  afterEach(() => vi.restoreAllMocks());
  it('fulfillment(canUpdate): 例外を投げず ok で判定する', async () => {
    const db = database();
    const controller = new CatalogController(db.pool, storage, true);
    const ok = await controller.detail(actor('agent'), requestId);
    expect(ok.fulfillment.canUpdate).toBe(true);
    expect(db.query.mock.calls.filter(isAssertionQuery)).toHaveLength(1);
    row(db).decided_at = new Date(row(db).expires_at.getTime() + 1000);
    const ng = await controller.detail(actor('agent'), requestId);
    expect(ng.fulfillment.canUpdate).toBe(false);
    expect(db.query.mock.calls.filter(isAssertionQuery)).toHaveLength(2);
  });
  it('updateChecklist: 成功時に検証を通り、承認者の再照会をしない', async () => {
    const db = database();
    await new CatalogController(db.pool, storage, true).updateChecklist(actor('agent'), requestId, {
      requestRevision: 1,
      expectedVersion: 1,
      key: 'prepare',
      completed: true,
    });
    expect(db.query.mock.calls.filter(isAssertionQuery)).toHaveLength(1);
    expect(db.query.mock.calls.some(([sql]) => sql.includes('SELECT DISTINCT u.id'))).toBe(false);
    expect(
      db.query.mock.calls.some(([sql]) =>
        sql.includes('INSERT INTO local_request_checklist_progress'),
      ),
    ).toBe(true);
  });
  it('updateChecklist: 検証失敗で409になり、書込みしない(ログに理由が残る)', async () => {
    const db = database();
    db.request.state = 'invalidated';
    const warn = vi.fn();
    await expect(
      new CatalogController(db.pool, storage, true, { warn } as unknown as Logger).updateChecklist(
        actor('agent'),
        requestId,
        { requestRevision: 1, expectedVersion: 1, key: 'prepare', completed: true },
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(db.query.mock.calls.filter(isAssertionQuery)).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      'catalog.approval.incomplete',
      expect.objectContaining({ reason: 'request_not_approved' }),
    );
    expect(
      db.query.mock.calls.some(([sql]) =>
        sql.includes('INSERT INTO local_request_checklist_progress'),
      ),
    ).toBe(false);
  });
  function stubSimulation() {
    vi.spyOn(TicketService.prototype, 'findById').mockImplementation(
      async () => ({ state: 'resolved' }) as never,
    );
    vi.spyOn(CollaborationService.prototype, 'addComment').mockImplementation(
      async () => ({}) as never,
    );
  }
  it('simulate: 成功時に検証を通り、承認行IDでレシートを保存する', async () => {
    const db = database();
    db.state.progress = { version: 2, completion: { prepare: { completed: true } } };
    stubSimulation();
    const result = await new CatalogController(db.pool, storage, true).simulate(
      actor('agent'),
      requestId,
      { expectedVersion: 3 },
    );
    expect(result.replayed).toBe(false);
    expect(db.query.mock.calls.filter(isAssertionQuery)).toHaveLength(1);
    expect(db.query.mock.calls.some(([sql]) => sql.includes('SELECT DISTINCT u.id'))).toBe(false);
    const insert = db.query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO local_simulation_receipt'),
    );
    expect(insert?.[1]?.[3]).toBe(approvalId);
  });
  it.each([
    ['申請が approved でない', (db: ReturnType<typeof database>) => (db.request.state = 'pending')],
    [
      '期限切れ',
      (db: ReturnType<typeof database>) => (row(db).expires_at = new Date(Date.now() - 1)),
    ],
    [
      'snapshot改変',
      (db: ReturnType<typeof database>) => (db.request.snapshot.inputs.reason = '改変'),
    ],
  ])('simulate: %s なら 409 で、レシートも完了更新も作らない', async (_n, mutate) => {
    const db = database();
    db.state.progress = { version: 2, completion: { prepare: { completed: true } } };
    mutate(db);
    stubSimulation();
    await expect(
      new CatalogController(db.pool, storage, true).simulate(actor('agent'), requestId, {
        expectedVersion: 3,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(db.query.mock.calls.filter(isAssertionQuery)).toHaveLength(1);
    expect(
      db.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO local_simulation_receipt')),
    ).toBe(false);
  });
  it('simulate: 既存レシートの返却(冪等リプレイ)は検証より前で、検証を行わない', async () => {
    const db = database();
    const receipt = { id: ticketId, result: { status: 'succeeded' } };
    const inner = db.query.getMockImplementation()!;
    db.query.mockImplementation(async (sql: string, p?: unknown[]) =>
      sql.includes('SELECT id,result FROM local_simulation_receipt')
        ? { rows: [receipt], rowCount: 1 }
        : inner(sql, p),
    );
    db.request.state = 'invalidated'; // 検証していれば409になる状態でも、既存レシートは返す
    await expect(
      new CatalogController(db.pool, storage, true).simulate(actor('agent'), requestId, {
        expectedVersion: 1,
      }),
    ).resolves.toEqual({ receipt, replayed: true });
    expect(db.query.mock.calls.filter(isAssertionQuery)).toHaveLength(0);
  });
});

describe('approvalMatches の置き換えが完了している(静的確認)', () => {
  const roots = ['services', 'apps', 'packages', 'tests', 'tools'];
  const skip = new Set(['node_modules', 'dist', '.next', 'coverage', '.turbo']);
  const self = resolve(__dirname, 'approval-assertion.test.ts');
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const full = join(dir, name);
      const info = statSync(full);
      if (info.isDirectory()) walk(full, out);
      else if (/\.(ts|tsx|mjs|js|json)$/.test(name)) out.push(full);
    }
    return out;
  };
  it('services/apps/packages/tests/tools に approvalMatches の参照が0件', () => {
    const repo = resolve(__dirname, '../..');
    const hits = roots
      .flatMap((r) => walk(join(repo, r)))
      .filter((f) => f !== self)
      .filter((f) => readFileSync(f, 'utf8').includes('approvalMatches'))
      .map((f) => relative(repo, f));
    expect(hits).toEqual([]);
  });
});
