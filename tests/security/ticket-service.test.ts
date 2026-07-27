/**
 * チケットサービスの統合・境界テスト(TL-04 / TL-06 / WP-P2-TKT-001)。
 *
 * 状態機械の網羅は tests/unit/ticket-state-machine.test.ts。
 * ここでは DB を含めた挙動 ― 採番の一意性、監査の同一トランザクション性、
 * 越境と存在秘匿 ― を検査する。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { TicketService } from '../../services/api/src/modules/ticket/ticket.service.js';
import type { AuthzContext, Principal } from '../../services/api/src/common/authz/authz.js';
import { runWithContext, newContext } from '@solvi/shared';
import { cleanBusinessData, cleanAuditData } from '../support/cleanup.js';
import { PoolDenialRecorder } from '../../services/api/src/common/audit/denial-recorder.js';

const ORG_A = '00000000-0000-4000-9000-000000000001';
const ORG_B = '00000000-0000-4000-9000-000000000002';
const PAST = new Date('2026-01-01T00:00:00Z');

let pool: pg.Pool;
let admin: pg.Client;
let denials: PoolDenialRecorder;
/** seed で作られたユーザ。組織・ロール別に引く。 */
const users = new Map<string, string>();

const principal = (userId: string, roleCode: string, organizationId: string | null): Principal => ({
  userId,
  status: 'active',
  bindings: [{ roleCode: roleCode as never, organizationId, validFrom: PAST, validUntil: null }],
});

const ctxFor = (userId: string, roleCode: string, orgId: string): AuthzContext => ({
  principal: principal(userId, roleCode, orgId),
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

const newTicketInput = () => ({
  kind: 'incident' as const,
  subject: 'メールが送信できない',
  body: '朝からOutlookでエラーが表示されます。',
  impact: 'medium' as const,
  urgency: 'high' as const,
});

beforeAll(async () => {
  const appUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!appUrl || !adminUrl) throw new Error('DATABASE_URL と DATABASE_ADMIN_URL が必要です');
  pool = new pg.Pool({ connectionString: appUrl, max: 10 });
  denials = new PoolDenialRecorder(pool, (e) => console.error('denial audit failed', e));
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();

  const { rows } = await admin.query(`
    SELECT rb.organization_id, r.code AS role_code, u.id AS user_id
      FROM role_binding rb
      JOIN role r ON r.id = rb.role_id
      JOIN app_user u ON u.id = rb.user_id
     WHERE rb.source = 'seed' AND u.status = 'active'
  `);
  for (const row of rows) users.set(`${row.organization_id}:${row.role_code}`, row.user_id);
});

afterAll(async () => {
  await admin?.end();
  await pool?.end();
});

beforeEach(async () => {
  await cleanBusinessData(admin);
  await cleanAuditData(admin, "target_type = 'ticket'");
});

describe('チケットの作成', () => {
  it('種別に応じた番号が採番される', async () => {
    const agent = users.get(`${ORG_A}:agent`)!;
    const ticket = await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) =>
        new TicketService(c, denials).create(ctxFor(agent, 'agent', ORG_A), newTicketInput()),
      ),
    );
    expect(ticket.number).toMatch(/^INC-\d{4}-\d{6}$/);
    expect(ticket.state).toBe('new');
  });

  it('Request は REQ 接頭辞で採番される', async () => {
    const agent = users.get(`${ORG_A}:agent`)!;
    const ticket = await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) =>
        new TicketService(c, denials).create(ctxFor(agent, 'agent', ORG_A), {
          ...newTicketInput(),
          kind: 'request',
        }),
      ),
    );
    expect(ticket.number).toMatch(/^REQ-\d{4}-\d{6}$/);
  });

  it('優先度が impact × urgency から導出される(入力から受け取らない)', async () => {
    const agent = users.get(`${ORG_A}:agent`)!;
    const ticket = await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) =>
        new TicketService(c, denials).create(ctxFor(agent, 'agent', ORG_A), {
          ...newTicketInput(),
          impact: 'high',
          urgency: 'high',
        }),
      ),
    );
    expect(ticket.priority).toBe('critical');
  });

  it('件名が空だと拒否される', async () => {
    const agent = users.get(`${ORG_A}:agent`)!;
    await expect(
      runWithContext(newContext(), () =>
        inOrg(ORG_A, (c) =>
          new TicketService(c, denials).create(ctxFor(agent, 'agent', ORG_A), {
            ...newTicketInput(),
            subject: '   ',
          }),
        ),
      ),
    ).rejects.toThrow();
  });

  it('一般利用者は他人名義で起票できない(依頼者の詐称防止)', async () => {
    const requester = users.get(`${ORG_A}:requester`)!;
    const other = users.get(`${ORG_A}:approver`)!;
    await expect(
      runWithContext(newContext(), () =>
        inOrg(ORG_A, (c) =>
          new TicketService(c, denials).create(ctxFor(requester, 'requester', ORG_A), {
            ...newTicketInput(),
            requesterId: other,
          }),
        ),
      ),
    ).rejects.toThrow();
  });

  it('担当者は代理起票できる', async () => {
    const agent = users.get(`${ORG_A}:agent`)!;
    const requester = users.get(`${ORG_A}:requester`)!;
    const ticket = await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) =>
        new TicketService(c, denials).create(ctxFor(agent, 'agent', ORG_A), {
          ...newTicketInput(),
          requesterId: requester,
        }),
      ),
    );
    expect(ticket.requesterId).toBe(requester);
  });
});

describe('採番の同時実行 (TL-04)', () => {
  it('20件を並行作成しても番号が重複しない', async () => {
    const agent = users.get(`${ORG_A}:agent`)!;
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        runWithContext(newContext(), () =>
          inOrg(ORG_A, (c) =>
            new TicketService(c, denials).create(ctxFor(agent, 'agent', ORG_A), newTicketInput()),
          ),
        ),
      ),
    );
    const numbers = results.map((t) => t.number);
    expect(new Set(numbers).size).toBe(20);
  });

  it('組織が違えば同じ番号が採番されうる(組織内で一意)', async () => {
    const agentA = users.get(`${ORG_A}:agent`)!;
    const agentB = users.get(`${ORG_B}:agent`)!;
    const a = await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) =>
        new TicketService(c, denials).create(ctxFor(agentA, 'agent', ORG_A), newTicketInput()),
      ),
    );
    const b = await runWithContext(newContext(), () =>
      inOrg(ORG_B, (c) =>
        new TicketService(c, denials).create(ctxFor(agentB, 'agent', ORG_B), newTicketInput()),
      ),
    );
    expect(a.number).toBe(b.number);
    expect(a.id).not.toBe(b.id);
  });
});

describe('監査 (AUD-001)', () => {
  it('作成で ticket.created が1件生成される', async () => {
    const agent = users.get(`${ORG_A}:agent`)!;
    const ticket = await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) =>
        new TicketService(c, denials).create(ctxFor(agent, 'agent', ORG_A), newTicketInput()),
      ),
    );
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE event_type = 'ticket.created' AND target_id = $1",
      [ticket.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it('遷移1件につき ticket.transitioned が1件生成される', async () => {
    const agent = users.get(`${ORG_A}:agent`)!;
    const ticket = await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) =>
        new TicketService(c, denials).create(ctxFor(agent, 'agent', ORG_A), newTicketInput()),
      ),
    );
    await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) =>
        new TicketService(c, denials).transition(ctxFor(agent, 'agent', ORG_A), {
          ticketId: ticket.id,
          to: 'assigned',
          reason: 'assign',
        }),
      ),
    );
    const { rows } = await admin.query(
      "SELECT before_state, after_state FROM audit_event WHERE event_type = 'ticket.transitioned' AND target_id = $1",
      [ticket.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].before_state).toMatchObject({ state: 'new' });
    expect(rows[0].after_state).toMatchObject({ state: 'assigned', reason: 'assign' });
  });

  it('監査に本文・件名が入らない (02.17 §4)', async () => {
    const agent = users.get(`${ORG_A}:agent`)!;
    const ticket = await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) =>
        new TicketService(c, denials).create(ctxFor(agent, 'agent', ORG_A), newTicketInput()),
      ),
    );
    const { rows } = await admin.query('SELECT after_state FROM audit_event WHERE target_id = $1', [
      ticket.id,
    ]);
    const serialized = JSON.stringify(rows[0].after_state);
    expect(serialized).not.toContain('Outlook');
    expect(serialized).not.toContain('メールが送信できない');
  });

  it('拒否された遷移が denied として記録される', async () => {
    const agent = users.get(`${ORG_A}:agent`)!;
    const ticket = await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) =>
        new TicketService(c, denials).create(ctxFor(agent, 'agent', ORG_A), newTicketInput()),
      ),
    );
    await expect(
      runWithContext(newContext(), () =>
        inOrg(ORG_A, (c) =>
          // new から直接 resolved へは遷移できない
          new TicketService(c, denials).transition(ctxFor(agent, 'agent', ORG_A), {
            ticketId: ticket.id,
            to: 'resolved',
            reason: 'resolve',
          }),
        ),
      ),
    ).rejects.toThrow();

    const { rows } = await admin.query(
      "SELECT outcome, policy_decision FROM audit_event WHERE event_type = 'authz.access.denied' AND target_id = $1",
      [ticket.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('denied');
    expect(rows[0].policy_decision).toMatchObject({ rule: 'state_machine' });
  });

  it('監査の失敗で状態変更も巻き戻る(同一トランザクション)', async () => {
    const agent = users.get(`${ORG_A}:agent`)!;
    const ticket = await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) =>
        new TicketService(c, denials).create(ctxFor(agent, 'agent', ORG_A), newTicketInput()),
      ),
    );

    // 監査書き込みを失敗させる: event_type の CHECK に違反する値を一時的に使う
    await admin.query(
      'ALTER TABLE audit_event ADD CONSTRAINT tmp_fail CHECK (event_type <> $$ticket.transitioned$$)',
    );
    try {
      await expect(
        runWithContext(newContext(), () =>
          inOrg(ORG_A, (c) =>
            new TicketService(c, denials).transition(ctxFor(agent, 'agent', ORG_A), {
              ticketId: ticket.id,
              to: 'assigned',
              reason: 'assign',
            }),
          ),
        ),
      ).rejects.toThrow();
    } finally {
      await admin.query('ALTER TABLE audit_event DROP CONSTRAINT tmp_fail');
    }

    const { rows } = await admin.query('SELECT state FROM ticket WHERE id = $1', [ticket.id]);
    expect(rows[0].state).toBe('new'); // 巻き戻っている
  });
});

describe('組織境界と存在秘匿 (TL-06 / NFR-SEC-006)', () => {
  it('他組織のチケットは取得できない', async () => {
    const agentB = users.get(`${ORG_B}:agent`)!;
    const ticketB = await runWithContext(newContext(), () =>
      inOrg(ORG_B, (c) =>
        new TicketService(c, denials).create(ctxFor(agentB, 'agent', ORG_B), newTicketInput()),
      ),
    );

    const agentA = users.get(`${ORG_A}:agent`)!;
    await expect(
      inOrg(ORG_A, (c) =>
        new TicketService(c, denials).findById(ctxFor(agentA, 'agent', ORG_A), ticketB.id),
      ),
    ).rejects.toThrow(/見つかりません/);
  });

  it('他人のチケットは依頼者から見えない(404で存在を秘匿)', async () => {
    const agent = users.get(`${ORG_A}:agent`)!;
    const otherRequester = users.get(`${ORG_A}:approver`)!;
    const ticket = await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) =>
        new TicketService(c, denials).create(ctxFor(agent, 'agent', ORG_A), {
          ...newTicketInput(),
          requesterId: otherRequester,
        }),
      ),
    );

    const requester = users.get(`${ORG_A}:requester`)!;
    await expect(
      inOrg(ORG_A, (c) =>
        new TicketService(c, denials).findById(ctxFor(requester, 'requester', ORG_A), ticket.id),
      ),
    ).rejects.toThrow(/見つかりません/);
  });

  it('自分のチケットは依頼者本人から見える', async () => {
    const requester = users.get(`${ORG_A}:requester`)!;
    const ticket = await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) =>
        new TicketService(c, denials).create(
          ctxFor(requester, 'requester', ORG_A),
          newTicketInput(),
        ),
      ),
    );
    const found = await inOrg(ORG_A, (c) =>
      new TicketService(c, denials).findById(ctxFor(requester, 'requester', ORG_A), ticket.id),
    );
    expect(found.id).toBe(ticket.id);
  });

  it('依頼者は自分のチケットを取消できるが、他の遷移はできない', async () => {
    const requester = users.get(`${ORG_A}:requester`)!;
    const ticket = await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) =>
        new TicketService(c, denials).create(
          ctxFor(requester, 'requester', ORG_A),
          newTicketInput(),
        ),
      ),
    );

    await expect(
      runWithContext(newContext(), () =>
        inOrg(ORG_A, (c) =>
          new TicketService(c, denials).transition(ctxFor(requester, 'requester', ORG_A), {
            ticketId: ticket.id,
            to: 'assigned',
            reason: 'assign',
          }),
        ),
      ),
    ).rejects.toThrow();

    const cancelled = await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) =>
        new TicketService(c, denials).transition(ctxFor(requester, 'requester', ORG_A), {
          ticketId: ticket.id,
          to: 'cancelled',
          reason: 'cancel',
        }),
      ),
    );
    expect(cancelled.state).toBe('cancelled');
  });
});

describe('DB制約による整合性', () => {
  it('resolved 以外で resolved_at が入らない', async () => {
    const agent = users.get(`${ORG_A}:agent`)!;
    const ticket = await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) =>
        new TicketService(c, denials).create(ctxFor(agent, 'agent', ORG_A), newTicketInput()),
      ),
    );
    await expect(
      admin.query('UPDATE ticket SET resolved_at = now() WHERE id = $1', [ticket.id]),
    ).rejects.toThrow(/ticket_resolved_at_consistency/);
  });

  it('遷移で resolved_at と closed_at が正しく設定される', async () => {
    const agent = users.get(`${ORG_A}:agent`)!;
    const ctx = ctxFor(agent, 'agent', ORG_A);
    const ticket = await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) => new TicketService(c, denials).create(ctx, newTicketInput())),
    );
    const svc = (c: pg.PoolClient) => new TicketService(c, denials);
    for (const step of [
      { to: 'assigned' as const, reason: 'assign' as const },
      { to: 'in_progress' as const, reason: 'start' as const },
      { to: 'resolved' as const, reason: 'resolve' as const },
    ]) {
      await runWithContext(newContext(), () =>
        inOrg(ORG_A, (c) => svc(c).transition(ctx, { ticketId: ticket.id, ...step })),
      );
    }
    const resolved = await inOrg(ORG_A, (c) => svc(c).findById(ctx, ticket.id));
    expect(resolved.resolvedAt).toBeInstanceOf(Date);
    expect(resolved.closedAt).toBeNull();

    const closed = await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) =>
        svc(c).transition(ctx, { ticketId: ticket.id, to: 'closed', reason: 'close' }),
      ),
    );
    expect(closed.closedAt).toBeInstanceOf(Date);
    expect(closed.resolvedAt).toBeInstanceOf(Date);
  });
});
