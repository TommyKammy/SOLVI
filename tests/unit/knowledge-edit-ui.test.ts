// FR-KNW-001, FR-KNW-002, NFR-UX-002, NFR-UX-003, NFR-UX-004.
// Controlled hook probes exercise real management JSX; the isolated Next run exercises dispatch.
import React, { type ReactNode, type FormHTMLAttributes } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KnowledgeArticle } from '../../apps/web/src/lib/api';
import type { FormFeedback } from '../../apps/web/src/lib/form-state';

type FormProps = FormHTMLAttributes<HTMLFormElement> & { feedback: FormFeedback; pending: boolean };
const hooks = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  actionCursor: 0,
  feedback: [] as FormFeedback[],
  pending: [] as boolean[],
  forms: [] as FormProps[],
  dispatch: vi.fn(),
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [
      hooks.values[index],
      (value: unknown) => {
        hooks.values[index] = value;
      },
    ];
  },
  useActionState: (_action: unknown, initial: FormFeedback) => {
    const index = hooks.actionCursor++;
    return [hooks.feedback[index] ?? initial, hooks.dispatch, hooks.pending[index] ?? false];
  },
}));
vi.mock('../../apps/web/src/app/knowledge/actions', () => ({
  saveArticle: vi.fn(),
  changeArticle: vi.fn(),
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
import {
  KnowledgeEditor,
  KnowledgeManagement,
} from '../../apps/web/src/components/KnowledgeEditor';

const article: KnowledgeArticle = {
  id: '08300000-0000-4000-8000-000000000001',
  version: 9,
  contentVersion: 7,
  publishedVersion: 2,
  state: 'draft',
  title: '合成記事',
  body: '本文',
  tags: 'Ａ, a',
  audience: 'organization',
  versionCreatedAt: '2026-10-10T01:00:00.000Z',
};
const versions = [7, 2].map((number) => ({
  number,
  title: '同じタイトル',
  createdAt: `2026-10-${number === 7 ? '10' : '09'}T01:00:00.000Z`,
}));
function render(current = article, canPublish = true, standalone = false) {
  hooks.cursor = 0;
  hooks.actionCursor = 0;
  hooks.forms = [];
  return renderToStaticMarkup(
    React.createElement(
      standalone ? KnowledgeEditor : KnowledgeManagement,
      standalone ? {} : { article: current, canPublish, versions },
    ),
  );
}
type Control = {
  name?: string;
  value?: unknown;
  disabled?: boolean;
  onChange?: (event: { target: { value: string } }) => void;
  children?: ReactNode;
};
function controls(node: ReactNode): Control[] {
  if (Array.isArray(node)) return node.flatMap(controls);
  if (!React.isValidElement<Control>(node)) return [];
  return [node.props, ...controls(node.props.children)];
}
function control(name: string, form = 0) {
  const found = controls(hooks.forms[form]?.children).find((p) => p.name === name);
  if (!found) throw new Error('TEST_CONTROL_MISSING');
  return found;
}
function change(name: string, value: string) {
  const callback = control(name).onChange;
  expect(callback).toBeTypeOf('function');
  callback!({ target: { value } });
}
function blocked(form: number) {
  const event = {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    currentTarget: { querySelector: () => null, ownerDocument: { activeElement: null } },
  };
  hooks.forms[form]?.onSubmitCapture?.(event as unknown as React.FormEvent<HTMLFormElement>);
  expect(event.stopPropagation.mock.calls.length).toBe(event.preventDefault.mock.calls.length);
  return event.preventDefault.mock.calls.length > 0;
}
beforeEach(() => {
  vi.stubGlobal('React', React);
  hooks.values = [];
  hooks.feedback = [];
  hooks.pending = [];
  hooks.forms = [];
  hooks.dispatch.mockClear();
});
afterEach(() => vi.unstubAllGlobals());
describe('knowledge management exact editing boundary', () => {
  it('blocks implicit submission from the restore selector while preserving explicit button activation', () => {
    render();
    const selector = {},
      review = {},
      restore = {};
    for (const [activeElement, expectedBlocked] of [
      [selector, true],
      [review, false],
      [restore, false],
    ] as const) {
      const event = {
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        currentTarget: { querySelector: () => selector, ownerDocument: { activeElement } },
      };
      hooks.forms[1]!.onSubmitCapture?.(event as unknown as React.FormEvent<HTMLFormElement>);
      expect(event.preventDefault).toHaveBeenCalledTimes(expectedBlocked ? 1 : 0);
      expect(event.stopPropagation).toHaveBeenCalledTimes(expectedBlocked ? 1 : 0);
    }
  });
  it('uses textarea line endings for saved CRLF and CR then detects exact edit and revert', () => {
    const stored = { ...article, body: '一行\r\n二行\r三行' };
    expect(render(stored)).toContain('保存済みの内容と一致');
    expect(control('body').value).toBe('一行\n二行\n三行');
    change('body', '一行\n二行\n三行 ');
    expect(render(stored)).toContain('未保存の変更');
    expect(blocked(1)).toBe(true);
    change('body', '一行\n二行\n三行');
    expect(render(stored)).toContain('保存済みの内容と一致');
    expect(blocked(1)).toBe(false);
    expect(stored.body).toBe('一行\r\n二行\r三行');
  });
  it.each([
    ['title', '合成記事 '],
    ['body', '本文\n'],
    ['tags', 'A, a'],
    ['audience', 'staff'],
    ['title', ''],
    ['body', '本文\r\n'],
    ['tags', 'Ａ, A'],
  ])('blocks lifecycle for exact %s change and releases after full restoration', (name, value) => {
    expect(render()).toContain('保存済みの内容と一致');
    change(name!, value!);
    expect(render()).toContain('未保存の変更');
    expect(blocked(1)).toBe(true);
    expect(control('action', 1).disabled).toBe(true);
    expect(control('restoreVersion', 1).disabled).toBe(true);
    expect(blocked(0)).toBe(false);
    change(name!, article[name as 'title' | 'body' | 'tags' | 'audience']);
    expect(render()).toContain('保存済みの内容と一致');
    expect(blocked(1)).toBe(false);
    expect(hooks.dispatch).not.toHaveBeenCalled();
  });
  it('requires all four fields to return to their saved values', () => {
    render();
    change('title', '変更');
    render();
    change('audience', 'staff');
    render();
    change('title', article.title);
    expect(render()).toContain('未保存の変更');
    change('audience', article.audience);
    expect(render()).toContain('保存済みの内容と一致');
  });
  it.each([400, 409, 503])(
    'keeps all four edits on save failure %s without adopting feedback as saved',
    (status) => {
      render();
      for (const [name, value] of Object.entries({
        title: '変更記事',
        body: '変更本文',
        tags: '変更タグ',
        audience: 'staff',
      })) {
        change(name, value);
        render();
      }
      hooks.feedback[0] = {
        message: String(status),
        attempt: 1,
        values: { title: '別値', body: '別値', tags: '', audience: 'organization' },
      };
      expect(render()).toContain('未保存の変更');
      expect(['title', 'body', 'tags', 'audience'].map((name) => control(name).value)).toEqual([
        '変更記事',
        '変更本文',
        '変更タグ',
        'staff',
      ]);
      expect(blocked(0)).toBe(false);
      expect(blocked(1)).toBe(true);
    },
  );
  it.each([0, 1])(
    'blocks both forms and input changes during pending action %s, releases after failure',
    (index) => {
      hooks.pending[index] = true;
      render();
      expect(['title', 'body', 'tags', 'audience'].every((name) => control(name).disabled)).toBe(
        true,
      );
      expect(blocked(0)).toBe(true);
      expect(blocked(1)).toBe(true);
      hooks.pending[index] = false;
      hooks.feedback[index] = { message: '再試行してください', attempt: 1 };
      render();
      expect(blocked(0)).toBe(false);
      expect(blocked(1)).toBe(false);
    },
  );
  it('uses stored content version for context, concurrency version only in hidden fields and original restore values/order', () => {
    const html = render();
    expect(html).toContain('操作対象: 保存済みの版 7');
    expect(hooks.forms.map((_, index) => control('expectedVersion', index).value)).toEqual([9, 9]);
    expect(
      controls(hooks.forms[1]?.children)
        .filter((p) => p.value === 7 || p.value === 2)
        .map((p) => p.value),
    ).toEqual([7, 2]);
    expect(html).toContain('2026年10月10日 10:00');
    expect(html).toContain('2026年10月9日 10:00');
  });
  it.each(['draft', 'review', 'published', 'retired'] as const)(
    'retains existing %s editor and role action visibility',
    (state) => {
      for (const canPublish of [false, true]) {
        const html = render({ ...article, state }, canPublish);
        expect(html.includes('name="title"')).toBe(state === 'draft' || state === 'published');
        expect(html.includes('value="review"')).toBe(state === 'draft');
        expect(html.includes('value="publish"')).toBe(state === 'review' && canPublish);
        expect(html.includes('value="retire"')).toBe(state !== 'retired' && canPublish);
        expect(html).toContain('value="restore"');
      }
    },
  );
  it('rebases only on the parent keyed remount with the successful new DTO', () => {
    render();
    change('title', '保存した記事');
    expect(render()).toContain('未保存の変更');
    hooks.values = [];
    expect(render({ ...article, title: '保存した記事', version: 10, contentVersion: 8 })).toContain(
      '操作対象: 保存済みの版 8',
    );
    expect(control('expectedVersion').value).toBe(10);
    expect(blocked(1)).toBe(false);
  });
  it('preserves standalone new editor and controlled audience after an unsuccessful save', () => {
    render(article, false, true);
    expect(control('expectedVersion').value).toBe(1);
    change('audience', 'staff');
    hooks.feedback[0] = { message: '入力を確認してください', attempt: 1 };
    render(article, false, true);
    expect(control('audience').value).toBe('staff');
    expect(hooks.forms).toHaveLength(1);
    expect(blocked(0)).toBe(false);
  });
});
