/**
 * 見ていた内容が古いときの競合 (NFR-UX-004 / WP-P2-UISTATE-020)。
 *
 * ITSMでは**二人が同じ問い合わせを開いている**ことが日常的に起きる。
 * これまで、片方の変更をもう片方が気付かずに上書きできた。
 *
 * 状態機械は不正な遷移を止めるが、**同じ状態のままの上書き**は止めない。
 * A が担当を X に、B が Y に割り当てれば、後から送ったほうが勝つ。
 * 誰も何も知らないまま担当が入れ替わる。
 *
 * ここで確かめるのは3つ。
 *
 *   1. **見ていた版が古ければ拒む**
 *   2. **版を送らない呼び出しは素通しする**(定期処理・API直叩き)
 *   3. **業務規則の競合と別の型で返す** — 利用者がとるべき行動が違う
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { runWithContext, newContext } from '@solvi/shared';
import { TicketService } from '../../services/api/src/modules/ticket/ticket.service.js';
import { NoopDenialRecorder } from '../../services/api/src/common/audit/denial-recorder.js';
import { cleanBusinessData, cleanAuditData } from '../support/cleanup.js';

const ORG_A = '00000000-0000-4000-9000-000000000001';

let pool: pg.Pool;
let admin: pg.Client;
let agentId: string;
let otherAgentId: string;

const PAST = new Date('2026-01-01T00:00:00Z');

const ctxFor = (userId: string) => ({
  principal: {
    userId,
    status: 'active' as const,
    bindings: [
      {
        roleCode: 'agent' as never,
        organizationId: ORG_A,
        validFrom: PAST,
        validUntil: null,
      },
    ],
  },
  organizationId: ORG_A,
});

async function inOrg<T>(fn: (svc: TicketService) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_org', ORG_A]);
    const out = await fn(new TicketService(client, new NoopDenialRecorder()));
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const run = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(newContext(), fn);

/** 新しいチケットを作り、その版を返す。 */
async function makeTicket(): Promise<{ id: string; version: string }> {
  const ticket = await run(() =>
    inOrg((svc) =>
      svc.create(ctxFor(agentId), {
        kind: 'incident',
        subject: '同時に触られる問い合わせ',
        body: '本文です。',
        impact: 'medium',
        urgency: 'medium',
      }),
    ),
  );
  return { id: ticket.id, version: ticket.version };
}

beforeAll(async () => {
  const appUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!appUrl || !adminUrl) throw new Error('DATABASE_URL と DATABASE_ADMIN_URL が必要です');
  pool = new pg.Pool({ connectionString: appUrl, max: 5 });
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();

  const { rows } = await admin.query(
    `SELECT u.id FROM app_user u
      JOIN role_binding rb ON rb.user_id = u.id AND rb.organization_id = $1
      JOIN role r ON r.id = rb.role_id
     WHERE r.code = 'agent' AND u.created_via = 'seed' LIMIT 1`,
    [ORG_A],
  );
  agentId = rows[0].id;

  const { rows: others } = await admin.query(
    `SELECT u.id FROM app_user u
      JOIN role_binding rb ON rb.user_id = u.id AND rb.organization_id = $1
      JOIN role r ON r.id = rb.role_id
     WHERE r.code = 'org_admin' AND u.created_via = 'seed' LIMIT 1`,
    [ORG_A],
  );
  otherAgentId = others[0].id;
});

afterAll(async () => {
  await admin?.end();
  await pool?.end();
});

beforeEach(async () => {
  await cleanBusinessData(admin);
  await cleanAuditData(admin, "target_type = 'ticket'");
});

describe('見ていた版が古ければ拒む', () => {
  it('**担当の割当が上書きされない**', async () => {
    const { id, version } = await makeTicket();

    // B が先に割り当てる
    await run(() => inOrg((svc) => svc.assign(ctxFor(agentId), id, otherAgentId, version)));

    // A は古い版のまま送る
    await expect(
      run(() => inOrg((svc) => svc.assign(ctxFor(agentId), id, agentId, version))),
    ).rejects.toMatchObject({ status: 409 });

    // B の割当が残っている
    const { rows } = await admin.query('SELECT assignee_id FROM ticket WHERE id = $1', [id]);
    expect(rows[0].assignee_id).toBe(otherAgentId);
  });

  it('状態の変更が上書きされない', async () => {
    const { id, version } = await makeTicket();

    await run(() =>
      inOrg((svc) =>
        svc.transition(ctxFor(agentId), {
          ticketId: id,
          to: 'assigned',
          reason: 'assign',
          expectedVersion: version,
        }),
      ),
    );

    await expect(
      run(() =>
        inOrg((svc) =>
          svc.transition(ctxFor(agentId), {
            ticketId: id,
            to: 'assigned',
            reason: 'assign',
            expectedVersion: version,
          }),
        ),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('担当グループの振り替えが上書きされない', async () => {
    const { id, version } = await makeTicket();
    const { rows } = await admin.query(
      'SELECT id FROM assignment_group WHERE organization_id = $1 AND active LIMIT 1',
      [ORG_A],
    );
    const groupId = rows[0].id as string;

    await run(() => inOrg((svc) => svc.assignGroup(ctxFor(agentId), id, groupId, version)));
    await expect(
      run(() => inOrg((svc) => svc.assignGroup(ctxFor(agentId), id, null, version))),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('見立ての見直しが上書きされない', async () => {
    const { id, version } = await makeTicket();

    await run(() =>
      inOrg((svc) =>
        svc.reassess(ctxFor(agentId), {
          ticketId: id,
          impact: 'high',
          urgency: 'high',
          reason: '影響が広いと分かった',
          expectedVersion: version,
        }),
      ),
    );

    await expect(
      run(() =>
        inOrg((svc) =>
          svc.reassess(ctxFor(agentId), {
            ticketId: id,
            impact: 'low',
            urgency: 'low',
            reason: '古い版のまま送る',
            expectedVersion: version,
          }),
        ),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('版を送らない呼び出しは素通しする', () => {
  it('**定期処理やAPI直叩きを止めない**', async () => {
    const { id, version } = await makeTicket();
    await run(() => inOrg((svc) => svc.assign(ctxFor(agentId), id, otherAgentId, version)));

    // 版を渡さなければ、その間の変更があっても通る
    const ticket = await run(() => inOrg((svc) => svc.assign(ctxFor(agentId), id, agentId)));
    expect(ticket.assigneeId).toBe(agentId);
  });

  it('空文字の版も「送っていない」として扱わない(誤って素通ししない)', async () => {
    const { id } = await makeTicket();
    // 空文字は明確に古い版である。**未指定と混ぜると、フォームが空を送ったときに
    // 競合の検出が黙って無効になる。**
    await expect(
      run(() => inOrg((svc) => svc.assign(ctxFor(agentId), id, agentId, ''))),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('新しい版で送れば通る', () => {
  it('読み直してから操作すれば成功する', async () => {
    const { id, version } = await makeTicket();
    await run(() => inOrg((svc) => svc.assign(ctxFor(agentId), id, otherAgentId, version)));

    // 読み直す
    const fresh = await run(() => inOrg((svc) => svc.findById(ctxFor(agentId), id)));
    expect(fresh.version).not.toBe(version);

    const ticket = await run(() =>
      inOrg((svc) => svc.assign(ctxFor(agentId), id, agentId, fresh.version)),
    );
    expect(ticket.assigneeId).toBe(agentId);
  });
});

describe('業務規則の競合と区別する', () => {
  it('**古い版は `stale` 型で返す**(利用者がとるべき行動が違う)', async () => {
    const { id, version } = await makeTicket();
    await run(() => inOrg((svc) => svc.assign(ctxFor(agentId), id, otherAgentId, version)));

    try {
      await run(() => inOrg((svc) => svc.assign(ctxFor(agentId), id, agentId, version)));
      expect.unreachable('競合するはず');
    } catch (error) {
      const problem = error as { status: number; type?: string; title?: string };
      expect(problem.status).toBe(409);
      // 「その記号のグループは既にある」等と同じ型にすると、
      // 画面は「競合が発生しました」としか言えない。
      expect(problem.type).toMatch(/\/stale$/);
      expect(problem.title).toContain('他の人が変更しました');
    }
  });
});

describe('版そのもの', () => {
  it('操作するたびに版が変わる', async () => {
    const { id, version } = await makeTicket();
    const after = await run(() =>
      inOrg((svc) => svc.assign(ctxFor(agentId), id, otherAgentId, version)),
    );
    expect(after.version).not.toBe(version);
  });

  it('**読むだけでは版が変わらない**(読んだだけで競合しては使えない)', async () => {
    const { id, version } = await makeTicket();
    const first = await run(() => inOrg((svc) => svc.findById(ctxFor(agentId), id)));
    const second = await run(() => inOrg((svc) => svc.findById(ctxFor(agentId), id)));
    expect(first.version).toBe(version);
    expect(second.version).toBe(version);
  });
});
