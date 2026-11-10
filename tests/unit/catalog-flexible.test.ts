import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type pg from 'pg';
import {
  catalogDefinitionSchema,
  catalogRequestFieldVisibility,
  getVisibleCatalogFields,
  validateCatalogFieldValues,
  validateCatalogRequestInputs,
  type CatalogDefinition,
  type CatalogField,
} from '../../packages/shared/src/catalog';
import { CatalogController } from '../../services/api/src/modules/catalog/catalog.routes';
import { TicketService } from '../../services/api/src/modules/ticket/ticket.service';
import { CollaborationService } from '../../services/api/src/modules/ticket/collaboration.service';
import type { AuthenticatedRequest } from '../../services/api/src/modules/auth/auth.routes';

vi.mock('../../services/api/src/common/audit/audit', async (load) => ({
  ...(await load<Record<string, unknown>>()),
  recordAuditEvent: vi.fn(),
}));

const org = '11111111-1111-4111-8111-111111111111';
const requester = '22222222-2222-4222-8222-222222222222';
const approver = '33333333-3333-4333-8333-333333333333';
const itemId = '44444444-4444-4444-8444-444444444444';
const requestId = '55555555-5555-4555-8555-555555555555';
const ticketId = '66666666-6666-4666-8666-666666666666';
const definition = (changes: Partial<CatalogDefinition> = {}): CatalogDefinition => ({
  mode: 'local_simulation',
  action: 'simulate.access_grant',
  targetLabel: '合成機器',
  allowedDurations: [7, 30],
  maxReasonLength: 10,
  approval: { mode: 'fixed', approverId: approver },
  ...changes,
});
const hidden = () => definition({ requestFields: { reason: false, duration: false } });
const fields: CatalogField[] = [
  {
    key: 'items',
    type: 'multiselect',
    label: '必要な機器',
    required: true,
    options: ['PC', 'マウス'],
  },
  {
    key: 'kind',
    type: 'select',
    label: 'PCの用途',
    required: true,
    options: ['交換', '追加'],
    visibleWhen: { field: 'items', contains: 'PC' },
  },
  {
    key: 'asset',
    type: 'text',
    label: '交換する管理番号',
    required: true,
    maxLength: 40,
    visibleWhen: { field: 'kind', equals: '交換' },
  },
];

describe('FR-CAT-002/003 per-service standard input visibility', () => {
  it('preserves exact legacy definitions while interpreting omitted flags as visible', () => {
    const legacy = definition();
    expect(catalogDefinitionSchema.parse(legacy)).toStrictEqual(legacy);
    expect(catalogRequestFieldVisibility(legacy)).toStrictEqual({ reason: true, duration: true });
    expect(
      catalogDefinitionSchema.parse(definition({ requestFields: {} })).requestFields,
    ).toStrictEqual({});
  });
  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])('keeps only enabled standard answers for reason=%s duration=%s', (reason, duration) => {
    const d = definition({ requestFields: { reason, duration } });
    const parsed = catalogDefinitionSchema.parse(d);
    expect(parsed).toStrictEqual(d);
    expect(
      validateCatalogRequestInputs(parsed, { reason: '  合成理由  ', durationDays: 7 }),
    ).toStrictEqual({
      inputs: {
        ...(reason ? { reason: '合成理由' } : {}),
        ...(duration ? { durationDays: 7 } : {}),
      },
      errors: [],
    });
    const missing = validateCatalogRequestInputs(parsed, {});
    expect(missing.errors.map((e) => e.field)).toStrictEqual([
      ...(reason ? ['reason'] : []),
      ...(duration ? ['durationDays'] : []),
    ]);
  });
  it.each([
    { requestFields: { reason: 'false' } },
    { requestFields: { duration: null } },
    { requestFields: { durationDays: false } },
    { requestFields: [] },
  ])('rejects malformed flags rather than hiding fields implicitly: %j', (change) => {
    expect(catalogDefinitionSchema.safeParse({ ...definition(), ...change }).success).toBe(false);
  });
  it.each(['', '   ', 1, null, 'x'.repeat(11)])('rejects visible malformed reason %j', (reason) => {
    expect(
      validateCatalogRequestInputs(definition(), { reason, durationDays: 7 }).errors.map(
        (e) => e.field,
      ),
    ).toContain('reason');
  });
  it.each([undefined, null, '', '7', 0, -1, 7.5, 8, NaN, Infinity])(
    'rejects visible malformed duration %j',
    (durationDays) => {
      expect(
        validateCatalogRequestInputs(definition(), { reason: '合成', durationDays }).errors.map(
          (e) => e.field,
        ),
      ).toContain('durationDays');
    },
  );
  it('drops disabled stale values without fabricating a reason or a duration', () => {
    expect(
      validateCatalogRequestInputs(hidden(), { reason: 'x'.repeat(3000), durationDays: -9 }),
    ).toStrictEqual({ inputs: {}, errors: [] });
    expect(validateCatalogRequestInputs(hidden(), {})).toStrictEqual({ inputs: {}, errors: [] });
  });
});

describe('FR-CAT-002 multiselect membership conditions', () => {
  it('validates a contains/select chain and displays selected descendants', () => {
    expect(catalogDefinitionSchema.parse(definition({ fields })).fields).toStrictEqual(fields);
    expect(
      getVisibleCatalogFields(fields, { items: ['PC'], kind: '交換' }).map((f) => f.key),
    ).toStrictEqual(['items', 'kind', 'asset']);
    expect(
      validateCatalogFieldValues({ fields }, { items: ['PC'], kind: '交換' }).errors.map(
        (e) => e.field,
      ),
    ).toContain('values.asset');
  });
  it('uses normalized whitespace-selected values for the same required-field decision', () => {
    const result = validateCatalogFieldValues({ fields }, { items: [' PC '], kind: '交換' });
    expect(result.values.items).toStrictEqual(['PC']);
    expect(result.errors.map((e) => e.field)).toContain('values.asset');
  });
  it('keeps raw unsaved option and condition whitespace consistent with parsed validation', () => {
    const draftFields: CatalogField[] = fields.map((field) =>
      field.key === 'items'
        ? { ...field, type: 'multiselect', options: [' PC ', 'マウス'] }
        : field.key === 'kind'
          ? { ...field, visibleWhen: { field: 'items', contains: ' PC ' } }
          : field,
    );
    expect(
      getVisibleCatalogFields(draftFields, { items: ['PC'], kind: '交換' }).map(
        (field) => field.key,
      ),
    ).toStrictEqual(['items', 'kind', 'asset']);
    const parsed = catalogDefinitionSchema.parse(definition({ fields: draftFields }));
    expect(
      validateCatalogFieldValues(parsed, { items: ['PC'], kind: '交換' }).errors.map(
        (issue) => issue.field,
      ),
    ).toContain('values.asset');
  });
  it('drops hidden required descendants despite stale matching answers after deselection', () => {
    const result = validateCatalogFieldValues(
      { fields },
      { items: ['マウス'], kind: '交換', asset: '古い管理番号' },
    );
    expect(result).toStrictEqual({ values: { items: ['マウス'] }, errors: [] });
  });
  it.each([
    { field: 'items', equals: 'PC' },
    { field: 'items', contains: '未知' },
    { field: 'kind', contains: '交換' },
    { field: 'items', contains: true },
    { field: 'items', contains: 'PC', equals: 'PC' },
    { field: 'items', matches: 'PC' },
    { field: 'asset', contains: 'PC' },
  ])('rejects invalid membership source or operator: %j', (condition) => {
    const changed = fields.map((f) => (f.key === 'asset' ? { ...f, visibleWhen: condition } : f));
    expect(
      catalogDefinitionSchema.safeParse(definition({ fields: changed as CatalogField[] })).success,
    ).toBe(false);
  });
  it('rejects a mixed contains/equals cycle and fails closed during rendering', () => {
    const cyclic = fields.map((f) =>
      f.key === 'items' ? { ...f, visibleWhen: { field: 'kind', equals: '交換' } } : f,
    );
    expect(catalogDefinitionSchema.safeParse(definition({ fields: cyclic })).success).toBe(false);
    expect(getVisibleCatalogFields(cyclic, { items: ['PC'], kind: '交換' })).toStrictEqual([]);
  });
  it.each([undefined, 'PC', ['PC', '未知'], [true]])(
    'fails closed for invalid source answers: %j',
    (items) => {
      expect(
        getVisibleCatalogFields(fields, { items, kind: '交換' }).map((f) => f.key),
      ).toStrictEqual(['items']);
    },
  );
  it.each([true, undefined, null, 1])(
    'fails closed for an unparsed malformed contains value %j',
    (contains) => {
      const rawFields = fields.map((field) =>
        field.key === 'kind' ? { ...field, visibleWhen: { field: 'items', contains } } : field,
      ) as unknown as CatalogField[];
      expect(
        getVisibleCatalogFields(rawFields, { items: ['PC'], kind: '交換' }).map(
          (field) => field.key,
        ),
      ).toStrictEqual(['items']);
    },
  );
});

function actor(role: 'requester' | 'agent' = 'requester'): AuthenticatedRequest {
  return {
    userId: requester,
    sessionId: itemId,
    authz: {
      organizationId: org,
      principal: {
        userId: requester,
        status: 'active',
        bindings: [
          { roleCode: role, organizationId: org, validFrom: new Date(0), validUntil: null },
        ],
      },
    },
  };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (key) => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key]),
        )
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
function database(
  d: CatalogDefinition,
  inputs: { reason?: string; durationDays?: number },
  replay = false,
) {
  const snapshot = {
    item: { id: itemId, version: 1, title: '合成機器', definition: d },
    inputs,
    requesterId: requester,
  };
  const request = {
    id: requestId,
    organization_id: org,
    requester_id: requester,
    ticket_id: ticketId,
    version: 1,
    revision: 1,
    state: 'approved',
    snapshot,
    snapshot_hash: createHash('sha256').update(canonical(snapshot)).digest('hex'),
    current_approval_id: approver,
  };
  const approval = {
    id: approver,
    approver_id: approver,
    state: 'approved',
    snapshot_hash: request.snapshot_hash,
    revision: 1,
    expires_at: new Date('2099-01-01'),
  };
  const originalSnapshot = structuredClone(snapshot);
  const query = vi.fn(async (sql: string, _params: unknown[] = []) => {
    if (sql.includes('FROM local_service_request'))
      return { rows: sql.includes('idempotency_key') && !replay ? [] : [request], rowCount: 1 };
    if (sql.includes('SELECT snapshot FROM local_request_revision'))
      return { rows: [{ snapshot: originalSnapshot }], rowCount: 1 };
    if (sql.includes('FROM local_request_approval')) return { rows: [approval], rowCount: 1 };
    if (sql.includes('FROM local_catalog_item'))
      return { rows: [{ id: itemId, version: 1, title: '合成機器', definition: d }], rowCount: 1 };
    if (sql.includes('SELECT DISTINCT u.id'))
      return { rows: [{ id: approver, name: '合成承認者' }], rowCount: 1 };
    if (
      sql.includes('FROM local_simulation_receipt') ||
      sql.includes('FROM local_request_checklist_progress')
    )
      return { rows: [], rowCount: 0 };
    if (
      /^(BEGIN|COMMIT|ROLLBACK|SELECT set_config|SELECT pg_advisory_xact_lock|INSERT|UPDATE)/.test(
        sql.trim(),
      )
    )
      return { rows: [], rowCount: 1 };
    throw new Error('Unhandled catalog test query: ' + sql.slice(0, 60));
  });
  const client = { query, release: vi.fn() } as unknown as pg.PoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
  return { query, request, originalSnapshot, pool };
}
const storage = {} as ConstructorParameters<typeof CatalogController>[1];
const submission = () => ({
  itemId,
  itemVersion: 1,
  idempotencyKey: requestId,
  approverId: approver,
});
afterEach(() => vi.restoreAllMocks());

describe('FR-CAT-003 frozen standard input API normalization', () => {
  it('creates a request with omitted disabled inputs and no fabricated ticket text', async () => {
    const db = database(hidden(), {});
    const create = vi
      .spyOn(TicketService.prototype, 'create')
      .mockImplementation(async () => ({ id: ticketId }) as never);
    await new CatalogController(db.pool, storage, true).create(actor(), {
      ...submission(),
      reason: '古い値',
      durationDays: -3,
    });
    const insert = db.query.mock.calls.find(([sql]) =>
      sql.startsWith('INSERT INTO local_service_request'),
    );
    expect((insert?.[1]?.[7] as { inputs: unknown }).inputs).toStrictEqual({});
    expect(create.mock.calls[0]?.[1].body).toBe('ローカル模擬申請（外部変更なし）');
  });
  it('requires enabled fields before creating a ticket', async () => {
    const db = database(definition(), {});
    const create = vi.spyOn(TicketService.prototype, 'create');
    await expect(
      new CatalogController(db.pool, storage, true).create(actor(), submission()),
    ).rejects.toMatchObject({ status: 400 });
    expect(create).not.toHaveBeenCalled();
  });
  it('replays using the original frozen definition and ignores disabled stale extras', async () => {
    const db = database(hidden(), {}, true);
    const result = await new CatalogController(db.pool, storage, true).create(actor(), {
      ...submission(),
      reason: '再送の古い値',
      durationDays: 7,
    });
    expect(result).toMatchObject({ id: requestId, replayed: true });
    expect(db.query.mock.calls.some(([sql]) => sql.includes('FROM local_catalog_item'))).toBe(
      false,
    );
    expect(db.request.snapshot).toStrictEqual(db.originalSnapshot);
    expect(db.query.mock.calls.some(([sql]) => /^(INSERT|UPDATE)/.test(sql))).toBe(false);
  });
  it('retains legacy enabled-field comparison and rejects changed replay input', async () => {
    const db = database(definition(), { reason: '合成', durationDays: 7 }, true);
    const controller = new CatalogController(db.pool, storage, true);
    await expect(
      controller.create(actor(), { ...submission(), reason: ' 合成 ', durationDays: 7 }),
    ).resolves.toMatchObject({ replayed: true });
    await expect(
      controller.create(actor(), { ...submission(), reason: '変更', durationDays: 7 }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('revises omitted inputs using the frozen request definition without changing prior history', async () => {
    const db = database(hidden(), {});
    const original = structuredClone(db.originalSnapshot);
    await new CatalogController(db.pool, storage, true).edit(actor(), requestId, {
      expectedVersion: 1,
      approverId: approver,
      reason: '古い値',
      durationDays: 99,
    });
    expect(db.request.revision).toBe(2);
    expect(db.request.snapshot.inputs).toStrictEqual({});
    expect(db.originalSnapshot).toStrictEqual(original);
    expect(db.query.mock.calls.some(([sql]) => sql.includes('FROM local_catalog_item'))).toBe(
      false,
    );
  });
  it('omits disabled duration from a successful simulation result and completion comment', async () => {
    const db = database(hidden(), {});
    vi.spyOn(TicketService.prototype, 'findById').mockImplementation(
      async () => ({ state: 'resolved' }) as never,
    );
    const comment = vi
      .spyOn(CollaborationService.prototype, 'addComment')
      .mockImplementation(async () => ({}) as never);
    const result = await new CatalogController(db.pool, storage, true).simulate(
      actor('agent'),
      requestId,
      { expectedVersion: 1 },
    );
    expect(result.receipt.result).not.toHaveProperty('durationDays');
    expect(comment.mock.calls[0]?.[1].body).not.toMatch(/利用日数|undefined/);
  });
});
