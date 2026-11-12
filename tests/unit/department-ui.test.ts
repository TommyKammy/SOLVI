// WP-P4-IDM-013 段階B: 部署管理画面の条件・選択肢・表示。
import React, { type AnchorHTMLAttributes, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, requireSession, type DepartmentNode } from '../../apps/web/src/lib/api';
import {
  departmentHref,
  departmentNoticeText,
  flattenDepartmentTree,
  parentOptions,
  parseDepartmentQuery,
  type DepartmentQuery,
} from '../../apps/web/src/app/ops/departments/department-ui';

vi.mock('../../apps/web/src/lib/api', () => ({
  api: {
    listDepartments: vi.fn(),
    departmentMembers: vi.fn(),
    departmentHead: vi.fn(),
    listMembers: vi.fn(),
    me: vi.fn(),
  },
  requireSession: vi.fn(),
}));
vi.mock('../../apps/web/src/app/ops/departments/actions', () => ({
  createDepartmentAction: vi.fn(),
  editDepartmentAction: vi.fn(),
  deactivateDepartmentAction: vi.fn(),
  assignHeadAction: vi.fn(),
  endHeadAction: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (href: string) => {
    throw new Error('REDIRECT:' + href);
  },
}));
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => React.createElement('a', props),
}));

const { default: ManageDepartments } = await vi.importActual<{
  default: (props: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }) => Promise<ReactNode>;
}>('../../apps/web/src/app/ops/departments/page');

const root: DepartmentNode = {
  id: '20000000-0000-4000-8000-000000000001',
  code: 'ROOT',
  name: '合成ルート部署',
  parentId: null,
  active: true,
  depth: 1,
  children: [],
};
const child: DepartmentNode = {
  id: '20000000-0000-4000-8000-000000000002',
  code: 'CHILD',
  name: '合成子部署',
  parentId: root.id,
  active: true,
  depth: 2,
  children: [],
};
const inactive: DepartmentNode = {
  id: '20000000-0000-4000-8000-000000000003',
  code: 'GONE',
  name: '合成無効部署',
  parentId: null,
  active: false,
  depth: 1,
  children: [],
};
root.children = [child];
const tree = [root, inactive];

const agent = {
  userId: '30000000-0000-4000-8000-000000000001',
  displayName: '合成 担当者',
  email: 'agent@example.test',
  status: 'active' as const,
  deactivatedAt: null,
  roleCodes: ['agent'],
  temporaryRoles: [],
  openTicketCount: 0,
  primaryDepartmentId: child.id,
  primaryDepartmentName: child.name,
  managerUserId: null,
  managerDisplayName: null,
  jobTitle: '合成役職',
  activeMembership: true,
};
const manager = {
  ...agent,
  userId: '30000000-0000-4000-8000-000000000002',
  displayName: '合成 上長',
  email: 'manager@example.test',
  primaryDepartmentId: null,
  primaryDepartmentName: null,
};
const head = {
  id: '40000000-0000-4000-8000-000000000001',
  departmentId: child.id,
  userId: agent.userId,
  displayName: agent.displayName,
  validFrom: '2026-11-13T00:00:00.000Z',
  validUntil: null,
};

const hrefs = (html: string) =>
  [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]!.replaceAll('&amp;', '&'));
const ids = (html: string) => [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]!);

function makeQuery(overrides: Partial<DepartmentQuery> = {}): DepartmentQuery {
  return { department: '', confirm: null, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('React', React);
  vi.mocked(requireSession).mockResolvedValue({
    userId: '50000000-0000-4000-8000-000000000001',
    organizationId: '60000000-0000-4000-8000-000000000001',
    roles: [{ roleCode: 'org_admin', organizationId: '60000000-0000-4000-8000-000000000001' }],
  });
  vi.mocked(api.listDepartments).mockResolvedValue({ ok: true, data: { items: tree } });
  vi.mocked(api.departmentMembers).mockResolvedValue({ ok: true, data: { items: [agent] } });
  vi.mocked(api.departmentHead).mockResolvedValue({ ok: true, data: { head } });
  vi.mocked(api.listMembers).mockResolvedValue({
    ok: true,
    data: {
      items: [agent, manager],
      profileCompleteness: {
        totalMembers: 2,
        missingManager: 1,
        missingDepartment: 1,
        totalDepartments: 2,
        missingDepartmentHead: 1,
      },
    },
  });
});

describe('部署管理画面の条件とURL', () => {
  it('選択中の部署と確認状態だけを受け付け、不正値は捨てる', () => {
    expect(
      parseDepartmentQuery({ department: root.id.toUpperCase(), confirm: 'deactivate' }),
    ).toEqual({ department: root.id, confirm: 'deactivate' });
    expect(parseDepartmentQuery({ department: 'javascript:alert(1)', confirm: 'delete' })).toEqual({
      department: '',
      confirm: null,
    });
    expect(parseDepartmentQuery({ department: [root.id] })).toEqual({
      department: '',
      confirm: null,
    });
  });

  it('部署を変えると確認を解除し、同じ部署では保持する', () => {
    const query = makeQuery({ department: root.id, confirm: 'deactivate' });
    expect(departmentHref(query)).toContain('confirm=deactivate');
    expect(departmentHref(query, { department: child.id })).not.toContain('confirm');
    expect(departmentHref(query, { department: root.id })).toContain('confirm=deactivate');
    expect(departmentHref(query, { confirm: null })).not.toContain('confirm');
  });

  it('通知とエラーは既知の値だけをURLへ載せる', () => {
    const href = departmentHref(makeQuery(), {
      notice: 'head-assigned',
      error: '  子部署が残っているため無効化できません。  ',
    });
    const url = new URL(href, 'https://solvi.test');
    expect(url.searchParams.get('notice')).toBe('head-assigned');
    expect(url.searchParams.get('error')).toBe('子部署が残っているため無効化できません。');
    expect(departmentHref(makeQuery(), { notice: 'oops' as never })).toBe('/ops/departments');
    expect(departmentNoticeText('oops')).toBeNull();
  });
});

describe('部署ツリーと親部署の選択肢', () => {
  it('親→子の順に深さ付きで並べ、無効部署も残す', () => {
    const options = flattenDepartmentTree(tree);
    expect(options.map((option) => [option.code, option.depth])).toEqual([
      ['ROOT', 1],
      ['CHILD', 2],
      ['GONE', 1],
    ]);
    expect(options[1]!.label).toBe('　合成子部署（CHILD）');
    expect(options[2]!.active).toBe(false);
  });

  it('自分自身・子孫・無効部署を理由付きで選べなくする', () => {
    const options = parentOptions(tree, root.id);
    expect(options.find((option) => option.id === root.id)?.disabledReason).toBe(
      '自分自身を親部署に指定できません',
    );
    expect(options.find((option) => option.id === child.id)?.disabledReason).toBe(
      '自分の配下の部署は親に指定できません(循環)',
    );
    expect(options.find((option) => option.id === inactive.id)?.disabledReason).toBe(
      '無効化された部署は親に指定できません',
    );
    expect(
      parentOptions(tree).every(
        (option) => option.active === false || option.disabledReason === null,
      ),
    ).toBe(true);
  });
});

describe('部署管理画面の表示', () => {
  const render = async (values: Record<string, string | string[] | undefined> = {}) =>
    renderToStaticMarkup(await ManageDepartments({ searchParams: Promise.resolve(values) }));

  it('ツリー・追加・選択中のメンバーと部署長を表示する', async () => {
    const html = await render({ department: child.id });
    expect(html).toContain('部署のツリー');
    expect(html).toContain('子部署 1 件');
    expect(html).toContain('合成子部署');
    expect(html).toContain('この部署のメンバー');
    expect(html).toContain('合成 担当者');
    expect(html).toContain('現在の部署長');
    expect(html).toContain('部署長を終了する');
    expect(html).toContain('この部署を無効化する');
    expect(hrefs(html)).toContain('/ops/users');
    expect(new Set(ids(html)).size).toBe(ids(html).length);
  });

  it('無効化の前に確認画面を挟み、理由を表示する', async () => {
    const confirm = await render({ department: child.id, confirm: 'deactivate' });
    expect(confirm).toContain('部署を無効化しますか');
    expect(confirm).toContain('この操作は取り消せません');
    expect(confirm).toContain('無効化する');
    expect(confirm).toContain('やめる');
    const rejected = await render({
      department: child.id,
      error:
        '子部署が残っているため無効化できません。先に子部署を無効化するか、親から外してください。',
    });
    expect(rejected).toContain('role="alert"');
    expect(rejected).toContain('子部署が残っているため無効化できません');
  });

  it('部署長がいなければ設定フォームを出し、無効部署には出さない', async () => {
    vi.mocked(api.departmentHead).mockResolvedValue({ ok: true, data: { head: null } });
    const active = await render({ department: child.id });
    expect(active).toContain('部署長に設定する');
    expect(active).toContain('現在の部署長はいません');
    const inactiveHtml = await render({ department: inactive.id });
    expect(inactiveHtml).toContain('この部署は無効化されています');
    expect(inactiveHtml).not.toContain('部署長に設定する');
  });

  it('org_admin 以外には画面もデータ取得も出さない', async () => {
    vi.mocked(requireSession).mockResolvedValue({
      userId: '50000000-0000-4000-8000-000000000002',
      organizationId: '60000000-0000-4000-8000-000000000001',
      roles: [{ roleCode: 'agent', organizationId: '60000000-0000-4000-8000-000000000001' }],
    });
    const html = await render();
    expect(html).toContain('この画面を表示する権限がありません');
    expect(api.listDepartments).not.toHaveBeenCalled();
    expect(api.departmentMembers).not.toHaveBeenCalled();
  });
});
