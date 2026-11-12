'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api, type ProblemDetails } from '../../../lib/api';
import { isOrgAdmin } from '../../../lib/navigation';
import { departmentHref, type DepartmentQuery } from './department-ui';

type Scope = { userId: string; organizationId: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** APIの日本語の理由だけを画面へ返す。内部の例外文・スタックは使わない。 */
function problemMessage(problem: ProblemDetails): string {
  if (problem.status === 401) {
    return 'ログインの有効期限が切れました。別のタブでログインしてから再度お試しください。';
  }
  if (problem.status >= 500) {
    return '操作できませんでした。時間をおいて、もう一度お試しください。';
  }
  return (
    problem.errors?.[0]?.message ??
    problem.detail ??
    problem.title ??
    '操作できませんでした。入力内容を確認してください。'
  ).slice(0, 500);
}

function back(query: DepartmentQuery, message: string, departmentId?: string): never {
  redirect(
    departmentHref(query, {
      department: departmentId ?? query.department,
      confirm: null,
      error: message,
    }) + '#department-notice',
  );
}

/**
 * 操作のたびに、アカウント・組織・権限を確認し直す。
 * 画面を出した時点の権限を信じない(AGENTS §1.4 と同じ考え方)。
 */
async function requireDepartmentAdmin(
  scope: Scope,
  query: DepartmentQuery,
  departmentId?: string,
): Promise<void> {
  const authentication = await api.me();
  if (!authentication.ok) {
    back(query, problemMessage(authentication.problem), departmentId);
  }
  const session = authentication.data;
  if (session.userId !== scope.userId || session.organizationId !== scope.organizationId) {
    back(
      query,
      '操作中のアカウントまたは組織が変わりました。画面を開き直してください。',
      departmentId,
    );
  }
  if (!isOrgAdmin(session)) {
    back(query, 'この操作を行う権限がありません。組織の管理者へご連絡ください。', departmentId);
  }
}

function read(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

export async function createDepartmentAction(
  scope: Scope,
  query: DepartmentQuery,
  formData: FormData,
): Promise<void> {
  await requireDepartmentAdmin(scope, query);
  const parentId = read(formData, 'parentId').trim();
  const result = await api.createDepartment({
    code: read(formData, 'code'),
    name: read(formData, 'name'),
    parentId: parentId.length > 0 ? parentId : null,
  });
  if (!result.ok) back(query, problemMessage(result.problem));
  revalidatePath('/ops/departments');
  revalidatePath('/ops/users');
  redirect(
    departmentHref(query, {
      department: result.data.department.id,
      confirm: null,
      notice: 'created',
    }) + '#department-details',
  );
}

export async function editDepartmentAction(
  scope: Scope,
  query: DepartmentQuery,
  departmentId: string,
  formData: FormData,
): Promise<void> {
  if (!UUID.test(departmentId)) {
    back(query, '対象の部署をツリーから選び直してください。');
  }
  await requireDepartmentAdmin(scope, query, departmentId);
  const parentId = read(formData, 'parentId').trim();
  const result = await api.editDepartment(departmentId, {
    code: read(formData, 'code'),
    name: read(formData, 'name'),
    parentId: parentId.length > 0 ? parentId : null,
  });
  if (!result.ok) back(query, problemMessage(result.problem), departmentId);
  revalidatePath('/ops/departments');
  revalidatePath('/ops/users');
  redirect(
    departmentHref(query, {
      department: departmentId,
      confirm: null,
      notice: 'updated',
    }) + '#department-details',
  );
}

export async function deactivateDepartmentAction(
  scope: Scope,
  query: DepartmentQuery,
  departmentId: string,
): Promise<void> {
  if (!UUID.test(departmentId)) {
    back(query, '対象の部署をツリーから選び直してください。');
  }
  await requireDepartmentAdmin(scope, query, departmentId);
  const result = await api.deactivateDepartment(departmentId);
  if (!result.ok) back(query, problemMessage(result.problem), departmentId);
  revalidatePath('/ops/departments');
  revalidatePath('/ops/users');
  redirect(
    departmentHref(query, {
      department: departmentId,
      confirm: null,
      notice: 'deactivated',
    }) + '#department-details',
  );
}

export async function assignHeadAction(
  scope: Scope,
  query: DepartmentQuery,
  departmentId: string,
  formData: FormData,
): Promise<void> {
  if (!UUID.test(departmentId)) {
    back(query, '対象の部署をツリーから選び直してください。');
  }
  await requireDepartmentAdmin(scope, query, departmentId);
  const userId = read(formData, 'userId').trim();
  if (!UUID.test(userId)) {
    back(query, '部署長にする利用者を選んでください。', departmentId);
  }
  const result = await api.assignDepartmentHead(departmentId, userId);
  if (!result.ok) back(query, problemMessage(result.problem), departmentId);
  revalidatePath('/ops/departments');
  revalidatePath('/ops/users');
  redirect(
    departmentHref(query, {
      department: departmentId,
      confirm: null,
      notice: 'head-assigned',
    }) + '#department-head',
  );
}

export async function endHeadAction(
  scope: Scope,
  query: DepartmentQuery,
  departmentId: string,
  formData: FormData,
): Promise<void> {
  if (!UUID.test(departmentId)) {
    back(query, '対象の部署をツリーから選び直してください。');
  }
  await requireDepartmentAdmin(scope, query, departmentId);
  const value = read(formData, 'validUntil').trim();
  if (value.length > 0 && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    back(query, '終了日は YYYY-MM-DD で入力してください。', departmentId);
  }
  const result = await api.endDepartmentHead(departmentId, value.length > 0 ? value : null);
  if (!result.ok) back(query, problemMessage(result.problem), departmentId);
  revalidatePath('/ops/departments');
  revalidatePath('/ops/users');
  redirect(
    departmentHref(query, {
      department: departmentId,
      confirm: null,
      notice: 'head-ended',
    }) + '#department-head',
  );
}
