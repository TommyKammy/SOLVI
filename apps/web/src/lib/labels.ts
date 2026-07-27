/**
 * 表示用の文言 (WP-P2-PORTAL-002)。
 *
 * **内部の識別子をそのまま画面に出さない。** `in_progress` と表示されても
 * 利用者には意味が分からず、問い合わせが増える。
 *
 * また、状態を**色だけで伝えない**。ここで返す文言だけを読んでも
 * 何が起きているか分かるようにする(11.10 / WCAG 2.2 AA)。
 */

const STATE_LABELS: Record<string, string> = {
  new: '受付済み',
  triaged: '確認中',
  in_progress: '対応中',
  pending: 'お客様の返信待ち',
  resolved: '解決済み',
  closed: '完了',
  canceled: '取り消し済み',
  merged: '他の問い合わせに統合',
};

const KIND_LABELS: Record<string, string> = {
  incident: '障害の報告',
  request: '依頼',
};

const PRIORITY_LABELS: Record<string, string> = {
  low: '低',
  medium: '中',
  high: '高',
  critical: '最優先',
};

const LEVEL_LABELS: Record<string, string> = {
  low: '低い',
  medium: 'ふつう',
  high: '高い',
};

/** 未知の値は識別子をそのまま返す。空欄にすると、何も表示されない画面になる。 */
const lookup = (table: Record<string, string>, value: string): string => table[value] ?? value;

export const stateLabel = (v: string): string => lookup(STATE_LABELS, v);
export const kindLabel = (v: string): string => lookup(KIND_LABELS, v);
export const priorityLabel = (v: string): string => lookup(PRIORITY_LABELS, v);
export const levelLabel = (v: string): string => lookup(LEVEL_LABELS, v);

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Tokyo',
  }).format(date);
}

/**
 * 絞り込みの選択肢。
 *
 * **状態を全部並べない。** 担当者が日常的に使うのは「対応が要るもの」の
 * 絞り込みであり、`merged` や `cancelled` を毎回目にする必要はない。
 * 選択肢が多いと、結局どれも使われなくなる。
 */
export const FILTERABLE_STATES = ['new', 'assigned', 'in_progress', 'pending', 'resolved'] as const;

export const FILTERABLE_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
