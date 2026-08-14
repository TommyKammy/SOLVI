/**
 * アクセスレビュー (NFR-SEC-002 / WP-P1-SEC-024 / TL-04 / TL-06 / TL-16)。
 *
 * この要求は「最小権限+四半期アクセスレビュー」であり、
 * ここで確かめるのは**レビューの側だけ**である。
 * Connector別最小スコープ表(GB-7)は Phase 4 で、まだ存在しない。
 *
 * 重点は4つ。
 *
 *   1. **開いた時点で対象が固定される** — 後から増えた役割は入らない
 *   2. **取り消しの判断が実際に効く** — 記録だけを作らない
 *   3. **未判断を残して完了できない** — 「実施した」は全部見たときだけ真
 *   4. **他組織のレビューは見えない・触れない** — API認可とRLSの二層
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { runWithContext, newContext } from '@solvi/shared';
import { AccessReviewService } from '../../services/api/src/modules/auth/access-review.service.js';
import { UserAdminService } from '../../services/api/src/modules/auth/user-admin.service.js';
import { uuidv7 } from '../../services/api/src/common/audit/audit.js';
import type { AuthzContext, RoleCode } from '../../services/api/src/common/authz/authz.js';
import { cleanBusinessData, cleanAuditData } from '../support/cleanup.js';

const ORG_A = '00000000-0000-4000-9000-000000000001';
const ORG_B = '00000000-0000-4000-9000-000000000002';
const PAST = new Date('2026-01-01T00:00:00Z');

let pool: pg.Pool;
let admin: pg.Client;

const run = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(newContext(), fn);

async function createUser(email: string, orgId: string, roleCode: string): Promise<string> {
  const userId = uuidv7();
  await admin.query(
    `INSERT INTO app_user (id, primary_email, display_name, status, created_via)
     VALUES ($1, $2, $3, 'active', 'admin')`,
    [userId, email, email],
  );
  const { rows } = await admin.query('SELECT id, scope FROM role WHERE code = $1', [roleCode]);
  await admin.query(
    `INSERT INTO role_binding (id, user_id, role_id, role_scope, organization_id, source, valid_from)
     VALUES ($1, $2, $3, $4, $5, 'manual', $6)`,
    [uuidv7(), userId, rows[0].id, rows[0].scope, orgId, PAST],
  );
  return userId;
}

function ctxFor(userId: string, orgId: string, roles: RoleCode[]): AuthzContext {
  return {
    principal: {
      userId,
      status: 'active',
      bindings: roles.map((roleCode) => ({
        roleCode,
        organizationId: orgId,
        validFrom: PAST,
        validUntil: null,
      })),
    },
    organizationId: orgId,
  };
}

/** 組織の文脈を張って1つの手続きを走らせる。実経路(controller)と同じ形。 */
async function withOrg<T>(orgId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
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

async function effectiveRoles(userId: string, orgId: string): Promise<string[]> {
  const { rows } = await admin.query(
    `SELECT r.code FROM role_binding rb JOIN role r ON r.id = rb.role_id
      WHERE rb.user_id = $1 AND rb.organization_id = $2
        AND rb.valid_from <= now() AND (rb.valid_until IS NULL OR rb.valid_until > now())`,
    [userId, orgId],
  );
  return rows.map((r) => r.code as string);
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
  await admin?.end();
  await pool?.end();
});

beforeEach(async () => {
  await cleanBusinessData(admin);
  await cleanAuditData(admin);
  // このファイルが作った利用者だけを片付ける。シードには触れない。
  await admin.query("DELETE FROM role_binding WHERE user_id IN (SELECT id FROM app_user WHERE primary_email LIKE 'ar-%')");
  await admin.query("DELETE FROM app_user WHERE primary_email LIKE 'ar-%'");
});

describe('開いた時点で対象が固定される (AC-1)', () => {
  it('**開始後に与えた役割は、その期の対象に入らない**', async () => {
    const adminUser = await createUser('ar-admin@example.com', ORG_A, 'org_admin');
    const member = await createUser('ar-member@example.com', ORG_A, 'agent');
    const ctx = ctxFor(adminUser, ORG_A, ['org_admin']);

    const { reviewId, items } = await withOrg(ORG_A, (c) =>
      run(() => new AccessReviewService(c).open(ctx, '2026-Q3')),
    );
    expect(items).toBeGreaterThanOrEqual(2);

    // 開いた後に役割を足す。
    await withOrg(ORG_A, (c) =>
      run(() =>
        new UserAdminService(c).grantRole(ctx, member, 'approver', {
          validUntil: null,
          reason: '開始後の付与',
        }),
      ),
    );

    const detail = await withOrg(ORG_A, (c) =>
      run(() => new AccessReviewService(c).detail(ctx, reviewId)),
    );
    const approverItems = detail.items.filter(
      (i) => i.userId === member && i.roleCode === 'approver',
    );
    expect(approverItems).toHaveLength(0);
  });

  it('同じ組織で2つ同時に開けない (AC-2)', async () => {
    const adminUser = await createUser('ar-admin@example.com', ORG_A, 'org_admin');
    const ctx = ctxFor(adminUser, ORG_A, ['org_admin']);
    await withOrg(ORG_A, (c) => run(() => new AccessReviewService(c).open(ctx, '2026-Q3')));

    await expect(
      withOrg(ORG_A, (c) => run(() => new AccessReviewService(c).open(ctx, '2026-Q4'))),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('判断が実際に効く (AC-3 / AC-4)', () => {
  it('理由の無い判断は拒む', async () => {
    const adminUser = await createUser('ar-admin@example.com', ORG_A, 'org_admin');
    const ctx = ctxFor(adminUser, ORG_A, ['org_admin']);
    const { reviewId } = await withOrg(ORG_A, (c) =>
      run(() => new AccessReviewService(c).open(ctx, '2026-Q3')),
    );
    const detail = await withOrg(ORG_A, (c) =>
      run(() => new AccessReviewService(c).detail(ctx, reviewId)),
    );

    await expect(
      withOrg(ORG_A, (c) =>
        run(() =>
          new AccessReviewService(c).decide(ctx, reviewId, detail.items[0]!.id, 'keep', '   '),
        ),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('**revoke は記録だけでなく、役割を実際に失効させる**', async () => {
    const adminUser = await createUser('ar-admin@example.com', ORG_A, 'org_admin');
    const member = await createUser('ar-member@example.com', ORG_A, 'agent');
    const ctx = ctxFor(adminUser, ORG_A, ['org_admin']);

    const { reviewId } = await withOrg(ORG_A, (c) =>
      run(() => new AccessReviewService(c).open(ctx, '2026-Q3')),
    );
    const detail = await withOrg(ORG_A, (c) =>
      run(() => new AccessReviewService(c).detail(ctx, reviewId)),
    );
    const target = detail.items.find((i) => i.userId === member && i.roleCode === 'agent');
    expect(target).toBeDefined();
    expect(await effectiveRoles(member, ORG_A)).toContain('agent');

    await withOrg(ORG_A, (c) =>
      run(() =>
        new AccessReviewService(c).decide(ctx, reviewId, target!.id, 'revoke', '異動により不要'),
      ),
    );

    // **ここが本体である。** 記録ではなく、権限そのものが消えていること。
    expect(await effectiveRoles(member, ORG_A)).not.toContain('agent');
  });

  it('既に失効した役割へ revoke を求めない (AC-9)', async () => {
    const adminUser = await createUser('ar-admin@example.com', ORG_A, 'org_admin');
    const member = await createUser('ar-member@example.com', ORG_A, 'agent');
    const ctx = ctxFor(adminUser, ORG_A, ['org_admin']);

    const { reviewId } = await withOrg(ORG_A, (c) =>
      run(() => new AccessReviewService(c).open(ctx, '2026-Q3')),
    );
    // 別経路(通常の取り消し)で先に失効させる。
    await withOrg(ORG_A, (c) =>
      run(() => new UserAdminService(c).revokeRole(ctx, member, 'agent', 'レビュー外で取り消し')),
    );

    const detail = await withOrg(ORG_A, (c) =>
      run(() => new AccessReviewService(c).detail(ctx, reviewId)),
    );
    const target = detail.items.find((i) => i.userId === member && i.roleCode === 'agent')!;
    expect(target.alreadyInactive).toBe(true);

    await expect(
      withOrg(ORG_A, (c) =>
        run(() => new AccessReviewService(c).decide(ctx, reviewId, target.id, 'revoke', '重ねて')),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('完了 (AC-5)', () => {
  it('**未判断が残っていれば完了できない**', async () => {
    const adminUser = await createUser('ar-admin@example.com', ORG_A, 'org_admin');
    await createUser('ar-member@example.com', ORG_A, 'agent');
    const ctx = ctxFor(adminUser, ORG_A, ['org_admin']);
    const { reviewId } = await withOrg(ORG_A, (c) =>
      run(() => new AccessReviewService(c).open(ctx, '2026-Q3')),
    );

    await expect(
      withOrg(ORG_A, (c) => run(() => new AccessReviewService(c).complete(ctx, reviewId))),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('全部を判断すると完了でき、完了者と時刻が残る', async () => {
    const adminUser = await createUser('ar-admin@example.com', ORG_A, 'org_admin');
    await createUser('ar-member@example.com', ORG_A, 'agent');
    const ctx = ctxFor(adminUser, ORG_A, ['org_admin']);
    const { reviewId } = await withOrg(ORG_A, (c) =>
      run(() => new AccessReviewService(c).open(ctx, '2026-Q3')),
    );
    const detail = await withOrg(ORG_A, (c) =>
      run(() => new AccessReviewService(c).detail(ctx, reviewId)),
    );

    for (const item of detail.items) {
      await withOrg(ORG_A, (c) =>
        run(() => new AccessReviewService(c).decide(ctx, reviewId, item.id, 'keep', '継続して必要')),
      );
    }

    const done = await withOrg(ORG_A, (c) =>
      run(() => new AccessReviewService(c).complete(ctx, reviewId)),
    );
    expect(done.decided).toBe(detail.items.length);

    const { rows } = await admin.query(
      'SELECT completed_at, completed_by FROM access_review WHERE id = $1',
      [reviewId],
    );
    expect(rows[0].completed_at).not.toBeNull();
    expect(rows[0].completed_by).toBe(adminUser);

    // 完了後は書き換えられない。
    await expect(
      withOrg(ORG_A, (c) =>
        run(() =>
          new AccessReviewService(c).decide(ctx, reviewId, detail.items[0]!.id, 'keep', '後から'),
        ),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('監査 (AC-6 / AC-8)', () => {
  it('開始・判断・完了が監査に残り、自己承認が分かる', async () => {
    const adminUser = await createUser('ar-admin@example.com', ORG_A, 'org_admin');
    const ctx = ctxFor(adminUser, ORG_A, ['org_admin']);
    const { reviewId } = await withOrg(ORG_A, (c) =>
      run(() => new AccessReviewService(c).open(ctx, '2026-Q3')),
    );
    const detail = await withOrg(ORG_A, (c) =>
      run(() => new AccessReviewService(c).detail(ctx, reviewId)),
    );
    // 自分自身の org_admin を自分で残す。**禁じないが、記録に残す。**
    const own = detail.items.find((i) => i.userId === adminUser)!;
    await withOrg(ORG_A, (c) =>
      run(() => new AccessReviewService(c).decide(ctx, reviewId, own.id, 'keep', '管理者として継続')),
    );
    for (const item of detail.items.filter((i) => i.id !== own.id)) {
      await withOrg(ORG_A, (c) =>
        run(() => new AccessReviewService(c).decide(ctx, reviewId, item.id, 'keep', '継続')),
      );
    }
    await withOrg(ORG_A, (c) => run(() => new AccessReviewService(c).complete(ctx, reviewId)));

    const { rows } = await admin.query(
      `SELECT event_type, after_state FROM audit_event
        WHERE event_type LIKE 'access.review%' ORDER BY occurred_at`,
    );
    const types = rows.map((r) => r.event_type as string);
    expect(types).toContain('access.review.opened');
    expect(types).toContain('access.review.item.decided');
    expect(types).toContain('access.review.completed');

    const selfDecision = rows.find(
      (r) => r.event_type === 'access.review.item.decided' && r.after_state?.selfReviewed === true,
    );
    expect(selfDecision).toBeDefined();
  });
});

describe('越境と権限 (AC-7)', () => {
  it('**他組織のレビューは存在も見えない**', async () => {
    const adminA = await createUser('ar-admin@example.com', ORG_A, 'org_admin');
    const adminB = await createUser('ar-admin-b@example.com', ORG_B, 'org_admin');
    const ctxA = ctxFor(adminA, ORG_A, ['org_admin']);
    const ctxB = ctxFor(adminB, ORG_B, ['org_admin']);

    const { reviewId } = await withOrg(ORG_A, (c) =>
      run(() => new AccessReviewService(c).open(ctxA, '2026-Q3')),
    );

    // 一覧に出ない。
    const listB = await withOrg(ORG_B, (c) => run(() => new AccessReviewService(c).list(ctxB)));
    expect(listB.find((r) => r.id === reviewId)).toBeUndefined();

    // IDを直接指定しても 404(存在を教えない)。
    await expect(
      withOrg(ORG_B, (c) => run(() => new AccessReviewService(c).detail(ctxB, reviewId))),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('担当者は開始できない', async () => {
    const agent = await createUser('ar-agent@example.com', ORG_A, 'agent');
    const ctx = ctxFor(agent, ORG_A, ['agent']);
    await expect(
      withOrg(ORG_A, (c) => run(() => new AccessReviewService(c).open(ctx, '2026-Q3'))),
    ).rejects.toMatchObject({ status: 403 });
  });
});
