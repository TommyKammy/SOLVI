/** WP-P2-UIX-041: new local synthetic fixtures only; never grant roles to existing users. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import pg from 'pg';

const password = process.env.SOLVI_SMOKE_PASSWORD;
const database = process.env.DATABASE_URL;
const base = new URL(process.env.SOLVI_API_BASE ?? 'http://127.0.0.1:3001');
if (
  !password ||
  !database ||
  !['localhost', '127.0.0.1'].includes(new URL(database).hostname) ||
  !['localhost', '127.0.0.1'].includes(base.hostname) ||
  base.protocol !== 'http:'
)
  throw new Error('Only local synthetic API/database credentials are supported');
const output = resolve(
  process.env.SOLVI_SMOKE_OUT ?? '.local/fix-041/catalog-operations-smoke.json',
);
const report = {
  workPackage: 'WP-P2-UIX-041',
  success: false,
  checks: [],
  syntheticUsers: [],
  catalogIds: [],
  requestIds: [],
  groupIds: [],
  grantsRevoked: false,
  catalogsUnpublished: false,
};
const pool = new pg.Pool({ connectionString: database, max: 1 });
const reused = process.env.SOLVI_SMOKE_REUSE_FIXTURES
  ? JSON.parse(await readFile(process.env.SOLVI_SMOKE_REUSE_FIXTURES, 'utf8')).syntheticUsers
  : [];
let admin, beta;
const ownUsers = [],
  ownCatalogs = [],
  ownGroups = [];

async function api(path, actor, body, status = 200) {
  const response = await fetch(new URL(path, base), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(actor ? { cookie: actor.cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  assert.equal(
    response.status,
    status,
    `${path}: expected HTTP ${status}, received ${response.status}`,
  );
  return {
    data: text ? JSON.parse(text) : {},
    cookie: response.headers.get('set-cookie')?.split(';')[0],
  };
}
async function login(email) {
  const actor = await api('/auth/login', null, { email, password });
  if (!actor.data.organizationId) {
    const organization = actor.data.organizations.find((entry) =>
      email.includes(`@${entry.code}.`),
    );
    assert.ok(organization, 'Synthetic organization must exist');
    await api('/auth/organization', actor, { organizationId: organization.id });
    actor.data.organizationId = organization.id;
  }
  return actor;
}
async function orgQuery(organizationId, run, readOnly = true) {
  const client = await pool.connect();
  try {
    await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    await client.query("SELECT set_config('app.current_org',$1,true)", [organizationId]);
    return await run(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}
async function check(name, run) {
  await run();
  report.checks.push({ name, passed: true });
}
async function createEditorUser(marker, suffix) {
  const prior = reused.find((user) =>
    new RegExp(`^ui041-syn-\\d+-${suffix}@acme\\.example\\.test$`).test(user.email),
  );
  if (prior) {
    const member = (await api('/users', admin)).data.items.find(
      (user) =>
        user.userId === prior.id &&
        user.email === prior.email &&
        user.displayName === `合成カタログ編集者 ${suffix}` &&
        !user.roleCodes.includes('catalog_editor'),
    );
    assert.ok(member, 'Only this task’s previously cleaned synthetic fixture may be reused');
    ownUsers.push(prior.id);
    report.syntheticUsers.push(prior);
    return { ...(await login(prior.email)), fixtureId: prior.id };
  }
  const email = `${marker.toLowerCase()}-${suffix}@acme.example.test`;
  const id = (
    await api(
      '/users',
      admin,
      {
        email,
        displayName: `合成カタログ編集者 ${suffix}`,
        roleCode: 'requester',
        reason: 'WP041ローカル合成検証だけに使用',
      },
      201,
    )
  ).data.userId;
  ownUsers.push(id);
  report.syntheticUsers.push({ id, email });
  const credential = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'tools/create_local_user.mjs', '--email', email],
    { encoding: 'utf8', timeout: 15000, env: { ...process.env, SOLVI_PASSWORD: password } },
  );
  assert.equal(credential.status, 0, 'Synthetic local credential creation failed');
  return { ...(await login(email)), fixtureId: id };
}
async function grant(id, validUntil = null) {
  await api(
    `/users/${id}/roles`,
    admin,
    { roleCode: 'catalog_editor', validUntil, reason: 'WP041の新規合成ユーザーだけへの一時検証' },
    204,
  );
}

try {
  if (process.env.SOLVI_SMOKE_RESUME_REVOCATION) {
    const previous = JSON.parse(await readFile(process.env.SOLVI_SMOKE_RESUME_REVOCATION, 'utf8'));
    assert.equal(previous.workPackage, report.workPackage);
    assert.equal(previous.checks.length, 13, 'Resume only the reconciled final revocation check');
    assert.equal(
      previous.checks.every((entry) => entry.passed),
      true,
    );
    admin = await login('org_admin@acme.example.test');
    const approver = await login('approver@acme.example.test');
    const agent = await login('agent@acme.example.test');
    const requester = await login('requester@acme.example.test');
    const members = (await api('/users', admin)).data.items;
    for (const fixture of previous.syntheticUsers) {
      assert.match(fixture.email, /^ui041-syn-\d+-(owner|temporary)@acme\.example\.test$/);
      assert.ok(
        members.some((member) => member.userId === fixture.id && member.email === fixture.email),
      );
      ownUsers.push(fixture.id);
    }
    for (const id of previous.catalogIds) {
      const item = (await api(`/catalog-admin/${id}`, admin)).data;
      assert.match(item.draft.title, /^UI041-SYN-\d+ /);
      assert.equal(item.active, false);
      ownCatalogs.push(id);
    }
    const owner = previous.syntheticUsers.find((fixture) => fixture.email.includes('-owner@'));
    assert.ok(owner);
    const editor = await login(owner.email);
    await grant(owner.id);
    assert.equal((await api('/catalog-admin', editor)).data.canPublish, false);
    // Reuse the existing no-checklist synthetic request to exercise valid approval/hash
    // evaluation after adding the guard, without creating another request or catalog.
    const legacyId = previous.requestIds.at(-1);
    const legacyPath = `/service-requests/${legacyId}`;
    let legacy = (await api(legacyPath, requester)).data;
    assert.match(legacy.request.snapshot.item.title, /^UI041-SYN-\d+ /);
    if (legacy.request.state === 'pending')
      await api(`${legacyPath}/decisions`, approver, {
        decision: 'approve',
        expectedVersion: legacy.request.version,
      });
    legacy = (await api(legacyPath, agent)).data;
    assert.equal(legacy.fulfillment.canUpdate, true);
    await api(
      `${legacyPath}/checklist`,
      agent,
      {
        requestRevision: legacy.request.revision,
        expectedVersion: legacy.fulfillment.checklistVersion,
        key: 'unknown',
        completed: true,
      },
      400,
    );
    await api(
      `/users/${owner.id}/roles/revoke`,
      admin,
      { roleCode: 'catalog_editor', reason: '時計差修正後の即時取消を確認する合成検証' },
      204,
    );
    await api('/catalog-admin', editor, undefined, 403);
    await api('/catalog', editor);
    report.checks = [
      ...previous.checks,
      {
        name: 'Revocation immediately removes editor authoring while other requester permissions remain',
        passed: true,
      },
    ];
    report.syntheticUsers = previous.syntheticUsers;
    report.catalogIds = previous.catalogIds;
    report.requestIds = previous.requestIds;
    report.groupIds = previous.groupIds;
    report.questionSetId = previous.questionSetId;
    report.expirationFixture = previous.expirationFixture;
    report.reconciliation = {
      previousChecksRetained: 13,
      newCatalogs: 0,
      newRequests: 0,
      reusedSyntheticUsers: true,
      completedFinalRoleRevocationCheck: true,
      approvedHashGuardReadChecked: true,
      reason: 'PostgreSQL/host clock skew; authorization now uses the database clock',
    };
  } else {
    admin = await login('org_admin@acme.example.test');
    beta = await login('org_admin@beta.example.test');
    const requester = await login('requester@acme.example.test'),
      approver = await login('approver@acme.example.test'),
      agent = await login('agent@acme.example.test');
    const marker = `UI041-SYN-${Date.now()}`;
    await check(
      'Legacy owner-less catalog administration still returns explicit capabilities and warnings',
      async () => {
        const list = (await api('/catalog-admin', admin)).data;
        assert.equal(list.canPublish, true);
        for (const field of ['canCreate', 'canPublish', 'canManageQuestionSets'])
          assert.equal(typeof list[field], 'boolean');
        assert.equal(list.viewerId, admin.data.userId);
        assert.ok(
          Array.isArray(list.owners) &&
            Array.isArray(list.groups) &&
            Array.isArray(list.questionSets),
        );
        const legacy = list.items.find((item) =>
          item.readiness.warnings.includes('責任者が未設定です'),
        );
        assert.ok(legacy, 'A baseline owner-less catalog remains present');
        const detail = (await api(`/catalog-admin/${legacy.id}`, admin)).data;
        assert.equal(detail.canEdit, true);
        assert.equal(detail.draft.definition.ownerId, undefined);
      },
    );
    const editor = await createEditorUser(marker, 'owner'),
      second = await createEditorUser(marker, 'temporary');
    await check(
      'Only an administrator can delegate the new org role to an existing synthetic member',
      async () => {
        await api(
          `/users/${editor.fixtureId}/roles`,
          requester,
          { roleCode: 'catalog_editor', validUntil: null, reason: '合成' },
          403,
        );
        await grant(editor.fixtureId);
        await api(
          `/users/${second.fixtureId}/roles`,
          editor,
          { roleCode: 'catalog_editor', validUntil: null, reason: '合成' },
          403,
        );
        await api(
          `/users/${second.fixtureId}/roles`,
          beta,
          { roleCode: 'catalog_editor', validUntil: null, reason: '合成' },
          404,
        );
      },
    );
    const expiration = Date.now() + 4000;
    await grant(second.fixtureId, new Date(Date.now() + 86400000).toISOString().slice(0, 10));
    // The public delegation API uses whole dates. Shorten only this newly created
    // synthetic binding to exercise real-time expiry without changing the API contract.
    const expiryClient = await pool.connect();
    try {
      assert.ok(ownUsers.includes(second.fixtureId));
      await expiryClient.query('BEGIN');
      await expiryClient.query("SELECT set_config('app.current_org',$1,true)", [
        admin.data.organizationId,
      ]);
      const changed = await expiryClient.query(
        "UPDATE role_binding SET valid_until=to_timestamp($3::double precision/1000) WHERE user_id=$1 AND organization_id=$2 AND source='manual' AND role_id=(SELECT id FROM role WHERE code='catalog_editor') AND valid_from<=clock_timestamp() AND valid_until>clock_timestamp()",
        [second.fixtureId, admin.data.organizationId, expiration],
      );
      assert.equal(changed.rowCount, 1);
      await expiryClient.query('COMMIT');
      report.expirationFixture =
        'Only the task-owned synthetic binding was shortened after normal API delegation';
    } catch (error) {
      await expiryClient.query('ROLLBACK');
      throw error;
    } finally {
      expiryClient.release();
    }
    const group = (
      await api(
        '/groups',
        admin,
        { code: `c041-${Date.now()}`, name: `${marker} 受付担当`, description: '合成検証グループ' },
        201,
      )
    ).data;
    const foreignGroup = (
      await api(
        '/groups',
        beta,
        { code: `c041-${Date.now()}`, name: `${marker} 別組織`, description: '合成検証グループ' },
        201,
      )
    ).data;
    ownGroups.push({ id: group.id, actor: admin }, { id: foreignGroup.id, actor: beta });
    report.groupIds.push(group.id, foreignGroup.id);
    const questionBody = {
      title: `${marker} 共有質問`,
      description: '挿入時だけコピーする合成セット',
      fields: [
        {
          key: 'loan',
          label: '貸与区分',
          type: 'select',
          required: true,
          options: ['標準', '一時'],
          section: 'loan_info',
        },
        {
          key: 'return_date',
          label: '返却日',
          type: 'date',
          required: true,
          visibleWhen: { field: 'loan', equals: '一時' },
          section: 'loan_info',
        },
      ],
      sections: [{ key: 'loan_info', title: '貸与内容', description: '合成確認' }],
      creationKey: randomUUID(),
    };
    let setId;
    await check(
      'Shared question sets have administrator writes, editor reads, idempotency and conflicts',
      async () => {
        await api('/catalog-question-sets', editor, questionBody, 403);
        const saved = (await api('/catalog-question-sets', admin, questionBody)).data;
        setId = saved.id;
        report.questionSetId = setId;
        assert.equal(saved.revision, 1);
        assert.equal((await api('/catalog-question-sets', admin, questionBody)).data.id, setId);
        await api('/catalog-question-sets', admin, { ...questionBody, title: '異なる内容' }, 409);
        const library = (await api('/catalog-question-sets', editor)).data;
        assert.equal(library.canManage, false);
        assert.deepEqual(library.items.find((set) => set.id === setId).fields, questionBody.fields);
        await api(
          `/catalog-question-sets/${setId}/save`,
          editor,
          { ...questionBody, creationKey: undefined, expectedVersion: 1 },
          403,
        );
        await api(
          `/catalog-question-sets/${setId}/save`,
          beta,
          { ...questionBody, creationKey: undefined, expectedVersion: 1 },
          404,
        );
      },
    );
    const definition = {
      mode: 'local_simulation',
      action: 'simulate.access_grant',
      targetLabel: '合成受付対象',
      allowedDurations: [7],
      maxReasonLength: 2000,
      category: '合成カタログ運用',
      fulfillmentGroupId: group.id,
      checklist: [
        { key: 'prepare', label: '合成の準備確認', required: true },
        { key: 'optional', label: '任意の補足確認', required: false },
      ],
      fields: structuredClone(questionBody.fields),
      sections: structuredClone(questionBody.sections),
      approval: { mode: 'fixed', approverId: approver.data.userId },
    };
    const content = {
      title: `${marker} サービス`,
      description: '複製/委任/受付後運用の合成検証',
      definition,
    };
    const creation = { ...content, code: `c041-${Date.now()}`, creationKey: randomUUID() };
    const created = (await api('/catalog-admin', editor, creation)).data;
    const catalogId = created.id;
    ownCatalogs.push(catalogId);
    report.catalogIds.push(catalogId);
    const adminPath = `/catalog-admin/${catalogId}`;
    const detail = async (actor = admin) => (await api(adminPath, actor)).data;
    await check(
      'Editor creation is self-owned and saved owner prevents direct URL and owner spoofing',
      async () => {
        const own = await detail(editor);
        assert.equal(own.draft.definition.ownerId, editor.fixtureId);
        assert.equal(own.canPublish, false);
        assert.deepEqual(
          own.owners.map((owner) => owner.id),
          [editor.fixtureId],
        );
        assert.equal(own.canEdit, true);
        assert.equal(own.readiness.ready, true);
        assert.equal((await api('/catalog-admin', editor, creation)).data.id, catalogId);
        await api(adminPath, second, undefined, 404);
        await api(adminPath, beta, undefined, 404);
        await api(
          '/catalog-admin',
          editor,
          {
            ...creation,
            creationKey: randomUUID(),
            definition: { ...definition, ownerId: second.fixtureId },
          },
          403,
        );
        await api(`${adminPath}/save`, editor, { ...content, definition, expectedVersion: 1 }, 403);
        await api(
          `${adminPath}/save`,
          editor,
          {
            ...content,
            definition: { ...definition, ownerId: second.fixtureId },
            expectedVersion: 1,
          },
          403,
        );
        await api(
          `${adminPath}/publication`,
          editor,
          { expectedVersion: 1, state: 'published' },
          403,
        );
        await api(
          `${adminPath}/save`,
          admin,
          {
            ...content,
            definition: { ...definition, ownerId: beta.data.userId },
            expectedVersion: 1,
          },
          400,
        );
        await api(
          `${adminPath}/save`,
          admin,
          {
            ...content,
            definition: { ...definition, fulfillmentGroupId: foreignGroup.id },
            expectedVersion: 1,
          },
          400,
        );
      },
    );
    await check(
      'Expired editor bindings stop authoring without changing requester identity',
      async () => {
        await new Promise((done) => setTimeout(done, Math.max(0, expiration - Date.now() + 100)));
        await api('/catalog-admin', second, undefined, 403);
        assert.equal((await api('/auth/me', second)).data.userId, second.data.userId);
      },
    );
    await api(`${adminPath}/publication`, admin, { expectedVersion: 1, state: 'published' });
    const submission = {
      itemId: catalogId,
      itemVersion: 1,
      idempotencyKey: randomUUID(),
      reason: '合成カタログ運用の確認',
      durationDays: 7,
      approverId: approver.data.userId,
      values: { loan: '標準', return_date: 'HIDDEN' },
    };
    const request = (await api('/service-requests', requester, submission, 201)).data;
    report.requestIds.push(request.id);
    const requestPath = `/service-requests/${request.id}`;
    const requestDetail = async (actor = requester) => (await api(requestPath, actor)).data;
    await check(
      'Published catalog routing initializes a new ticket queue without forged staff or manual assignment',
      async () => {
        const row = await orgQuery(admin.data.organizationId, async (client) => ({
          ticket: (
            await client.query('SELECT state,assignee_group_id FROM ticket WHERE id=$1', [
              request.ticketId,
            ])
          ).rows[0],
          assignments: (
            await client.query('SELECT id FROM ticket_assignment WHERE ticket_id=$1', [
              request.ticketId,
            ])
          ).rowCount,
          audit: (
            await client.query(
              "SELECT after_state FROM audit_event WHERE target_id=$1 AND event_type='ticket.created'",
              [request.ticketId],
            )
          ).rows[0],
        }));
        assert.deepEqual(row.ticket, { state: 'new', assignee_group_id: group.id });
        assert.equal(row.assignments, 0);
        assert.equal(row.audit.after_state.source, 'catalog');
        assert.equal(row.audit.after_state.groupId, group.id);
        assert.equal((await requestDetail()).fulfillment.groupName, group.name);
        await api(`/groups/${group.id}/active`, admin, { active: false }, 204);
        await api(
          '/service-requests',
          requester,
          { ...submission, idempotencyKey: randomUUID() },
          400,
        );
        await api(`/groups/${group.id}/active`, admin, { active: true }, 204);
      },
    );
    const checkpoint = (revision, version, key = 'prepare', completed = true) => ({
      requestRevision: revision,
      expectedVersion: version,
      key,
      completed,
    });
    await check('Checklist writes require staff and a currently approved request', async () => {
      await api(`${requestPath}/checklist`, requester, checkpoint(1, 1), 403);
      await api(`${requestPath}/checklist`, editor, checkpoint(1, 1), 403);
      await api(`${requestPath}/checklist`, agent, checkpoint(1, 1), 409);
      await api(`${requestPath}/checklist`, beta, checkpoint(1, 1), 404);
      await api(`${requestPath}/decisions`, approver, { decision: 'approve', expectedVersion: 1 });
      await api(`${requestPath}/simulate`, agent, { expectedVersion: 2 }, 409);
      await api(`${requestPath}/checklist`, agent, checkpoint(1, 1, 'unknown'), 400);
    });
    await check(
      'Checklist completion has an independent optimistic version and preserves frozen request/hash/approval',
      async () => {
        const before = await requestDetail();
        assert.equal(
          (await api(`${requestPath}/checklist`, agent, checkpoint(1, 1))).data.checklistVersion,
          2,
        );
        const after = await requestDetail();
        assert.deepEqual(after.request, before.request);
        assert.deepEqual(after.approval, before.approval);
        assert.equal(after.fulfillment.checks[0].completed, true);
        assert.equal(after.fulfillment.checks[1].completed, false);
        await api(`${requestPath}/checklist`, agent, checkpoint(1, 1), 409);
      },
    );
    await api(`/tickets/${request.ticketId}/group`, agent, { groupId: null });
    await api(`${requestPath}/edit`, requester, {
      reason: '改訂した合成申請',
      durationDays: 7,
      approverId: approver.data.userId,
      values: { loan: '標準' },
      expectedVersion: 2,
    });
    await check(
      'A new request revision resets progress, keeps old progress and never re-routes an existing ticket',
      async () => {
        const current = await requestDetail();
        assert.equal(current.request.revision, 2);
        assert.equal(current.fulfillment.checklistVersion, 1);
        assert.equal(current.fulfillment.checks[0].completed, false);
        const old = await orgQuery(admin.data.organizationId, async (client) => ({
          progress: (
            await client.query(
              'SELECT completion FROM local_request_checklist_progress WHERE request_id=$1 AND request_revision=1',
              [request.id],
            )
          ).rows[0],
          group: (
            await client.query('SELECT assignee_group_id FROM ticket WHERE id=$1', [
              request.ticketId,
            ])
          ).rows[0],
        }));
        assert.equal(old.progress.completion.prepare.completed, true);
        assert.equal(old.group.assignee_group_id, null);
        await api(`${requestPath}/checklist`, agent, checkpoint(1, 2), 409);
        await api(`${requestPath}/decisions`, approver, {
          decision: 'approve',
          expectedVersion: 3,
        });
        await api(`${requestPath}/simulate`, agent, { expectedVersion: 4 }, 409);
        await api(`${requestPath}/checklist`, agent, checkpoint(2, 1));
        await api(`${requestPath}/simulate`, agent, { expectedVersion: 4 });
        assert.equal((await requestDetail()).request.state, 'completed');
      },
    );
    await check(
      'Question-set revisions and later catalog metadata never propagate into copied services or requests',
      async () => {
        const savedRequest = (await requestDetail()).request;
        await api(`/catalog-question-sets/${setId}/save`, admin, {
          ...questionBody,
          creationKey: undefined,
          fields: questionBody.fields.map((field) => ({
            ...field,
            label: `${field.label}（改訂）`,
          })),
          expectedVersion: 1,
        });
        await api(
          `/catalog-question-sets/${setId}/save`,
          admin,
          { ...questionBody, creationKey: undefined, expectedVersion: 1 },
          409,
        );
        assert.deepEqual((await detail()).draft.definition.fields, questionBody.fields);
        const revised = {
          ...definition,
          ownerId: admin.data.userId,
          checklist: [{ key: 'new_check', label: '新しい申請だけの作業', required: true }],
        };
        await api(`${adminPath}/save`, admin, {
          ...content,
          definition: revised,
          expectedVersion: (await detail()).editVersion,
        });
        await api(`${adminPath}/publication`, admin, {
          expectedVersion: (await detail()).editVersion,
          state: 'published',
        });
        await api(adminPath, editor, undefined, 404);
        assert.equal(
          (await api('/catalog-admin', editor)).data.items.some((item) => item.id === catalogId),
          false,
        );
        assert.deepEqual((await requestDetail()).request, savedRequest);
        const oldSet = await orgQuery(admin.data.organizationId, (client) =>
          client.query(
            'SELECT fields FROM local_catalog_question_set_revision WHERE set_id=$1 AND revision=1',
            [setId],
          ),
        );
        assert.deepEqual(oldSet.rows[0].fields, questionBody.fields);
      },
    );
    await check(
      'Legacy admin create/replay/publication and no-checklist request detail stay compatible',
      async () => {
        const legacy = {
          title: `${marker} 旧形式`,
          description: 'owner/group/checklistなしの合成互換確認',
          definition: {
            mode: 'local_simulation',
            action: 'simulate.access_grant',
            targetLabel: '合成旧形式',
            allowedDurations: [7],
            maxReasonLength: 2000,
            approval: { mode: 'fixed', approverId: approver.data.userId },
          },
          code: `c041-old-${Date.now()}`,
          creationKey: randomUUID(),
        };
        const id = (await api('/catalog-admin', admin, legacy)).data.id;
        ownCatalogs.push(id);
        report.catalogIds.push(id);
        assert.equal((await api('/catalog-admin', admin, legacy)).data.id, id);
        await api(`/catalog-admin/${id}/publication`, admin, {
          expectedVersion: 1,
          state: 'published',
        });
        const oldRequest = (
          await api(
            '/service-requests',
            requester,
            { ...submission, itemId: id, values: {}, idempotencyKey: randomUUID() },
            201,
          )
        ).data;
        report.requestIds.push(oldRequest.id);
        const old = (await api(`/service-requests/${oldRequest.id}`, requester)).data;
        assert.deepEqual(old.fulfillment.checks, []);
        assert.equal(old.request.snapshot.item.definition.ownerId, undefined);
      },
    );
    await check(
      'New immutable question-set history and revision progress enforce app-role RLS',
      async () => {
        const hidden = await orgQuery(beta.data.organizationId, async (client) => ({
          sets: (
            await client.query(
              'SELECT revision FROM local_catalog_question_set_revision WHERE set_id=$1',
              [setId],
            )
          ).rowCount,
          progress: (
            await client.query(
              'SELECT version FROM local_request_checklist_progress WHERE request_id=$1',
              [request.id],
            )
          ).rowCount,
        }));
        assert.deepEqual(hidden, { sets: 0, progress: 0 });
        let denied = false;
        try {
          await orgQuery(
            admin.data.organizationId,
            (client) =>
              client.query(
                'UPDATE local_catalog_question_set_revision SET title=$2 WHERE set_id=$1 AND revision=1',
                [setId, '書換え禁止の確認'],
              ),
            false,
          );
        } catch (error) {
          denied = ['42501', 'P0001'].includes(error.code);
        }
        assert.equal(denied, true);
      },
    );
    await check('Migration down refuses to erase newly persisted operation data', async () => {
      const url = process.env.DATABASE_ADMIN_URL ?? database;
      assert.ok(['localhost', '127.0.0.1'].includes(new URL(url).hostname));
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      let refused = false;
      try {
        await client.query('BEGIN');
        const down = (await readFile('db/migrations/0036_catalog_operations.sql', 'utf8')).split(
          '-- +migrate down',
        )[1];
        await client.query(down);
      } catch (error) {
        refused = String(error.message).includes('rollback refused');
      } finally {
        await client.query('ROLLBACK');
        await client.end();
      }
      assert.equal(refused, true);
    });
    await api(
      `/users/${editor.fixtureId}/roles/revoke`,
      admin,
      { roleCode: 'catalog_editor', reason: '合成検証終了のため取消' },
      204,
    );
    await check(
      'Revocation immediately removes editor authoring while other requester permissions remain',
      async () => {
        await api('/catalog-admin', editor, undefined, 403);
        await api('/catalog', editor);
      },
    );
  }
  report.success = true;
} catch (error) {
  report.failure = String(error.message).replaceAll(password, '<redacted>');
  process.exitCode = 1;
} finally {
  try {
    if (admin) {
      const members = (await api('/users', admin)).data.items;
      for (const id of ownUsers)
        if (members.find((user) => user.userId === id)?.roleCodes.includes('catalog_editor'))
          await api(
            `/users/${id}/roles/revoke`,
            admin,
            { roleCode: 'catalog_editor', reason: 'WP041合成検証の後片付け' },
            204,
          );
      report.grantsRevoked = await orgQuery(
        admin.data.organizationId,
        async (client) =>
          (
            await client.query(
              "SELECT rb.id FROM role_binding rb JOIN role r ON r.id=rb.role_id WHERE rb.user_id=ANY($1::uuid[]) AND r.code='catalog_editor' AND rb.valid_from<=clock_timestamp() AND (rb.valid_until IS NULL OR rb.valid_until>clock_timestamp())",
              [ownUsers],
            )
          ).rowCount === 0,
      );
      for (const id of ownCatalogs) {
        const item = (await api(`/catalog-admin/${id}`, admin)).data;
        if (item.active)
          await api(`/catalog-admin/${id}/publication`, admin, {
            expectedVersion: item.editVersion,
            state: 'unpublished',
          });
      }
      report.catalogsUnpublished = (await api('/catalog', admin)).data.items.every(
        (item) => !ownCatalogs.includes(item.id),
      );
      for (const group of ownGroups)
        await api(`/groups/${group.id}/active`, group.actor, { active: false }, 204);
    }
  } catch {
    report.cleanupFailure = 'Could not confirm fixture role revocation and unpublication';
    report.success = false;
    process.exitCode = 1;
  }
  await pool.end();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `Catalog operations API/PG smoke: ${report.success ? 'PASS' : 'FAIL'}; ${report.checks.length} checks; rolesRevoked=${report.grantsRevoked}; catalogsUnpublished=${report.catalogsUnpublished}`,
  );
  if (report.failure) console.log(report.failure);
}
