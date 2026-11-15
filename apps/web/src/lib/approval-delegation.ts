import type { ProblemDetails } from './api';
import { formatDateTime } from './labels';

/**
 * 承認の委任の画面 (WP-P4-APR-020 §6.7) の表示と文言。
 *
 * 認可・期間・重なりの判定はAPIが持つ。ここに置くのは**表示のためだけ**の
 * 純粋な関数である。状態の導出や「有効か」の判定をここで書き直さない。
 */

/** 委任の状態の表示名。`unknown` は値が読めない場合で、有効とは扱わない。 */
export const DELEGATION_STATE_LABELS: Record<string, string> = {
  scheduled: '開始前',
  active: '有効',
  ended: '期間終了',
  revoked: '取消済み',
  delegate_ineligible: '代理者が資格なし',
  unknown: '状態を確認できません',
};

/** 状態の補足。状態名だけでは判断できない場合に、一覧の下に出す。 */
const STATE_NOTES: Record<string, string> = {
  scheduled: '開始日時になると有効になります。',
  active: 'この期間は、代理者が委任者宛ての承認を判断できます。',
  ended: '期間が終わっています。延長するには新しい委任を作成してください。',
  revoked: '取り消されています。代理で承認済みのステップは有効のままです。',
  delegate_ineligible:
    '代理者が今は承認者の役割を持たないか、有効な所属ではありません。この委任では代理で承認できません。',
  unknown: '状態を確認できませんでした。この委任は有効とは扱いません。一覧を読み直してください。',
};

export function delegationStateLabel(state: unknown): string {
  return typeof state === 'string' && Object.hasOwn(DELEGATION_STATE_LABELS, state)
    ? DELEGATION_STATE_LABELS[state]!
    : DELEGATION_STATE_LABELS.unknown!;
}

/** 状態の補足文。未知の状態は `unknown` の文にする(有効とは扱わない)。 */
export function delegationStateHint(state: unknown): string {
  return typeof state === 'string' && Object.hasOwn(STATE_NOTES, state)
    ? STATE_NOTES[state]!
    : STATE_NOTES.unknown!;
}

/**
 * 取消(代理者から見れば辞退)の操作を出せる状態か。
 * 取消済み・期間終了はAPIが 409 で拒否するため、入口を出さない。
 * ここは表示の制御だけであり、最終的な可否はAPIが決める。
 */
export function delegationRevocable(state: unknown): boolean {
  return state === 'scheduled' || state === 'active' || state === 'delegate_ineligible';
}

/** 一覧から、URLで指定されたIDの委任を探す。見つからなければ null。 */
export function findDelegation<T extends { id: string }>(
  items: readonly T[],
  id: unknown,
): T | null {
  if (
    typeof id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    return null;
  return items.find((item) => item.id === id) ?? null;
}

type DelegationRecord = {
  delegateName: string;
  delegatorName: string;
  startsAt: string;
  endsAt: string;
  revokedAt: string | null;
};

/**
 * 作成の成功の文。**URLの値ではなく、一覧に実在する記録から組み立てる**。
 * 記録が無い・形が読めない場合は null(成功を装わない)。
 */
export function delegationCreatedText(item: DelegationRecord | null): string | null {
  if (!item || item.revokedAt !== null) return null;
  const starts = Date.parse(item.startsAt);
  const ends = Date.parse(item.endsAt);
  if (!Number.isFinite(starts) || !Number.isFinite(ends)) return null;
  return `「${item.delegateName}」さんへの委任を作成しました（${formatDateTime(item.startsAt)}〜${formatDateTime(item.endsAt)}）。`;
}

/** 取消・辞退の成功の文。取消の記録があるときだけ作る。 */
export function delegationRevokedText(
  item: DelegationRecord | null,
  kind: 'revoked' | 'declined',
): string | null {
  if (!item || item.revokedAt === null) return null;
  if (!Number.isFinite(Date.parse(item.revokedAt))) return null;
  const who = kind === 'declined' ? item.delegatorName : item.delegateName;
  const action = kind === 'declined' ? 'からの委任を辞退しました' : 'への委任を取り消しました';
  return `「${who}」さん${action}（${formatDateTime(item.revokedAt)}）。`;
}

/**
 * 日時の入力(`datetime-local`)の値を、日本時間としてISO 8601へ変える。
 * 既存の変更管理の画面と同じ規則である(`YYYY-MM-DDTHH:mm` + `+09:00`)。
 * 空・読めない値は null(APIへ送らず、項目のエラーにする)。
 */
export function jstInputToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(`${value}+09:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * サーバの現在時刻を、日本時間の `datetime-local` の初期値にする。
 * 開始の既定にだけ使う。終了の既定は置かない(利用者に決めさせる)。
 */
export function jstDateTimeInput(at: Date): string {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}`;
}

export type DelegationFieldError = { field: string; message: string; label: string };

export type DelegationFeedback = {
  message: string;
  errors?: DelegationFieldError[];
};

const FIELD_LABELS: Record<string, string> = {
  delegateId: '代理者',
  startsAt: '開始',
  endsAt: '終了',
  reason: '理由',
};

const LOGIN_EXPIRED =
  'ログインの有効期限が切れました。別のタブでログインしてから、もう一度お試しください。';
const UNAVAILABLE = '操作できませんでした。時間をおいて、もう一度お試しください。';

function detailText(problem: ProblemDetails, max = 200): string | null {
  const text = problem.errors?.[0]?.message ?? problem.detail ?? null;
  if (typeof text !== 'string' || text.trim().length === 0) return null;
  return text.trim().slice(0, max);
}

/** 400 の項目のエラーだけを取り出す。未知の項目・内部の文言は出さない。 */
function fieldErrors(problem: ProblemDetails): DelegationFieldError[] {
  const errors: DelegationFieldError[] = [];
  for (const error of problem.errors ?? []) {
    const field = error.field.split('.').pop() ?? '';
    const label = FIELD_LABELS[field];
    if (!label || typeof error.message !== 'string') continue;
    const message = error.message.trim().slice(0, 200);
    if (!message) continue;
    errors.push({ field, message, label });
  }
  return errors;
}

/**
 * 委任の作成の失敗を、利用者向けの文と項目に結び付いたエラーにする。
 * **理由のコード・内部の例外文を画面に出さない。** APIの 400 の項目の文言だけは
 * そのまま使う(すでに利用者向けの日本語である)。
 */
export function delegationCreateFailure(problem: ProblemDetails): DelegationFeedback {
  if (problem.status === 401) return { message: LOGIN_EXPIRED };
  if (problem.status === 403) {
    // APIの 403 は、委任者自身の所属と代理者の資格で同じ文言を使い分ける。
    // どちらも利用者向けの日本語であり、内部の用語は含まない。
    const detail = detailText(problem);
    if (
      detail &&
      (detail.includes('委任できるのは現在有効な所属') ||
        detail.includes('現在有効な所属の承認者を代理者に'))
    )
      return { message: detail.endsWith('。') ? detail : `${detail}。` };
    return {
      message:
        '委任を作成できませんでした。代理者に選べるのは、現在有効な所属で承認者の役割を持つ人だけです。候補から選び直してください。',
    };
  }
  if (problem.status === 404)
    return {
      message: 'この環境では代理承認の委任を利用できません。組織の管理者へご連絡ください。',
    };
  if (problem.status === 400) {
    const errors = fieldErrors(problem);
    if (errors.length > 0) return { message: '入力内容を確認してください。', errors };
    return { message: '入力内容を確認してください。期間と代理者を選び直してください。' };
  }
  if (problem.status === 409) {
    const detail = detailText(problem);
    if (detail?.includes('期間'))
      return {
        message:
          '同じ期間に重なる委任が既にあります。代理者になれるのは同時に1人です。期間をずらすか、既存の委任を取り消してください。',
      };
    if (detail?.includes('プロフィール'))
      return {
        message:
          '組織プロフィールが未設定のため、委任を作成できません。組織の管理者にプロフィールの設定を依頼してください。',
      };
    if (detail?.includes('同時'))
      return {
        message: 'ほかの操作で委任が更新されました。一覧を読み直してから、もう一度お試しください。',
      };
    return { message: '委任を作成できませんでした。期間と既存の委任を確認してください。' };
  }
  return { message: UNAVAILABLE };
}

/** 取消・辞退の失敗。 */
export function delegationRevokeFailure(problem: ProblemDetails): DelegationFeedback {
  if (problem.status === 401) return { message: LOGIN_EXPIRED };
  if (problem.status === 403)
    return { message: 'この委任を取り消す権限がありません。一覧を読み直してください。' };
  if (problem.status === 404)
    return { message: '委任が見つかりませんでした。一覧を読み直してください。' };
  if (problem.status === 400) {
    const errors = fieldErrors(problem);
    return errors.length > 0
      ? { message: '入力内容を確認してください。', errors }
      : { message: '取消の理由を入力してください。' };
  }
  if (problem.status === 409) {
    const detail = detailText(problem);
    if (detail?.includes('取り消し済み') || detail?.includes('取消済み'))
      return { message: 'この委任は既に取り消されています。一覧を読み直してください。' };
    if (detail?.includes('期間'))
      return {
        message: '期間の終わった委任は取り消せません。一覧を読み直してください。',
      };
    if (detail?.includes('同時'))
      return {
        message: 'ほかの操作で委任が更新されました。一覧を読み直してから、もう一度お試しください。',
      };
    return { message: '委任を取り消せませんでした。一覧を読み直してください。' };
  }
  return { message: UNAVAILABLE };
}
