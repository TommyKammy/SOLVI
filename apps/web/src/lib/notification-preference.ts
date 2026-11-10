export interface NotificationPreference {
  ticketEmailEnabled: boolean;
}

export function parseNotificationPreference(value: unknown): NotificationPreference | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !('ticketEmailEnabled' in value) ||
    typeof value.ticketEmailEnabled !== 'boolean'
  )
    return null;
  return { ticketEmailEnabled: value.ticketEmailEnabled };
}

export interface NotificationPreferenceState {
  message: string;
  attempt: number;
  saved?: boolean;
  scopeChanged?: boolean;
}

export function preferenceFailure(status: number): string {
  if (status === 401)
    return 'ログインの有効期限が切れました。別のタブでログインしてから、もう一度お試しください。';
  if (status === 403)
    return 'この組織で設定を変更する権限を確認できませんでした。所属と操作中の組織を確認してください。';
  if (status === 409) return '利用者または組織が変更されています。この画面を開き直してください。';
  if (status === 400) return '設定内容を確認できませんでした。この画面を開き直してください。';
  return '保存結果を確認できませんでした。入力は保持しています。再読み込みで保存済みの設定を確認してから、必要な場合だけ保存してください。';
}
