'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { api, type ProblemDetails } from '../../../lib/api';
import { isUuid } from '../../../lib/approval-route';
import {
  delegationCreateFailure,
  delegationRevokeFailure,
  jstInputToIso,
} from '../../../lib/approval-delegation';
import type { FormFeedback } from '../../../lib/form-state';

/**
 * 承認の委任の作成・取消 (WP-P4-APR-020 §6.7 / ADR-0025 §1)。
 *
 * この画面は利用者ごとの設定である。操作のたびにアカウントと組織を確認し直し、
 * 画面を出した時点の状態を信じない。認可・期間・重なり・代理者の資格はAPIが決める。
 * 本文に委任者のIDを含めない(委任者は常に認証済みの本人)。
 */
type Scope = { userId: string; organizationId: string | null };

const SESSION_CHANGED = '操作中のアカウントまたは組織が変わりました。画面を開き直してください。';

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

/** 操作の直前に、認証済みの本人と組織が画面のものと一致するか確かめる。 */
async function sessionError(scope: Scope): Promise<string | null> {
  const authentication = await api.me();
  if (!authentication.ok) return sessionFailure(authentication.problem);
  const session = authentication.data;
  if (session.userId !== scope.userId || session.organizationId !== scope.organizationId)
    return SESSION_CHANGED;
  return null;
}

function sessionFailure(problem: ProblemDetails): string {
  if (problem.status === 401)
    return 'ログインの有効期限が切れました。別のタブでログインしてから、もう一度お試しください。';
  if (problem.status === 403 || problem.status >= 500)
    return '現在のログイン状態を確認できません。時間をおいて、もう一度お試しください。';
  return '現在のログイン状態を確認できません。画面を開き直してください。';
}

function refresh(): void {
  revalidatePath('/settings/delegations');
}

export async function createDelegationAction(
  scope: Scope,
  previous: FormFeedback,
  form: FormData,
): Promise<FormFeedback> {
  const attempt = (previous.attempt ?? 0) + 1;
  const changed = await sessionError(scope);
  if (changed) return { message: changed, attempt };

  const delegateId = read(form, 'delegateId');
  const startsAt = jstInputToIso(read(form, 'startsAt'));
  const endsAt = jstInputToIso(read(form, 'endsAt'));
  if (!isUuid(delegateId))
    return {
      message: '代理者を候補から選んでください。',
      errors: [
        { field: 'delegateId', message: '代理者を候補から選んでください。', label: '代理者' },
      ],
      attempt,
    };
  if (!startsAt)
    return {
      message: '開始の日時を入力してください。',
      errors: [{ field: 'startsAt', message: '開始の日時を入力してください。', label: '開始' }],
      attempt,
    };
  if (!endsAt)
    return {
      message: '終了の日時を入力してください。',
      errors: [{ field: 'endsAt', message: '終了の日時を入力してください。', label: '終了' }],
      attempt,
    };
  if (read(form, 'confirm') !== '1')
    return {
      message: '委任を作成するには、確認の欄にチェックを入れてください。',
      errors: [
        {
          field: 'confirm',
          message: '委任を作成するには、確認の欄にチェックを入れてください。',
          label: '確認',
        },
      ],
      attempt,
    };

  const result = await api.createApprovalDelegation({ delegateId, startsAt, endsAt });
  if (!result.ok) return { ...delegationCreateFailure(result.problem), attempt };
  refresh();
  // 成功の文は、同じ画面で一覧を読み直し、実在する記録から組み立てる
  // (URLの値だけで成功を表示しない / WP-P4-APR-018 の教訓)。
  redirect(`/settings/delegations?created=${result.data.id}#delegation-mine`);
}

/**
 * 委任の取消。代理者が自分の受けた委任を取り消す場合は「辞退」として扱うが、
 * APIの経路と検証は同じである(理由が必須)。
 */
export async function revokeDelegationAction(
  scope: Scope,
  delegationId: string,
  kind: 'revoked' | 'declined',
  previous: FormFeedback,
  form: FormData,
): Promise<FormFeedback> {
  const attempt = (previous.attempt ?? 0) + 1;
  if (!isUuid(delegationId))
    return { message: '対象の委任を一覧から選び直してください。', attempt };
  const changed = await sessionError(scope);
  if (changed) return { message: changed, attempt };

  const reason = read(form, 'reason').trim();
  if (!reason)
    return {
      message:
        kind === 'declined' ? '辞退の理由を入力してください。' : '取消の理由を入力してください。',
      errors: [
        {
          field: 'reason',
          message:
            kind === 'declined'
              ? '辞退の理由を入力してください。'
              : '取消の理由を入力してください。',
          label: kind === 'declined' ? '辞退の理由' : '取消の理由',
        },
      ],
      attempt,
    };
  if (reason.length > 2000)
    return {
      message: '理由は2000文字以内で入力してください。',
      errors: [
        { field: 'reason', message: '理由は2000文字以内で入力してください。', label: '理由' },
      ],
      attempt,
    };
  if (read(form, 'confirm') !== '1')
    return {
      message:
        kind === 'declined'
          ? '辞退するには、確認の欄にチェックを入れてください。'
          : '取り消すには、確認の欄にチェックを入れてください。',
      errors: [
        {
          field: 'confirm',
          message:
            kind === 'declined'
              ? '辞退するには、確認の欄にチェックを入れてください。'
              : '取り消すには、確認の欄にチェックを入れてください。',
          label: '確認',
        },
      ],
      attempt,
    };

  const result = await api.revokeApprovalDelegation(delegationId, { reason });
  if (!result.ok) return { ...delegationRevokeFailure(result.problem), attempt };
  refresh();
  const key = kind === 'declined' ? 'declined' : 'revoked';
  const anchor = kind === 'declined' ? 'delegation-received' : 'delegation-mine';
  redirect(`/settings/delegations?${key}=${delegationId}#${anchor}`);
}
