import type { DepartmentNode } from '../../../lib/api';

/**
 * 部署管理画面の表示条件と、選択肢の組み立て (WP-P4-IDM-013 段階B)。
 *
 * 画面から送るIDはここで既知の形に限定する。値の妥当性(同組織・有効・循環)は
 * APIが毎回再検証する。ここは「押すと必ず失敗する選択肢を出さない」ための整理である。
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DepartmentQuery {
  /** 選択中の部署。未選択は空文字。 */
  department: string;
  /** 無効化の確認画面を出しているか。 */
  confirm: 'deactivate' | null;
}

export const DEPARTMENT_NOTICES = [
  'created',
  'updated',
  'deactivated',
  'head-assigned',
  'head-ended',
] as const;

export type DepartmentNotice = (typeof DEPARTMENT_NOTICES)[number];

export interface DepartmentHrefOverrides {
  department?: string | null;
  confirm?: 'deactivate' | null;
  notice?: DepartmentNotice | null;
  /** APIが返した日本語の理由。個人データは含めない。 */
  error?: string | null;
}

export function parseDepartmentQuery(
  params: Record<string, string | string[] | undefined>,
): DepartmentQuery {
  const department =
    typeof params.department === 'string' && UUID.test(params.department)
      ? params.department.toLowerCase()
      : '';
  const confirm = params.confirm === 'deactivate' ? 'deactivate' : null;
  return { department, confirm };
}

/** 内部の固定した行き先だけを組み立てる。任意の戻り先URLは受け取らない。 */
export function departmentHref(
  query: DepartmentQuery,
  overrides: DepartmentHrefOverrides = {},
): string {
  const nextDepartment =
    typeof overrides.department === 'string' && UUID.test(overrides.department)
      ? overrides.department.toLowerCase()
      : overrides.department === null || overrides.department === ''
        ? ''
        : query.department;
  const nextConfirm =
    overrides.confirm !== undefined
      ? overrides.confirm
      : nextDepartment === query.department
        ? query.confirm
        : null;
  const params = new URLSearchParams();
  if (nextDepartment) params.set('department', nextDepartment);
  if (nextConfirm === 'deactivate') params.set('confirm', 'deactivate');
  if (overrides.notice && (DEPARTMENT_NOTICES as readonly string[]).includes(overrides.notice)) {
    params.set('notice', overrides.notice);
  }
  if (typeof overrides.error === 'string' && overrides.error.trim().length > 0) {
    params.set('error', overrides.error.trim().slice(0, 500));
  }
  const search = params.toString();
  return search ? `/ops/departments?${search}` : '/ops/departments';
}

export function departmentNoticeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const notices: Record<DepartmentNotice, string> = {
    created: '部署を追加しました。',
    updated: '部署の変更を保存しました。',
    deactivated: '部署を無効化しました。この操作は取り消せません。',
    'head-assigned': '部署長を設定しました。',
    'head-ended': '部署長を終了しました。',
  };
  return Object.hasOwn(notices, value) ? notices[value as DepartmentNotice] : null;
}

export interface DepartmentOption {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  depth: number;
  active: boolean;
  /** 選択肢に出す名前。深さは全角スペースで表す。 */
  label: string;
}

/** ツリーを親→子の順に並べる。壊れたデータでも訪問済みで止まる。 */
export function flattenDepartmentTree(nodes: readonly DepartmentNode[]): DepartmentOption[] {
  const out: DepartmentOption[] = [];
  const seen = new Set<string>();
  const visit = (node: DepartmentNode, depth: number) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    out.push({
      id: node.id,
      code: node.code,
      name: node.name,
      parentId: node.parentId,
      depth,
      active: node.active,
      label: `${'　'.repeat(Math.max(depth - 1, 0))}${node.name}（${node.code}）`,
    });
    for (const child of node.children) visit(child, depth + 1);
  };
  for (const node of nodes) visit(node, 1);
  return out;
}

export function findDepartmentNode(
  nodes: readonly DepartmentNode[],
  departmentId: string,
): DepartmentNode | null {
  for (const node of nodes) {
    if (node.id === departmentId) return node;
    const child = findDepartmentNode(node.children, departmentId);
    if (child) return child;
  }
  return null;
}

export interface ParentOption extends DepartmentOption {
  /** 選べない理由。null なら選べる。 */
  disabledReason: string | null;
}

function isDescendant(
  options: readonly DepartmentOption[],
  candidateId: string,
  ancestorId: string,
) {
  const byId = new Map(options.map((option) => [option.id, option]));
  const seen = new Set<string>();
  let current: string | null = candidateId;
  while (current && !seen.has(current)) {
    if (current === ancestorId) return true;
    seen.add(current);
    current = byId.get(current)?.parentId ?? null;
  }
  return false;
}

/**
 * 親部署の選択肢。無効化済みの部署、自分自身、自分の子孫は選べない。
 * 選べないものも理由付きで残す。
 */
export function parentOptions(nodes: readonly DepartmentNode[], targetId?: string): ParentOption[] {
  const options = flattenDepartmentTree(nodes);
  return options.map((option) => ({
    ...option,
    disabledReason: !option.active
      ? '無効化された部署は親に指定できません'
      : targetId && option.id === targetId
        ? '自分自身を親部署に指定できません'
        : targetId && isDescendant(options, option.id, targetId)
          ? '自分の配下の部署は親に指定できません(循環)'
          : null,
  }));
}
