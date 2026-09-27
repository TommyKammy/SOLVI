/**
 * 監査の書き出し (AUD-002 / AUD-003 / WP-P1-AUD-018)。
 *
 * ADR-0009 で追記専用・ハッシュ連鎖の監査を作り、日次アンカーで固定した。
 * **取り出す手段が無かった。** `audit.export.executed` は監査イベント型として
 * 定義されていたが、発行する者が居ない — `check_unwired` が最後まで
 * 報告し続けていた1件である。
 *
 * **読めない記録は、記録していないことに近い。**
 *
 * 重点は3つ。
 *
 *   1. **見てよい人だけが見られる**(AUD-002)
 *   2. **取り出したことが残る**(AUD-002「export 自体も監査記録」)
 *   3. **再計算がアンカーと一致する**(AUD-003)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createHash } from 'node:crypto';
import { runWithContext, newContext } from '@solvi/shared';
import {
  AuditExportService,
  toJsonl,
} from '../../services/api/src/modules/audit/audit-export.service.js';
import { computeDailyRoot } from '../../services/worker/src/jobs/audit-anchor/anchor.js';
import type { AuthzContext } from '../../services/api/src/common/authz/authz.js';

const ORG_A = '00000000-0000-4000-9000-000000000001';
const ORG_B = '00000000-0000-4000-9000-000000000002';
const PAST = new Date('2026-01-01T00:00:00Z');
const TODAY = new Date().toISOString().slice(0, 10);
/** 固定が済んだ日。**当日は照合できない**(書き出した記録自体が含まれないため)。 */
const SETTLED_DAY = '2026-03-15';

let pool: pg.Pool;
let admin: pg.Client;

const ctxFor = (roleCode: string, orgId = ORG_A): AuthzContext => ({
  principal: {
    userId: '00000000-0000-4000-8000-0000000000aa',
    status: 'active',
    bindings: [
      {
        roleCode: roleCode as never,
        organizationId: roleCode.startsWith('platform_') ? null : orgId,
        validFrom: PAST,
        validUntil: null,
      },
    ],
  },
  organizationId: orgId,
});

async function inOrg<T>(orgId: string, fn: (svc: AuditExportService) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_org', orgId]);
    const out = await fn(new AuditExportService(client));
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

beforeAll(async () => {
  const appUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!appUrl || !adminUrl) throw new Error('DATABASE_URL と DATABASE_ADMIN_URL が必要です');
  pool = new pg.Pool({ connectionString: appUrl, max: 5 });
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
});

afterAll(async () => {
  await admin?.end();
  await pool?.end();
});

describe('見てよい人だけが見られる (AUD-002)', () => {
  it('監査者は書き出せる', async () => {
    const result = await run(() => inOrg(ORG_A, (s) => s.exportDay(ctxFor('auditor'), TODAY)));
    expect(result.manifest.scope).toBe('organization');
  });

  it('**組織の管理者は書き出せない**(管理者にも見せない)', async () => {
    await expect(
      run(() => inOrg(ORG_A, (s) => s.exportDay(ctxFor('org_admin'), TODAY))),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('担当者は書き出せない', async () => {
    await expect(
      run(() => inOrg(ORG_A, (s) => s.exportDay(ctxFor('agent'), TODAY))),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('依頼者は書き出せない', async () => {
    await expect(
      run(() => inOrg(ORG_A, (s) => s.exportDay(ctxFor('requester'), TODAY))),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('**組織の監査者には自組織の記録しか出ない**', async () => {
    const result = await run(() => inOrg(ORG_A, (s) => s.exportDay(ctxFor('auditor'), TODAY)));
    // RLS により他組織は物理的に見えない。
    expect(
      result.events.every((e) => e.organizationId === ORG_A || e.organizationId === null),
    ).toBe(true);
    expect(result.events.some((e) => e.organizationId === ORG_B)).toBe(false);
  });

  it('**プラットフォーム監査者には全組織が出る**', async () => {
    // **測ることが対象を増やす。** 書き出しは `audit.export.executed` を自分で記録するので、
    // 後から取った側が必ず1件多い(04.23 §26 と同じ形)。
    //
    // 以前は件数の大小で比べていた。これは**他組織の記録がたまたま在る日にだけ通る**
    // 検査であり、その日が来ないと「プラットフォーム側のほうが少ない」と落ちる
    // (WP-P1-SEC-024 で実際に落ちた — その組織の記録しか無い状態を作ったため)。
    //
    // 組織側を先に取り、**プラットフォーム側がその上位集合であること**を見る。
    // 件数の比較より強い主張であり、測定の順序にも左右されない。
    const orgScoped = await run(() => inOrg(ORG_A, (s) => s.exportDay(ctxFor('auditor'), TODAY)));
    const platform = await run(() =>
      inOrg(ORG_A, (s) => s.exportDay(ctxFor('platform_auditor'), TODAY)),
    );

    expect(platform.manifest.scope).toBe('platform');
    // 横断の読み取り例外(migration 0023)が効いている
    const visibleToPlatform = new Set(platform.events.map((e) => e.eventId));
    expect(orgScoped.events.every((e) => visibleToPlatform.has(e.eventId))).toBe(true);
    expect(orgScoped.events.length).toBeGreaterThan(0);
  });

  it('日付の形式を見る', async () => {
    await expect(
      run(() => inOrg(ORG_A, (s) => s.exportDay(ctxFor('auditor'), '2026/08/08'))),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('取り出したことが残る (AUD-002)', () => {
  it('**書き出しそのものが監査に記録される**', async () => {
    const before = await admin.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE event_type = 'audit.export.executed'",
    );

    await run(() => inOrg(ORG_A, (s) => s.exportDay(ctxFor('auditor'), TODAY)));

    const after = await admin.query(
      `SELECT count(*)::int AS n FROM audit_event WHERE event_type = 'audit.export.executed'`,
    );
    expect(after.rows[0].n).toBe(before.rows[0].n + 1);
  });

  it('**中身は残さない。範囲と件数だけ**', async () => {
    await run(() => inOrg(ORG_A, (s) => s.exportDay(ctxFor('auditor'), TODAY)));

    const { rows } = await admin.query(
      `SELECT after_state FROM audit_event
        WHERE event_type = 'audit.export.executed' ORDER BY event_id DESC LIMIT 1`,
    );
    const state = rows[0].after_state;
    expect(Object.keys(state).sort()).toEqual(['date', 'eventCount', 'scope', 'truncated']);
  });
});

describe('再計算がアンカーと一致する (AUD-003)', () => {
  it('**全体の書き出しから日次ルートを再計算できる**', async () => {
    const result = await run(() =>
      inOrg(ORG_A, (s) => s.exportDay(ctxFor('platform_auditor'), SETTLED_DAY)),
    );
    expect(result.manifest.anchorVerifiable).toBe(true);

    // 書き出しだけを入力に連鎖を組み直す
    let chain = createHash('sha256').update('').digest('hex');
    for (const event of result.events) {
      chain = createHash('sha256').update(chain).update(event.canonical).digest('hex');
    }

    // アンカー計算(worker 側)と突き合わせる。
    // **正準形を書き写していないことの確認でもある** —
    // 書き写して片方だけずれていれば、ここで合わない。
    const expected = await computeDailyRoot(admin, SETTLED_DAY);
    expect(result.events.length).toBe(expected.eventCount);
    expect(chain).toBe(expected.rootHash);
  });

  it('**組織で絞った書き出しは照合できないと明示する**', async () => {
    const result = await run(() => inOrg(ORG_A, (s) => s.exportDay(ctxFor('auditor'), TODAY)));
    // 連鎖は組織をまたぐ。できないことを「できる」と見せない。
    expect(result.manifest.anchorVerifiable).toBe(false);
    expect(result.manifest.scope).toBe('organization');
  });

  it('**当日は照合できないと明示する**(書き出した記録自体が含まれない)', async () => {
    const result = await run(() =>
      inOrg(ORG_A, (s) => s.exportDay(ctxFor('platform_auditor'), TODAY)),
    );
    // 書き出しは `audit.export.executed` を記録する。当日を書き出すと
    // その1件が含まれず、あとから再計算すると必ず食い違う。
    expect(result.manifest.anchorVerifiable).toBe(false);
  });

  it('書き出しは event_id 昇順である(連鎖は順序に依存する)', async () => {
    const result = await run(() =>
      inOrg(ORG_A, (s) => s.exportDay(ctxFor('platform_auditor'), SETTLED_DAY)),
    );
    const ids = result.events.map((e) => e.eventId);
    expect(ids).toEqual([...ids].sort());
  });
});

describe('JSONL の形', () => {
  it('**1行目が manifest、以降が1件ずつ**', async () => {
    const result = await run(() => inOrg(ORG_A, (s) => s.exportDay(ctxFor('auditor'), TODAY)));
    const lines = toJsonl(result).split('\n');

    expect(JSON.parse(lines[0]!).kind).toBe('manifest');
    for (const line of lines.slice(1)) {
      expect(JSON.parse(line).kind).toBe('event');
    }
    expect(lines.length).toBe(result.events.length + 1);
  });

  it('1行ずつ独立して読める(壊れた行を飛ばせる)', async () => {
    const result = await run(() => inOrg(ORG_A, (s) => s.exportDay(ctxFor('auditor'), TODAY)));
    for (const line of toJsonl(result).split('\n')) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
