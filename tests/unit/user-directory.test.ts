import { describe, expect, it } from 'vitest';
import {
  DIRECTORY_ROLES,
  directoryHref,
  managerFieldReasons,
  managerOptions,
  parseDirectoryQuery,
  selectDirectoryMembers,
  type DirectoryHrefOverrides,
  type DirectoryMember,
} from '../../apps/web/src/lib/user-directory';
import {
  buildDepartmentTree,
  type DepartmentTreeRow,
} from '../../services/api/src/modules/auth/department.service';
import {
  parseMemberFilters,
  readProfileUpdate,
} from '../../services/api/src/modules/auth/user-admin.routes';

function member(index: number, overrides: Partial<DirectoryMember> = {}): DirectoryMember {
  return {
    userId: `00000000-0000-4000-9000-${String(index).padStart(12, '0')}`,
    displayName: `利用者${String(index).padStart(3, '0')}`,
    email: `person${index}@example.test`,
    status: 'active',
    deactivatedAt: null,
    roleCodes: ['requester'],
    temporaryRoles: [],
    openTicketCount: 0,
    primaryDepartmentId: null,
    primaryDepartmentName: null,
    managerUserId: null,
    managerDisplayName: null,
    jobTitle: null,
    ...overrides,
  };
}

const defaultQuery = parseDirectoryQuery({});

describe('利用者ディレクトリの条件', () => {
  it('検索欄の原文を保ち、既知の役割と状態だけを受け付ける', () => {
    expect(
      parseDirectoryQuery({
        q: '  ＡＫＩ 山田  ',
        role: 'agent',
        status: 'deactivated',
        page: '2',
      }),
    ).toEqual({
      q: 'ＡＫＩ 山田',
      role: 'agent',
      status: 'deactivated',
      department: 'all',
      manager: 'all',
      jobTitle: '',
      page: 2,
    });
    expect(parseDirectoryQuery({ role: 'owner', status: 'deleted' })).toEqual(defaultQuery);
    expect(parseDirectoryQuery({ role: 'platform_auditor' }).role).toBe('platform_auditor');
    expect(DIRECTORY_ROLES).not.toContain('platform_auditor');
    expect(DIRECTORY_ROLES).not.toContain('platform_admin');
  });

  it.each(['0', '-1', '1.5', 'Infinity', 'NaN', '1e3', '2x', '9007199254740992', ''])(
    '不正なページ %s は1ページ目になる',
    (page) => {
      expect(parseDirectoryQuery({ page }).page).toBe(1);
    },
  );

  it('重複したURLパラメーターを採用せず、検索長を制限する', () => {
    expect(
      parseDirectoryQuery({
        q: ['山田', '鈴木'],
        role: ['agent'],
        status: ['active'],
        page: ['2'],
      }),
    ).toEqual(defaultQuery);
    expect(parseDirectoryQuery({ q: 'あ'.repeat(201) }).q).toHaveLength(200);
  });
});

describe('利用者ディレクトリの検索とページ', () => {
  it('61人を安定した名前順で25/25/11人に分け、入力配列を変更しない', () => {
    const members = Object.freeze(Array.from({ length: 61 }, (_, index) => member(61 - index)));
    const original = structuredClone(members);
    const pages = [1, 2, 3].map((page) =>
      selectDirectoryMembers(members, { ...defaultQuery, page }),
    );
    expect(pages.map((page) => page.items.length)).toEqual([25, 25, 11]);
    expect(pages.map(({ from, to }) => [from, to])).toEqual([
      [1, 25],
      [26, 50],
      [51, 61],
    ]);
    expect(
      pages.every((page) => page.total === 61 && page.filtered === 61 && page.pageCount === 3),
    ).toBe(true);
    expect(pages.flatMap((page) => page.items.map((person) => person.userId))).toEqual(
      Array.from({ length: 61 }, (_, index) => member(index + 1).userId),
    );
    expect(members).toEqual(original);
  });

  it('0人と検索結果0人を区別でき、範囲外ページを最終ページに収める', () => {
    expect(selectDirectoryMembers([], { ...defaultQuery, page: 100 })).toEqual({
      items: [],
      total: 0,
      filtered: 0,
      page: 1,
      pageCount: 1,
      from: 0,
      to: 0,
    });
    expect(
      selectDirectoryMembers([member(1)], { ...defaultQuery, q: '該当なし', page: 3 }),
    ).toMatchObject({ total: 1, filtered: 0, page: 1, from: 0, to: 0 });
    const members = Array.from({ length: 61 }, (_, index) => member(index + 1));
    expect(
      selectDirectoryMembers(members, { ...defaultQuery, page: Number.MAX_SAFE_INTEGER }),
    ).toMatchObject({ page: 3, from: 51, to: 61 });
  });

  it('名前とメールのUnicode互換文字・大小文字を同じ検索語として扱う', () => {
    const members = [
      member(1, { displayName: 'Ａｋｉ 山田', email: 'ＡＫＩ＠ＥＸＡＭＰＬＥ．ＴＥＳＴ' }),
      member(2, { displayName: '鈴木', email: 'suzuki@example.test' }),
    ];
    for (const q of ['aki', 'ＡＫＩ', '山田', 'aki@example.test']) {
      expect(
        selectDirectoryMembers(members, { ...defaultQuery, q }).items.map((p) => p.userId),
      ).toEqual([member(1).userId]);
    }
  });

  it('複数役割の人は各役割の一覧に現れ、状態と検索の条件は同時に効く', () => {
    const members = [
      member(1, { displayName: '山田 一郎', roleCodes: ['agent', 'requester'] }),
      member(2, { displayName: '山田 二郎', roleCodes: ['agent'], status: 'deactivated' }),
      member(3, { displayName: '山田 三郎' }),
    ];
    expect(selectDirectoryMembers(members, { ...defaultQuery, role: 'agent' }).filtered).toBe(2);
    expect(selectDirectoryMembers(members, { ...defaultQuery, role: 'requester' }).filtered).toBe(
      2,
    );
    expect(
      selectDirectoryMembers(members, {
        ...defaultQuery,
        q: '山田',
        role: 'agent',
        status: 'active',
      }).items.map((p) => p.userId),
    ).toEqual([member(1).userId]);
    expect(
      selectDirectoryMembers(members, {
        ...defaultQuery,
        role: 'agent',
        status: 'deactivated',
      }).items.map((p) => p.userId),
    ).toEqual([member(2).userId]);
  });

  it('同姓同名はuserIdで順序が固定され、サーバーの期限情報を変えない', () => {
    const temporaryRoles = [
      {
        roleCode: 'agent',
        validUntil: '2026-10-05T00:00:00.000Z',
        daysRemaining: 1,
        expiringSoon: true,
      },
    ];
    const members = [
      member(2, { displayName: '山田 太郎', temporaryRoles }),
      member(1, { displayName: '山田 太郎' }),
    ];
    const result = selectDirectoryMembers(members, defaultQuery);
    expect(result.items.map((p) => p.userId)).toEqual([member(1).userId, member(2).userId]);
    expect(result.items[1]?.temporaryRoles).toBe(temporaryRoles);
  });
});

describe('部署・上長・役職の絞り込みと上長候補 (WP-P4-IDM-013 §6)', () => {
  const dept = '10000000-0000-4000-8000-000000000001';
  const other = '10000000-0000-4000-8000-000000000002';
  const members = [
    member(1, {
      displayName: '山田 一郎',
      primaryDepartmentId: dept,
      primaryDepartmentName: '合成部署',
      managerUserId: null,
      jobTitle: '課長',
    }),
    member(2, {
      displayName: '山田 二郎',
      primaryDepartmentId: dept,
      managerUserId: member(1).userId,
      jobTitle: '担当',
    }),
    member(3, { displayName: '鈴木', primaryDepartmentId: other, jobTitle: '部長' }),
    member(4, { displayName: '佐藤', status: 'deactivated' }),
  ];

  it('部署・上長・役職で絞り込み、未設定も選べる', () => {
    const byDepartment = selectDirectoryMembers(members, {
      ...defaultQuery,
      department: dept,
    });
    expect(byDepartment.items.map((person) => person.displayName)).toEqual([
      '山田 一郎',
      '山田 二郎',
    ]);
    expect(
      selectDirectoryMembers(members, { ...defaultQuery, manager: member(1).userId }).items.map(
        (person) => person.displayName,
      ),
    ).toEqual(['山田 二郎']);
    expect(
      selectDirectoryMembers(members, { ...defaultQuery, manager: 'unset' }).items.map(
        (person) => person.displayName,
      ),
    ).toEqual(['佐藤', '山田 一郎', '鈴木']);
    expect(
      selectDirectoryMembers(members, { ...defaultQuery, department: 'unset' }).items.map(
        (person) => person.displayName,
      ),
    ).toEqual(['佐藤']);
    expect(
      selectDirectoryMembers(members, { ...defaultQuery, jobTitle: '部長' }).items.map(
        (person) => person.displayName,
      ),
    ).toEqual(['鈴木']);
  });

  it('不正なIDは条件に採用せず、検索語の長さを制限する', () => {
    expect(parseDirectoryQuery({ department: 'javascript:alert(1)' }).department).toBe('all');
    expect(parseDirectoryQuery({ manager: ['x'] }).manager).toBe('all');
    expect(parseDirectoryQuery({ jobTitle: 'あ'.repeat(201) }).jobTitle).toHaveLength(200);
  });

  it('上長候補から本人・停止者を外し、循環になる候補は理由付きで残す', () => {
    const options = managerOptions(members, members[0]!);
    expect(options.map((option) => option.userId)).not.toContain(members[0]!.userId);
    expect(options.find((option) => option.userId === members[3]!.userId)?.disabledReason).toBe(
      '停止中のため上長に選べません',
    );
    expect(options.find((option) => option.userId === members[1]!.userId)?.disabledReason).toBe(
      '選ぶと上長の関係が循環するため選べません',
    );
    expect(
      options.find((option) => option.userId === members[2]!.userId)?.disabledReason,
    ).toBeNull();
  });

  it('本人と組織管理者の上長欄を無効にする理由を返す', () => {
    expect(managerFieldReasons(members[0]!, false)).toEqual([]);
    expect(managerFieldReasons(members[0]!, true)).toEqual([
      '自分自身の上長は自分では変更できません。別の組織管理者に設定を依頼してください。',
    ]);
    expect(managerFieldReasons(member(5, { roleCodes: ['org_admin'] }), false)).toEqual([
      '組織管理者の上長は設定できません。上長を設定するには、先に組織管理者の役割を取り消してください。',
    ]);
    expect(managerFieldReasons(member(5, { roleCodes: ['org_admin'] }), true)).toHaveLength(2);
  });
});

describe('利用者ディレクトリの内部URL', () => {
  it('再読込用の条件とページを保持し、フィルター変更では1ページ目へ戻す', () => {
    const query = parseDirectoryQuery({ q: '山田', role: 'agent', status: 'active', page: '3' });
    const href = directoryHref(query);
    const restored = parseDirectoryQuery(
      Object.fromEntries(new URL(href, 'https://solvi.test').searchParams),
    );
    expect(restored).toEqual(query);
    for (const overrides of [
      { q: '鈴木' },
      { role: 'requester' },
      { status: 'deactivated' as const },
      { department: 'unset' as const },
      { manager: 'unset' as const },
      { jobTitle: '部長' },
    ]) {
      expect(
        new URL(directoryHref(query, overrides), 'https://solvi.test').searchParams.has('page'),
      ).toBe(false);
    }
    expect(directoryHref(defaultQuery)).toBe('/ops/users');
    expect(directoryHref(query, { page: 2 })).toContain('page=2');
  });

  it('選択・作成・成功通知を固定キーとして出し、未知キーと不正値を捨てる', () => {
    const selected = member(1).userId;
    const url = new URL(
      directoryHref(defaultQuery, {
        selected,
        create: 'agent',
        notice: 'stopped',
        count: 3,
      }),
      'https://solvi.test',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      selected,
      create: 'agent',
      notice: 'stopped',
      count: '3',
    });
    expect(
      directoryHref(defaultQuery, {
        selected: 'javascript:alert(1)',
        create: 'platform_admin',
        notice: 'oops',
        count: -1,
        returnTo: 'https://attacker.example',
      } as unknown as DirectoryHrefOverrides),
    ).toBe('/ops/users');
    expect(directoryHref(defaultQuery, { count: Number.NaN })).toBe('/ops/users');
    expect(directoryHref(defaultQuery, { selected: null, create: null, notice: null })).toBe(
      '/ops/users',
    );
  });

  it('検索語内のURLや特殊文字は値として符号化し、遷移先や別条件にしない', () => {
    const q = '//attacker.example/?role=platform_admin&selected=bad#fragment';
    const url = new URL(directoryHref({ ...defaultQuery, q }), 'https://solvi.test');
    expect(url.origin).toBe('https://solvi.test');
    expect(url.pathname).toBe('/ops/users');
    expect(url.hash).toBe('');
    expect([...url.searchParams]).toEqual([['q', q]]);
  });
});

describe('部署ツリーと利用者一覧の条件 (WP-P4-IDM-013 API)', () => {
  function department(id: string, code: string, parentId: string | null): DepartmentTreeRow {
    return { id, code, name: `部署${code}`, parentId, active: true };
  }

  it('親子を木に組み立て、深さを付け、同じ階層をコード順に並べる', () => {
    const tree = buildDepartmentTree([
      department('3', 'c', '2'),
      department('2', 'b', '1'),
      department('1', 'a', null),
      department('4', 'd', null),
    ]);
    expect(tree.map((node) => node.code)).toEqual(['a', 'd']);
    expect(tree[0]!.depth).toBe(1);
    expect(tree[0]!.children.map((node) => node.code)).toEqual(['b']);
    expect(tree[0]!.children[0]!.depth).toBe(2);
    expect(tree[0]!.children[0]!.children[0]!.depth).toBe(3);
    expect(tree[0]!.children[0]!.children[0]!.id).toBe('3');
  });

  it('壊れたデータ(親が循環)でも無限ループせず全件を返す', () => {
    const tree = buildDepartmentTree([
      department('1', 'a', '2'),
      department('2', 'b', '1'),
      department('3', 'c', null),
    ]);
    const collect = (nodes: ReturnType<typeof buildDepartmentTree>): string[] =>
      nodes.flatMap((node) => [node.id, ...collect(node.children)]);
    expect(collect(tree).sort()).toEqual(['1', '2', '3']);
  });

  it('利用者一覧の条件は既知の項目だけを受け付け、IDの形式と長さを検査する', () => {
    const departmentId = '00000000-0000-4000-9000-000000000001';
    const managerUserId = '00000000-0000-4000-9000-000000000002';
    expect(
      parseMemberFilters({
        departmentId,
        managerUserId,
        jobTitle: '  合成役職  ',
      }),
    ).toEqual({ departmentId, managerUserId, jobTitle: '合成役職' });
    expect(parseMemberFilters({})).toEqual({
      departmentId: null,
      managerUserId: null,
      jobTitle: null,
    });
    expect(() => parseMemberFilters({ organization_id: departmentId })).toThrow();
    expect(() => parseMemberFilters({ departmentId: 'not-a-uuid' })).toThrow();
    expect(() => parseMemberFilters({ departmentId: [departmentId, managerUserId] })).toThrow();
    expect(() => parseMemberFilters({ jobTitle: 'あ'.repeat(201) })).toThrow();
  });

  it('プロフィール更新は指定できる項目だけを受け付け、未知の項目を拒否する', () => {
    const id = '00000000-0000-4000-9000-000000000001';
    expect(
      readProfileUpdate({
        primaryDepartmentId: null,
        managerUserId: id,
        jobTitle: '  役職  ',
        location: '',
        employeeId: null,
      }),
    ).toEqual({
      primaryDepartmentId: null,
      managerUserId: id,
      jobTitle: '  役職  ',
      location: '',
      employeeId: null,
    });
    expect(() => readProfileUpdate({ jobTitle: 'x', organization_id: id })).toThrow();
    expect(() => readProfileUpdate({ managerUserId: 'self' })).toThrow();
    expect(() => readProfileUpdate([])).toThrow();
  });
});
