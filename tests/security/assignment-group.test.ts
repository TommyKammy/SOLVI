/**
 * 担当グループ (FR-TKT-003 / WP-P2-GRP-015 / TL-06)。
 *
 * 要求は「担当 Group / User を設定」だが、実装は個人割当だけだった。
 * **これはITSMの基本動作の欠落である。** 問い合わせはまず担当グループの
 * キューに入り、そこから個人が引き受ける。個人指名しかできないと、
 * 「誰に振ればいいか分かる人」が全件を捌くことになる。
 *
 * 重点は3つ。
 *
 *   1. **グループは経路であって進行状態ではない。** 振っても状態は動かない
 *   2. **越境しない。** 他組織のグループへは振れない、メンバーにできない
 *   3. **管理する手段がある。** 作れないグループ機能は使えない
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { runWithContext, newContext } from '@solvi/shared';
import { hashPassword } from '../../packages/shared/src/auth/password.js';
import { TicketController } from '../../services/api/src/modules/ticket/ticket.routes.js';
import { CollaborationController } from '../../services/api/src/modules/ticket/collaboration.routes.js';
import { GroupController } from '../../services/api/src/modules/ticket/group.routes.js';
import { PoolDenialRecorder } from '../../services/api/src/common/audit/denial-recorder.js';
import { S3CompatibleStorage } from '@solvi/shared';
import { SessionService } from '../../services/api/src/modules/auth/session.service.js';
import {
  LocalAuthService,
  LOCAL_ISSUER,
} from '../../services/api/src/modules/auth/local-auth.service.js';
import { beginAuthTransaction } from '../../services/api/src/modules/auth/auth-context.js';
import { uuidv7 } from '../../services/api/src/common/audit/audit.js';
import type { AuthenticatedRequest } from '../../services/api/src/modules/auth/auth.routes.js';
import { cleanBusinessData, cleanAuditData } from '../support/cleanup.js';

const ORG_A = '00000000-0000-4000-9000-000000000001';
const ORG_B = '00000000-0000-4000-9000-000000000002';
const PASSWORD = 'a-perfectly-fine-password';
const PAST = new Date('2026-01-01T00:00:00Z');

let pool: pg.Pool;
let admin: pg.Client;
let tickets: TicketController;
let collab: CollaborationController;
let groups: GroupController;

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
  await admin.query(
    `INSERT INTO identity (id, user_id, idp_type, issuer, subject) VALUES ($1, $2, 'local', $3, $4)`,
    [uuidv7(), userId, LOCAL_ISSUER, email],
  );
  await admin.query(
    `INSERT INTO local_credential (id, user_id, password_hash) VALUES ($1, $2, $3)`,
    [uuidv7(), userId, await hashPassword(PASSWORD)],
  );
  return userId;
}

async function loginAs(email: string, orgId: string): Promise<AuthenticatedRequest> {
  const client = await pool.connect();
  try {
    await beginAuthTransaction(client);
    const sessions = new SessionService(client);
    const auth = new LocalAuthService(client, sessions, {
      maxFailedAttempts: 5,
      lockoutSeconds: 900,
    });
    const result = await runWithContext(newContext(), () =>
      auth.authenticate({ email, password: PASSWORD, organizationId: orgId }),
    );
    if (!result.ok) throw new Error(`ログイン失敗: ${result.reason}`);
    const validation = await sessions.validate(result.token);
    await client.query('COMMIT');
    if (!validation.valid) throw new Error('セッション検証に失敗');
    return {
      authz: { principal: validation.principal, organizationId: orgId },
      sessionId: validation.session.id,
      userId: validation.session.userId,
    };
  } finally {
    client.release();
  }
}

const run = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(newContext(), fn);

async function newTicket(auth: AuthenticatedRequest): Promise<string> {
  const created = await run(() =>
    tickets.create(auth, {
      kind: 'incident',
      subject: 'グループ検査用',
      body: '本文です。',
      impact: 'medium',
      urgency: 'medium',
    }),
  );
  return created.body.id as string;
}

async function newGroup(auth: AuthenticatedRequest, code: string, name: string): Promise<string> {
  const created = await run(() => groups.create(auth, { code, name }));
  return created.body.id as string;
}

beforeAll(async () => {
  const appUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!appUrl || !adminUrl) throw new Error('DATABASE_URL と DATABASE_ADMIN_URL が必要です');
  pool = new pg.Pool({ connectionString: appUrl, max: 10 });
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const denialRecorder = new PoolDenialRecorder(pool);
  tickets = new TicketController({ pool, denialRecorder });
  groups = new GroupController({ pool, denialRecorder });
  collab = new CollaborationController({
    pool,
    denialRecorder,
    storage: new S3CompatibleStorage({
      endpoint: 'http://127.0.0.1:9100',
      bucket: 'solvi-attachments',
      accessKey: 'test',
      secretKey: 'test',
      region: 'ap-northeast-1',
    }),
  });
});

afterAll(async () => {
  await admin?.end();
  await pool?.end();
});

beforeEach(async () => {
  await admin.query('DELETE FROM session');
  await admin.query(
    `DELETE FROM local_credential WHERE user_id IN (SELECT id FROM app_user WHERE created_via = 'admin')`,
  );
  await admin.query(
    `DELETE FROM identity WHERE issuer = $1 AND user_id IN (SELECT id FROM app_user WHERE created_via = 'admin')`,
    [LOCAL_ISSUER],
  );
  await cleanBusinessData(admin);
  // シードのグループは残す(通し確認が使う)。テストが作ったものだけ消す。
  await admin.query(
    "DELETE FROM assignment_group_member WHERE group_id IN (SELECT id FROM assignment_group WHERE code LIKE 'test-%')",
  );
  await admin.query("DELETE FROM assignment_group WHERE code LIKE 'test-%'");
  await admin.query(
    `DELETE FROM role_binding
      WHERE source = 'manual'
        AND user_id IN (SELECT id FROM app_user WHERE created_via = 'admin')`,
  );
  await admin.query("DELETE FROM app_user WHERE created_via = 'admin'");
  await cleanAuditData(
    admin,
    "target_type IN ('ticket', 'session', 'app_user', 'assignment_group')",
  );
});

describe('グループの管理 (FR-TKT-003)', () => {
  it('組織管理者がグループを作れる', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);

    const created = await run(() =>
      groups.create(orgAdmin, { code: 'test-hd', name: 'テストヘルプデスク' }),
    );
    expect(created.status).toBe(201);

    const list = await run(() => groups.list(orgAdmin, new URLSearchParams()));
    expect(list.body.items.some((g) => g.code === 'test-hd')).toBe(true);
  });

  it('**担当者はグループを作れない**(体制を変えられるのは管理者)', async () => {
    await createUser('ops@example.com', ORG_A, 'agent');
    const agent = await loginAs('ops@example.com', ORG_A);

    await expect(
      run(() => groups.create(agent, { code: 'test-x', name: 'X' })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('担当者はグループの一覧を見られる(振り先を選ぶため)', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('ops@example.com', ORG_A, 'agent');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const agent = await loginAs('ops@example.com', ORG_A);
    await newGroup(orgAdmin, 'test-hd', 'テストヘルプデスク');

    const list = await run(() => groups.list(agent, new URLSearchParams()));
    expect(list.body.items.some((g) => g.code === 'test-hd')).toBe(true);
  });

  it('**依頼者はグループを見られない**', async () => {
    await createUser('req@example.com', ORG_A, 'requester');
    const requester = await loginAs('req@example.com', ORG_A);

    await expect(run(() => groups.list(requester, new URLSearchParams()))).rejects.toMatchObject({
      status: 403,
    });
  });

  it('記号が重複したら 409', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    await newGroup(orgAdmin, 'test-dup', '重複');

    await expect(
      run(() => groups.create(orgAdmin, { code: 'test-dup', name: '重複2' })),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('記号の形式が不正なら 400', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);

    await expect(
      run(() => groups.create(orgAdmin, { code: 'Test Group!', name: 'X' })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('**無効化しても消えない**(過去のチケットが振り先を失わない)', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const groupId = await newGroup(orgAdmin, 'test-old', '旧チーム');

    await run(() => groups.setActive(orgAdmin, groupId, { active: false }));

    // 既定の一覧には出ない(振り先の選択肢に使えないものを並べない)
    const active = await run(() => groups.list(orgAdmin, new URLSearchParams()));
    expect(active.body.items.some((g) => g.id === groupId)).toBe(false);

    // 明示すれば出る。行そのものは残っている。
    const all = await run(() =>
      groups.list(orgAdmin, new URLSearchParams({ includeInactive: '1' })),
    );
    expect(all.body.items.some((g) => g.id === groupId)).toBe(true);
  });

  it('**他組織のグループは見えない・触れない**', async () => {
    await createUser('adm-a@example.com', ORG_A, 'org_admin');
    await createUser('adm-b@example.com', ORG_B, 'org_admin');
    const admA = await loginAs('adm-a@example.com', ORG_A);
    const admB = await loginAs('adm-b@example.com', ORG_B);

    const foreignId = await newGroup(admB, 'test-foreign', '他組織のチーム');

    const list = await run(() => groups.list(admA, new URLSearchParams({ includeInactive: '1' })));
    expect(list.body.items.some((g) => g.id === foreignId)).toBe(false);

    await expect(
      run(() => groups.setActive(admA, foreignId, { active: false })),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('メンバー (FR-TKT-003)', () => {
  it('メンバーを追加・削除できる', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    const memberId = await createUser('ops@example.com', ORG_A, 'agent');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const groupId = await newGroup(orgAdmin, 'test-hd', 'テストヘルプデスク');

    await run(() => groups.addMember(orgAdmin, groupId, { userId: memberId }));
    let members = await run(() => groups.listMembers(orgAdmin, groupId));
    expect(members.body.items).toHaveLength(1);

    await run(() => groups.removeMember(orgAdmin, groupId, { userId: memberId }));
    members = await run(() => groups.listMembers(orgAdmin, groupId));
    expect(members.body.items).toHaveLength(0);
  });

  it('二重に追加しても増えない', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    const memberId = await createUser('ops@example.com', ORG_A, 'agent');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const groupId = await newGroup(orgAdmin, 'test-hd', 'テストヘルプデスク');

    await run(() => groups.addMember(orgAdmin, groupId, { userId: memberId }));
    await run(() => groups.addMember(orgAdmin, groupId, { userId: memberId }));
    const members = await run(() => groups.listMembers(orgAdmin, groupId));
    expect(members.body.items).toHaveLength(1);
  });

  it('**他組織の利用者はメンバーにできない**(キュー経由でチケットが読める)', async () => {
    await createUser('adm-a@example.com', ORG_A, 'org_admin');
    const foreignUserId = await createUser('ops-b@example.com', ORG_B, 'agent');
    const admA = await loginAs('adm-a@example.com', ORG_A);
    const groupId = await newGroup(admA, 'test-hd', 'テストヘルプデスク');

    await expect(
      run(() => groups.addMember(admA, groupId, { userId: foreignUserId })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('**担当者はメンバーを変えられない**', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    const memberId = await createUser('ops@example.com', ORG_A, 'agent');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const agent = await loginAs('ops@example.com', ORG_A);
    const groupId = await newGroup(orgAdmin, 'test-hd', 'テストヘルプデスク');

    await expect(
      run(() => groups.addMember(agent, groupId, { userId: memberId })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('本人の所属グループを引ける(自分のキューの絞り込みに使う)', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    const memberId = await createUser('ops@example.com', ORG_A, 'agent');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const agent = await loginAs('ops@example.com', ORG_A);
    const mine = await newGroup(orgAdmin, 'test-mine', '自分のチーム');
    await newGroup(orgAdmin, 'test-other', '他のチーム');
    await run(() => groups.addMember(orgAdmin, mine, { userId: memberId }));

    const result = await run(() => groups.mine(agent));
    expect(result.body.items).toHaveLength(1);
    expect(result.body.items[0]!.id).toBe(mine);
  });
});

describe('チケットへの割当 (FR-TKT-003)', () => {
  it('グループへ振れる', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('req@example.com', ORG_A, 'requester');
    await createUser('ops@example.com', ORG_A, 'agent');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const requester = await loginAs('req@example.com', ORG_A);
    const agent = await loginAs('ops@example.com', ORG_A);
    const groupId = await newGroup(orgAdmin, 'test-hd', 'テストヘルプデスク');
    const ticketId = await newTicket(requester);

    const result = await run(() => collab.assignGroup(agent, ticketId, { groupId }));
    expect(result.body.assigneeGroupId).toBe(groupId);
  });

  it('**グループへ振っても状態は動かない**(キューは経路であって進行状態ではない)', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('req@example.com', ORG_A, 'requester');
    await createUser('ops@example.com', ORG_A, 'agent');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const requester = await loginAs('req@example.com', ORG_A);
    const agent = await loginAs('ops@example.com', ORG_A);
    const groupId = await newGroup(orgAdmin, 'test-hd', 'テストヘルプデスク');
    const ticketId = await newTicket(requester);

    await run(() => collab.assignGroup(agent, ticketId, { groupId }));

    // キューに入っただけで assigned にすると「担当者が決まった」ことになるが、
    // 実際には誰も見ていない。SLAの応答時間は人が応答するまでの時間である。
    const { rows } = await admin.query('SELECT state FROM ticket WHERE id = $1', [ticketId]);
    expect(rows[0].state).toBe('new');
  });

  it('**個人の担当を外さない**(振り直したら担当が消えたは事故になる)', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('req@example.com', ORG_A, 'requester');
    const agentId = await createUser('ops@example.com', ORG_A, 'agent');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const requester = await loginAs('req@example.com', ORG_A);
    const agent = await loginAs('ops@example.com', ORG_A);
    const first = await newGroup(orgAdmin, 'test-a', 'Aチーム');
    const second = await newGroup(orgAdmin, 'test-b', 'Bチーム');
    const ticketId = await newTicket(requester);

    await run(() => collab.assign(agent, ticketId, { assigneeId: agentId }));
    await run(() => collab.assignGroup(agent, ticketId, { groupId: first }));
    await run(() => collab.assignGroup(agent, ticketId, { groupId: second }));

    const { rows } = await admin.query(
      'SELECT assignee_id, assignee_group_id FROM ticket WHERE id = $1',
      [ticketId],
    );
    expect(rows[0].assignee_id).toBe(agentId);
    expect(rows[0].assignee_group_id).toBe(second);
  });

  it('キューから外せる', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('req@example.com', ORG_A, 'requester');
    await createUser('ops@example.com', ORG_A, 'agent');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const requester = await loginAs('req@example.com', ORG_A);
    const agent = await loginAs('ops@example.com', ORG_A);
    const groupId = await newGroup(orgAdmin, 'test-hd', 'テストヘルプデスク');
    const ticketId = await newTicket(requester);

    await run(() => collab.assignGroup(agent, ticketId, { groupId }));
    const result = await run(() => collab.assignGroup(agent, ticketId, { groupId: '' }));
    expect(result.body.assigneeGroupId).toBeNull();
  });

  it('**無効化したグループへは新しく振れない**', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('req@example.com', ORG_A, 'requester');
    await createUser('ops@example.com', ORG_A, 'agent');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const requester = await loginAs('req@example.com', ORG_A);
    const agent = await loginAs('ops@example.com', ORG_A);
    const groupId = await newGroup(orgAdmin, 'test-old', '旧チーム');
    const ticketId = await newTicket(requester);
    await run(() => groups.setActive(orgAdmin, groupId, { active: false }));

    await expect(run(() => collab.assignGroup(agent, ticketId, { groupId }))).rejects.toMatchObject(
      { status: 400 },
    );
  });

  it('**他組織のグループへは振れない**', async () => {
    await createUser('adm-b@example.com', ORG_B, 'org_admin');
    await createUser('req@example.com', ORG_A, 'requester');
    await createUser('ops@example.com', ORG_A, 'agent');
    const admB = await loginAs('adm-b@example.com', ORG_B);
    const requester = await loginAs('req@example.com', ORG_A);
    const agent = await loginAs('ops@example.com', ORG_A);
    const foreignGroup = await newGroup(admB, 'test-foreign', '他組織のチーム');
    const ticketId = await newTicket(requester);

    await expect(
      run(() => collab.assignGroup(agent, ticketId, { groupId: foreignGroup })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('**依頼者は振れない**', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('req@example.com', ORG_A, 'requester');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const requester = await loginAs('req@example.com', ORG_A);
    const groupId = await newGroup(orgAdmin, 'test-hd', 'テストヘルプデスク');
    const ticketId = await newTicket(requester);

    await expect(
      run(() => collab.assignGroup(requester, ticketId, { groupId })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('振り先の変更が履歴と監査に残る', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('req@example.com', ORG_A, 'requester');
    await createUser('ops@example.com', ORG_A, 'agent');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const requester = await loginAs('req@example.com', ORG_A);
    const agent = await loginAs('ops@example.com', ORG_A);
    const first = await newGroup(orgAdmin, 'test-a', 'Aチーム');
    const second = await newGroup(orgAdmin, 'test-b', 'Bチーム');
    const ticketId = await newTicket(requester);

    await run(() => collab.assignGroup(agent, ticketId, { groupId: first }));
    await run(() => collab.assignGroup(agent, ticketId, { groupId: second }));

    // 「なぜこのグループに来たのか」を辿れないと、振り間違いの原因が分からない。
    const { rows: history } = await admin.query(
      'SELECT group_id, previous_group_id FROM ticket_assignment WHERE ticket_id = $1 ORDER BY id',
      [ticketId],
    );
    expect(history).toHaveLength(2);
    expect(history[1].previous_group_id).toBe(first);
    expect(history[1].group_id).toBe(second);

    const { rows: audits } = await admin.query(
      `SELECT action, before_state, after_state FROM audit_event
        WHERE event_type = 'ticket.assigned' AND action = 'assign_group' AND target_id = $1
        ORDER BY event_id`,
      [ticketId],
    );
    expect(audits).toHaveLength(2);
    expect(audits[1].before_state.assigneeGroupId).toBe(first);
    expect(audits[1].after_state.assigneeGroupId).toBe(second);
  });

  it('同じグループへの振り直しは履歴を増やさない', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('req@example.com', ORG_A, 'requester');
    await createUser('ops@example.com', ORG_A, 'agent');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const requester = await loginAs('req@example.com', ORG_A);
    const agent = await loginAs('ops@example.com', ORG_A);
    const groupId = await newGroup(orgAdmin, 'test-hd', 'テストヘルプデスク');
    const ticketId = await newTicket(requester);

    await run(() => collab.assignGroup(agent, ticketId, { groupId }));
    await run(() => collab.assignGroup(agent, ticketId, { groupId }));

    const { rows } = await admin.query(
      'SELECT count(*)::int AS n FROM ticket_assignment WHERE ticket_id = $1',
      [ticketId],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe('キューの絞り込み (FR-TKT-003 / FR-TKT-006)', () => {
  it('グループを指定して絞り込める', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('req@example.com', ORG_A, 'requester');
    await createUser('ops@example.com', ORG_A, 'agent');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const requester = await loginAs('req@example.com', ORG_A);
    const agent = await loginAs('ops@example.com', ORG_A);
    const groupId = await newGroup(orgAdmin, 'test-hd', 'テストヘルプデスク');
    const inQueue = await newTicket(requester);
    await newTicket(requester);
    await run(() => collab.assignGroup(agent, inQueue, { groupId }));

    const result = await run(() => tickets.list(agent, new URLSearchParams({ group: groupId })));
    expect(result.body.items).toHaveLength(1);
    expect(result.body.items[0]!.id).toBe(inQueue);
  });

  it('**グループ未割当を探せる**(誰も見ていないものを見つける)', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('req@example.com', ORG_A, 'requester');
    await createUser('ops@example.com', ORG_A, 'agent');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const requester = await loginAs('req@example.com', ORG_A);
    const agent = await loginAs('ops@example.com', ORG_A);
    const groupId = await newGroup(orgAdmin, 'test-hd', 'テストヘルプデスク');
    const inQueue = await newTicket(requester);
    const orphan = await newTicket(requester);
    await run(() => collab.assignGroup(agent, inQueue, { groupId }));

    const result = await run(() =>
      tickets.list(agent, new URLSearchParams({ group: 'ungrouped' })),
    );
    expect(result.body.items.map((t) => t.id)).toContain(orphan);
    expect(result.body.items.map((t) => t.id)).not.toContain(inQueue);
  });

  it('「自分のグループ」で絞り込める', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('req@example.com', ORG_A, 'requester');
    const agentId = await createUser('ops@example.com', ORG_A, 'agent');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const requester = await loginAs('req@example.com', ORG_A);
    const agent = await loginAs('ops@example.com', ORG_A);
    const mine = await newGroup(orgAdmin, 'test-mine', '自分のチーム');
    const other = await newGroup(orgAdmin, 'test-other', '他のチーム');
    await run(() => groups.addMember(orgAdmin, mine, { userId: agentId }));

    const inMine = await newTicket(requester);
    const inOther = await newTicket(requester);
    await run(() => collab.assignGroup(agent, inMine, { groupId: mine }));
    await run(() => collab.assignGroup(agent, inOther, { groupId: other }));

    const result = await run(() => tickets.list(agent, new URLSearchParams({ group: 'mine' })));
    expect(result.body.items.map((t) => t.id)).toEqual([inMine]);
  });

  it('**所属が無い人の「自分のグループ」は0件になる**(絞り込んだつもりで全件が出ない)', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('req@example.com', ORG_A, 'requester');
    await createUser('ops@example.com', ORG_A, 'agent');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const requester = await loginAs('req@example.com', ORG_A);
    const agent = await loginAs('ops@example.com', ORG_A);
    const groupId = await newGroup(orgAdmin, 'test-hd', 'テストヘルプデスク');
    const ticketId = await newTicket(requester);
    await run(() => collab.assignGroup(agent, ticketId, { groupId }));

    // agent はどのグループにも入っていない
    const result = await run(() => tickets.list(agent, new URLSearchParams({ group: 'mine' })));
    expect(result.body.items).toHaveLength(0);
  });

  it('知らない値は 400(黙って無視しない)', async () => {
    await createUser('ops@example.com', ORG_A, 'agent');
    const agent = await loginAs('ops@example.com', ORG_A);

    await expect(
      run(() => tickets.list(agent, new URLSearchParams({ group: 'everything' }))),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('絞り込んだ条件が応答に含まれる', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('ops@example.com', ORG_A, 'agent');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const agent = await loginAs('ops@example.com', ORG_A);
    const groupId = await newGroup(orgAdmin, 'test-hd', 'テストヘルプデスク');

    const result = await run(() => tickets.list(agent, new URLSearchParams({ group: groupId })));
    expect(result.body.appliedFilter).toMatchObject({ assigneeGroupIds: [groupId] });
  });
});
