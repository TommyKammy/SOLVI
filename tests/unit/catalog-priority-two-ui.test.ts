// WP-P2-UIX-040 / FR-CAT-002/003: real save-action serialization, separate from API authorization.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormFeedback } from '../../apps/web/src/lib/form-state';

const calls = vi.hoisted(() => ({
  save: vi.fn(),
  publish: vi.fn(),
  revalidate: vi.fn(),
  redirect: vi.fn((_path: string) => {
    throw new Error('NEXT_REDIRECT_PROBE');
  }),
}));
vi.mock('../../apps/web/src/lib/api', () => ({
  api: { saveCatalogItem: calls.save, publishCatalogItem: calls.publish },
}));
vi.mock('next/cache', () => ({ revalidatePath: calls.revalidate }));
vi.mock('next/navigation', () => ({ redirect: calls.redirect }));
import { saveCatalog } from '../../apps/web/src/app/catalog/manage/actions';

const itemId = '04000000-0000-4000-8000-000000000001';
const creationKey = '04000000-0000-4000-8000-000000000002';
const approverId = '04000000-0000-4000-8000-000000000003';
const sections = [
  { key: 'schedule', title: '貸与の予定', description: '開始日と返却予定日を確認します。' },
  { key: 'devices', title: '端末と付属品' },
];
const fields = [
  { key: 'team', type: 'text', label: '利用部署', required: true, maxLength: 100 },
  { key: 'notes', type: 'textarea', label: '補足', required: false, maxLength: 500 },
  {
    key: 'loan_kind',
    type: 'select',
    label: '貸与区分',
    required: true,
    options: ['標準貸与', '一時貸出'],
    helpText: '返却予定がある場合は一時貸出を選んでください。',
    section: 'schedule',
  },
  { key: 'confirm', type: 'checkbox', label: '入力内容の確認', required: true },
  {
    key: 'return_date',
    type: 'date',
    label: '返却予定日',
    required: true,
    minDate: '2026-11-10',
    maxDate: '2027-12-31',
    section: 'schedule',
    helpText: '一時貸出の場合だけ入力します。',
    visibleWhen: { field: 'loan_kind', equals: '一時貸出' },
  },
  {
    key: 'count',
    type: 'number',
    label: '台数',
    required: true,
    min: 0,
    max: 10,
    section: 'devices',
  },
  {
    key: 'accessories',
    type: 'multiselect',
    label: '周辺機器',
    required: false,
    options: ['マウス', 'モニター', 'ドック'],
    section: 'devices',
    visibleWhen: { field: 'confirm', equals: true },
  },
];

function form(metadata = true) {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    code: 'service-' + creationKey,
    creationKey,
    expectedVersion: '7',
    title: '合成PC貸与',
    description: '合成データの貸与フォームです。',
    targetLabel: '模擬対象040',
    allowedDurations: '7, 30, 90',
    maxReasonLength: '2000',
    approverId,
    fields: JSON.stringify(
      metadata
        ? fields
        : fields.slice(0, 4).map((field) => ({
            ...field,
            section: undefined,
            helpText: undefined,
            visibleWhen: undefined,
          })),
    ),
    returnTo: '/catalog/manage?q=PC',
  }))
    data.set(key, value);
  if (metadata) {
    data.set('category', 'PC・機器');
    data.set('sections', JSON.stringify(sections));
  }
  return data;
}

async function submitted(id: string | null, data: FormData) {
  await expect(saveCatalog(id, { message: '' }, data)).rejects.toThrow('NEXT_REDIRECT_PROBE');
  expect(calls.save).toHaveBeenCalledOnce();
  return calls.save.mock.calls[0]![1] as Record<string, unknown> & {
    definition: Record<string, unknown>;
  };
}

beforeEach(() => {
  calls.save.mockReset().mockResolvedValue({ ok: true, data: { id: itemId } });
  calls.publish.mockReset();
  calls.revalidate.mockClear();
  calls.redirect.mockClear();
});

describe('priority-two catalog save serialization', () => {
  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])(
    'preserves explicit reason=%s duration=%s in create and edit definitions',
    async (reason, duration) => {
      const data = form();
      data.set('requestFields', JSON.stringify({ reason, duration }));
      const payload = await submitted(itemId, data);
      expect(payload.definition.requestFields).toEqual({ reason, duration });
      expect(payload.definition.allowedDurations).toEqual([7, 30, 90]);
      expect(payload.definition.maxReasonLength).toBe(2000);
    },
  );

  it('does not add requestFields to an unchanged legacy definition', async () => {
    const payload = await submitted(itemId, form());
    expect(payload.definition).not.toHaveProperty('requestFields');
  });

  it('returns a form error without saving malformed visibility JSON', async () => {
    const data = form();
    data.set('requestFields', '{');
    expect((await saveCatalog(itemId, { message: '' }, data)).message).toContain('形式');
    expect(calls.save).not.toHaveBeenCalled();
  });
  it('saves the category, ordered sections, all seven field types and conditional metadata', async () => {
    const payload = await submitted(null, form());
    expect(payload.definition).toEqual({
      mode: 'local_simulation',
      action: 'simulate.access_grant',
      targetLabel: '模擬対象040',
      allowedDurations: [7, 30, 90],
      maxReasonLength: 2000,
      approval: { mode: 'fixed', approverId },
      category: 'PC・機器',
      sections,
      fields,
    });
    expect(calls.publish).not.toHaveBeenCalled();
  });

  it('retains a create intent while sending the exact current metadata', async () => {
    const payload = await submitted(null, form());
    expect(calls.save.mock.calls[0]![0]).toBeNull();
    expect(payload.code).toBe('service-' + creationKey);
    expect(payload.creationKey).toBe(creationKey);
    expect(payload).not.toHaveProperty('expectedVersion');
  });

  it('sends the optimistic edit version without replacing the immutable code or creation intent', async () => {
    const payload = await submitted(itemId, form());
    expect(calls.save.mock.calls[0]![0]).toBe(itemId);
    expect(payload.expectedVersion).toBe(7);
    expect(payload).not.toHaveProperty('code');
    expect(payload).not.toHaveProperty('creationKey');
    expect(payload.definition.sections).toEqual(sections);
  });

  it('does not inject optional metadata into a legacy form that has none', async () => {
    const payload = await submitted(itemId, form(false));
    expect(payload.definition).not.toHaveProperty('category');
    expect(payload.definition).not.toHaveProperty('sections');
  });

  it('omits a blank category and an empty section collection', async () => {
    const data = form(false);
    data.set('category', '   ');
    data.set('sections', '[]');
    const payload = await submitted(itemId, data);
    expect(payload.definition).not.toHaveProperty('category');
    expect(payload.definition).not.toHaveProperty('sections');
  });

  it.each(['fields', 'sections'])(
    'rejects malformed %s JSON before calling the API',
    async (key) => {
      const data = form();
      data.set(key, '[');
      const feedback = await saveCatalog(null, { message: '' }, data);
      expect(feedback.message).toBeTruthy();
      expect(calls.save).not.toHaveBeenCalled();
      expect(calls.redirect).not.toHaveBeenCalled();
      expect(calls.revalidate).not.toHaveBeenCalled();
    },
  );

  it('does not persist any trial answers, unchecked control aliases or arbitrary form keys', async () => {
    const data = form();
    data.set('value:return_date', '2027-01-01');
    data.set('value:count', '0');
    data.append('value:accessories', 'モニター');
    data.append('value:accessories', 'ドック');
    data.set('checkbox:confirm', 'on');
    data.set('preview-answer', 'PRIVATE_TRIAL_040');
    data.set('definition.category', 'UNTRUSTED_OVERRIDE');
    const payload = await submitted(null, data);
    expect(Object.keys(payload).sort()).toEqual([
      'code',
      'creationKey',
      'definition',
      'description',
      'title',
    ]);
    expect(payload.definition.category).toBe('PC・機器');
    expect(JSON.stringify(payload)).not.toContain('PRIVATE_TRIAL_040');
    expect(JSON.stringify(payload)).not.toContain('UNTRUSTED_OVERRIDE');
    expect(payload.definition.fields).toEqual(fields);
  });

  it('keeps field paths from server validation and makes no success redirect on failure', async () => {
    const errors = [
      { field: 'definition.fields.4.minDate', message: '開始日を確認してください。' },
      { field: 'definition.sections.0.title', message: 'セクション名を入力してください。' },
      { field: 'definition.category', message: 'カテゴリは80文字以内です。' },
    ];
    calls.save.mockResolvedValue({
      ok: false,
      problem: { title: 'Validation failed', status: 400, errors },
    });
    const previous: FormFeedback = { message: '前のエラー', attempt: 2 };
    const result = await saveCatalog(itemId, previous, form());
    expect(result.errors).toEqual(errors);
    expect(result.attempt).toBe(3);
    expect(calls.redirect).not.toHaveBeenCalled();
    expect(calls.revalidate).not.toHaveBeenCalled();
    expect(calls.publish).not.toHaveBeenCalled();
  });

  it('returns to the saved preview with a safe management return path after a successful save', async () => {
    await submitted(itemId, form());
    expect(calls.revalidate).toHaveBeenCalledWith('/catalog/manage');
    const location = calls.redirect.mock.calls[0]![0];
    const url = new URL(location, 'https://solvi.test');
    expect(url.pathname).toBe('/catalog/manage/' + itemId);
    expect(url.searchParams.get('saved')).toBe('1');
    expect(url.searchParams.get('returnTo')).toBe('/catalog/manage?q=PC');
    expect(url.hash).toBe('#preview');
  });
});
