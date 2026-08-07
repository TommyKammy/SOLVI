/**
 * 期限切れセッションの掃除 (FR-IDM-008 / 03.16 / WP-P1-IDM-013)。
 *
 * `SessionService.purgeExpired` は [[WP-P1-IDM-009]] で書かれ、
 * 冒頭に「定期実行から呼ぶ」と書かれていた。**その定期実行が無かった。**
 *
 * ここで確かめるのは2つ。
 *
 *   1. **生きているものを消さない** — 消すと利用者が理由なく締め出される
 *   2. **消しても記録は失われない** — 監査は `audit_event` 側に残る
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { runWithContext, newContext, type Logger } from '@solvi/shared';
import { SessionPurger } from '../../services/api/src/common/session/purge.js';
import { SessionService } from '../../services/api/src/modules/auth/session.service.js';
import { uuidv7 } from '../../services/api/src/common/audit/audit.js';
import { hashPassword } from '../../packages/shared/src/auth/password.js';

const ORG_A = '00000000-0000-4000-9000-000000000001';
const DAY = 24 * 60 * 60 * 1000;

let pool: pg.Pool;
let admin: pg.Client;
let userId: string;

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** 任意の時刻・状態のセッション行を直接作る。検査の下準備である。 */
async function makeSession(params: {
  createdDaysAgo: number;
  absoluteExpiresDaysAgo?: number;
  revokedDaysAgo?: number;
}): Promise<string> {
  const id = uuidv7();
  const created = new Date(Date.now() - params.createdDaysAgo * DAY);
  const absolute =
    params.absoluteExpiresDaysAgo === undefined
      ? new Date(Date.now() + DAY)
      : new Date(Date.now() - params.absoluteExpiresDaysAgo * DAY);
  const revoked =
    params.revokedDaysAgo === undefined ? null : new Date(Date.now() - params.revokedDaysAgo * DAY);

  await admin.query(
    `INSERT INTO session
       (id, user_id, organization_id, token_hash, auth_method, issued_at, last_seen_at,
        idle_expires_at, absolute_expires_at, revoked_at, revoked_reason)
     VALUES ($1, $2, $3, $4, 'local', $5, $5, $6, $7, $8, $9)`,
    [
      id,
      userId,
      ORG_A,
      `hash-${id}`,
      created,
      new Date(created.getTime() + 60 * 60 * 1000),
      absolute,
      revoked,
      revoked ? 'logout' : null,
    ],
  );
  return id;
}

const exists = async (id: string): Promise<boolean> => {
  const { rows } = await admin.query('SELECT 1 FROM session WHERE id = $1', [id]);
  return rows.length > 0;
};

const sweep = (retentionDays = 30): Promise<{ deleted: number }> =>
  runWithContext(newContext(), () => new SessionPurger(pool, silent, retentionDays).sweepOnce());

beforeAll(async () => {
  const appUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!appUrl || !adminUrl) throw new Error('DATABASE_URL と DATABASE_ADMIN_URL が必要です');
  pool = new pg.Pool({ connectionString: appUrl, max: 5 });
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();

  userId = uuidv7();
  await admin.query(
    `INSERT INTO app_user (id, primary_email, display_name, status, created_via)
     VALUES ($1, 'purge@example.com', 'purge', 'active', 'admin')`,
    [userId],
  );
  const { rows } = await admin.query("SELECT id, scope FROM role WHERE code = 'agent'");
  await admin.query(
    `INSERT INTO role_binding (id, user_id, role_id, role_scope, organization_id, source)
     VALUES ($1, $2, $3, $4, $5, 'manual')`,
    [uuidv7(), userId, rows[0].id, rows[0].scope, ORG_A],
  );
  await admin.query(
    `INSERT INTO local_credential (id, user_id, password_hash) VALUES ($1, $2, $3)`,
    [uuidv7(), userId, await hashPassword('a-perfectly-fine-password')],
  );
});

afterAll(async () => {
  await admin.query('DELETE FROM session WHERE user_id = $1', [userId]);
  await admin.query('DELETE FROM local_credential WHERE user_id = $1', [userId]);
  await admin.query('DELETE FROM role_binding WHERE user_id = $1', [userId]);
  await admin.query('DELETE FROM app_user WHERE id = $1', [userId]);
  await admin?.end();
  await pool?.end();
});

beforeEach(async () => {
  await admin.query('DELETE FROM session WHERE user_id = $1', [userId]);
});

describe('消してはいけないものを消さない', () => {
  it('**生きているセッションは消さない**', async () => {
    const live = await makeSession({ createdDaysAgo: 0 });
    await sweep();
    expect(await exists(live)).toBe(true);
  });

  it('**古くても生きていれば消さない**(絶対期限が先ならまだ使える)', async () => {
    // 100日前に発行されたが、絶対期限はまだ先という行。
    // 「作られてから何日経ったか」で消すと、これを消してしまう。
    const old = await makeSession({ createdDaysAgo: 100 });
    await sweep();
    expect(await exists(old)).toBe(true);
  });

  it('失効したばかりのものは消さない(保持期間の中)', async () => {
    const recent = await makeSession({ createdDaysAgo: 1, revokedDaysAgo: 1 });
    await sweep(30);
    expect(await exists(recent)).toBe(true);
  });

  it('期限切れでも保持期間の中なら消さない', async () => {
    const recent = await makeSession({ createdDaysAgo: 2, absoluteExpiresDaysAgo: 1 });
    await sweep(30);
    expect(await exists(recent)).toBe(true);
  });
});

describe('保持期間を過ぎたものは消える', () => {
  it('絶対期限が保持期間より前なら消える', async () => {
    const stale = await makeSession({ createdDaysAgo: 60, absoluteExpiresDaysAgo: 59 });
    const result = await sweep(30);
    expect(result.deleted).toBe(1);
    expect(await exists(stale)).toBe(false);
  });

  it('**失効から保持期間が過ぎたものも消える**', async () => {
    // 絶対期限はまだ先だが、失効させて久しい行。
    // 失効を見ないと、この行は永久に残る。
    const revoked = await makeSession({ createdDaysAgo: 60, revokedDaysAgo: 45 });
    const result = await sweep(30);
    expect(result.deleted).toBe(1);
    expect(await exists(revoked)).toBe(false);
  });

  it('保持日数を変えると境界も動く', async () => {
    const id = await makeSession({ createdDaysAgo: 21, absoluteExpiresDaysAgo: 20 });
    expect((await sweep(30)).deleted).toBe(0);
    expect((await sweep(10)).deleted).toBe(1);
    expect(await exists(id)).toBe(false);
  });

  it('何度回しても消えるものが尽きたら0件になる', async () => {
    await makeSession({ createdDaysAgo: 60, absoluteExpiresDaysAgo: 59 });
    expect((await sweep()).deleted).toBe(1);
    expect((await sweep()).deleted).toBe(0);
  });
});

describe('消しても記録は失われない', () => {
  it('**監査イベントは減らない**', async () => {
    const before = await admin.query('SELECT count(*)::int AS n FROM audit_event');

    await makeSession({ createdDaysAgo: 60, absoluteExpiresDaysAgo: 59 });
    await makeSession({ createdDaysAgo: 90, revokedDaysAgo: 80 });
    expect((await sweep()).deleted).toBe(2);

    const after = await admin.query('SELECT count(*)::int AS n FROM audit_event');
    // セッション行は業務の記録ではなく運用の状態である。
    // 「誰がいつログインしたか」「なぜ失効したか」は audit_event 側に残る。
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('掃除しても他の利用者のセッションは触らない', async () => {
    const otherId = uuidv7();
    await admin.query(
      `INSERT INTO app_user (id, primary_email, display_name, status, created_via)
       VALUES ($1, 'purge-other@example.com', 'other', 'active', 'admin')`,
      [otherId],
    );
    await admin.query(
      `INSERT INTO session
         (id, user_id, organization_id, token_hash, auth_method, issued_at, last_seen_at,
          idle_expires_at, absolute_expires_at)
       VALUES ($1, $2, $3, $4, 'local', now(), now(), now() + interval '1 hour',
               now() + interval '12 hours')`,
      [uuidv7(), otherId, ORG_A, `hash-other-${uuidv7()}`],
    );

    await makeSession({ createdDaysAgo: 60, absoluteExpiresDaysAgo: 59 });
    expect((await sweep()).deleted).toBe(1);

    const { rows } = await admin.query(
      'SELECT count(*)::int AS n FROM session WHERE user_id = $1',
      [otherId],
    );
    expect(rows[0].n).toBe(1);

    await admin.query('DELETE FROM session WHERE user_id = $1', [otherId]);
    await admin.query('DELETE FROM app_user WHERE id = $1', [otherId]);
  });
});

describe('定期実行として成り立つ', () => {
  it('**組織コンテキストを設定しなくても動く**(session は組織の軸を持たない)', async () => {
    // `session` の RLS は USING (true)(migration 0011)。
    // 兼務者は1つのセッションで組織を切り替えるため、組織で分けると
    // 「どちらの組織の掃除か」が決められない。
    const stale = await makeSession({ createdDaysAgo: 60, absoluteExpiresDaysAgo: 59 });
    const client = await pool.connect();
    try {
      // app.current_org を一切設定せずに呼ぶ
      const deleted = await new SessionService(client).purgeExpired(30);
      expect(deleted).toBe(1);
    } finally {
      client.release();
    }
    expect(await exists(stale)).toBe(false);
  });

  it('失敗してもAPIを落とさない(接続が死んでいても例外を投げ切らない)', async () => {
    const dead = new pg.Pool({ connectionString: 'postgres://127.0.0.1:1/none' });
    const purger = new SessionPurger(dead, silent, 30);
    await expect(runWithContext(newContext(), () => purger.sweepOnce())).rejects.toBeDefined();
    // ループ側が握るため、ここでは「投げること」だけを固定する。
    await dead.end().catch(() => undefined);
  });
});
