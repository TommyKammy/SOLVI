/**
 * 検索とSLAの結合テスト(TL-06 / TL-03 / TL-04 / WP-P2-SEARCH-006)。
 *
 * 検索は一覧と同じ認可条件を使う。別実装にすると片方だけ修正されて漏れる。
 * SLAは実DBを通したときにクロックが正しく積み上がるかを見る。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { TicketService } from '../../services/api/src/modules/ticket/ticket.service.js';
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

const ctxFor = (userId: string, roleCode: string, orgId: string, now?: Date): AuthzContext => ({
  principal: {
    userId,
    status: 'active',
    bindings: [
      { roleCode: roleCode as never, organizationId: orgId, validFrom: PAST, validUntil: null },
    ],
  } satisfies Principal,
  organizationId: orgId,
  ...(now ? { now } : {}),
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

const input = (subject: string, body = '本文') => ({
  kind: 'incident' as const,
  subject,
  body,
  impact: 'medium' as const,
  urgency: 'high' as const,
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
  await cleanBusinessData(admin);
  await cleanAuditData(admin, "target_type = 'ticket'");
});

describe('日本語検索 (FR-TKT-006)', () => {
  beforeEach(async () => {
    const agent = users.get(`${ORG_A}:agent`)!;
    const ctx = ctxFor(agent, 'agent', ORG_A);
    await runWithContext(newContext(), () =>
      inOrg(ORG_A, async (c) => {
        await svc(c).create(
          ctx,
          input('ログインできない', 'パスワード変更後にログイン画面でエラー'),
        );
        await svc(c).create(ctx, input('VPNが繋がらない', '在宅勤務中にVPN接続が切断される'));
        await svc(c).create(ctx, input('プリンタで印刷できない', '3階の複合機が応答しない'));
      }),
    );
  });

  it('件名の部分一致で見つかる', async () => {
    const ctx = ctxFor(users.get(`${ORG_A}:agent`)!, 'agent', ORG_A);
    const result = await inOrg(ORG_A, (c) => svc(c).list(ctx, { filter: { keyword: 'ログイン' } }));
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.subject).toBe('ログインできない');
  });

  it('本文の部分一致でも見つかる', async () => {
    const ctx = ctxFor(users.get(`${ORG_A}:agent`)!, 'agent', ORG_A);
    const result = await inOrg(ORG_A, (c) => svc(c).list(ctx, { filter: { keyword: '在宅勤務' } }));
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.subject).toBe('VPNが繋がらない');
  });

  it('語の途中からでも一致する(形態素解析なしのtrigram)', async () => {
    const ctx = ctxFor(users.get(`${ORG_A}:agent`)!, 'agent', ORG_A);
    const result = await inOrg(ORG_A, (c) => svc(c).list(ctx, { filter: { keyword: '複合機' } }));
    expect(result.items).toHaveLength(1);
  });

  it('チケット番号でも検索できる', async () => {
    const ctx = ctxFor(users.get(`${ORG_A}:agent`)!, 'agent', ORG_A);
    const all = await inOrg(ORG_A, (c) => svc(c).list(ctx, {}));
    const number = all.items[0]!.number;
    const result = await inOrg(ORG_A, (c) => svc(c).list(ctx, { filter: { keyword: number } }));
    expect(result.items.map((t) => t.id)).toContain(all.items[0]!.id);
  });

  it('該当なしなら0件を返す(例外にしない)', async () => {
    const ctx = ctxFor(users.get(`${ORG_A}:agent`)!, 'agent', ORG_A);
    const result = await inOrg(ORG_A, (c) =>
      svc(c).list(ctx, { filter: { keyword: '存在しないキーワード' } }),
    );
    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});

describe('検索キーワードの安全性 (TL-03 / 脅威 T-03)', () => {
  beforeEach(async () => {
    const ctx = ctxFor(users.get(`${ORG_A}:agent`)!, 'agent', ORG_A);
    await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) => svc(c).create(ctx, input('通常のチケット'))),
    );
  });

  it.each([
    "'; DROP TABLE ticket; --",
    'a & b | c ! d',
    "to_tsquery('x')",
    ':*',
    '\\',
    '100%',
    'under_score',
  ])('特殊文字を含むキーワード %s で例外にならない', async (keyword) => {
    const ctx = ctxFor(users.get(`${ORG_A}:agent`)!, 'agent', ORG_A);
    const result = await inOrg(ORG_A, (c) => svc(c).list(ctx, { filter: { keyword } }));
    expect(Array.isArray(result.items)).toBe(true);
    // テーブルが残っていること
    const { rows } = await admin.query("SELECT to_regclass('public.ticket') AS t");
    expect(rows[0].t).toBe('ticket');
  });

  it('ワイルドカード % が検索範囲を広げない', async () => {
    const ctx = ctxFor(users.get(`${ORG_A}:agent`)!, 'agent', ORG_A);
    // % をエスケープしないと全件ヒットしてしまう
    const result = await inOrg(ORG_A, (c) => svc(c).list(ctx, { filter: { keyword: '%' } }));
    expect(result.items).toHaveLength(0);
  });

  it('アンダースコアが1文字ワイルドカードにならない', async () => {
    const ctx = ctxFor(users.get(`${ORG_A}:agent`)!, 'agent', ORG_A);
    const result = await inOrg(ORG_A, (c) => svc(c).list(ctx, { filter: { keyword: '通_の' } }));
    expect(result.items).toHaveLength(0);
  });
});

describe('検索の権限絞り込み (TL-06)', () => {
  it('検索結果に他組織のチケットが含まれない', async () => {
    const agentA = users.get(`${ORG_A}:agent`)!;
    const agentB = users.get(`${ORG_B}:agent`)!;
    await runWithContext(newContext(), () =>
      inOrg(ORG_B, (c) =>
        svc(c).create(ctxFor(agentB, 'agent', ORG_B), input('共通キーワード B社')),
      ),
    );
    await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) =>
        svc(c).create(ctxFor(agentA, 'agent', ORG_A), input('共通キーワード A社')),
      ),
    );

    const result = await inOrg(ORG_A, (c) =>
      svc(c).list(ctxFor(agentA, 'agent', ORG_A), { filter: { keyword: '共通キーワード' } }),
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.subject).toContain('A社');
  });

  it('依頼者の検索結果に他人のチケットが含まれない', async () => {
    const agent = users.get(`${ORG_A}:agent`)!;
    const requester = users.get(`${ORG_A}:requester`)!;
    await runWithContext(newContext(), () =>
      inOrg(ORG_A, async (c) => {
        await svc(c).create(ctxFor(agent, 'agent', ORG_A), input('社内システム 担当者起票'));
        await svc(c).create(
          ctxFor(requester, 'requester', ORG_A),
          input('社内システム 依頼者起票'),
        );
      }),
    );
    const result = await inOrg(ORG_A, (c) =>
      svc(c).list(ctxFor(requester, 'requester', ORG_A), { filter: { keyword: '社内システム' } }),
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.subject).toContain('依頼者起票');
    expect(result.total).toBe(1);
  });
});

describe('SLAクロックの実DB挙動 (FR-TKT-008)', () => {
  const T0 = new Date('2026-07-01T09:00:00Z');
  const at = (min: number) => new Date(T0.getTime() + min * 60_000);

  async function makeTicket(): Promise<string> {
    const ctx = ctxFor(users.get(`${ORG_A}:agent`)!, 'agent', ORG_A);
    const t = await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) => svc(c).create(ctx, input('SLA検証'))),
    );
    // 作成時刻を基準時刻に揃える(実時刻依存を排除する)
    await admin.query(
      'UPDATE ticket SET created_at = $2, sla_clock_started_at = $2 WHERE id = $1',
      [t.id, T0],
    );
    return t.id;
  }

  it('作成時にクロックが動き始める', async () => {
    const id = await makeTicket();
    const { rows } = await admin.query(
      'SELECT sla_clock_started_at, sla_elapsed_seconds FROM ticket WHERE id = $1',
      [id],
    );
    expect(rows[0].sla_clock_started_at).not.toBeNull();
    expect(rows[0].sla_elapsed_seconds).toBe(0);
  });

  it('pending へ遷移するとクロックが止まり経過が加算される', async () => {
    const id = await makeTicket();
    const agent = users.get(`${ORG_A}:agent`)!;

    await runWithContext(newContext(), () =>
      inOrg(ORG_A, async (c) => {
        await svc(c).transition(ctxFor(agent, 'agent', ORG_A, at(5)), {
          ticketId: id,
          to: 'assigned',
          reason: 'assign',
        });
        await svc(c).transition(ctxFor(agent, 'agent', ORG_A, at(10)), {
          ticketId: id,
          to: 'in_progress',
          reason: 'start',
        });
        await svc(c).transition(ctxFor(agent, 'agent', ORG_A, at(40)), {
          ticketId: id,
          to: 'pending',
          reason: 'wait_requester',
        });
      }),
    );

    const { rows } = await admin.query(
      'SELECT sla_clock_started_at, sla_elapsed_seconds FROM ticket WHERE id = $1',
      [id],
    );
    expect(rows[0].sla_clock_started_at).toBeNull(); // 停止している
    expect(rows[0].sla_elapsed_seconds).toBe(40 * 60);
  });

  it('**待ち時間はSLAに算入されない**', async () => {
    const id = await makeTicket();
    const agent = users.get(`${ORG_A}:agent`)!;

    await runWithContext(newContext(), () =>
      inOrg(ORG_A, async (c) => {
        for (const [minutes, to, reason] of [
          [10, 'assigned', 'assign'],
          [20, 'in_progress', 'start'],
          [30, 'pending', 'wait_requester'],
          // ここから3時間の待ち
          [210, 'in_progress', 'resume'],
          [240, 'resolved', 'resolve'],
        ] as const) {
          await svc(c).transition(ctxFor(agent, 'agent', ORG_A, at(minutes)), {
            ticketId: id,
            to: to as never,
            reason: reason as never,
          });
        }
      }),
    );

    const { rows } = await admin.query('SELECT sla_elapsed_seconds FROM ticket WHERE id = $1', [
      id,
    ]);
    // 実時間は4時間だが、3時間の待ちを除いた1時間だけが算入される
    expect(rows[0].sla_elapsed_seconds).toBe(60 * 60);
  });

  it('SLA超過を記録するが遷移は止めない', async () => {
    const id = await makeTicket();
    const agent = users.get(`${ORG_A}:agent`)!;
    // 優先度 high(応答2時間 / 解決1日)に対し、30時間かけて解決する
    const resolved = await runWithContext(newContext(), () =>
      inOrg(ORG_A, async (c) => {
        await svc(c).transition(ctxFor(agent, 'agent', ORG_A, at(10)), {
          ticketId: id,
          to: 'assigned',
          reason: 'assign',
        });
        await svc(c).transition(ctxFor(agent, 'agent', ORG_A, at(20)), {
          ticketId: id,
          to: 'in_progress',
          reason: 'start',
        });
        return svc(c).transition(ctxFor(agent, 'agent', ORG_A, at(1800)), {
          ticketId: id,
          to: 'resolved',
          reason: 'resolve',
        });
      }),
    );
    // 遷移は成功している
    expect(resolved.state).toBe('resolved');

    // **判定は保存しない。読むたびに計算する。**
    //
    // かつては `response_sla_breached` / `resolution_sla_breached` 列へ
    // 書き込んでいたが、更新するのは状態遷移のときだけだった。つまり
    // 放置されたチケットは期限を過ぎてもフラグが立たず、
    // **一覧で最も見たいものだけが更新されない**状態だった (WP-P2-SLAUI-016)。
    const status = await inOrg(ORG_A, (c) =>
      svc(c).slaStatus(ctxFor(agent, 'agent', ORG_A), id, at(1800)),
    );
    expect(status.resolutionBreached).toBe(true);
  });

  it('**放置しただけで超過が見える**(遷移しなくても判定される)', async () => {
    const id = await makeTicket();
    const agent = users.get(`${ORG_A}:agent`)!;

    // 誰も触らない。状態は new のまま、時間だけが過ぎる。
    // 保存値を使っていた頃は、これが**永久に超過にならなかった**。
    const status = await inOrg(ORG_A, (c) =>
      svc(c).slaStatus(ctxFor(agent, 'agent', ORG_A), id, at(1800)),
    );
    expect(status.resolutionBreached).toBe(true);
    expect(status.remainingSeconds).toBeLessThan(0);
  });

  it('SLA状況を取得できる', async () => {
    const id = await makeTicket();
    const ctx = ctxFor(users.get(`${ORG_A}:agent`)!, 'agent', ORG_A);
    const status = await inOrg(ORG_A, (c) => svc(c).slaStatus(ctx, id, at(60)));
    expect(status.elapsedSeconds).toBe(3600);
    expect(status.resolutionTargetSeconds).toBe(1440 * 60); // high の解決目標
    expect(status.remainingSeconds).toBeGreaterThan(0);
  });

  it('初回応答が記録され、2回目以降は上書きされない', async () => {
    const id = await makeTicket();
    // 起票したのは agent なので、**agent 自身の書き込みは応答に数えない**。
    // 別の担当者として記録する。
    const other = ctxFor(users.get(`${ORG_A}:org_admin`)!, 'org_admin', ORG_A);
    await inOrg(ORG_A, (c) => svc(c).recordFirstResponse(other, id, at(15)));
    await inOrg(ORG_A, (c) => svc(c).recordFirstResponse(other, id, at(90)));
    const { rows } = await admin.query('SELECT first_responded_at FROM ticket WHERE id = $1', [id]);
    expect(new Date(rows[0].first_responded_at).toISOString()).toBe(at(15).toISOString());
  });

  it('**依頼者自身の書き込みは初回応答に数えない**', async () => {
    const id = await makeTicket();
    // makeTicket は agent が起票している = agent が依頼者である。
    const self = ctxFor(users.get(`${ORG_A}:agent`)!, 'agent', ORG_A);
    await inOrg(ORG_A, (c) => svc(c).recordFirstResponse(self, id, at(15)));
    const { rows } = await admin.query('SELECT first_responded_at FROM ticket WHERE id = $1', [id]);
    expect(rows[0].first_responded_at).toBeNull();
  });

  it('SLAポリシーが組織ごとに分離される', async () => {
    const { rows } = await admin.query(
      'SELECT organization_id, count(*)::int AS n FROM sla_policy GROUP BY organization_id',
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) expect(row.n).toBe(4); // 優先度4種
  });
});
