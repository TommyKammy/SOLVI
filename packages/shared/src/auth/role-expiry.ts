/**
 * 役割の期限に関する共通の値 (FR-IDM-006 / WP-P1-IDM-017)。
 *
 * **画面とサーバで別々に持たない。**
 *
 * 在籍者の管理画面は「あと N 日」を強調して出し、
 * サーバは同じ N 日で予告の通知を送る。
 * 値が2か所にあると、片方だけ変えたときに
 * **「画面は警告しているのに通知は来ない」**(あるいは逆)が起きる。
 * 利用者から見ると、どちらが本当なのか分からない。
 */

/**
 * 期限の何日前から「まもなく切れる」として扱うか。
 *
 * 30日にした根拠は運用の都合である。
 * **法務・人事による確定値ではない**(03.16 と同じ状況)。
 * 兼務・出向の延長は上長の承認を要することが多く、
 * ひと月あれば手続きが間に合う、という見込みにすぎない。
 */
export const ROLE_EXPIRY_WARNING_DAYS = 30;

/** 期限までの残り日数。切り上げる — 「あと0日」は当日を意味する。 */
export function daysUntil(validUntil: Date | string, now: Date = new Date()): number {
  const until = typeof validUntil === 'string' ? new Date(validUntil) : validUntil;
  return Math.ceil((until.getTime() - now.getTime()) / 86_400_000);
}

/** まもなく切れるか。**切れたあとは含めない** — それは予告ではなく事後である。 */
export function isExpiringSoon(validUntil: Date | string, now: Date = new Date()): boolean {
  const days = daysUntil(validUntil, now);
  return days >= 0 && days <= ROLE_EXPIRY_WARNING_DAYS;
}
