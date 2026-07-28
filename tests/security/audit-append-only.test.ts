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
import { runDailyAnchor } from '../../services/worker/src/jobs/audit-anchor/runner.js';
import { runWithContext, newContext } from '@solvi/shared';
import { cleanAuditData } from '../support/cleanup.js';

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
  await cleanAuditData(admin, "event_type = 'config.changed'");
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

/**
 * **アンカーが実際に動く経路の検査。**
 *
 * 上の一連の検査はすべて `admin`(BYPASSRLS を持つ所有者)で行っている。
 * そのため「アプリロールでは1件も見えない」という事実を一度も踏まなかった。
 * 実運用のワーカーは `solvi_app` で接続する。**そちらで確かめる。**
 *
 * この検査が無かったために、アンカーは実装済みとして扱われながら
 * 一度も実行されず、仮に実行されていれば毎日「0件の1日」を記録していた。
 */
describe('アンカーの実行経路 (migration 0014)', () => {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const silentLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as Parameters<typeof runDailyAnchor>[1];

  // audit_anchor はファイル冒頭の beforeEach(cleanAuditData)で消える。
  // ここで生の DELETE を書いてはいけない — append-only トリガに阻まれる。

  it('**組織コンテキストが無いとアプリロールには1件も見えない**', async () => {
    await runWithContext(newContext(), () =>
      asOrg(ORG_A, (c) => recordAuditEvent(c, sampleEvent())),
    );

    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      const blind = await computeDailyRoot(client, new Date().toISOString().slice(0, 10));
      await client.query('ROLLBACK');
      // ここが 0 であることこそが、例外ポリシーを必要とする理由である。
      // そして 0 件でも rootHash は正しく計算でき、保存も成功してしまう。
      expect(blind.eventCount).toBe(0);
      expect(blind.rootHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      client.release();
    }
  });

  it('app.anchor を立てると全組織のイベントが見える', async () => {
    await runWithContext(newContext(), () =>
      asOrg(ORG_A, (c) => recordAuditEvent(c, sampleEvent(ORG_A))),
    );
    await runWithContext(newContext(), () =>
      asOrg(ORG_B, (c) => recordAuditEvent(c, sampleEvent(ORG_B))),
    );

    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.anchor', 'on', true)");
      const seen = await computeDailyRoot(client, new Date().toISOString().slice(0, 10));
      await client.query('ROLLBACK');
      // 組織をまたいで1本の連鎖にする。組織ごとに分けると、
      // その組織の行を全部消してアンカーを作り直せば辻褄が合ってしまう。
      expect(seen.eventCount).toBeGreaterThanOrEqual(2);
    } finally {
      client.release();
    }
  });

  it('例外はトランザクションを越えて残らない', async () => {
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.anchor', 'on', true)");
      await client.query('COMMIT');

      await client.query('BEGIN');
      const { rows } = await client.query("SELECT current_setting('app.anchor', true) AS v");
      await client.query('ROLLBACK');
      expect(rows[0].v === null || rows[0].v === '').toBe(true);
    } finally {
      client.release();
    }
  });

  it('runDailyAnchor が前日分を固定し、照合まで行う', async () => {
    const summary = await runWithContext(newContext(), () => runDailyAnchor(appPool, silentLogger));
    expect(summary.anchored).toBe(yesterday);
    expect(summary.mismatched).toHaveLength(0);

    const { rows } = await admin.query('SELECT anchor_date FROM audit_anchor');
    expect(rows).toHaveLength(1);
  });

  it('**同じ日を二度実行しても増えない**(1時間おきに回せる)', async () => {
    await runWithContext(newContext(), () => runDailyAnchor(appPool, silentLogger));
    await runWithContext(newContext(), () => runDailyAnchor(appPool, silentLogger));
    const { rows } = await admin.query('SELECT count(*)::int AS n FROM audit_anchor');
    expect(rows[0].n).toBe(1);
  });

  it('**当日分は固定しない**(まだイベントが増える日をアンカーすると必ず不一致になる)', async () => {
    await runWithContext(newContext(), () => runDailyAnchor(appPool, silentLogger));
    const { rows } = await admin.query('SELECT anchor_date::text AS d FROM audit_anchor');
    expect(rows.map((r) => r.d)).not.toContain(new Date().toISOString().slice(0, 10));
  });

  it('ポリシーが無ければ実行を拒む(空のアンカーを保存しない)', async () => {
    await admin.query('DROP POLICY audit_event_anchor_lookup ON audit_event');
    try {
      await expect(
        runWithContext(newContext(), () => runDailyAnchor(appPool, silentLogger)),
      ).rejects.toThrow(/audit_event_anchor_lookup/);
      const { rows } = await admin.query('SELECT count(*)::int AS n FROM audit_anchor');
      expect(rows[0].n).toBe(0);
    } finally {
      await admin.query(
        `CREATE POLICY audit_event_anchor_lookup ON audit_event
           FOR SELECT USING (current_setting('app.anchor', true) = 'on')`,
      );
    }
  });

  it('改変を検出すると mismatched に日付が入る', async () => {
    const eventId = await runWithContext(newContext(), () =>
      asOrg(ORG_A, (c) => recordAuditEvent(c, sampleEvent())),
    );
    // 前日分を対象にするため、記録済みイベントの時刻を1日戻す。
    // occurred_at はアプリからは指定できない(捏造を防ぐため)。
    await admin.query('ALTER TABLE audit_event DISABLE TRIGGER audit_event_no_update');
    await admin.query(
      "UPDATE audit_event SET occurred_at = occurred_at - interval '1 day' WHERE event_id = $1",
      [eventId],
    );
    await admin.query('ALTER TABLE audit_event ENABLE TRIGGER audit_event_no_update');

    const first = await runWithContext(newContext(), () => runDailyAnchor(appPool, silentLogger));
    expect(first.eventCount).toBeGreaterThan(0);

    await admin.query('ALTER TABLE audit_event DISABLE TRIGGER audit_event_no_update');
    await admin.query("UPDATE audit_event SET outcome = 'failure' WHERE event_id = $1", [eventId]);
    await admin.query('ALTER TABLE audit_event ENABLE TRIGGER audit_event_no_update');

    const summary = await runWithContext(newContext(), () => runDailyAnchor(appPool, silentLogger));
    expect(summary.mismatched).toContain(yesterday);
  });
});
