/**
 * 四半期アクセスレビューの定期起票 (NFR-SEC-002 / WP-P1-SEC-025 / TL-04 / TL-06)。
 *
 * [[WP-P1-SEC-024]] で「開ける」ようになった。ここで確かめるのは
 * 「**開かれていなければ、機械が開く**」ことと「**遅れが見える**」ことである。
 *
 * 重点は4つ。
 *
 *   1. **期を名前で判定しない** — 人が別の名前で開いていれば、それで足りる
 *   2. **前の期が終わっていなければ開かない** — 代わりに遅れとして数える
 *   3. **何度回しても1つしかできない**(冪等)
 *   4. **人ではないものを人として記録しない** — opened_by は空、監査は system
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { runWithContext, newContext, type Logger } from '@solvi/shared';
import {
  AccessReviewScheduler,
  quarterOf,
  startAccessReviewScheduleLoop,
} from '../../services/api/src/modules/auth/access-review-scheduler.js';
import { AccessReviewService } from '../../services/api/src/modules/auth/access-review.service.js';
import { uuidv7 } from '../../services/api/src/common/audit/audit.js';
import type { AuthzContext } from '../../services/api/src/common/authz/authz.js';
import { cleanBusinessData, cleanAuditData } from '../support/cleanup.js';

const ORG_A = '00000000-0000-4000-9000-000000000001';
const ORG_B = '00000000-0000-4000-9000-000000000002';
const PAST = new Date('2026-01-01T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

let pool: pg.Pool;
let admin: pg.Client;

const run = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(newContext(), fn);
const scheduler = (dueDays = 30) => new AccessReviewScheduler(pool, silent, dueDays);

async function activeOrgIds(): Promise<string[]> {
  const { rows } = await admin.query("SELECT id FROM organization WHERE status = 'active'");
  return rows.map((r) => r.id as string);
}

async function reviewsOf(orgId: string) {
  const { rows } = await admin.query(
    `SELECT id, period_label, source, opened_by, opened_at, due_at, completed_at
       FROM access_review WHERE organization_id = $1 ORDER BY opened_at`,
    [orgId],
  );
  return rows;
}

async function createAdmin(orgId: string): Promise<string> {
  const userId = uuidv7();
  await admin.query(
    `INSERT INTO app_user (id, primary_email, display_name, status, created_via)
     VALUES ($1, $2, $3, 'active', 'admin')`,
    [userId, `ars-${userId}@example.com`, `ars-${userId}`],
  );
  const { rows } = await admin.query("SELECT id FROM role WHERE code = 'org_admin'");
  await admin.query(
    `INSERT INTO role_binding (id, user_id, role_id, role_scope, organization_id, source, valid_from)
     VALUES ($1, $2, $3, 'org', $4, 'manual', $5)`,
    [uuidv7(), userId, rows[0].id, orgId, PAST],
  );
  return userId;
}

function ctxFor(userId: string, orgId: string): AuthzContext {
  return {
    principal: {
      userId,
      status: 'active',
      bindings: [
        { roleCode: 'org_admin', organizationId: orgId, validFrom: PAST, validUntil: null },
      ],
    },
    organizationId: orgId,
  };
}

async function openManually(orgId: string, label: string, dueDays = 30): Promise<string> {
  const userId = await createAdmin(orgId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_org', orgId]);
    const { reviewId } = await run(() =>
      new AccessReviewService(client, dueDays).open(ctxFor(userId, orgId), label),
    );
    await client.query('COMMIT');
    return reviewId;
  } finally {
    client.release();
  }
}

/** 開始時刻を前の四半期へずらす(「前の期が残っている」状態を作る)。 */
async function moveToPreviousQuarter(reviewId: string): Promise<void> {
  const opened = new Date(quarterOf(new Date()).start.getTime() - 40 * DAY);
  await admin.query(
    `UPDATE access_review SET opened_at = $2, due_at = $2::timestamptz + interval '30 days'
      WHERE id = $1`,
    [reviewId, opened.toISOString()],
  );
}

beforeAll(async () => {
  const appUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!appUrl || !adminUrl) throw new Error('DATABASE_URL と DATABASE_ADMIN_URL が必要です');
  pool = new pg.Pool({ connectionString: appUrl, max: 10 });
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
});

afterAll(async () => {
  await cleanBusinessData(admin);
  await admin.query(
    "DELETE FROM role_binding WHERE user_id IN (SELECT id FROM app_user WHERE primary_email LIKE 'ars-%')",
  );
  await admin.query("DELETE FROM app_user WHERE primary_email LIKE 'ars-%'");
  await admin?.end();
  await pool?.end();
});

beforeEach(async () => {
  await cleanBusinessData(admin);
  await cleanAuditData(admin);
});

describe('四半期の名前', () => {
  it('境界は UTC で数える', () => {
    expect(quarterOf(new Date('2026-09-30T23:59:59Z')).label).toBe('2026-Q3');
    expect(quarterOf(new Date('2026-10-01T00:00:00Z')).label).toBe('2026-Q4');
    expect(quarterOf(new Date('2026-01-01T00:00:00Z')).start.toISOString()).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });
});

describe('開かれていなければ開く (AC-1 / AC-8)', () => {
  it('**その四半期のレビューが無い組織すべてに、定期処理が開く**', async () => {
    const summary = await run(() => scheduler().runOnce());
    const orgs = await activeOrgIds();
    expect(summary.opened).toBe(orgs.length);

    const { label } = quarterOf(new Date());
    for (const orgId of orgs) {
      const reviews = await reviewsOf(orgId);
      expect(reviews).toHaveLength(1);
      expect(reviews[0].period_label).toBe(label);
      expect(reviews[0].source).toBe('scheduled');
      // **人ではないものを人として記録しない。**
      expect(reviews[0].opened_by).toBeNull();
    }

    const { rows } = await admin.query(
      `SELECT actor_type, actor_id FROM audit_event WHERE event_type = 'access.review.opened'`,
    );
    expect(rows.length).toBe(orgs.length);
    expect(rows.every((r) => r.actor_type === 'system' && r.actor_id === null)).toBe(true);
  });

  it('**開いた項目はその組織の役割だけ**(書き込みを越境させない / AC-10)', async () => {
    await run(() => scheduler().runOnce());
    const { rows } = await admin.query(
      `SELECT count(*)::int AS n
         FROM access_review_item i
         JOIN access_review ar ON ar.id = i.review_id
         JOIN role_binding rb ON rb.id = i.role_binding_id
        WHERE i.organization_id <> ar.organization_id
           OR rb.organization_id IS DISTINCT FROM ar.organization_id`,
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('名前ではなく、その四半期に開かれたかで判定する (AC-2)', () => {
  it('**人が別の名前で開いて完了していれば、定期処理は開かない**', async () => {
    const reviewId = await openManually(ORG_A, 'Extra-Review');
    // 項目を全部判断して完了させる代わりに、完了済みの状態を作る。
    await admin.query(
      `UPDATE access_review_item SET decision = 'keep', decided_at = now(),
              decided_by = (SELECT opened_by FROM access_review WHERE id = $1), reason = '検査'
        WHERE review_id = $1`,
      [reviewId],
    );
    await admin.query(
      `UPDATE access_review SET completed_at = now(), completed_by = opened_by WHERE id = $1`,
      [reviewId],
    );

    await run(() => scheduler().runOnce());
    const reviews = await reviewsOf(ORG_A);
    expect(reviews).toHaveLength(1);
    expect(reviews[0].period_label).toBe('Extra-Review');
  });
});

describe('前の期が終わっていなければ開かない (AC-3)', () => {
  it('**開かずに、遅れとして数える**', async () => {
    const reviewId = await openManually(ORG_A, 'Old-Quarter');
    await moveToPreviousQuarter(reviewId);

    const summary = await run(() => scheduler().runOnce());
    expect(summary.blockedByOpen).toBeGreaterThanOrEqual(1);

    const reviews = await reviewsOf(ORG_A);
    expect(reviews).toHaveLength(1);
    expect(reviews[0].period_label).toBe('Old-Quarter');

    // 前の期の期日(開始から30日)は既に過ぎている。
    expect(await scheduler().countOverdue()).toBeGreaterThanOrEqual(1);
  });
});

describe('冪等 (AC-4)', () => {
  it('**何度回しても、同じ期は1つしかできない**', async () => {
    await run(() => scheduler().runOnce());
    const second = await run(() => scheduler().runOnce());
    expect(second.opened).toBe(0);
    for (const orgId of await activeOrgIds()) {
      expect(await reviewsOf(orgId)).toHaveLength(1);
    }
  });

  it('同時に回しても1つしかできない', async () => {
    await Promise.all([run(() => scheduler().runOnce()), run(() => scheduler().runOnce())]);
    for (const orgId of await activeOrgIds()) {
      expect(await reviewsOf(orgId)).toHaveLength(1);
    }
  });
});

describe('期日 (AC-5)', () => {
  it('**期日は設定した日数で付く**(定期処理)', async () => {
    await run(() => scheduler(7).runOnce());
    const [review] = await reviewsOf(ORG_B);
    const days = (review.due_at.getTime() - review.opened_at.getTime()) / DAY;
    expect(days).toBeCloseTo(7, 3);
  });

  it('**人が開いた期にも期日が付く**', async () => {
    const reviewId = await openManually(ORG_A, 'Manual-Due', 30);
    const { rows } = await admin.query(
      'SELECT opened_at, due_at FROM access_review WHERE id = $1',
      [reviewId],
    );
    const days = (rows[0].due_at.getTime() - rows[0].opened_at.getTime()) / DAY;
    expect(days).toBeCloseTo(30, 3);
  });

  it('期日前のものは遅れに数えない', async () => {
    await run(() => scheduler().runOnce());
    expect(await scheduler().countOverdue()).toBe(0);
  });
});

describe('始まらないことを数える (AC-6)', () => {
  it('**開かれる前は全組織が「未開始」、開いた後は 0**', async () => {
    const before = await scheduler().countMissingThisQuarter();
    expect(before).toBe((await activeOrgIds()).length);
    await run(() => scheduler().runOnce());
    expect(await scheduler().countMissingThisQuarter()).toBe(0);
  });
});

describe('平時にもログを出す (AC-7)', () => {
  it('**開くものが無い周回でも、件数をログへ出す**', async () => {
    // 1周目で全組織が開かれる。2周目は「開くものが無い」周回である。
    await run(() => scheduler().runOnce());

    const infos: Array<{ message: string; detail?: string }> = [];
    const capturing: Logger = {
      ...silent,
      info: (message: string, fields?: { message?: string }) => {
        infos.push({ message, detail: fields?.message });
      },
    };
    const timer = startAccessReviewScheduleLoop(scheduler(), capturing, 60 * 60 * 1000);
    try {
      for (let i = 0; i < 50 && infos.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      clearInterval(timer);
    }

    const line = infos.find((l) => l.message === 'access review schedule');
    expect(line).toBeDefined();
    // **止まっていることと、対象が無いことを区別できる**形で出ている。
    expect(line!.detail).toMatch(/opened=0 /);
    expect(line!.detail).toMatch(/alreadyCovered=\d+/);
  });
});
