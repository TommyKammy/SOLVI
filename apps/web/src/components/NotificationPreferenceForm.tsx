'use client';

import { useActionState, useId, useState } from 'react';
import {
  preferenceFailure,
  type NotificationPreferenceState,
} from '../lib/notification-preference';
import { FeedbackForm, FormField } from './FeedbackForm';

type PreferenceAction = (
  previous: NotificationPreferenceState,
  form: FormData,
) => Promise<NotificationPreferenceState>;

export function NotificationPreferenceForm({
  initialEnabled,
  action,
}: {
  initialEnabled: boolean;
  action: PreferenceAction;
}) {
  const id = useId();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [state, dispatch, pending] = useActionState<NotificationPreferenceState, FormData>(
    async (previous: NotificationPreferenceState, form: FormData) => {
      try {
        const result = await action(previous, form);
        return { ...result, saved: result.saved ?? previous.saved };
      } catch {
        return {
          message: preferenceFailure(503),
          saved: previous.saved,
          attempt: previous.attempt + 1,
        };
      }
    },
    { message: '', attempt: 0 },
  );
  const saved = state.saved ?? initialEnabled;
  const unchanged = enabled === saved;
  return (
    <FeedbackForm
      action={dispatch}
      feedback={state}
      pending={pending}
      aria-label="メール通知の設定"
      className="notification-preference-form"
    >
      <input type="hidden" name="ticketEmailEnabled" value={String(enabled)} />
      <fieldset disabled={pending || state.scopeChanged}>
        <legend>任意のチケット通知</legend>
        <FormField name="ticketEmailEnabled">
          <label className="notification-preference-choice" htmlFor={id}>
            <input
              id={id}
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
              aria-describedby={`${id}-hint`}
            />
            <span>チケットの更新をメールで受け取る</span>
          </label>
          <p className="hint" id={`${id}-hint`}>
            問い合わせの作成・状態の変更・担当の変更・コメント・再評価の通知が対象です。
          </p>
        </FormField>
        <div className="notification-preference-actions">
          <button
            type="submit"
            disabled={pending || (unchanged && !state.message) || state.scopeChanged}
          >
            {pending ? '保存しています…' : '設定を保存'}
          </button>
          <span className="hint">
            {state.message
              ? '保存結果を確認してください。'
              : unchanged
                ? '保存済みの設定です。'
                : 'まだ保存していません。'}
          </span>
        </div>
      </fieldset>
      {state.saved !== undefined && unchanged && !state.message && (
        <p className="notice" role="status">
          設定を保存しました。
        </p>
      )}
      {state.scopeChanged && (
        <p>
          <a href="/settings/notifications">現在の組織で設定を開き直す</a>
        </p>
      )}
    </FeedbackForm>
  );
}
