// WP-P2-UIX-041 / FR-CAT-002/003 / FR-IDM-006 / NFR-UX-002/003/004.
// Real server pages/actions with API probes; real authorization and DB isolation have separate evidence.
import React, { type AnchorHTMLAttributes, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CatalogAdminDetail,
  CatalogAdminList,
  CatalogQuestionSet,
} from '../../apps/web/src/lib/api';
import { DIRECTORY_ROLES, parseDirectoryQuery } from '../../apps/web/src/lib/user-directory';

const probes = vi.hoisted(() => ({
  read: vi.fn(),
  detail: vi.fn(),
  sets: vi.fn(),
  saveSet: vi.fn(),
  save: vi.fn(),
  session: vi.fn(),
  editor: vi.fn(),
  setForm: vi.fn(),
  revalidate: vi.fn(),
  redirect: vi.fn((_href: string) => {
    throw new Error('NEXT_REDIRECT_PROBE');
  }),
}));
vi.mock('../../apps/web/src/lib/api', () => ({
  api: {
    catalogManagementRead: probes.read,
    catalogManagementDetail: probes.detail,
    catalogQuestionSets: probes.sets,
    saveCatalogQuestionSet: probes.saveSet,
    saveCatalogItem: probes.save,
  },
  requireSession: probes.session,
}));
vi.mock('../../apps/web/src/components/CatalogAdminForm', () => ({
  CatalogAdminForm: probes.editor,
}));
vi.mock('../../apps/web/src/components/CatalogQuestionSetForm', () => ({
  CatalogQuestionSetForm: probes.setForm,
}));
vi.mock('../../apps/web/src/components/ContextLink', () => ({
  ContextLink: (props: { children?: ReactNode; href: string }) =>
    React.createElement('a', { href: props.href }, props.children),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  redirect: probes.redirect,
}));
vi.mock('next/cache', () => ({ revalidatePath: probes.revalidate }));
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => React.createElement('a', props),
}));

import NewPage from '../../apps/web/src/app/catalog/manage/new/page';
import ManagePage from '../../apps/web/src/app/catalog/manage/page';
import QuestionSetsPage from '../../apps/web/src/app/catalog/manage/question-sets/page';
import { saveQuestionSet } from '../../apps/web/src/app/catalog/manage/question-sets/actions';
import { saveCatalog } from '../../apps/web/src/app/catalog/manage/actions';

const owner = '04100000-0000-4000-8000-000000000001';
const group = '04100000-0000-4000-8000-000000000002';
const id = '04100000-0000-4000-8000-000000000003';
const setId = '04100000-0000-4000-8000-000000000004';
const creationKey = '04100000-0000-4000-8000-000000000005';
const approver = '04100000-0000-4000-8000-000000000006';
const source: CatalogAdminDetail = {
  id,
  code: 'synthetic-041',
  editVersion: 7,
  active: false,
  publishedRevision: null,
  draft: {
    revision: 3,
    title: '合成の複製元',
    description: '共有・複製の合成説明',
    definition: {
      mode: 'local_simulation',
      action: 'simulate.access_grant',
      targetLabel: '合成対象041',
      allowedDurations: [7, 30],
      maxReasonLength: 2000,
      approval: { mode: 'fixed', approverId: approver },
      ownerId: owner,
      fulfillmentGroupId: group,
      checklist: [{ key: 'verify', label: '合成確認', required: true }],
      sections: [{ key: 'delivery', title: '配送の情報' }],
      fields: [
        {
          key: 'kind',
          type: 'select',
          label: '配送区分',
          required: true,
          options: ['配送', '窓口'],
          section: 'delivery',
        },
        {
          key: 'address',
          type: 'text',
          label: '合成配送先',
          required: true,
          maxLength: 100,
          section: 'delivery',
          visibleWhen: { field: 'kind', equals: '配送' },
        },
      ],
    },
  },
  published: null,
  history: [],
  approvers: [{ id: approver, name: '合成承認者' }],
  viewerId: owner,
  owners: [{ id: owner, name: '合成責任者' }],
  groups: [{ id: group, name: '合成IT担当' }],
  questionSets: [],
  canCreate: true,
  canEdit: true,
  canPublish: true,
  canManageQuestionSets: true,
};
const list: CatalogAdminList = {
  viewerId: owner,
  owners: source.owners,
  groups: source.groups,
  questionSets: [],
  canCreate: true,
  canPublish: true,
  canManageQuestionSets: true,
  approvers: source.approvers,
  items: [
    {
      id,
      code: source.code,
      editVersion: 7,
      draftRevision: 3,
      publishedRevision: 1,
      active: true,
      title: source.draft.title,
      description: source.draft.description,
      ownerName: '合成責任者',
      updatedAt: '2026-11-10T00:00:00Z',
      readiness: { ready: false, issues: ['合成の設定確認が必要'] },
    },
  ],
};
const set: CatalogQuestionSet = {
  id: setId,
  revision: 2,
  title: '合成の共有質問',
  description: '質問だけを共有する',
  fields: source.draft.definition.fields!,
  sections: source.draft.definition.sections!,
  updatedAt: '2026-11-10T00:00:00Z',
};
type Query = Record<string, string | string[] | undefined>;
const newPage = (query: Query = {}) => NewPage({ searchParams: Promise.resolve(query) });
const render = async (node: ReactNode | Promise<ReactNode>) => renderToStaticMarkup(await node);
function setForm() {
  const data = new FormData();
  data.set('title', '合成の共有質問');
  data.set('description', '質問だけを共有する');
  data.set('source', `${id}|3`);
  data.set('creationKey', creationKey);
  data.set('expectedVersion', '2');
  return data;
}

beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.clearAllMocks();
  probes.read.mockResolvedValue({ ok: true, data: structuredClone(list) });
  probes.detail.mockResolvedValue({ ok: true, data: structuredClone(source) });
  probes.sets.mockResolvedValue({
    ok: true,
    data: { items: [structuredClone(set)], canManage: true },
  });
  probes.saveSet.mockResolvedValue({ ok: true, data: { id: setId, revision: 1 } });
  probes.save.mockResolvedValue({ ok: true, data: { id } });
  probes.session.mockResolvedValue({ userId: owner, organizationId: 'synthetic-org', roles: [] });
  probes.editor.mockImplementation(() =>
    React.createElement('form', { 'data-editor-probe': true }),
  );
  probes.setForm.mockImplementation(() =>
    React.createElement('form', { 'data-set-form-probe': true }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('catalog operation pages and capabilities', () => {
  it('loads an authorized clone with GETs only and forwards content without its identity or edit version', async () => {
    const html = await render(newPage({ copyFrom: id, returnTo: '/catalog/manage?q=合成' }));
    expect(html).toContain('サービスを複製する');
    expect(probes.read).toHaveBeenCalledOnce();
    expect(probes.detail).toHaveBeenCalledExactlyOnceWith(id);
    const props = probes.editor.mock.calls[0]![0];
    expect(props.options).toEqual(list);
    expect(props.initialContent).toEqual({
      title: source.draft.title,
      description: source.draft.description,
      definition: source.draft.definition,
    });
    expect(props.initialContent).not.toHaveProperty('id');
    expect(props.initialContent).not.toHaveProperty('code');
    expect(props.initialContent).not.toHaveProperty('editVersion');
    expect(probes.save).not.toHaveBeenCalled();
    expect(probes.saveSet).not.toHaveBeenCalled();
  });

  it.each([false, undefined])(
    'does not load clone source or render a create form without canCreate=%s',
    async (canCreate) => {
      probes.read.mockResolvedValue({ ok: true, data: { ...list, canCreate } });
      await expect(newPage({ copyFrom: id })).rejects.toThrow('NEXT_NOT_FOUND');
      expect(probes.detail).not.toHaveBeenCalled();
      expect(probes.editor).not.toHaveBeenCalled();
    },
  );

  it.each(['bad', '../source', `${id}/extra`, [id], 'https://example.invalid'])(
    'rejects a malformed clone selector before the source GET: %j',
    async (copyFrom) => {
      await expect(newPage({ copyFrom })).rejects.toThrow('NEXT_NOT_FOUND');
      expect(probes.detail).not.toHaveBeenCalled();
      expect(probes.editor).not.toHaveBeenCalled();
    },
  );

  it.each([403, 404])(
    'treats a source refusal %i as unavailable and never renders a form',
    async (status) => {
      probes.detail.mockResolvedValue({ ok: false, problem: { status, title: 'PRIVATE_SOURCE' } });
      await expect(newPage({ copyFrom: id })).rejects.toThrow('NEXT_NOT_FOUND');
      expect(probes.editor).not.toHaveBeenCalled();
    },
  );

  it('retains an authorized clone retry path after a read failure without exposing server details', async () => {
    probes.detail.mockResolvedValue({
      ok: false,
      problem: { status: 503, title: 'PRIVATE_SOURCE', detail: 'PRIVATE_DETAIL' },
    });
    const html = await render(newPage({ copyFrom: id, returnTo: '/catalog/manage?q=合成' }));
    expect(html).toContain('複製元を再取得する');
    expect(html).toContain('copyFrom=' + id);
    expect(html).not.toContain('PRIVATE_');
    expect(probes.editor).not.toHaveBeenCalled();
    expect(probes.save).not.toHaveBeenCalled();
  });

  it('retains the selected clone identity when the initial authoring-options read fails', async () => {
    probes.read.mockResolvedValue({
      ok: false,
      problem: { status: 503, title: 'PRIVATE_OPTIONS' },
    });
    const html = await render(newPage({ copyFrom: id, returnTo: '/catalog/manage?q=合成' }));
    expect(html).toContain('copyFrom=' + id);
    expect(html).not.toContain('PRIVATE_OPTIONS');
    expect(probes.detail).not.toHaveBeenCalled();
    expect(probes.editor).not.toHaveBeenCalled();
    expect(probes.save).not.toHaveBeenCalled();
  });

  it('shows owner, update, unpublished changes, readiness and a read-only clone link on the management list', async () => {
    const html = await render(ManagePage({ searchParams: Promise.resolve({ q: '合成責任者' }) }));
    expect(html).toContain('合成責任者');
    expect(html).toContain('最終更新');
    expect(html).toContain('未公開の変更あり');
    expect(html).toContain('設定の見直しが必要');
    expect(html).toContain('合成の設定確認が必要');
    expect(html).toContain('copyFrom=' + id);
    expect(probes.save).not.toHaveBeenCalled();
  });

  it.each([false, undefined])(
    'hides creation, cloning and delegation controls when capabilities are %s',
    async (allowed) => {
      probes.read.mockResolvedValue({
        ok: true,
        data: { ...list, canCreate: allowed, canPublish: allowed, canManageQuestionSets: allowed },
      });
      const html = await render(ManagePage({ searchParams: Promise.resolve({}) }));
      expect(html).not.toContain('サービスを作成する');
      expect(html).not.toContain('このサービスを複製する');
      expect(html).not.toContain('編集権限を委任する');
      expect(html).toContain('合成の複製元');
    },
  );

  it.each([false, undefined])(
    'keeps readable question-set contents while hiding manage forms without canManage=%s',
    async (canManage) => {
      probes.sets.mockResolvedValue({ ok: true, data: { items: [set], canManage } });
      const html = await render(QuestionSetsPage({ searchParams: Promise.resolve({}) }));
      expect(html).toContain(set.title);
      expect(html).toContain('配送区分');
      expect(probes.setForm).not.toHaveBeenCalled();
      expect(probes.saveSet).not.toHaveBeenCalled();
    },
  );

  it('offers create/update forms to an explicitly authorized library manager', async () => {
    const html = await render(QuestionSetsPage({ searchParams: Promise.resolve({ saved: '1' }) }));
    expect(html).toContain('共有項目セットを保存しました');
    expect(probes.setForm).toHaveBeenCalledTimes(2);
    expect(probes.setForm.mock.calls[0]![0]).toEqual({ sources: list.items });
    expect(probes.setForm.mock.calls[1]![0]).toEqual({ sources: list.items, item: set });
  });

  it('recognizes the catalog editor as a distinct directory role', () => {
    expect(DIRECTORY_ROLES).toContain('catalog_editor');
    expect(parseDirectoryQuery({ role: 'catalog_editor' }).role).toBe('catalog_editor');
  });
});

describe('question-set and operation save actions', () => {
  it('copies only fields and sections from a freshly authorized source revision', async () => {
    await expect(saveQuestionSet(null, { message: '' }, setForm())).rejects.toThrow(
      'NEXT_REDIRECT_PROBE',
    );
    expect(probes.detail).toHaveBeenCalledExactlyOnceWith(id);
    expect(probes.saveSet).toHaveBeenCalledExactlyOnceWith(null, {
      title: '合成の共有質問',
      description: '質問だけを共有する',
      fields: source.draft.definition.fields,
      sections: source.draft.definition.sections,
      creationKey,
    });
    const payload = probes.saveSet.mock.calls[0]![1];
    expect(payload).not.toHaveProperty('ownerId');
    expect(payload).not.toHaveProperty('fulfillmentGroupId');
    expect(payload).not.toHaveProperty('checklist');
    expect(payload).not.toHaveProperty('approval');
  });

  it.each(['', 'bad', `${id}|0`, `${id}|03`, `${id}|NaN`, `${id}|3|extra`])(
    'does not save a malformed source selector %j',
    async (sourceValue) => {
      const data = setForm();
      data.set('source', sourceValue);
      const result = await saveQuestionSet(null, { message: '' }, data);
      expect(result.message).toBeTruthy();
      expect(probes.detail).not.toHaveBeenCalled();
      expect(probes.saveSet).not.toHaveBeenCalled();
    },
  );

  it('requires the same saved source revision and retains an actionable failure', async () => {
    probes.detail.mockResolvedValue({
      ok: true,
      data: { ...source, draft: { ...source.draft, revision: 4 } },
    });
    const result = await saveQuestionSet(null, { message: '', attempt: 1 }, setForm());
    expect(result.message).toContain('元サービスが更新されました');
    expect(result.attempt).toBe(2);
    expect(probes.saveSet).not.toHaveBeenCalled();
    expect(probes.redirect).not.toHaveBeenCalled();
  });

  it('does not turn source-read authorization failures into a question-set write', async () => {
    probes.detail.mockResolvedValue({ ok: false, problem: { status: 403, title: 'PRIVATE' } });
    const result = await saveQuestionSet(null, { message: '' }, setForm());
    expect(result.message).not.toContain('PRIVATE');
    expect(probes.saveSet).not.toHaveBeenCalled();
  });

  it('updates only metadata while preserving the explicitly selected current question-set revision', async () => {
    const data = setForm();
    data.set('source', '');
    await expect(saveQuestionSet(setId, { message: '' }, data)).rejects.toThrow(
      'NEXT_REDIRECT_PROBE',
    );
    expect(probes.saveSet).toHaveBeenCalledExactlyOnceWith(setId, {
      title: set.title,
      description: set.description,
      fields: set.fields,
      sections: set.sections,
      expectedVersion: 2,
    });
    expect(probes.detail).not.toHaveBeenCalled();
  });

  it('rejects a stale library edit without writing or redirecting', async () => {
    const data = setForm();
    data.set('source', '');
    data.set('expectedVersion', '1');
    const result = await saveQuestionSet(setId, { message: '' }, data);
    expect(result.message).toContain('更新されています');
    expect(probes.saveSet).not.toHaveBeenCalled();
    expect(probes.redirect).not.toHaveBeenCalled();
  });

  it('serializes owner, group and checklist definitions without accepting progress or hidden answer controls', async () => {
    const data = new FormData();
    data.set('title', source.draft.title);
    data.set('description', source.draft.description);
    data.set('targetLabel', '合成対象');
    data.set('allowedDurations', '7,30');
    data.set('maxReasonLength', '2000');
    data.set('approverId', approver);
    data.set('fields', '[]');
    data.set('sections', '[]');
    data.set('ownerId', owner);
    data.set('fulfillmentGroupId', group);
    data.set('checklist', JSON.stringify(source.draft.definition.checklist));
    data.set('expectedVersion', '7');
    data.set('completed:verify', 'true');
    data.set('value:private', 'TRIAL_ONLY');
    await expect(saveCatalog(id, { message: '' }, data)).rejects.toThrow('NEXT_REDIRECT_PROBE');
    const payload = probes.save.mock.calls[0]![1];
    expect(payload.definition).toMatchObject({
      ownerId: owner,
      fulfillmentGroupId: group,
      checklist: source.draft.definition.checklist,
    });
    expect(JSON.stringify(payload)).not.toContain('TRIAL_ONLY');
    expect(JSON.stringify(payload)).not.toContain('completed:');
  });

  it.each(['[', '{}', 'null'])(
    'refuses malformed/non-array checklist JSON %s before saving',
    async (checklist) => {
      const data = new FormData();
      data.set('fields', '[]');
      data.set('checklist', checklist);
      const result = await saveCatalog(id, { message: '' }, data);
      expect(result.message).toBeTruthy();
      expect(probes.save).not.toHaveBeenCalled();
    },
  );
});
