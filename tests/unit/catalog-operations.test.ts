import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { catalogDefinitionSchema, type CatalogDefinition } from '../../packages/shared/src/catalog';
import { CatalogAdminController } from '../../services/api/src/modules/catalog/catalog-admin.routes';
import { CatalogController } from '../../services/api/src/modules/catalog/catalog.routes';
import { UserAdminService } from '../../services/api/src/modules/auth/user-admin.service';
import { hasRole, type RoleCode } from '../../services/api/src/common/authz/authz';
import type { AuthenticatedRequest } from '../../services/api/src/modules/auth/auth.routes';

const org = '11111111-1111-4111-8111-111111111111';
const editorId = '22222222-2222-4222-8222-222222222222';
const otherId = '33333333-3333-4333-8333-333333333333';
const approverId = '44444444-4444-4444-8444-444444444444';
const itemId = '55555555-5555-4555-8555-555555555555';
const requestId = '66666666-6666-4666-8666-666666666666';
const groupId = '77777777-7777-4777-8777-777777777777';
const definition = (changes: Partial<CatalogDefinition> = {}): CatalogDefinition => ({
  mode: 'local_simulation',
  action: 'simulate.access_grant',
  targetLabel: '合成対象',
  allowedDurations: [7],
  maxReasonLength: 2000,
  approval: { mode: 'fixed', approverId },
  ...changes,
});
function actor(
  role: RoleCode,
  { expired = false, userId = editorId, organizationId = org } = {},
): AuthenticatedRequest {
  return {
    userId,
    sessionId: itemId,
    authz: {
      organizationId,
      principal: {
        userId,
        status: 'active',
        bindings: [
          {
            roleCode: role,
            organizationId,
            validFrom: new Date(Date.now() - 60000),
            validUntil: expired ? new Date(Date.now() - 1) : null,
          },
        ],
      },
    },
  };
}
function database({
  ownerId = editorId,
  progressVersion = 1,
  requestRevision = 1,
  requestState = 'approved',
  checks = [{ key: 'prepare', label: '準備確認', required: true }],
  noRequest = false,
} = {}) {
  const savedDefinition = definition({ ...(ownerId ? { ownerId } : {}) });
  const request = {
    id: requestId,
    organization_id: org,
    requester_id: otherId,
    ticket_id: itemId,
    version: 5,
    revision: requestRevision,
    state: requestState,
    snapshot: {
      item: {
        id: itemId,
        version: 1,
        title: '合成',
        definition: definition({ checklist: checks }),
      },
      inputs: { reason: '合成', durationDays: 7 },
      requesterId: otherId,
    },
    snapshot_hash: 'a'.repeat(64),
    current_approval_id: approverId,
  };
  request.snapshot_hash = createHash('sha256')
    .update(
      JSON.stringify(request.snapshot, (_key, value) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
          : value,
      ),
    )
    .digest('hex');
  const approval = {
    id: approverId,
    approver_id: approverId,
    state: 'approved',
    step_no: 1,
    route_generation: 1,
    authority_type: 'legacy',
    resolved_from: null,
    decided_by: approverId,
    snapshot_hash: request.snapshot_hash,
    revision: requestRevision,
    expires_at: new Date('2099-01-01'),
    decided_at: new Date('2098-12-31'),
  };
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (
      sql.startsWith('BEGIN') ||
      sql === 'COMMIT' ||
      sql === 'ROLLBACK' ||
      sql.includes('set_config') ||
      sql.includes('pg_advisory_xact_lock')
    )
      return { rows: [], rowCount: 0 };
    if (sql.includes('SELECT * FROM local_service_request'))
      return { rows: noRequest ? [] : [request], rowCount: noRequest ? 0 : 1 };
    if (
      sql.includes(
        'SELECT route,route_hash,route_generation,snapshot_hash FROM local_request_revision',
      )
    )
      return {
        rows: [
          {
            route: null,
            route_hash: null,
            route_generation: 1,
            snapshot_hash: request.snapshot_hash,
          },
        ],
        rowCount: 1,
      };
    if (sql.includes('SELECT * FROM local_request_revision'))
      return {
        rows: [
          {
            request_id: requestId,
            organization_id: org,
            revision: requestRevision,
            snapshot: request.snapshot,
            snapshot_hash: request.snapshot_hash,
            route: null,
            route_hash: null,
            route_generation: 1,
          },
        ],
        rowCount: 1,
      };
    if (sql.includes('revision_hash_ok'))
      return {
        rows: [{ ...approval, revision_hash_ok: params[3] === approval.snapshot_hash }],
        rowCount: 1,
      };
    if (sql.includes('FROM local_request_approval'))
      return {
        rows: [approval],
        rowCount: 1,
      };
    if (sql.includes('FROM local_request_checklist_progress'))
      return {
        rows: progressVersion === 1 ? [] : [{ version: progressVersion, completion: {} }],
        rowCount: progressVersion === 1 ? 0 : 1,
      };
    if (sql.includes('SELECT * FROM local_catalog_item'))
      return {
        rows: [
          {
            id: itemId,
            draft_revision: 1,
            published_revision: null,
            edit_version: 1,
            code: 'synth-operation',
            active: false,
          },
        ],
        rowCount: 1,
      };
    if (sql.includes('SELECT definition FROM local_catalog_revision'))
      return { rows: [{ definition: savedDefinition }], rowCount: 1 };
    if (sql.includes('FROM local_catalog_revision') && sql.includes('ORDER BY revision'))
      return {
        rows: [
          {
            revision: 1,
            title: '合成',
            description: '合成',
            definition: savedDefinition,
            createdAt: new Date(),
          },
        ],
        rowCount: 1,
      };
    if (sql.includes('SELECT DISTINCT u.id') && sql.includes("r.code='approver'"))
      return { rows: [{ id: approverId, name: '承認者' }], rowCount: 1 };
    if (sql.includes('SELECT DISTINCT u.id'))
      return {
        rows: [
          { id: editorId, name: '編集者' },
          { id: otherId, name: '他者' },
        ],
        rowCount: 2,
      };
    if (sql.includes('FROM assignment_group'))
      return { rows: [{ id: groupId, name: '処理グループ' }], rowCount: 1 };
    if (sql.includes('FROM local_catalog_question_set_revision')) return { rows: [], rowCount: 0 };
    if (sql.includes('JOIN local_catalog_revision') && sql.includes('creation_key'))
      return { rows: [], rowCount: 0 };
    if (sql.includes('SELECT id FROM local_catalog_item')) return { rows: [], rowCount: 0 };
    if (sql.includes('FROM local_catalog_item i JOIN'))
      return {
        rows: [
          {
            id: itemId,
            definition: savedDefinition,
            title: '合成',
            description: '合成',
            updatedAt: new Date(),
          },
        ],
        rowCount: 1,
      };
    if (/^\s*(INSERT|UPDATE)\b/.test(sql)) return { rows: [], rowCount: 1 };
    throw new Error(`Unhandled test query: ${sql.slice(0, 65)} (${params.length})`);
  });
  const client = { query, release: vi.fn() } as unknown as pg.PoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
  return { pool, client, query, request, approval };
}
const content = (ownerId?: string) => ({
  title: '合成カタログ',
  description: '合成の操作検証',
  definition: definition(ownerId ? { ownerId } : {}),
});
const storage = {} as ConstructorParameters<typeof CatalogController>[1];

describe('FR-CAT-002/003 optional catalog operations metadata', () => {
  it('does not insert new operation properties into legacy definitions', () => {
    const legacy = definition();
    expect(catalogDefinitionSchema.parse(legacy)).toEqual(legacy);
    expect(legacy).not.toHaveProperty('ownerId');
  });
  it('accepts bounded owner/group/checklist properties', () => {
    expect(
      catalogDefinitionSchema.safeParse(
        definition({
          ownerId: editorId,
          fulfillmentGroupId: groupId,
          checklist: [{ key: 'prepare', label: '確認', required: true }],
        }),
      ).success,
    ).toBe(true);
  });
  it.each([
    { ownerId: 'not-a-user-id' },
    { fulfillmentGroupId: 'not-a-group-id' },
    {
      checklist: [
        { key: 'same', label: '先頭', required: true },
        { key: 'same', label: '重複', required: false },
      ],
    },
    {
      checklist: Array.from({ length: 21 }, (_, i) => ({
        key: `check_${i}`,
        label: '確認',
        required: true,
      })),
    },
    { checklist: [{ key: 'prepare', label: 'x'.repeat(201), required: true }] },
  ])('rejects invalid operation metadata %j', (changes) => {
    expect(catalogDefinitionSchema.safeParse(definition(changes)).success).toBe(false);
  });
});

describe('NFR-SEC-006/FR-IDM-006 catalog editor boundaries', () => {
  it.each(['requester', 'agent', 'approver', 'auditor'] as RoleCode[])(
    'does not give %s authoring permissions',
    async (role) => {
      const db = database();
      await expect(
        new CatalogAdminController(db.pool, true).list(actor(role)),
      ).rejects.toMatchObject({ status: 403 });
      expect(db.pool.connect).not.toHaveBeenCalled();
    },
  );
  it('does not treat an editor as agent or admin and honors expiration', async () => {
    const editor = actor('catalog_editor');
    expect(hasRole(editor.authz, 'agent', 'org_admin', 'platform_admin')).toBe(false);
    const db = database();
    await expect(
      new CatalogAdminController(db.pool, true).list(actor('catalog_editor', { expired: true })),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('returns explicit editor capabilities and scopes the catalog list by saved owner', async () => {
    const db = database();
    const result = await new CatalogAdminController(db.pool, true).list(actor('catalog_editor'));
    expect(result).toMatchObject({
      viewerId: editorId,
      canCreate: true,
      canPublish: false,
      canManageQuestionSets: false,
    });
    expect(
      db.query.mock.calls.find(
        ([sql]) => sql.includes('SELECT DISTINCT u.id') && !sql.includes("r.code='approver'"),
      )?.[1],
    ).toEqual([org, false, editorId]);
    expect(
      db.query.mock.calls.find(([sql]) => sql.includes('FROM local_catalog_item i JOIN'))?.[1],
    ).toEqual([org, false, editorId]);
  });
  it.each([otherId, ''])(
    'hides a non-owned or legacy draft from an editor: %s',
    async (ownerId) => {
      const db = database({ ownerId });
      await expect(
        new CatalogAdminController(db.pool, true).detail(actor('catalog_editor'), itemId),
      ).rejects.toMatchObject({ status: 404 });
      expect(db.query.mock.calls.some(([sql]) => /^\s*(INSERT|UPDATE)\b/.test(sql))).toBe(false);
    },
  );
  it('allows an editor to save only its own draft without changing owner', async () => {
    const db = database();
    const controller = new CatalogAdminController(db.pool, true);
    await expect(
      controller.save(actor('catalog_editor'), itemId, {
        ...content(editorId),
        expectedVersion: 1,
      }),
    ).resolves.toEqual({ id: itemId });
    await expect(
      controller.save(actor('catalog_editor'), itemId, { ...content(otherId), expectedVersion: 1 }),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('does not let an editor steal another draft by sending its own owner ID', async () => {
    const db = database({ ownerId: otherId });
    await expect(
      new CatalogAdminController(db.pool, true).save(actor('catalog_editor'), itemId, {
        ...content(editorId),
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('forces a new editor draft to self ownership and rejects a forged owner', async () => {
    const db = database(),
      controller = new CatalogAdminController(db.pool, true);
    const body = { ...content(), code: 'synth-new', creationKey: itemId };
    await controller.create(actor('catalog_editor'), body);
    const insert = db.query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO local_catalog_item'),
    );
    expect((insert?.[1]?.[5] as CatalogDefinition).ownerId).toBe(editorId);
    await expect(
      controller.create(actor('catalog_editor'), {
        ...body,
        definition: definition({ ownerId: otherId }),
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('keeps legacy admin saves valid and reports missing owner/group as warnings', async () => {
    const db = database({ ownerId: '' }),
      controller = new CatalogAdminController(db.pool, true);
    const list = await controller.list(actor('org_admin'));
    expect(list.items[0]?.readiness).toMatchObject({
      ready: true,
      issues: [],
      warnings: ['責任者が未設定です', '処理グループが未設定です'],
    });
    await expect(
      controller.save(actor('org_admin'), itemId, { ...content(), expectedVersion: 1 }),
    ).resolves.toEqual({ id: itemId });
  });
  it('refuses editor publication, shared-set writes and role delegation before DB writes', async () => {
    const db = database(),
      controller = new CatalogAdminController(db.pool, true),
      editor = actor('catalog_editor');
    await expect(
      controller.publication(editor, itemId, { expectedVersion: 1, state: 'published' }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(controller.saveQuestionSet(editor, null, {})).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      new UserAdminService(db.client).grantRole(editor.authz, otherId, 'catalog_editor', {
        validUntil: null,
        reason: '合成',
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('FR-CAT-003 independent checklist progress', () => {
  const body = { requestRevision: 1, expectedVersion: 1, key: 'prepare', completed: true };
  it('does not accept a requester-supplied routing group in the public request body', async () => {
    const db = database();
    await expect(
      new CatalogController(db.pool, storage, true).create(actor('requester'), {
        itemId,
        itemVersion: 1,
        idempotencyKey: requestId,
        approverId,
        reason: '合成',
        durationDays: 7,
        fulfillmentGroupId: groupId,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(db.query).not.toHaveBeenCalled();
  });
  it.each(['catalog_editor', 'requester', 'approver'] as RoleCode[])(
    'refuses checklist changes by %s',
    async (role) => {
      const db = database();
      await expect(
        new CatalogController(db.pool, storage, true).updateChecklist(actor(role), requestId, body),
      ).rejects.toMatchObject({ status: 403 });
      expect(db.query).not.toHaveBeenCalled();
    },
  );
  it('saves an independent checklist version without changing request or snapshot', async () => {
    const db = database(),
      before = structuredClone(db.request);
    await expect(
      new CatalogController(db.pool, storage, true).updateChecklist(
        actor('agent'),
        requestId,
        body,
      ),
    ).resolves.toEqual({ id: requestId, checklistVersion: 2 });
    expect(db.request).toEqual(before);
    expect(db.query.mock.calls.some(([sql]) => sql.includes('UPDATE local_service_request'))).toBe(
      false,
    );
    expect(
      db.query.mock.calls.some(([sql]) =>
        sql.includes('INSERT INTO local_request_checklist_progress'),
      ),
    ).toBe(true);
    expect(
      db.query.mock.calls.some(
        ([sql, params]) =>
          sql.includes('INSERT INTO audit_event') && params?.[1] === 'request.checklist.updated',
      ),
    ).toBe(true);
  });
  it.each(['snapshot', 'approvalHash', 'approvalRevision'] as const)(
    'rejects checklist writes when %s no longer matches approval',
    async (kind) => {
      const db = database();
      if (kind === 'snapshot') db.request.snapshot.inputs.reason = '未承認の改変';
      else if (kind === 'approvalHash') db.approval.snapshot_hash = '0'.repeat(64);
      else db.approval.revision++;
      await expect(
        new CatalogController(db.pool, storage, true).updateChecklist(
          actor('agent'),
          requestId,
          body,
        ),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        db.query.mock.calls.some(([sql]) =>
          sql.includes('INSERT INTO local_request_checklist_progress'),
        ),
      ).toBe(false);
    },
  );
  it.each(['pending', 'invalidated', 'completed', 'cancelled'])(
    'refuses checklist changes in state %s',
    async (requestState) => {
      const db = database({ requestState });
      await expect(
        new CatalogController(db.pool, storage, true).updateChecklist(
          actor('agent'),
          requestId,
          body,
        ),
      ).rejects.toMatchObject({ status: 409 });
    },
  );
  it('rejects stale progress and a previous request revision', async () => {
    const db = database({ progressVersion: 3 });
    await expect(
      new CatalogController(db.pool, storage, true).updateChecklist(
        actor('agent'),
        requestId,
        body,
      ),
    ).rejects.toMatchObject({ status: 409 });
    const revised = database({ requestRevision: 2 });
    await expect(
      new CatalogController(revised.pool, storage, true).updateChecklist(
        actor('agent'),
        requestId,
        body,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('rejects unknown tasks and missing cross-organization requests', async () => {
    const db = database();
    await expect(
      new CatalogController(db.pool, storage, true).updateChecklist(actor('agent'), requestId, {
        ...body,
        key: 'unknown',
      }),
    ).rejects.toMatchObject({ status: 400 });
    const hidden = database({ noRequest: true });
    await expect(
      new CatalogController(hidden.pool, storage, true).updateChecklist(
        actor('agent'),
        requestId,
        body,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});
