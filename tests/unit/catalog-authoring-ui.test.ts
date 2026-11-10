// WP-P2-UIX-039: authoring wiring probes; real form dispatch and preview input tests are separate.
import React, { type FormHTMLAttributes, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogAdminDetail, CatalogField } from '../../apps/web/src/lib/api';
import type { FormFeedback } from '../../apps/web/src/lib/form-state';

type FormProps = FormHTMLAttributes<HTMLFormElement> & {
  feedback: FormFeedback;
  pending: boolean;
};
type PreviewProps = {
  title: string;
  description: string;
  target: string;
  days: string;
  maxReason: number;
  approver: string;
  fields: CatalogField[];
  category?: string;
  sections?: CatalogAdminDetail['draft']['definition']['sections'];
  approvers: CatalogAdminDetail['approvers'];
  disabled: boolean;
};
const hooks = vi.hoisted(() => ({
  values: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  dependencies: [] as Array<readonly unknown[] | undefined>,
  effects: [] as Array<() => unknown>,
  states: 0,
  references: 0,
  effectIndex: 0,
  actionIndex: 0,
  changed: false,
  pending: [] as boolean[],
  forms: [] as FormProps[],
  previews: [] as PreviewProps[],
  save: vi.fn(),
  publish: vi.fn(),
  randomUUID: vi.fn(),
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = hooks.states++;
    if (!(index in hooks.values))
      hooks.values[index] = typeof initial === 'function' ? initial() : initial;
    return [
      hooks.values[index],
      (value: unknown) => {
        const next = typeof value === 'function' ? value(hooks.values[index]) : value;
        hooks.changed ||= !Object.is(next, hooks.values[index]);
        hooks.values[index] = next;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const index = hooks.references++;
    return hooks.refs[index] ?? (hooks.refs[index] = { current: initial });
  },
  useEffect: (effect: () => unknown, dependencies?: readonly unknown[]) => {
    const index = hooks.effectIndex++;
    const previous = hooks.dependencies[index];
    if (
      !(index in hooks.dependencies) ||
      !dependencies ||
      !previous ||
      dependencies.some((dependency, i) => !Object.is(dependency, previous[i]))
    ) {
      hooks.effects.push(effect);
      hooks.dependencies[index] = dependencies;
    }
  },
  useActionState: (_reducer: unknown, initial: FormFeedback) => {
    const index = hooks.actionIndex++;
    return [initial, vi.fn(), hooks.pending[index] ?? false];
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
vi.mock('../../apps/web/src/components/CatalogLivePreview', () => ({
  CatalogLivePreview: (props: PreviewProps) => {
    hooks.previews.push(props);
    return React.createElement('div', { 'data-live-preview-probe': 'true' });
  },
}));
import {
  CatalogAdminForm,
  CatalogManagement,
} from '../../apps/web/src/components/CatalogAdminForm';

const uuid = '03900000-0000-4000-8000-000000000001';
const item: CatalogAdminDetail = {
  id: '03900000-0000-4000-8000-000000000010',
  code: 'synthetic-catalog',
  editVersion: 7,
  active: true,
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
  history: [{ revision: 5, title: '保存済みサービス', createdAt: '2026-11-10T00:00:00Z' }],
  approvers: [
    { id: 'approver-a', name: '合成承認者A' },
    { id: 'approver-b', name: '合成承認者B' },
  ],
};

const expandedItem: CatalogAdminDetail = {
  ...item,
  draft: {
    ...item.draft,
    definition: {
      ...item.draft.definition,
      category: 'PC・機器',
      sections: [
        { key: 'schedule', title: '利用する期間', description: '開始日と返却日を選んでください。' },
        { key: 'equipment', title: '端末と周辺機器' },
      ],
      fields: [
        ...item.draft.definition.fields!,
        {
          key: 'return_date',
          type: 'date',
          label: '返却予定日',
          required: true,
          minDate: '2026-11-10',
          maxDate: '2027-12-31',
          helpText: '検証の場合だけ返却日を指定します。',
          section: 'schedule',
          visibleWhen: { field: 'purpose', equals: '検証' },
        },
        {
          key: 'count',
          type: 'number',
          label: '台数',
          required: true,
          min: 0,
          max: 10,
          section: 'equipment',
        },
        {
          key: 'accessories',
          type: 'multiselect',
          label: '必要な付属品',
          required: false,
          options: ['マウス', 'モニター'],
          section: 'equipment',
          visibleWhen: { field: 'confirm', equals: true },
        },
      ],
    },
  },
};

function render(create = false, current = item) {
  for (let pass = 0; pass < 5; pass++) {
    hooks.states = hooks.references = hooks.effectIndex = hooks.actionIndex = 0;
    hooks.forms = [];
    hooks.previews = [];
    hooks.changed = false;
    const html = renderToStaticMarkup(
      create
        ? React.createElement(CatalogAdminForm, { approvers: current.approvers })
        : React.createElement(CatalogManagement, { item: current }),
    );
    const effects = hooks.effects.splice(0);
    for (const effect of effects) effect();
    if (!hooks.changed) return html;
  }
  throw Error('authoring effects did not settle');
}
function nodes(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!React.isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...nodes(node.props.children as ReactNode)];
}
function editorForm() {
  const form = hooks.forms.find((f) =>
    nodes(f.children).some((n) => n.props.name === 'creationKey'),
  );
  if (!form) throw Error('missing editor form');
  return form;
}
function control(id: string) {
  const element = nodes(editorForm().children).find((n) => n.props.id === id);
  if (!element) throw Error('missing control ' + id);
  return element.props;
}
function named(name: string) {
  return nodes(editorForm().children).filter(
    (n) => ['input', 'select', 'textarea'].includes(String(n.type)) && n.props.name === name,
  );
}
function hidden(name: string) {
  const element = named(name).find((n) => n.type === 'input' && n.props.type === 'hidden');
  if (!element) throw Error('missing hidden control ' + name);
  return element.props.value;
}
function fields() {
  return JSON.parse(hidden('fields') as string) as CatalogField[];
}
function change(id: string, value: unknown) {
  (control(id).onChange as (event: unknown) => void)({ target: { value, checked: value } });
}
function labeledControl(label: string) {
  const normalized = (value: string) => value.replace(/\s+/g, ' ').trim();
  const element = nodes(editorForm().children).find(
    (node) =>
      node.type === 'label' &&
      normalized(text(node.props.children as ReactNode)) === normalized(label),
  );
  if (!element || typeof element.props.htmlFor !== 'string') throw Error('missing label ' + label);
  return control(element.props.htmlFor);
}
function changeLabeled(label: string, value: unknown) {
  (labeledControl(label).onChange as (event: unknown) => void)({
    target: { value, checked: value },
  });
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join('');
  if (React.isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
  return node === null || node === undefined || typeof node === 'boolean' ? '' : String(node);
}
function button(label: string) {
  const element = nodes(editorForm().children).find(
    (n) => n.type === 'button' && text(n.props.children as ReactNode) === label,
  );
  if (!element) throw Error('missing button ' + label);
  return element.props;
}
function click(label: string) {
  (button(label).onClick as () => void)();
}
function capture(form: FormProps) {
  const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
  form.onSubmitCapture?.(
    event as unknown as Parameters<NonNullable<FormProps['onSubmitCapture']>>[0],
  );
  return event;
}
function preview() {
  expect(hooks.previews).toHaveLength(1);
  return hooks.previews[0]!;
}
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('crypto', { randomUUID: hooks.randomUUID });
  hooks.values = [];
  hooks.refs = [];
  hooks.dependencies = [];
  hooks.effects = [];
  hooks.pending = [];
  hooks.save.mockReset();
  hooks.publish.mockReset();
  hooks.randomUUID.mockReset().mockReturnValue(uuid);
});
afterEach(() => vi.unstubAllGlobals());

describe('catalog authoring sections and save boundary', () => {
  it('keeps all four editable sections mounted with focusable navigation targets and description help', () => {
    const html = render();
    for (const id of [
      'catalog-basic-settings',
      'catalog-question-settings',
      'catalog-approval-settings',
      'catalog-save-review',
    ]) {
      expect(html).toContain('href="#' + id + '"');
      const heading = nodes(editorForm().children).find((n) => n.props.id === id);
      expect(heading?.type).toBe('h2');
      expect(heading?.props.tabIndex).toBe(-1);
    }
    for (const id of ['catalog-title', 'catalog-description', 'catalog-days', 'catalog-approver']) {
      expect(control(id).disabled).not.toBe(true);
    }
    expect(nodes(editorForm().children).filter((n) => n.props.hidden === true)).toHaveLength(0);
    expect(control('catalog-description')['aria-describedby']).toBe('catalog-description-help');
    expect(control('catalog-description').placeholder).toContain('業務用PC');
    expect(html).toContain('対象者、依頼できる内容、用意する情報、承認後の流れ');
  });

  it('retains complete save controls and all four field variants while preview stays outside the form', () => {
    const html = render();
    const editorMarkup = html
      .match(/<form\b[^>]*>[\s\S]*?<\/form>/g)
      ?.find((f) => f.includes('name="creationKey"'));
    expect(editorMarkup).toBeDefined();
    expect(editorMarkup).not.toContain('data-live-preview-probe');
    expect(html).toContain('data-live-preview-probe="true"');
    expect(html).toContain('id="catalog-live-preview"');
    expect(hidden('expectedVersion')).toBe(7);
    expect(hidden('code')).toBe(item.code);
    expect(fields()).toEqual(item.draft.definition.fields);
    for (const name of [
      'title',
      'description',
      'targetLabel',
      'allowedDurations',
      'maxReasonLength',
      'approverId',
    ])
      expect(named(name)).toHaveLength(1);
    const controls = nodes(editorForm().children);
    expect(controls.filter((n) => /^value:|^checkbox:/.test(String(n.props.name)))).toHaveLength(0);
    expect(controls.filter((n) => n.type === 'fieldset' && n.props.disabled)).toHaveLength(0);
  });

  it('keeps internal identifiers in details and hidden payload inputs rather than editable controls', () => {
    const html = render();
    for (const name of ['code', 'fields.0.key', 'fields.1.key', 'fields.2.key', 'fields.3.key']) {
      expect(named(name)).toHaveLength(1);
      expect(named(name)[0]!.props.type).toBe('hidden');
      expect(named(name)[0]!.props.onChange).toBeUndefined();
    }
    expect(html).toContain('管理コードを確認する');
    expect(html).toContain('<code>synthetic-catalog</code>');
    expect(html).toContain('項目1の保存キーを確認する');
    expect(hidden('fields.0.key')).toBe('team');
  });
});

describe('catalog creation intent and live values', () => {
  it('initializes one creation intent and unique service code, preserving both across templates and edits', () => {
    render(true);
    expect(hidden('creationKey')).toBe(uuid);
    expect(hidden('code')).toBe('service-' + uuid);
    change('catalog-template', 'local-pc-loan');
    render(true);
    click('選んだテンプレートを入力する');
    render(true);
    expect(control('catalog-title').value).toBe('PC貸与申請');
    expect(fields().length).toBeGreaterThan(0);
    expect(fields().at(-1)).toMatchObject({ key: 'simulation_confirm', section: 'delivery' });
    expect(hidden('creationKey')).toBe(uuid);
    expect(hidden('code')).toBe('service-' + uuid);
    change('catalog-title', '開発端末の貸与');
    render(true);
    click('汎用の合成例を入力する');
    render(true);
    expect(hidden('code')).toBe('service-' + uuid);
    expect(hooks.randomUUID).toHaveBeenCalledOnce();
  });

  it('passes unsaved raw configuration to the sibling preview while the saved preview remains unchanged', () => {
    render();
    change('catalog-title', '編集中のPC貸与');
    change('catalog-description', '利用者への新しい説明');
    change('catalog-days', '1, ');
    change('catalog-target', '編集中の対象');
    change('catalog-reason-limit', 120);
    change('catalog-approver', 'approver-b');
    change('field-label-0', '利用部署');
    const html = render();
    expect(preview()).toMatchObject({
      title: '編集中のPC貸与',
      description: '利用者への新しい説明',
      target: '編集中の対象',
      days: '1, ',
      maxReason: 120,
      approver: 'approver-b',
      approvers: item.approvers,
    });
    expect(preview().fields[0]).toMatchObject({ key: 'team', label: '利用部署', type: 'text' });
    const savedPreview = html.match(/<section id="preview"[\s\S]*?<\/section>/)?.[0];
    expect(savedPreview).toContain('<h3>保存済みサービス</h3>');
    expect(savedPreview).not.toContain('編集中のPC貸与');
    expect(html).toContain('未保存の入力があります');
    const publication = hooks.forms.find((f) => f !== editorForm())!;
    expect(capture(publication).preventDefault).toHaveBeenCalledOnce();
    expect(hooks.save).not.toHaveBeenCalled();
    expect(hooks.publish).not.toHaveBeenCalled();
  });

  it('reorders full field definitions without changing keys or losing options and required flags', () => {
    render();
    expect(button('項目1を上へ').disabled).toBe(true);
    expect(button('項目4を下へ').disabled).toBe(true);
    click('項目3を上へ');
    render();
    const original = item.draft.definition.fields!;
    expect(fields()).toEqual([original[0], original[2], original[1], original[3]]);
    expect(preview().fields).toEqual(fields());
    expect(hidden('fields.1.key')).toBe('purpose');
    change('field-label-1', '用途');
    render();
    click('項目2を下へ');
    render();
    expect(fields()).toEqual([
      original[0],
      original[1],
      { ...original[2], label: '用途' },
      original[3],
    ]);
    expect(hidden('code')).toBe(item.code);
    expect(hidden('fields.2.key')).toBe('purpose');
  });

  it.each([0, 1])('locks authoring and preview during pending action %i', (pendingAction) => {
    render();
    const original = fields();
    hooks.pending[pendingAction] = true;
    render();
    expect(preview().disabled).toBe(true);
    expect(
      nodes(editorForm().children).some((n) => n.type === 'fieldset' && n.props.disabled),
    ).toBe(true);
    expect(capture(editorForm()).preventDefault).toHaveBeenCalledOnce();
    change('catalog-title', '保存中の変更');
    click('項目2を上へ');
    click('申請項目を追加する');
    render();
    expect(control('catalog-title').value).toBe(item.draft.title);
    expect(fields()).toEqual(original);
    expect(hooks.save).not.toHaveBeenCalled();
    expect(hooks.publish).not.toHaveBeenCalled();
  });

  it('keeps saving unavailable without an eligible approver after generating the creation intent', () => {
    const html = render(true, { ...item, approvers: [] });
    expect(hidden('creationKey')).toBe(uuid);
    expect(html).toContain('有効な承認者がいません');
    expect(button('下書きを保存してプレビューする').disabled).toBe(true);
  });
});

describe('priority-two authoring metadata and compatibility', () => {
  it('loads all seven question types and current category, sections and conditional metadata without changing their keys', () => {
    render(false, expandedItem);
    expect(fields()).toEqual(expandedItem.draft.definition.fields);
    expect(new Set(fields().map((field) => field.type))).toEqual(
      new Set(['text', 'textarea', 'select', 'checkbox', 'date', 'number', 'multiselect']),
    );
    expect(labeledControl('業務カテゴリ').value).toBe('PC・機器');
    expect(JSON.parse(hidden('sections') as string)).toEqual(
      expandedItem.draft.definition.sections,
    );
    expect(preview()).toMatchObject({
      category: 'PC・機器',
      sections: expandedItem.draft.definition.sections,
      fields: expandedItem.draft.definition.fields,
    });
    expect(hidden('code')).toBe(item.code);
  });

  it('passes edited category, section copy and help text to the unsaved preview and preserves the saved definition', () => {
    render(false, expandedItem);
    changeLabeled('業務カテゴリ', '端末・貸与');
    render(false, expandedItem);
    changeLabeled('セクション名 1', '貸与と返却');
    render(false, expandedItem);
    changeLabeled('セクションの説明 1', '一時貸出の予定を入力してください。');
    render(false, expandedItem);
    changeLabeled('補足説明 5', '返却日は担当者との相談用です。');
    const html = render(false, expandedItem);
    const editedSections = JSON.parse(hidden('sections') as string);
    expect(editedSections[0]).toEqual({
      key: 'schedule',
      title: '貸与と返却',
      description: '一時貸出の予定を入力してください。',
    });
    expect(preview().category).toBe('端末・貸与');
    expect(preview().sections).toEqual(editedSections);
    expect(preview().fields[4]).toMatchObject({
      key: 'return_date',
      helpText: '返却日は担当者との相談用です。',
      visibleWhen: { field: 'purpose', equals: '検証' },
    });
    expect(expandedItem.draft.definition.category).toBe('PC・機器');
    expect(expandedItem.draft.definition.sections?.[0]?.title).toBe('利用する期間');
    expect(html).toContain('未保存の入力があります');
    const publication = hooks.forms.find((candidate) => candidate !== editorForm())!;
    expect(capture(publication).preventDefault).toHaveBeenCalledOnce();
  });

  it('reorders and renames fields without losing their conditional, section, date or numeric boundaries', () => {
    render(false, expandedItem);
    expect(button('項目5を上へ').disabled).toBe(true);
    click('項目7を上へ');
    render(false, expandedItem);
    expect(fields()[5]).toEqual(expandedItem.draft.definition.fields?.[6]);
    change('field-label-5', '相談した付属品');
    render(false, expandedItem);
    click('項目6を下へ');
    render(false, expandedItem);
    expect(fields()[6]).toEqual({
      ...expandedItem.draft.definition.fields?.[6],
      label: '相談した付属品',
    });
    expect(fields()[4]).toEqual(expandedItem.draft.definition.fields?.[4]);
    expect(fields()[5]).toEqual(expandedItem.draft.definition.fields?.[5]);
    expect(hidden('fields.6.key')).toBe('accessories');
    expect(preview().fields).toEqual(fields());
  });

  it('keeps a removed condition source as an invalid reference instead of silently making the dependent field unconditional', () => {
    render(false, expandedItem);
    click('項目3を下書きから外す');
    render(false, expandedItem);
    expect(fields().some((field) => field.key === 'purpose')).toBe(false);
    expect(fields().find((field) => field.key === 'return_date')?.visibleWhen).toEqual({
      field: 'purpose',
      equals: '検証',
    });
    expect(preview().fields).toEqual(fields());
  });

  it('shows an unusable condition source after its type changes and lets the operator explicitly clear it', () => {
    render(false, expandedItem);
    change('field-type-2', 'text');
    const html = render(false, expandedItem);
    expect(fields().find((field) => field.key === 'return_date')?.visibleWhen).toEqual({
      field: 'purpose',
      equals: '検証',
    });
    expect(control('field-condition-4').value).toBe('purpose');
    expect(html).toContain('利用できなくなった質問（条件を選び直してください）');
    change('field-condition-4', '');
    render(false, expandedItem);
    expect(fields().find((field) => field.key === 'return_date')).not.toHaveProperty('visibleWhen');
    expect(control('field-condition-4').value).toBe('');
    expect(preview().fields).toEqual(fields());
  });

  it.each([
    ['catalog-category', '端末貸与'],
    ['catalog-section-title-0', '返却の予定'],
    ['catalog-section-description-0', '新しい予定の説明'],
    ['field-help-4', '新しい返却日の補足'],
    ['field-section-4', 'equipment'],
    ['field-condition-4', 'confirm'],
    ['field-condition-value-4', '運用'],
    ['field-min-date-4', '2026-12-01'],
    ['field-max-date-4', '2027-11-30'],
    ['field-min-number-5', '-1'],
    ['field-max-number-5', '20'],
    ['field-options-6', 'マウス\nドック'],
  ])(
    'tracks %s in dirty state and clears the block when its displayed original value is restored',
    (id, value) => {
      render(false, expandedItem);
      const original = labeledControl('業務カテゴリ').value;
      const previous = control(id).value;
      change(id, value);
      const changed = render(false, expandedItem);
      expect(changed).toContain('未保存の入力があります');
      expect(
        capture(hooks.forms.find((candidate) => candidate !== editorForm())!).preventDefault,
      ).toHaveBeenCalledOnce();
      change(id, previous);
      if (id === 'field-condition-4') {
        render(false, expandedItem);
        change('field-condition-value-4', '検証');
      }
      expect(render(false, expandedItem)).not.toContain('未保存の入力があります');
      expect(labeledControl('業務カテゴリ').value).toBe(original);
    },
  );

  it('does not remain dirty after optional copy is entered and then cleared back to an absent value', () => {
    render(false, expandedItem);
    changeLabeled('補足説明 1', '入力後に取り消す補足');
    expect(render(false, expandedItem)).toContain('未保存の入力があります');
    changeLabeled('補足説明 1', '');
    expect(render(false, expandedItem)).not.toContain('未保存の入力があります');
    changeLabeled('セクションの説明 2', '入力後に取り消す説明');
    expect(render(false, expandedItem)).toContain('未保存の入力があります');
    changeLabeled('セクションの説明 2', '');
    expect(render(false, expandedItem)).not.toContain('未保存の入力があります');
  });

  it('keeps a legacy definition without inserting category, section or help metadata into saved fields', () => {
    render();
    expect(fields()).toEqual(item.draft.definition.fields);
    expect(labeledControl('業務カテゴリ').value).toBe('');
    expect(JSON.parse(hidden('sections') as string)).toEqual([]);
    expect(item.draft.definition).not.toHaveProperty('category');
    expect(item.draft.definition).not.toHaveProperty('sections');
    expect(render()).not.toContain('未保存の入力があります');
  });

  it.each([0, 1])(
    'holds category, section and field metadata unchanged during pending action %i',
    (action) => {
      render(false, expandedItem);
      hooks.pending[action] = true;
      render(false, expandedItem);
      changeLabeled('業務カテゴリ', '保存中のカテゴリ');
      changeLabeled('セクション名 1', '保存中のセクション');
      changeLabeled('補足説明 5', '保存中の補足');
      click('セクションを追加する');
      render(false, expandedItem);
      expect(labeledControl('業務カテゴリ').value).toBe('PC・機器');
      expect(JSON.parse(hidden('sections') as string)).toEqual(
        expandedItem.draft.definition.sections,
      );
      expect(fields()).toEqual(expandedItem.draft.definition.fields);
      expect(preview().disabled).toBe(true);
      expect(capture(editorForm()).preventDefault).toHaveBeenCalledOnce();
    },
  );
});
