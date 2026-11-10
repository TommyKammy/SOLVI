import { api, type SessionView } from './api';

export function formScope(session: SessionView) {
  return `${session.organizationId}:${session.userId}`;
}
/** Rendered identity is not authorization: compare it with the authenticated API session. */
export async function formScopeError(form: FormData): Promise<string | null> {
  const session = await api.me();
  if (!session.ok)
    return session.problem.status >= 500
      ? '現在のログイン状態を確認できません。入力を保持して時間を置いてお試しください。'
      : 'ログインの期限が切れました。同じアカウントでログインし、この画面を開き直してください。';
  if (form.get('formScope') !== formScope(session.data))
    return '利用者または組織が変更されています。現在のログイン状態で画面を開き直してください。';
  return null;
}
