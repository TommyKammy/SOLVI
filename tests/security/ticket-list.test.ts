/**
 * 一覧の権限絞り込みと割当(TL-06 / TL-03 / TL-15 / WP-P2-OPS-003)。
 *
 * 一覧は「条件に合う全件」を返すため、認可が絞り込みに入っていないと
 * 一度に大量に漏れる。ここでは件数を数えるだけでなく、
 * **他者・他組織のIDが1件も混ざらないこと**を集合として確認する。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { TicketService } from '../../services/api/src/modules/ticket/ticket.service.js';
import { buildListQuery } from '../../services/api/src/modules/ticket/ticket-query.js';
import { PoolDenialRecorder } from '../../services/api/src/common/audit/denial-recorder.js';
import type { AuthzContext, Principal } from '../../services/api/src/common/authz/authz.js';
import { runWithContext, newContext } from '@solvi/shared';
import { cleanBusinessData, cleanAuditData } from '../support/cleanup.js';

const ORG_A = '00000000-0000-4000-9000-000000000001';
const ORG_B = '00000000-0000-4000-9000-000000000002';
const PAST = new Date('2026-01-01T00:00:00Z');

let pool: pg.Pool;
let admin: pg.Client;
let denials: PoolDenialRecorder;
const users = new Map<string, string>();

const ctxFor = (userId: string, roleCode: string, orgId: string): AuthzContext => ({
  principal: {
    userId,
    status: 'active',
    bindings: [
      { roleCode: roleCode as never, organizationId: orgId, validFrom: PAST, validUntil: null },
    ],
  } satisfies Principal,
  organizationId: orgId,
});

async function inOrg<T>(orgId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_org', orgId]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const svc = (c: pg.PoolClient) => new TicketService(c, denials);

const input = (subject: string) => ({
  kind: 'incident' as const,
  subject,
  body: '本文',
  impact: 'medium' as const,
  urgency: 'medium' as const,
});

beforeAll(async () => {
  const appUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!appUrl || !adminUrl) throw new Error('DATABASE_URL と DATABASE_ADMIN_URL が必要です');
  pool = new pg.Pool({ connectionString: appUrl, max: 10 });
  denials = new PoolDenialRecorder(pool);
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const { rows } = await admin.query(`
    SELECT rb.organization_id, r.code AS role_code, u.id AS user_id
      FROM role_binding rb JOIN role r ON r.id = rb.role_id JOIN app_user u ON u.id = rb.user_id
     WHERE rb.source = 'seed' AND u.status = 'active'
  `);
  for (const row of rows) users.set(`${row.organization_id}:${row.role_code}`, row.user_id);
});

afterAll(async () => {
  await admin?.end();
  await pool?.end();
});

beforeEach(async () => {
  await admin.query('DELETE FROM ticket_assignment');
  await cleanBusinessData(admin);
  await cleanAuditData(admin, "target_type = 'ticket'");
});

/** 各組織・各依頼者のチケットを作る */
async function seedTickets() {
  const requesterA = users.get(`${ORG_A}:requester`)!;
  const approverA = users.get(`${ORG_A}:approver`)!;
  const agentA = users.get(`${ORG_A}:agent`)!;
  const agentB = users.get(`${ORG_B}:agent`)!;

  const tickets = {
    byRequesterA: [] as string[],
    byApproverA: [] as string[],
    inOrgB: [] as string[],
  };

  await runWithContext(newContext(), () =>
    inOrg(ORG_A, async (c) => {
      for (let i = 0; i < 3; i++) {
        const t = await svc(c).create(
          ctxFor(requesterA, 'requester', ORG_A),
          input(`依頼者A-${i}`),
        );
        tickets.byRequesterA.push(t.id);
      }
      for (let i = 0; i < 2; i++) {
        const t = await svc(c).create(ctxFor(approverA, 'approver', ORG_A), input(`承認者A-${i}`));
        tickets.byApproverA.push(t.id);
      }
    }),
  );
  await runWithContext(newContext(), () =>
    inOrg(ORG_B, async (c) => {
      for (let i = 0; i < 4; i++) {
        const t = await svc(c).create(ctxFor(agentB, 'agent', ORG_B), input(`B社-${i}`));
        tickets.inOrgB.push(t.id);
      }
    }),
  );
  return { ...tickets, requesterA, approverA, agentA, agentB };
}

describe('一覧の権限絞り込み (NFR-SEC-006 / 脅威 T-02)', () => {
  it('依頼者の一覧に自分以外のチケットが1件も含まれない', async () => {
    const s = await seedTickets();
    const result = await inOrg(ORG_A, (c) =>
      svc(c).list(ctxFor(s.requesterA, 'requester', ORG_A), { limit: 100 }),
    );
    const ids = new Set(result.items.map((t) => t.id));
    expect(ids.size).toBe(3);
    // 他者・他組織のIDが1件も混ざらないこと
    for (const foreign of [...s.byApproverA, ...s.inOrgB]) {
      expect(ids.has(foreign)).toBe(false);
    }
    expect(result.scope).toBe('own');
  });

  it('担当者は組織内の全件を見られるが他組織は1件も含まれない', async () => {
    const s = await seedTickets();
    const result = await inOrg(ORG_A, (c) =>
      svc(c).list(ctxFor(s.agentA, 'agent', ORG_A), { limit: 100 }),
    );
    const ids = new Set(result.items.map((t) => t.id));
    expect(ids.size).toBe(5); // requesterA 3 + approverA 2
    for (const foreign of s.inOrgB) expect(ids.has(foreign)).toBe(false);
    expect(result.scope).toBe('organization');
  });

  it('件数(total)も権限で絞られる(全体件数を漏らさない)', async () => {
    const s = await seedTickets();
    const asRequester = await inOrg(ORG_A, (c) =>
      svc(c).list(ctxFor(s.requesterA, 'requester', ORG_A), { limit: 1 }),
    );
    const asAgent = await inOrg(ORG_A, (c) =>
      svc(c).list(ctxFor(s.agentA, 'agent', ORG_A), { limit: 1 }),
    );
    expect(asRequester.total).toBe(3);
    expect(asAgent.total).toBe(5);
    // 依頼者から見た総数が組織全体(5)や全体(9)になっていないこと
    expect(asRequester.total).not.toBe(9);
  });

  it('認可条件がSQLのWHERE句に含まれている', () => {
    const requesterQuery = buildListQuery(ctxFor('u1', 'requester', ORG_A));
    expect(requesterQuery.sql).toContain('t.organization_id = $1');
    expect(requesterQuery.sql).toContain('t.requester_id = $2');
    // 件数クエリにも同じ条件が入っていること
    expect(requesterQuery.countSql).toContain('t.organization_id = $1');
    expect(requesterQuery.countSql).toContain('t.requester_id = $2');

    const agentQuery = buildListQuery(ctxFor('u2', 'agent', ORG_A));
    expect(agentQuery.sql).toContain('t.organization_id = $1');
    expect(agentQuery.sql).not.toContain('requester_id');
  });
});

describe('フィルタ (FR-TKT-006)', () => {
  it('状態で絞り込める', async () => {
    const s = await seedTickets();
    const agentCtx = ctxFor(s.agentA, 'agent', ORG_A);
    await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) =>
        svc(c).transition(agentCtx, {
          ticketId: s.byRequesterA[0]!,
          to: 'assigned',
          reason: 'assign',
        }),
      ),
    );
    const result = await inOrg(ORG_A, (c) =>
      svc(c).list(agentCtx, { filter: { state: ['assigned'] }, limit: 100 }),
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.id).toBe(s.byRequesterA[0]);
  });

  it('キーワードで件名を部分一致検索できる', async () => {
    const s = await seedTickets();
    const result = await inOrg(ORG_A, (c) =>
      svc(c).list(ctxFor(s.agentA, 'agent', ORG_A), { filter: { keyword: '承認者A' }, limit: 100 }),
    );
    expect(result.items).toHaveLength(2);
  });

  it('番号の前方一致で検索できる', async () => {
    const s = await seedTickets();
    const all = await inOrg(ORG_A, (c) =>
      svc(c).list(ctxFor(s.agentA, 'agent', ORG_A), { limit: 100 }),
    );
    const number = all.items[0]!.number;
    const result = await inOrg(ORG_A, (c) =>
      svc(c).list(ctxFor(s.agentA, 'agent', ORG_A), { filter: { keyword: number }, limit: 100 }),
    );
    expect(result.items.map((t) => t.id)).toContain(all.items[0]!.id);
  });

  it('未割当のみに絞り込める', async () => {
    const s = await seedTickets();
    const agentCtx = ctxFor(s.agentA, 'agent', ORG_A);
    await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) => svc(c).assign(agentCtx, s.byRequesterA[0]!, s.agentA)),
    );
    const result = await inOrg(ORG_A, (c) =>
      svc(c).list(agentCtx, { filter: { unassignedOnly: true }, limit: 100 }),
    );
    expect(result.items).toHaveLength(4);
    expect(result.items.map((t) => t.id)).not.toContain(s.byRequesterA[0]);
  });

  it('フィルタ値のSQL片がパラメータとして扱われる(注入されない)', async () => {
    const s = await seedTickets();
    const result = await inOrg(ORG_A, (c) =>
      svc(c).list(ctxFor(s.agentA, 'agent', ORG_A), {
        filter: { keyword: "'; DROP TABLE ticket; --" },
        limit: 100,
      }),
    );
    expect(result.items).toHaveLength(0);
    // テーブルが残っていること
    const { rows } = await admin.query("SELECT to_regclass('public.ticket') AS t");
    expect(rows[0].t).toBe('ticket');
  });

  it('未知のソート列を拒否する', () => {
    expect(() =>
      buildListQuery(ctxFor('u1', 'agent', ORG_A), {
        // 許可リストにない値を意図的に渡す
        sort: { column: 'body; DROP TABLE ticket' as never, direction: 'desc' },
      }),
    ).toThrow();
  });
});

describe('キーセットページネーション', () => {
  it('連続取得で重複・欠落が発生しない', async () => {
    const agentA = users.get(`${ORG_A}:agent`)!;
    const agentCtx = ctxFor(agentA, 'agent', ORG_A);
    await runWithContext(newContext(), () =>
      inOrg(ORG_A, async (c) => {
        for (let i = 0; i < 25; i++) await svc(c).create(agentCtx, input(`ページ-${i}`));
      }),
    );

    const collected: string[] = [];
    let cursor = undefined as { createdAt: string; id: string } | undefined;
    for (let page = 0; page < 10; page++) {
      const result: Awaited<ReturnType<TicketService['list']>> = await inOrg(ORG_A, (c) =>
        svc(c).list(agentCtx, { limit: 10, ...(cursor ? { cursor } : {}) }),
      );
      collected.push(...result.items.map((t) => t.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }

    expect(collected).toHaveLength(25);
    expect(new Set(collected).size).toBe(25); // 重複なし
  });

  it('ページを進めても total が減らない(残り件数ではなく総件数)', async () => {
    const agentA = users.get(`${ORG_A}:agent`)!;
    const agentCtx = ctxFor(agentA, 'agent', ORG_A);
    await runWithContext(newContext(), () =>
      inOrg(ORG_A, async (c) => {
        for (let i = 0; i < 25; i++) await svc(c).create(agentCtx, input(`total-${i}`));
      }),
    );
    const first = await inOrg(ORG_A, (c) => svc(c).list(agentCtx, { limit: 10 }));
    const second = await inOrg(ORG_A, (c) =>
      svc(c).list(agentCtx, { limit: 10, cursor: first.nextCursor! }),
    );
    expect(first.total).toBe(25);
    expect(second.total).toBe(25);
  });

  it('マイクロ秒精度のカーソルで次ページが空にならない', async () => {
    // 同一トランザクションで作ると created_at が全件同一になる。
    // カーソルを JS Date 経由で往復させるとマイクロ秒が落ち、次ページが0件になる。
    const agentA = users.get(`${ORG_A}:agent`)!;
    const agentCtx = ctxFor(agentA, 'agent', ORG_A);
    await runWithContext(newContext(), () =>
      inOrg(ORG_A, async (c) => {
        for (let i = 0; i < 12; i++) await svc(c).create(agentCtx, input(`micro-${i}`));
      }),
    );
    const first = await inOrg(ORG_A, (c) => svc(c).list(agentCtx, { limit: 10 }));
    expect(first.nextCursor).not.toBeNull();
    // カーソルは文字列であり、Date へ変換されていないこと
    expect(typeof first.nextCursor!.createdAt).toBe('string');
    const second = await inOrg(ORG_A, (c) =>
      svc(c).list(agentCtx, { limit: 10, cursor: first.nextCursor! }),
    );
    expect(second.items).toHaveLength(2);
  });

  it('取得の途中で新規作成されても既存分の重複が起きない', async () => {
    const agentA = users.get(`${ORG_A}:agent`)!;
    const agentCtx = ctxFor(agentA, 'agent', ORG_A);
    await runWithContext(newContext(), () =>
      inOrg(ORG_A, async (c) => {
        for (let i = 0; i < 15; i++) await svc(c).create(agentCtx, input(`既存-${i}`));
      }),
    );

    const first = await inOrg(ORG_A, (c) => svc(c).list(agentCtx, { limit: 10 }));
    // 1ページ目の取得後に新しいチケットが作られる状況を再現
    await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) => svc(c).create(agentCtx, input('割り込み'))),
    );
    const second = await inOrg(ORG_A, (c) =>
      svc(c).list(agentCtx, { limit: 10, cursor: first.nextCursor! }),
    );

    const ids = [...first.items, ...second.items].map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length); // 重複なし
    // 新しく作られたチケットは1ページ目より前に来るため、2ページ目には現れない
    expect(second.items.some((t) => t.subject === '割り込み')).toBe(false);
  });
});

describe('担当割当 (FR-TKT-003)', () => {
  it('割当で監査イベントと履歴が生成される', async () => {
    const s = await seedTickets();
    const agentCtx = ctxFor(s.agentA, 'agent', ORG_A);
    const ticketId = s.byRequesterA[0]!;

    await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) => svc(c).assign(agentCtx, ticketId, s.agentA)),
    );

    const { rows: audit } = await admin.query(
      "SELECT after_state FROM audit_event WHERE event_type = 'ticket.assigned' AND target_id = $1",
      [ticketId],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].after_state).toMatchObject({ assigneeId: s.agentA });

    const { rows: history } = await admin.query(
      'SELECT assignee_id, previous_assignee_id FROM ticket_assignment WHERE ticket_id = $1',
      [ticketId],
    );
    expect(history).toHaveLength(1);
    expect(history[0].previous_assignee_id).toBeNull();
  });

  it('他組織のユーザを担当者にできない', async () => {
    const s = await seedTickets();
    const agentCtx = ctxFor(s.agentA, 'agent', ORG_A);
    try {
      await runWithContext(newContext(), () =>
        inOrg(ORG_A, (c) => svc(c).assign(agentCtx, s.byRequesterA[0]!, s.agentB)),
      );
      throw new Error('例外が投げられませんでした');
    } catch (error) {
      const problem = error as { status?: number; errors?: Array<{ message: string }> };
      expect(problem.status).toBe(400);
      expect(problem.errors?.[0]?.message).toMatch(/所属していません/);
    }

    const { rows } = await admin.query(
      "SELECT policy_decision FROM audit_event WHERE outcome = 'denied' AND target_id = $1",
      [s.byRequesterA[0]],
    );
    expect(rows[0].policy_decision).toMatchObject({ rule: 'assignee_membership' });
  });

  it('割当解除も履歴に残る', async () => {
    const s = await seedTickets();
    const agentCtx = ctxFor(s.agentA, 'agent', ORG_A);
    const ticketId = s.byRequesterA[0]!;
    await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) => svc(c).assign(agentCtx, ticketId, s.agentA)),
    );
    const unassigned = await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) => svc(c).assign(agentCtx, ticketId, null)),
    );
    expect(unassigned.assigneeId).toBeNull();

    const { rows } = await admin.query(
      'SELECT assignee_id, previous_assignee_id FROM ticket_assignment WHERE ticket_id = $1 ORDER BY assigned_at',
      [ticketId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[1].assignee_id).toBeNull();
    expect(rows[1].previous_assignee_id).toBe(s.agentA);
  });

  it('同じ相手への再割当は履歴を増やさない', async () => {
    const s = await seedTickets();
    const agentCtx = ctxFor(s.agentA, 'agent', ORG_A);
    const ticketId = s.byRequesterA[0]!;
    for (let i = 0; i < 3; i++) {
      await runWithContext(newContext(), () =>
        inOrg(ORG_A, (c) => svc(c).assign(agentCtx, ticketId, s.agentA)),
      );
    }
    const { rows } = await admin.query(
      'SELECT count(*)::int AS n FROM ticket_assignment WHERE ticket_id = $1',
      [ticketId],
    );
    expect(rows[0].n).toBe(1);
  });

  it('依頼者は割当できない', async () => {
    const s = await seedTickets();
    await expect(
      runWithContext(newContext(), () =>
        inOrg(ORG_A, (c) =>
          svc(c).assign(ctxFor(s.requesterA, 'requester', ORG_A), s.byRequesterA[0]!, s.agentA),
        ),
      ),
    ).rejects.toThrow();
  });
});
