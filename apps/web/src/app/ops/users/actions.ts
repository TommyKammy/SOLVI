'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api, type ProblemDetails } from '../../../lib/api';
import { isOrgAdmin, navigationRoles } from '../../../lib/navigation';
import { directoryHref, type DirectoryQuery } from '../../../lib/user-directory';
import type { UserDirectoryFormState } from '../../../components/UserDirectoryForms';

type Scope = { userId: string; organizationId: string | null };
type Operation = 'create' | 'grant' | 'revoke' | 'deactivate' | 'reactivate';
const fields = ['displayName', 'email', 'roleCode', 'reason', 'validUntil'];

function failure(problem: ProblemDetails, values: Record<string, string>): UserDirectoryFormState {
  const fieldErrors: Record<string, string> = {};
  for (const item of problem.errors ?? []) {
    if (fields.includes(item.field)) fieldErrors[item.field] = item.message;
  }
  return {
    error:
      problem.detail ?? problem.title ?? '操作できませんでした。入力を確認して再度お試しください。',
    fieldErrors,
    values,
  };
}

/** APIの日本語の理由だけを画面へ返す。内部の例外文・スタックは使わない。 */
function profileFailure(problem: ProblemDetails): string {
  if (problem.status === 401) {
    return 'ログインの有効期限が切れました。別のタブでログインしてから再度お試しください。';
  }
  if (problem.status >= 500) {
    return 'プロフィールを保存できませんでした。時間をおいて、もう一度お試しください。';
  }
  return (
    problem.errors?.[0]?.message ??
    problem.detail ??
    problem.title ??
    'プロフィールを保存できませんでした。入力内容を確認してください。'
  ).slice(0, 500);
}

const PROFILE_FIELDS = [
  ['primaryDepartmentId', 'primaryDepartmentId'],
  ['managerUserId', 'managerUserId'],
  ['jobTitle', 'jobTitle'],
  ['location', 'location'],
  ['employeeId', 'employeeId'],
] as const;

/**
 * 組織プロフィールの更新 (WP-P4-IDM-013 段階B)。
 *
 * 変更された項目だけを送る。現在値と違うかをサーバー側で判定するのはAPIの責務だが、
 * **無効化済みの主部署や停止した上長を「変更していないのに再検証」させない**ため、
 * 画面は元の値を hidden で持ち、変わった項目だけを本文に載せる。
 * 値の妥当性(同組織・有効・循環)はAPIが毎回再検証する。
 */
export async function updateMemberProfile(
  scope: Scope,
  query: DirectoryQuery,
  target: string,
  formData: FormData,
): Promise<void> {
  const back = (overrides: Parameters<typeof directoryHref>[1]) =>
    directoryHref(query, { selected: target, ...overrides }) + '#member-details';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target)) {
    redirect(directoryHref(query, { profileError: '対象の利用者を一覧から選び直してください。' }));
  }
  const authentication = await api.me();
  if (!authentication.ok) {
    redirect(back({ profileError: profileFailure(authentication.problem) }));
  }
  const session = authentication.data;
  if (session.userId !== scope.userId || session.organizationId !== scope.organizationId) {
    redirect(
      back({
        profileError: '操作中のアカウントまたは組織が変わりました。一覧を開き直してください。',
      }),
    );
  }
  if (!isOrgAdmin(session)) {
    redirect(
      back({ profileError: 'この操作を行う権限がありません。組織の管理者へご連絡ください。' }),
    );
  }

  const read = (name: string): string => {
    const value = formData.get(name);
    return typeof value === 'string' ? value : '';
  };
  const body: Record<string, string | null> = {};
  for (const [name] of PROFILE_FIELDS) {
    if (!formData.has(name)) continue;
    const value = read(name);
    const origin = read(`origin_${name}`);
    if (value !== origin) body[name] = value.trim().length === 0 ? null : value.trim();
  }
  if (Object.keys(body).length === 0) {
    redirect(back({ notice: 'profile-unchanged' }));
  }

  const result = await api.updateProfile(target, body);
  if (!result.ok) {
    redirect(back({ profileError: profileFailure(result.problem) }));
  }
  revalidatePath('/ops/users');
  redirect(back({ notice: 'profile' }));
}

/** Bound targets and the current session are checked again for every submission. */
export async function updateDirectoryUser(
  scope: Scope,
  query: DirectoryQuery,
  target: string | null,
  operation: Operation,
  _previous: UserDirectoryFormState,
  formData: FormData,
): Promise<UserDirectoryFormState> {
  const values = Object.fromEntries(
    fields.map((field) => [field, String(formData.get(field) ?? '')]),
  );
  if (!['create', 'grant', 'revoke', 'deactivate', 'reactivate'].includes(operation)) {
    return { error: '操作を確認できませんでした。一覧を開き直してください。', values };
  }
  const authentication = await api.me();
  if (!authentication.ok) {
    return {
      error:
        authentication.problem.status === 401
          ? 'ログインの有効期限が切れました。別のタブでログインしてから再度お試しください。'
          : authentication.problem.status >= 500
            ? 'アカウントを確認できませんでした。しばらくしてから再度お試しください。'
            : '選択中の組織または操作権限を確認できませんでした。一覧を開き直してください。',
      values,
    };
  }
  const session = authentication.data;
  if (session.userId !== scope.userId || session.organizationId !== scope.organizationId) {
    return {
      error: '操作中のアカウントまたは組織が変わりました。一覧を開き直してください。',
      values,
    };
  }
  if (!navigationRoles(session).admin) {
    return { error: 'この操作を行う権限がありません。組織の管理者へご連絡ください。', values };
  }
  if (operation === 'create') {
    const result = await api.createUser({
      displayName: values.displayName,
      email: values.email,
      roleCode: values.roleCode,
      reason: values.reason,
    });
    if (!result.ok) return failure(result.problem, values);
    revalidatePath('/ops/users');
    redirect(
      directoryHref(query, { selected: result.data.userId, notice: 'created' }) +
        '#directory-notice',
    );
  }
  if (!target || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target)) {
    return { error: '対象の利用者を一覧から選び直してください。', values };
  }
  if (operation === 'deactivate') {
    const result = await api.deactivateUser(target, values.reason);
    if (!result.ok) return failure(result.problem, values);
    revalidatePath('/ops/users');
    redirect(
      directoryHref(query, {
        selected: target,
        notice: 'stopped',
        count: result.data.openTicketCount,
      }) + '#directory-notice',
    );
  }
  const result =
    operation === 'grant'
      ? await api.grantRole(target, values.roleCode, values.reason, values.validUntil)
      : operation === 'revoke'
        ? await api.revokeRole(target, values.roleCode, values.reason)
        : await api.reactivateUser(target, values.reason);
  if (!result.ok) return failure(result.problem, values);
  revalidatePath('/ops/users');
  const notice =
    operation === 'grant' ? 'granted' : operation === 'revoke' ? 'revoked' : 'reactivated';
  redirect(directoryHref(query, { selected: target, notice }) + '#directory-notice');
}
