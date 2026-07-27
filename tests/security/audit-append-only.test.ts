/**
 * 監査のappend-only性と改ざん検知(TL-06 / TL-16 / NFR-SEC-003 / AUD-001〜003)。
 * Gate 1 の G1-4 / G1-5 の判定に使う。
 *
 * 「アプリが消さない」ではなく「**消せない**」ことを検査する。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { recordAuditEvent, auditState, uuidv7 } from '../../services/api/src/common/audit/audit.js';
import {
  computeDailyRoot,
  persistAnchor,
  verifyAnchor,
} from '../../services/worker/src/jobs/audit-anchor/anchor.js';
import { runWithContext, newContext } from '@solvi/shared';

const ORG_A = '00000000-0000-4000-9000-000000000001';
const ORG_B = '00000000-0000-4000-9000-000000000002';

let appPool: pg.Pool;
let admin: pg.Client;

async function asOrg<T>(orgId: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_org', orgId ?? '']);
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

beforeAll(async () => {
  const appUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!appUrl || !adminUrl) throw new Error('DATABASE_URL と DATABASE_ADMIN_URL が必要です');
  appPool = new pg.Pool({ connectionString: appUrl, max: 5 });
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
});

afterAll(async () => {
  await admin?.end();
  await appPool?.end();
});

beforeEach(async () => {
  // 各テストの前に当日のテストデータを片付ける(admin権限でも消せないため、トリガを一時無効化)
  await admin.query('ALTER TABLE audit_event DISABLE TRIGGER audit_event_no_delete');
  await admin.query("DELETE FROM audit_event WHERE event_type = 'config.changed'");
  await admin.query('ALTER TABLE audit_event ENABLE TRIGGER audit_event_no_delete');
  await admin.query('ALTER TABLE audit_anchor DISABLE TRIGGER audit_anchor_no_delete');
  await admin.query('DELETE FROM audit_anchor');
  await admin.query('ALTER TABLE audit_anchor ENABLE TRIGGER audit_anchor_no_delete');
});

const sampleEvent = (organizationId: string | null = ORG_A) =>
  ({
    eventType: 'config.changed',
    organizationId,
    actorType: 'user',
    actorId: '00000000-0000-4000-9000-000000000101',
    actorDisplay: 'テスト利用者',
    targetType: 'setting',
    targetId: 'notification.email',
    action: 'update',
    outcome: 'success',
    beforeState: { enabled: false },
    afterState: { enabled: true },
  }) as const;

describe('監査イベントの記録', () => {
  it('業務トランザクションと同一クライアントで書ける', async () => {
    const eventId = await runWithContext(newContext(), () =>
      asOrg(ORG_A, (c) => recordAuditEvent(c, sampleEvent())),
    );
    const { rows } = await admin.query(
      'SELECT event_type, outcome FROM audit_event WHERE event_id = $1',
      [eventId],
    );
    expect(rows[0]).toMatchObject({ event_type: 'config.changed', outcome: 'success' });
  });

  it('相関IDが記録される (NFR-OPS-003)', async () => {
    const ctx = newContext();
    const eventId = await runWithContext(ctx, () =>
      asOrg(ORG_A, (c) => recordAuditEvent(c, sampleEvent())),
    );
    const { rows } = await admin.query(
      'SELECT correlation_id, request_id FROM audit_event WHERE event_id = $1',
      [eventId],
    );
    expect(rows[0].correlation_id).toBe(ctx.correlationId);
    expect(rows[0].request_id).toBe(ctx.requestId);
  });

  it('denied には policyDecision が必須 (理由のない拒否を残さない)', async () => {
    await expect(
      runWithContext(newContext(), () =>
        asOrg(ORG_A, (c) =>
          recordAuditEvent(c, { ...sampleEvent(), outcome: 'denied', policyDecision: null }),
        ),
      ),
    ).rejects.toThrow(/policyDecision/);
  });

  it('event_id が時系列順に並ぶ (uuid v7)', () => {
    // 同一ミリ秒内で大量に採番しても順序が崩れないこと。
    // 崩れると日次アンカーの連鎖ハッシュが非決定的になり、改ざん検知が成立しない。
    const ids = Array.from({ length: 5000 }, () => uuidv7());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('append-only の強制 (ADR-0009 / Gate 1 G1-4)', () => {
  let eventId: string;

  beforeEach(async () => {
    eventId = await runWithContext(newContext(), () =>
      asOrg(ORG_A, (c) => recordAuditEvent(c, sampleEvent())),
    );
  });

  it('アプリロールは UPDATE できない', async () => {
    await expect(
      asOrg(ORG_A, (c) =>
        c.query("UPDATE audit_event SET outcome = 'failure' WHERE event_id = $1", [eventId]),
      ),
    ).rejects.toThrow(/append-only|permission denied/i);
  });

  it('アプリロールは DELETE できない', async () => {
    await expect(
      asOrg(ORG_A, (c) => c.query('DELETE FROM audit_event WHERE event_id = $1', [eventId])),
    ).rejects.toThrow(/append-only|permission denied/i);
  });

  it('アプリロールは TRUNCATE できない', async () => {
    await expect(asOrg(ORG_A, (c) => c.query('TRUNCATE audit_event'))).rejects.toThrow(
      /append-only|permission denied/i,
    );
  });

  it('owner 権限でもトリガが UPDATE/DELETE を拒否する', async () => {
    // 権限だけでは owner を止められない。トリガによる二層目が効いていることを確認する。
    await expect(
      admin.query("UPDATE audit_event SET outcome = 'failure' WHERE event_id = $1", [eventId]),
    ).rejects.toThrow(/append-only/);
    await expect(
      admin.query('DELETE FROM audit_event WHERE event_id = $1', [eventId]),
    ).rejects.toThrow(/append-only/);
  });
});

describe('監査の組織境界', () => {
  it('他組織の監査イベントが見えない', async () => {
    await runWithContext(newContext(), () =>
      asOrg(ORG_B, (c) => recordAuditEvent(c, sampleEvent(ORG_B))),
    );
    const visibleFromA = await asOrg(ORG_A, async (c) => {
      const { rows } = await c.query(
        'SELECT count(*)::int AS n FROM audit_event WHERE organization_id = $1',
        [ORG_B],
      );
      return rows[0].n;
    });
    expect(visibleFromA).toBe(0);
  });

  it('他組織のIDを詐称した監査イベントを書けない', async () => {
    await expect(
      runWithContext(newContext(), () =>
        asOrg(ORG_A, (c) => recordAuditEvent(c, sampleEvent(ORG_B))),
      ),
    ).rejects.toThrow(/row-level security|監査イベントの記録に失敗/);
  });
});

describe('機微情報のマスキング (02.17 §4)', () => {
  it('構造体を before/after へ流し込めない', () => {
    const state = auditState({ nested: { secret: 'value' }, list: [1, 2, 3], ok: 'plain' });
    expect(state).toEqual({
      nested: '[object omitted]',
      list: '[array omitted]',
      ok: 'plain',
    });
  });

  it('秘密らしい文字列は落とされる', () => {
    const state = auditState({ conn: 'postgres://user:pass@host:5432/db' });
    expect(state!.conn).toBe('[REDACTED]');
  });

  it('長い文字列は切り詰められる(本文の丸ごと保存を防ぐ)', () => {
    const state = auditState({ note: 'あ'.repeat(500) });
    expect(String(state!.note).length).toBeLessThanOrEqual(220);
  });
});

describe('日次アンカーと改ざん検知 (Gate 1 G1-5)', () => {
  const today = new Date().toISOString().slice(0, 10);

  it('アンカーを作成して照合できる', async () => {
    await runWithContext(newContext(), () =>
      asOrg(ORG_A, (c) => recordAuditEvent(c, sampleEvent())),
    );

    const result = await computeDailyRoot(admin, today);
    expect(result.eventCount).toBeGreaterThan(0);
    expect(result.rootHash).toMatch(/^[0-9a-f]{64}$/);

    const persisted = await persistAnchor(admin, result, 's3://solvi-audit-anchor/test.json');
    expect(persisted).toBe('created');

    const verification = await verifyAnchor(admin, today);
    expect(verification.status).toBe('match');
  });

  it('イベントが事後に改変されると mismatch を検出する', async () => {
    const eventId = await runWithContext(newContext(), () =>
      asOrg(ORG_A, (c) => recordAuditEvent(c, sampleEvent())),
    );
    await persistAnchor(admin, await computeDailyRoot(admin, today), null);
    expect((await verifyAnchor(admin, today)).status).toBe('match');

    // トリガを一時無効化して改ざんを再現する(実運用では管理者権限を持つ内部者を想定)
    await admin.query('ALTER TABLE audit_event DISABLE TRIGGER audit_event_no_update');
    await admin.query("UPDATE audit_event SET outcome = 'failure' WHERE event_id = $1", [eventId]);
    await admin.query('ALTER TABLE audit_event ENABLE TRIGGER audit_event_no_update');

    const verification = await verifyAnchor(admin, today);
    expect(verification.status).toBe('mismatch');
    expect(verification.storedRootHash).not.toBe(verification.recomputedRootHash);
  });

  it('イベントが削除されると mismatch と件数差を検出する', async () => {
    const eventId = await runWithContext(newContext(), () =>
      asOrg(ORG_A, (c) => recordAuditEvent(c, sampleEvent())),
    );
    await persistAnchor(admin, await computeDailyRoot(admin, today), null);

    await admin.query('ALTER TABLE audit_event DISABLE TRIGGER audit_event_no_delete');
    await admin.query('DELETE FROM audit_event WHERE event_id = $1', [eventId]);
    await admin.query('ALTER TABLE audit_event ENABLE TRIGGER audit_event_no_delete');

    const verification = await verifyAnchor(admin, today);
    expect(verification.status).toBe('mismatch');
    expect(verification.currentEventCount).toBeLessThan(verification.storedEventCount!);
  });

  it('アンカーは上書きできない(改ざん後の辻褄合わせを防ぐ)', async () => {
    await persistAnchor(admin, await computeDailyRoot(admin, today), null);
    const second = await persistAnchor(
      admin,
      {
        anchorDate: today,
        eventCount: 0,
        rootHash: 'f'.repeat(64),
        firstEventId: null,
        lastEventId: null,
      },
      null,
    );
    expect(second).toBe('already_exists');
    // UPDATE も拒否される
    await expect(
      admin.query('UPDATE audit_anchor SET root_hash = $1 WHERE anchor_date = $2', [
        '0'.repeat(64),
        today,
      ]),
    ).rejects.toThrow(/append-only/);
  });

  it('アンカーがない日は no_anchor を返す', async () => {
    expect((await verifyAnchor(admin, '2020-01-01')).status).toBe('no_anchor');
  });
});
