/**
 * 関連付けとMerge(TL-02 / TL-04 / TL-06 / WP-P2-REL-009)。
 *
 * 重点:
 *   - 1階層制約が**構造的に**効くこと(アプリを迂回しても破れない)
 *   - Merge がコメント・添付を空洞化させないこと
 *   - 関連付けが片側だけの権限で作れないこと(件名からの情報推測を防ぐ)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { TicketService } from '../../services/api/src/modules/ticket/ticket.service.js';
import { RelationService } from '../../services/api/src/modules/ticket/relation.service.js';
import { CollaborationService } from '../../services/api/src/modules/ticket/collaboration.service.js';
import { PoolDenialRecorder } from '../../services/api/src/common/audit/denial-recorder.js';
import { S3CompatibleStorage } from '@solvi/shared';
import type { AuthzContext, Principal } from '../../services/api/src/common/authz/authz.js';
import { runWithContext, newContext } from '@solvi/shared';
import { cleanBusinessData, cleanAuditData } from '../support/cleanup.js';

const ORG_A = '00000000-0000-4000-9000-000000000001';
const ORG_B = '00000000-0000-4000-9000-000000000002';
const PAST = new Date('2026-01-01T00:00:00Z');

let pool: pg.Pool;
let admin: pg.Client;
let denials: PoolDenialRecorder;
let storage: S3CompatibleStorage;
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

const rel = (c: pg.PoolClient) => new RelationService(c, denials);
const tkt = (c: pg.PoolClient) => new TicketService(c, denials);
const collab = (c: pg.PoolClient) => new CollaborationService(c, storage, denials);

const input = (subject: string) => ({
  kind: 'incident' as const,
  subject,
  body: '本文',
  impact: 'medium' as const,
  urgency: 'medium' as const,
});

async function makeTickets(orgId: string, actorRole: string, count: number): Promise<string[]> {
  const actor = users.get(`${orgId}:${actorRole}`)!;
  const ctx = ctxFor(actor, actorRole, orgId);
  return runWithContext(newContext(), () =>
    inOrg(orgId, async (c) => {
      const ids: string[] = [];
      for (let i = 0; i < count; i++) {
        const t = await tkt(c).create(ctx, input(`関連-${orgId.slice(-1)}-${i}`));
        ids.push(t.id);
      }
      return ids;
    }),
  );
}

beforeAll(async () => {
  const appUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!appUrl || !adminUrl) throw new Error('DATABASE_URL と DATABASE_ADMIN_URL が必要です');
  pool = new pg.Pool({ connectionString: appUrl, max: 10 });
  denials = new PoolDenialRecorder(pool);
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  storage = new S3CompatibleStorage({
    endpoint: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9100',
    bucket: 'solvi-attachments',
    accessKey: 'test',
    secretKey: 'test',
    region: 'ap-northeast-1',
  });
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

describe('関連付けの基本制約 (FR-TKT-010)', () => {
  it('自分自身とは関連付けられない', async () => {
    const [a] = await makeTickets(ORG_A, 'agent', 1);
    const agent = users.get(`${ORG_A}:agent`)!;
    await expect(
      runWithContext(newContext(), () =>
        inOrg(ORG_A, (c) => rel(c).link(ctxFor(agent, 'agent', ORG_A), a!, a!, 'related')),
      ),
    ).rejects.toThrow();
  });

  it('related は無向。A→B の後に B→A を作れない', async () => {
    const [a, b] = await makeTickets(ORG_A, 'agent', 2);
    const ctx = ctxFor(users.get(`${ORG_A}:agent`)!, 'agent', ORG_A);
    await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) => rel(c).link(ctx, a!, b!, 'related')),
    );
    await expect(
      runWithContext(newContext(), () => inOrg(ORG_A, (c) => rel(c).link(ctx, b!, a!, 'related'))),
    ).rejects.toThrow(/既に存在します/);
  });

  it('related は双方から相手が見える', async () => {
    const [a, b] = await makeTickets(ORG_A, 'agent', 2);
    const ctx = ctxFor(users.get(`${ORG_A}:agent`)!, 'agent', ORG_A);
    await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) => rel(c).link(ctx, a!, b!, 'related')),
    );
    const fromA = await inOrg(ORG_A, (c) => rel(c).listRelations(ctx, a!));
    const fromB = await inOrg(ORG_A, (c) => rel(c).listRelations(ctx, b!));
    expect(fromA.map((r) => r.ticketId)).toEqual([b]);
    expect(fromB.map((r) => r.ticketId)).toEqual([a]);
    expect(fromA[0]!.role).toBe('related');
  });
});

describe('1階層の強制 (01.5 Non-Goals)', () => {
  it('親子関係を1階層作れる', async () => {
    const [parent, child] = await makeTickets(ORG_A, 'agent', 2);
    const ctx = ctxFor(users.get(`${ORG_A}:agent`)!, 'agent', ORG_A);
    await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) => rel(c).link(ctx, parent!, child!, 'parent_of')),
    );
    const fromParent = await inOrg(ORG_A, (c) => rel(c).listRelations(ctx, parent!));
    const fromChild = await inOrg(ORG_A, (c) => rel(c).listRelations(ctx, child!));
    expect(fromParent[0]!.role).toBe('child');
    expect(fromChild[0]!.role).toBe('parent');
  });

  it('子に孫を付けられない(子が親になれない)', async () => {
    const [parent, child, grandchild] = await makeTickets(ORG_A, 'agent', 3);
    const ctx = ctxFor(users.get(`${ORG_A}:agent`)!, 'agent', ORG_A);
    await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) => rel(c).link(ctx, parent!, child!, 'parent_of')),
    );
    await expect(
      runWithContext(newContext(), () =>
        inOrg(ORG_A, (c) => rel(c).link(ctx, child!, grandchild!, 'parent_of')),
      ),
    ).rejects.toThrow(/1階層/);
  });

  it('親を別のチケットの子にできない', async () => {
    const [grandparent, parent, child] = await makeTickets(ORG_A, 'agent', 3);
    const ctx = ctxFor(users.get(`${ORG_A}:agent`)!, 'agent', ORG_A);
    await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) => rel(c).link(ctx, parent!, child!, 'parent_of')),
    );
    await expect(
      runWithContext(newContext(), () =>
        inOrg(ORG_A, (c) => rel(c).link(ctx, grandparent!, parent!, 'parent_of')),
      ),
    ).rejects.toThrow(/1階層/);
  });

  it('子は親を1つしか持てない', async () => {
    const [p1, p2, child] = await makeTickets(ORG_A, 'agent', 3);
    const ctx = ctxFor(users.get(`${ORG_A}:agent`)!, 'agent', ORG_A);
    await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) => rel(c).link(ctx, p1!, child!, 'parent_of')),
    );
    await expect(
      runWithContext(newContext(), () =>
        inOrg(ORG_A, (c) => rel(c).link(ctx, p2!, child!, 'parent_of')),
      ),
    ).rejects.toThrow();
  });

  it('アプリを迂回してSQLで直接挿入しても1階層制約が効く', async () => {
    // 制約がアプリ層だけでなくDB側にもあることを確認する。
    const [parent, child, grandchild] = await makeTickets(ORG_A, 'agent', 3);
    const ctx = ctxFor(users.get(`${ORG_A}:agent`)!, 'agent', ORG_A);
    await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) => rel(c).link(ctx, parent!, child!, 'parent_of')),
    );
    await expect(
      inOrg(ORG_A, (c) =>
        c.query(
          `INSERT INTO ticket_relation
             (id, organization_id, relation_type, source_ticket_id, target_ticket_id, created_by)
           VALUES (gen_random_uuid(), $1, 'parent_of', $2, $3, $4)`,
          [ORG_A, child, grandchild, users.get(`${ORG_A}:agent`)],
        ),
      ),
    ).rejects.toThrow(/1階層/);
  });
});

describe('関連付けの権限 (脅威 T-02)', () => {
  it('他組織のチケットとは関連付けられない', async () => {
    const [a] = await makeTickets(ORG_A, 'agent', 1);
    const [b] = await makeTickets(ORG_B, 'agent', 1);
    const ctx = ctxFor(users.get(`${ORG_A}:agent`)!, 'agent', ORG_A);
    await expect(
      runWithContext(newContext(), () => inOrg(ORG_A, (c) => rel(c).link(ctx, a!, b!, 'related'))),
    ).rejects.toThrow(/見つかりません/);
  });

  it('片側しか見えない依頼者は関連付けできない', async () => {
    const requester = users.get(`${ORG_A}:requester`)!;
    const agent = users.get(`${ORG_A}:agent`)!;
    const requesterCtx = ctxFor(requester, 'requester', ORG_A);
    const agentCtx = ctxFor(agent, 'agent', ORG_A);

    const own = await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) => tkt(c).create(requesterCtx, input('自分の起票'))),
    );
    const other = await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) => tkt(c).create(agentCtx, input('他人の起票'))),
    );

    await expect(
      runWithContext(newContext(), () =>
        inOrg(ORG_A, (c) => rel(c).link(requesterCtx, own.id, other.id, 'related')),
      ),
    ).rejects.toThrow();
  });

  it('依頼者は関連付けの権限を持たない', async () => {
    const [a, b] = await makeTickets(ORG_A, 'agent', 2);
    const requesterCtx = ctxFor(users.get(`${ORG_A}:requester`)!, 'requester', ORG_A);
    await expect(
      runWithContext(newContext(), () =>
        inOrg(ORG_A, (c) => rel(c).link(requesterCtx, a!, b!, 'related')),
      ),
    ).rejects.toThrow();
  });
});

describe('Merge (FR-TKT-011)', () => {
  it('統合後、元チケットが merged 状態になり統合先が記録される', async () => {
    const [source, target] = await makeTickets(ORG_A, 'agent', 2);
    const ctx = ctxFor(users.get(`${ORG_A}:agent`)!, 'agent', ORG_A);
    await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) => rel(c).merge(ctx, source!, target!, '同一事象のため統合')),
    );
    const { rows } = await admin.query('SELECT state, merged_into_id FROM ticket WHERE id = $1', [
      source,
    ]);
    expect(rows[0].state).toBe('merged');
    expect(rows[0].merged_into_id).toBe(target);
  });

  it('**統合してもコメント・添付が元チケットに残る**', async () => {
    const [source, target] = await makeTickets(ORG_A, 'agent', 2);
    const ctx = ctxFor(users.get(`${ORG_A}:agent`)!, 'agent', ORG_A);

    await runWithContext(newContext(), () =>
      inOrg(ORG_A, async (c) => {
        await collab(c).addComment(ctx, {
          ticketId: source!,
          visibility: 'public',
          body: '元チケットのやり取り',
        });
        await collab(c).createAttachment(ctx, {
          ticketId: source!,
          fileName: 'evidence.png',
          contentType: 'image/png',
          sizeBytes: 1000,
        });
      }),
    );

    const result = await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) => rel(c).merge(ctx, source!, target!, '重複')),
    );
    expect(result.retained).toEqual({ comments: 1, attachments: 1 });

    // 統合後も元チケットから取得できる
    const comments = await inOrg(ORG_A, (c) => collab(c).listComments(ctx, source!));
    const attachments = await inOrg(ORG_A, (c) => collab(c).listAttachments(ctx, source!));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toBe('元チケットのやり取り');
    expect(attachments).toHaveLength(1);

    // 統合先へは移動していない
    const targetComments = await inOrg(ORG_A, (c) => collab(c).listComments(ctx, target!));
    expect(targetComments).toHaveLength(0);
  });

  it('統合先から元チケットを辿れる', async () => {
    const [source, target] = await makeTickets(ORG_A, 'agent', 2);
    const ctx = ctxFor(users.get(`${ORG_A}:agent`)!, 'agent', ORG_A);
    await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) => rel(c).merge(ctx, source!, target!, '重複')),
    );
    const relations = await inOrg(ORG_A, (c) => rel(c).listRelations(ctx, target!));
    expect(relations.map((r) => r.ticketId)).toContain(source);
  });

  it('統合済みチケットへの統合を拒否する(連鎖を作らない)', async () => {
    const [a, b, cTicket] = await makeTickets(ORG_A, 'agent', 3);
    const ctx = ctxFor(users.get(`${ORG_A}:agent`)!, 'agent', ORG_A);
    await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) => rel(c).merge(ctx, a!, b!, '1回目')),
    );
    // b は統合先。a は統合済み。c を a へ統合しようとする
    await expect(
      runWithContext(newContext(), () =>
        inOrg(ORG_A, (c) => rel(c).merge(ctx, cTicket!, a!, '2回目')),
      ),
    ).rejects.toThrow(/最終的な統合先/);

    const { rows } = await admin.query(
      "SELECT policy_decision FROM audit_event WHERE outcome = 'denied' AND action = 'merge'",
    );
    expect(rows[0].policy_decision).toMatchObject({ rule: 'merge_chain' });
  });

  it('統合済みチケットは状態変更できない(終端)', async () => {
    const [source, target] = await makeTickets(ORG_A, 'agent', 2);
    const ctx = ctxFor(users.get(`${ORG_A}:agent`)!, 'agent', ORG_A);
    await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) => rel(c).merge(ctx, source!, target!, '重複')),
    );
    await expect(
      runWithContext(newContext(), () =>
        inOrg(ORG_A, (c) =>
          tkt(c).transition(ctx, { ticketId: source!, to: 'assigned', reason: 'assign' }),
        ),
      ),
    ).rejects.toThrow();
  });

  it('理由なしの統合を拒否する(不可逆な操作の根拠を残す)', async () => {
    const [source, target] = await makeTickets(ORG_A, 'agent', 2);
    const ctx = ctxFor(users.get(`${ORG_A}:agent`)!, 'agent', ORG_A);
    await expect(
      runWithContext(newContext(), () =>
        inOrg(ORG_A, (c) => rel(c).merge(ctx, source!, target!, '   ')),
      ),
    ).rejects.toThrow();
  });

  it('統合が監査に記録される(理由と保持件数を含む)', async () => {
    const [source, target] = await makeTickets(ORG_A, 'agent', 2);
    const ctx = ctxFor(users.get(`${ORG_A}:agent`)!, 'agent', ORG_A);
    await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) => rel(c).merge(ctx, source!, target!, '同一のVPN障害')),
    );
    const { rows } = await admin.query(
      "SELECT after_state FROM audit_event WHERE event_type = 'ticket.merged' AND target_id = $1",
      [source],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].after_state).toMatchObject({
      state: 'merged',
      mergedIntoId: target,
      reason: '同一のVPN障害',
    });
  });

  it('他組織のチケットへ統合できない', async () => {
    const [a] = await makeTickets(ORG_A, 'agent', 1);
    const [b] = await makeTickets(ORG_B, 'agent', 1);
    const ctx = ctxFor(users.get(`${ORG_A}:agent`)!, 'agent', ORG_A);
    await expect(
      runWithContext(newContext(), () => inOrg(ORG_A, (c) => rel(c).merge(ctx, a!, b!, '重複'))),
    ).rejects.toThrow(/見つかりません/);
  });
});

describe('親の解決時の警告 (WP §6)', () => {
  it('未解決の子がいる場合に一覧を返す', async () => {
    const [parent, child] = await makeTickets(ORG_A, 'agent', 2);
    const ctx = ctxFor(users.get(`${ORG_A}:agent`)!, 'agent', ORG_A);
    await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) => rel(c).link(ctx, parent!, child!, 'parent_of')),
    );
    const unresolved = await inOrg(ORG_A, (c) => rel(c).unresolvedChildren(ctx, parent!));
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.ticketId).toBe(child);
  });

  it('子が解決済みなら警告されない', async () => {
    const [parent, child] = await makeTickets(ORG_A, 'agent', 2);
    const ctx = ctxFor(users.get(`${ORG_A}:agent`)!, 'agent', ORG_A);
    await runWithContext(newContext(), () =>
      inOrg(ORG_A, async (c) => {
        await rel(c).link(ctx, parent!, child!, 'parent_of');
        for (const step of [
          { to: 'assigned' as const, reason: 'assign' as const },
          { to: 'in_progress' as const, reason: 'start' as const },
          { to: 'resolved' as const, reason: 'resolve' as const },
        ]) {
          await tkt(c).transition(ctx, { ticketId: child!, ...step });
        }
      }),
    );
    const unresolved = await inOrg(ORG_A, (c) => rel(c).unresolvedChildren(ctx, parent!));
    expect(unresolved).toHaveLength(0);
  });

  it('未解決の子がいても親を解決できる(拒否しない)', async () => {
    const [parent, child] = await makeTickets(ORG_A, 'agent', 2);
    const ctx = ctxFor(users.get(`${ORG_A}:agent`)!, 'agent', ORG_A);
    const resolved = await runWithContext(newContext(), () =>
      inOrg(ORG_A, async (c) => {
        await rel(c).link(ctx, parent!, child!, 'parent_of');
        for (const step of [
          { to: 'assigned' as const, reason: 'assign' as const },
          { to: 'in_progress' as const, reason: 'start' as const },
          { to: 'resolved' as const, reason: 'resolve' as const },
        ]) {
          await tkt(c).transition(ctx, { ticketId: parent!, ...step });
        }
        return tkt(c).findById(ctx, parent!);
      }),
    );
    expect(resolved.state).toBe('resolved');
  });
});

describe('関連付けの解除', () => {
  it('解除すると双方から見えなくなる', async () => {
    const [a, b] = await makeTickets(ORG_A, 'agent', 2);
    const ctx = ctxFor(users.get(`${ORG_A}:agent`)!, 'agent', ORG_A);
    const relation = await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) => rel(c).link(ctx, a!, b!, 'related')),
    );
    await runWithContext(newContext(), () => inOrg(ORG_A, (c) => rel(c).unlink(ctx, relation.id)));
    expect(await inOrg(ORG_A, (c) => rel(c).listRelations(ctx, a!))).toHaveLength(0);
    expect(await inOrg(ORG_A, (c) => rel(c).listRelations(ctx, b!))).toHaveLength(0);
  });

  it('解除が監査に記録される', async () => {
    const [a, b] = await makeTickets(ORG_A, 'agent', 2);
    const ctx = ctxFor(users.get(`${ORG_A}:agent`)!, 'agent', ORG_A);
    const relation = await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) => rel(c).link(ctx, a!, b!, 'related')),
    );
    await runWithContext(newContext(), () => inOrg(ORG_A, (c) => rel(c).unlink(ctx, relation.id)));
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE event_type = 'ticket.unlinked'",
    );
    expect(rows[0].n).toBe(1);
  });
});
