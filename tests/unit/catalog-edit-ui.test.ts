// NFR-UX-002, NFR-UX-003, NFR-UX-004. Real JSX probes, separate from actual Next dispatch evidence.
import React, { type FormHTMLAttributes, type ReactNode, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogAdminDetail } from '../../apps/web/src/lib/api';
import type { FormFeedback } from '../../apps/web/src/lib/form-state';

type FormProps = FormHTMLAttributes<HTMLFormElement> & { feedback: FormFeedback; pending: boolean };
const hooks = vi.hoisted(() => ({
  state: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  states: 0,
  references: 0,
  actions: 0,
  pending: [] as boolean[],
  feedback: [] as FormFeedback[],
  reducers: [] as Array<(previous: FormFeedback, data: FormData) => Promise<FormFeedback>>,
  forms: [] as FormProps[],
  save: vi.fn(),
  publish: vi.fn(),
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = hooks.states++;
    if (!(index in hooks.state)) hooks.state[index] = initial;
    return [
      hooks.state[index],
      (value: unknown) => {
        hooks.state[index] = value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const index = hooks.references++;
    return hooks.refs[index] ?? (hooks.refs[index] = { current: initial });
  },
  useEffect: () => {},
  useActionState: (reducer: (typeof hooks.reducers)[number], initial: FormFeedback) => {
    const index = hooks.actions++;
    hooks.reducers[index] = reducer;
    return [hooks.feedback[index] ?? initial, vi.fn(), hooks.pending[index] ?? false];
  },
}));
vi.mock('../../apps/web/src/app/catalog/manage/actions', () => ({
  saveCatalog: hooks.save,
  publishCatalog: hooks.publish,
}));
vi.mock('../../apps/web/src/components/FeedbackForm', () => ({
  FeedbackForm: (props: FormProps) => {
    hooks.forms.push(props);
    const { feedback: _feedback, pending: _pending, action: _action, ...rest } = props;
    return React.createElement('form', rest);
  },
  FormField: ({ children }: { children: ReactNode }) => React.createElement('div', null, children),
}));
vi.mock('../../apps/web/src/components/ContextLink', () => ({
  ContextLink: ({ children, href }: { children: ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}));
// These probes own the save/publication coordinator. Preview state and validation
// are exercised independently in catalog-preview and catalog-authoring-ui tests.
vi.mock('../../apps/web/src/components/CatalogLivePreview', () => ({
  CatalogLivePreview: () => null,
}));
import {
  CatalogAdminForm,
  CatalogManagement,
} from '../../apps/web/src/components/CatalogAdminForm';

const item: CatalogAdminDetail = {
  id: '08600000-0000-4000-8000-000000000010',
  code: 'synthetic-catalog',
  editVersion: 7,
  active: true,
  canEdit: true,
  canCreate: true,
  canPublish: true,
  canManageQuestionSets: true,
  viewerId: '08600000-0000-4000-8000-000000000020',
  owners: [],
  groups: [],
  questionSets: [],
  publishedRevision: 3,
  draft: {
    revision: 5,
    title: '保存済みサービス',
    description: '説明\r\n本文',
    definition: {
      mode: 'local_simulation',
      action: 'simulate.access_grant',
      targetLabel: '対象',
      allowedDurations: [1, 7, 30],
      maxReasonLength: 2000,
      approval: { mode: 'fixed', approverId: 'approver-a' },
      fields: [
        { key: 'team', label: '部署', type: 'text', required: true, maxLength: 80 },
        { key: 'notes', label: '補足', type: 'textarea', required: false, maxLength: 500 },
        {
          key: 'purpose',
          label: '目的',
          type: 'select',
          required: true,
          options: ['運用', '検証'],
        },
        { key: 'confirm', label: '確認', type: 'checkbox', required: true },
      ],
    },
  },
  published: null,
  history: [{ revision: 5, title: '保存済みサービス', createdAt: '2026-10-10T00:00:00Z' }],
  approvers: [
    { id: 'approver-a', name: '合成承認者A' },
    { id: 'approver-b', name: '合成承認者B' },
  ],
};
function render(current = item, create = false) {
  hooks.states = hooks.references = hooks.actions = 0;
  hooks.forms = [];
  return renderToStaticMarkup(
    create
      ? React.createElement(CatalogAdminForm, {
          approvers: current.approvers,
          options: {
            viewerId: current.viewerId ?? '',
            owners: current.owners ?? [],
            groups: current.groups ?? [],
            questionSets: current.questionSets ?? [],
            canCreate: current.canCreate === true,
            canPublish: current.canPublish === true,
            canManageQuestionSets: current.canManageQuestionSets === true,
          },
        })
      : React.createElement(CatalogManagement, { item: current }),
  );
}
function nodes(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!React.isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...nodes(node.props.children as ReactNode)];
}
function control(id: string) {
  const found = hooks.forms.flatMap((f) => nodes(f.children)).find((n) => n.props.id === id);
  if (!found) throw Error('missing ' + id);
  return found.props;
}
function change(id: string, value: unknown) {
  (control(id).onChange as (e: unknown) => void)({ target: { value, checked: value } });
}
function capture(form: number) {
  const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
  hooks.forms[form]?.onSubmitCapture?.(
    event as unknown as Parameters<NonNullable<FormProps['onSubmitCapture']>>[0],
  );
  return event;
}
function blocked() {
  const event = capture(0);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(event.stopPropagation).toHaveBeenCalledOnce();
}
beforeEach(() => {
  vi.stubGlobal('React', React);
  hooks.state = [];
  hooks.refs = [];
  hooks.pending = [];
  hooks.feedback = [];
  hooks.reducers = [];
  hooks.save.mockReset();
  hooks.publish.mockReset();
  hooks.save.mockResolvedValue({ message: '保存失敗', attempt: 1 });
  hooks.publish.mockResolvedValue({ message: '公開失敗', attempt: 1 });
});
afterEach(() => vi.unstubAllGlobals());

describe('catalog edit values and saved targets', () => {
  it('shows independently numbered saved draft and published targets with an unchanged preview', () => {
    const html = render();
    expect(html).toContain('保存済みの下書き版5');
    expect(html).toContain('公開版3の新規受付を停止する');
    expect(capture(0).preventDefault).not.toHaveBeenCalled();
    change('catalog-title', '未保存のサービス');
    const dirty = render();
    expect(dirty).toContain('未保存の入力があります');
    expect(dirty).toContain('保存済みサービス');
    expect(dirty).not.toContain('未保存のサービス</h2>');
    blocked();
  });
  it.each([
    ['catalog-title', '別名'],
    ['catalog-description', '説明\n本文 '],
    ['catalog-target', '別対象'],
    ['catalog-days', '1,7,30'],
    ['catalog-reason-limit', '1900'],
    ['catalog-approver', 'approver-b'],
    ['catalog-category', '端末貸与'],
    ['field-label-0', '別部署'],
    ['field-type-0', 'checkbox'],
    ['field-options-2', '検証\n運用'],
    ['field-limit-0', '81'],
    ['field-limit-1', '501'],
  ])('compares %s exactly and clears dirty when the original value is restored', (id, value) => {
    render();
    const original = control(id).value;
    const snapshot = structuredClone(hooks.state[0]);
    change(id, value);
    render();
    blocked();
    if (id === 'field-type-0') {
      hooks.state[0] = snapshot;
      hooks.refs[1]!.current = snapshot;
    } else change(id, original);
    expect(render()).not.toContain('未保存の入力があります');
    expect(capture(0).preventDefault).not.toHaveBeenCalled();
  });
  it('normalizes only textarea display newlines, retaining days order and spaces', () => {
    render();
    change('catalog-description', '説明\r本文');
    expect(render()).not.toContain('未保存の入力があります');
    change('catalog-days', '30, 7, 1');
    render();
    blocked();
    change('catalog-days', '1, 7, 30');
    expect(render()).not.toContain('未保存の入力があります');
  });
  it('keeps field identity hidden and immutable when renaming and reordering a question', () => {
    render();
    const keyControls = () =>
      nodes(hooks.forms[1]?.children).filter(
        (n) => n.type === 'input' && /^fields\.\d+\.key$/.test(String(n.props.name)),
      );
    expect(keyControls().map((n) => [n.props.type, n.props.value, n.props.onChange])).toEqual([
      ['hidden', 'team', undefined],
      ['hidden', 'notes', undefined],
      ['hidden', 'purpose', undefined],
      ['hidden', 'confirm', undefined],
    ]);
    change('field-label-0', '利用部署');
    render();
    blocked();
    const down = nodes(hooks.forms[1]?.children).find(
      (n) =>
        n.type === 'button' &&
        Array.isArray(n.props.children) &&
        n.props.children.join('') === '項目1を下へ',
    );
    expect(down).toBeDefined();
    (down!.props.onClick as () => void)();
    render();
    expect(keyControls().map((n) => n.props.value)).toEqual([
      'notes',
      'team',
      'purpose',
      'confirm',
    ]);
    const serialized = nodes(hooks.forms[1]?.children).find(
      (n) => n.type === 'input' && n.props.name === 'fields',
    );
    expect(JSON.parse(serialized!.props.value as string)[1]).toEqual({
      key: 'team',
      label: '利用部署',
      type: 'text',
      required: true,
      maxLength: 80,
    });
    blocked();
  });
  it.each(['required', 'order', 'add', 'delete', 'option-boundary'])(
    'tracks field %s without losing array boundaries',
    (kind) => {
      render();
      const original = structuredClone(hooks.state[0]) as { fields: unknown[] };
      const changed = structuredClone(original);
      if (kind === 'required') (changed.fields[0] as { required: boolean }).required = false;
      if (kind === 'order') changed.fields.reverse();
      if (kind === 'add')
        changed.fields.push({ key: 'new', label: '追加', type: 'checkbox', required: false });
      if (kind === 'delete') changed.fields.pop();
      if (kind === 'option-boundary') {
        (original.fields[2] as { options: string[] }).options = ['a\nb', 'c'];
        (changed.fields[2] as { options: string[] }).options = ['a', 'b\nc'];
      }
      if (kind === 'option-boundary') {
        const specific = structuredClone(item);
        specific.draft.definition.fields =
          original.fields as CatalogAdminDetail['draft']['definition']['fields'];
        hooks.state[0] = changed;
        hooks.refs[1]!.current = changed;
        render(specific);
        blocked();
      } else {
        hooks.state[0] = changed;
        hooks.refs[1]!.current = changed;
        render();
        blocked();
      }
    },
  );
  it('ignores code and unknown DTO properties in edit comparison', () => {
    render();
    const changed = { ...(hooks.state[0] as object), code: 'ignored', unknown: 'ignored' };
    hooks.state[0] = changed;
    hooks.refs[1]!.current = changed;
    expect(render()).not.toContain('未保存の入力があります');
  });
  it('reads current dirty values at capture before a rerender', () => {
    render();
    change('catalog-title', '未保存');
    blocked();
    change('catalog-title', item.draft.title);
    expect(capture(0).preventDefault).not.toHaveBeenCalled();
  });
  it('rebases only on a fresh keyed coordinator after a confirmed new DTO', () => {
    render();
    change('catalog-title', '未保存');
    render();
    blocked();
    const next = structuredClone(item);
    next.editVersion = 8;
    next.draft.revision = 6;
    next.draft.title = '確認済みの新下書き';
    hooks.state = [];
    hooks.refs = [];
    const html = render(next);
    expect(html).toContain('保存済みの下書き版6');
    expect(html).not.toContain('未保存の入力があります');
    expect(control('catalog-title').value).toBe(next.draft.title);
  });
});

describe('catalog action isolation', () => {
  it.each([0, 1])('blocks all edits and both captures during pending operation %s', (index) => {
    render();
    change('catalog-title', '未保存');
    render();
    hooks.pending[index] = true;
    render();
    expect(
      hooks.forms[1]?.children &&
        nodes(hooks.forms[1].children).some((n) => n.type === 'fieldset' && n.props.disabled),
    ).toBe(true);
    expect(capture(0).preventDefault).toHaveBeenCalledOnce();
    expect(capture(1).preventDefault).toHaveBeenCalledOnce();
    change('catalog-title', '消してはいけない');
    expect(control('catalog-title').value).toBe('未保存');
    hooks.pending[index] = false;
    hooks.feedback[index] = { message: '失敗', attempt: 1 };
    render();
    expect(control('catalog-title').value).toBe('未保存');
    blocked();
    expect(capture(1).preventDefault).not.toHaveBeenCalled();
  });
  it.each([0, 1])(
    'latches operation %s after FormData and rejects same-event cross dispatch without an API call',
    async (index) => {
      render();
      let release!: (feedback: FormFeedback) => void;
      const wait = new Promise<FormFeedback>((resolve) => {
        release = resolve;
      });
      (index === 0 ? hooks.save : hooks.publish).mockReturnValueOnce(wait);
      const data = new FormData();
      data.set('expectedVersion', '7');
      data.set('state', 'published');
      const first = hooks.reducers[index]!({ message: '' }, data);
      expect(capture(0).preventDefault).toHaveBeenCalledOnce();
      expect(capture(1).preventDefault).toHaveBeenCalledOnce();
      change('catalog-title', 'blocked');
      expect(control('catalog-title').value).toBe(item.draft.title);
      const second = await hooks.reducers[1 - index]!({ message: '' }, data);
      expect(second.message).toContain('別の処理が進行中');
      expect(index === 0 ? hooks.publish : hooks.save).not.toHaveBeenCalled();
      release({ message: '503 合成失敗', attempt: 1 });
      await first;
      expect(capture(0).preventDefault).not.toHaveBeenCalled();
    },
  );
  it('releases the synchronous latch when the unchanged action redirects or throws', async () => {
    render();
    hooks.save.mockRejectedValueOnce(new Error('NEXT_REDIRECT'));
    await expect(hooks.reducers[0]!({ message: '' }, new FormData())).rejects.toThrow(
      'NEXT_REDIRECT',
    );
    expect(capture(0).preventDefault).not.toHaveBeenCalled();
  });
  it('preserves standalone create templates, example and four field variants', () => {
    const html = render(item, true);
    expect(html).toContain('種類別のテンプレートから始める');
    expect(html).not.toContain('公開版3');
    expect(hooks.forms).toHaveLength(1);
    const example = nodes(hooks.forms[0]?.children).find(
      (n) => n.type === 'button' && n.props.children === '汎用の合成例を入力する',
    );
    (example?.props.onClick as () => void)();
    const created = render(item, true);
    for (const type of ['text', 'textarea', 'select', 'checkbox'])
      expect(created).toContain('value="' + type + '"');
    expect(control('catalog-title').value).toBe('合成アクセス利用申請');
  });
  it('keeps missing approver notice and disabled save on create', () => {
    const current = { ...item, approvers: [] };
    const html = render(current, true);
    expect(html).toContain('有効な承認者がいません');
    const save = nodes(hooks.forms[0]?.children).find(
      (n) =>
        n.type === 'button' &&
        Array.isArray(n.props.children) === false &&
        n.props.children === '下書きを保存してプレビューする',
    );
    expect(save?.props.disabled).toBe(true);
  });
});
