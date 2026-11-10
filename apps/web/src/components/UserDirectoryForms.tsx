'use client';

import { useActionState, useId, useState } from 'react';
import Link from 'next/link';
import { formatDateTime } from '../lib/labels';
import type { FormFeedback } from '../lib/form-state';
import {
  type DirectoryMember,
  DIRECTORY_ROLES,
  DIRECTORY_ROLE_LABELS,
} from '../lib/user-directory';
import { FeedbackForm, FormField } from './FeedbackForm';

export interface UserDirectoryFormState {
  error?: string;
  fieldErrors?: Record<string, string>;
  values?: Record<string, string>;
}

export type UserDirectoryAction = (
  previous: UserDirectoryFormState,
  formData: FormData,
) => Promise<UserDirectoryFormState>;

const FIELD_LABELS: Record<string, string> = {
  displayName: '表示名',
  email: 'メールアドレス',
  roleCode: '役割',
  reason: '理由',
  validUntil: '期限',
};

/** Keep failed submissions in the form, including an interrupted server response. */
function useDirectoryAction(action: UserDirectoryAction) {
  const [state, dispatch, pending] = useActionState(
    async (
      previous: UserDirectoryFormState & { attempt: number },
      formData: FormData,
    ): Promise<UserDirectoryFormState & { attempt: number }> => {
      const values: Record<string, string> = {};
      formData.forEach((value, key) => {
        if (typeof value === 'string') values[key] = value;
      });
      try {
        const result = await action(previous, formData);
        return { ...result, values: result.values ?? values, attempt: previous.attempt + 1 };
      } catch (error) {
        // Successful server actions may redirect. Let Next complete that navigation.
        if (
          typeof error === 'object' &&
          error !== null &&
          'digest' in error &&
          typeof error.digest === 'string' &&
          error.digest.startsWith('NEXT_REDIRECT;')
        ) {
          throw error;
        }
        return {
          error: '送信結果を確認できませんでした。入力はこの画面に保持しています。',
          values,
          attempt: previous.attempt + 1,
        };
      }
    },
    { attempt: 0 },
  );
  const errors = Object.entries(state.fieldErrors ?? {}).map(([field, message]) => ({
    field,
    message,
    label: FIELD_LABELS[field],
  }));
  const feedback: FormFeedback = {
    message: state.error ?? (errors.length > 0 ? '入力内容を確認してください。' : ''),
    errors,
    attempt: state.attempt,
    values: state.values,
  };
  return { feedback, dispatch, pending };
}

export function UserCreateForm({
  action,
  initialRole,
  cancelHref,
}: {
  action: UserDirectoryAction;
  initialRole: 'requester' | 'agent';
  cancelHref: string;
}) {
  const { feedback, dispatch, pending } = useDirectoryAction(action);
  const id = useId();
  const [values, setValues] = useState({
    displayName: '',
    email: '',
    roleCode: initialRole as string,
    reason: '',
  });
  const update = (name: keyof typeof values, value: string) =>
    setValues((current) => ({ ...current, [name]: value }));
  const submitLabel =
    values.roleCode === 'agent'
      ? 'オペレーターを追加する'
      : values.roleCode === 'requester'
        ? 'リクエスターを追加する'
        : '利用者を追加する';

  return (
    <FeedbackForm
      action={dispatch}
      feedback={feedback}
      pending={pending}
      className="directory-form"
      aria-label={submitLabel}
    >
      <fieldset disabled={pending} className="directory-form-grid">
        <legend>新しい利用者の情報</legend>
        <FormField>
          <label htmlFor={`${id}-name`}>表示名</label>
          <input
            id={`${id}-name`}
            name="displayName"
            type="text"
            required
            maxLength={200}
            autoComplete="off"
            value={values.displayName}
            onChange={(event) => update('displayName', event.target.value)}
          />
        </FormField>
        <FormField>
          <label htmlFor={`${id}-email`}>メールアドレス</label>
          <p className="hint" id={`${id}-email-hint`}>
            連絡先として使います。本人の識別には使いません。
          </p>
          <input
            id={`${id}-email`}
            name="email"
            type="email"
            required
            autoComplete="off"
            aria-describedby={`${id}-email-hint`}
            value={values.email}
            onChange={(event) => update('email', event.target.value)}
          />
        </FormField>
        <FormField>
          <label htmlFor={`${id}-role`}>最初の役割</label>
          <select
            id={`${id}-role`}
            name="roleCode"
            required
            value={values.roleCode}
            onChange={(event) => update('roleCode', event.target.value)}
          >
            {DIRECTORY_ROLES.map((code) => (
              <option key={code} value={code}>
                {DIRECTORY_ROLE_LABELS[code] ?? code}
              </option>
            ))}
          </select>
        </FormField>
        <FormField>
          <label htmlFor={`${id}-reason`}>追加の理由</label>
          <input
            id={`${id}-reason`}
            name="reason"
            type="text"
            required
            maxLength={500}
            value={values.reason}
            onChange={(event) => update('reason', event.target.value)}
          />
        </FormField>
        <p className="hint">作成しただけではログインできません。資格情報の設定は別の手順です。</p>
        <div className="directory-form-actions">
          <button type="submit" disabled={pending}>
            {pending ? '追加しています…' : submitLabel}
          </button>
          <Link href={cancelHref}>一覧へ戻る</Link>
        </div>
      </fieldset>
    </FeedbackForm>
  );
}

function RoleForm({
  action,
  member,
  mode,
  options,
}: {
  action: UserDirectoryAction;
  member: DirectoryMember;
  mode: 'grant' | 'revoke';
  options: string[];
}) {
  const { feedback, dispatch, pending } = useDirectoryAction(action);
  const id = useId();
  const [roleCode, setRoleCode] = useState(options[0] ?? '');
  const [reason, setReason] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const granting = mode === 'grant';
  const label = granting ? '役割を与える' : '役割を取り消す';

  return (
    <FeedbackForm
      action={dispatch}
      feedback={feedback}
      pending={pending}
      className="directory-form"
      aria-label={`${member.displayName}の${label}`}
    >
      <input type="hidden" name="userId" value={member.userId} />
      <fieldset disabled={pending} className="directory-form-grid">
        <legend>{label}</legend>
        <FormField>
          <label htmlFor={`${id}-role`}>{granting ? '与える役割' : '取り消す役割'}</label>
          <select
            id={`${id}-role`}
            name="roleCode"
            required
            value={options.includes(roleCode) ? roleCode : (options[0] ?? '')}
            onChange={(event) => setRoleCode(event.target.value)}
          >
            {options.map((code) => (
              <option key={code} value={code}>
                {DIRECTORY_ROLE_LABELS[code] ?? code}
              </option>
            ))}
          </select>
        </FormField>
        {granting && (
          <FormField>
            <label htmlFor={`${id}-until`}>期限（任意）</label>
            <p className="hint" id={`${id}-until-hint`}>
              兼務・出向などの終了日を指定できます。期限が来ると自動で失効し、記録に残ります。
            </p>
            <input
              id={`${id}-until`}
              name="validUntil"
              type="date"
              aria-describedby={`${id}-until-hint`}
              value={validUntil}
              onChange={(event) => setValidUntil(event.target.value)}
            />
          </FormField>
        )}
        <FormField>
          <label htmlFor={`${id}-reason`}>{granting ? '付与の理由' : '取り消しの理由'}</label>
          <input
            id={`${id}-reason`}
            name="reason"
            type="text"
            required
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </FormField>
        <div className="directory-form-actions">
          <button type="submit" className="secondary" disabled={pending}>
            {pending ? '反映しています…' : label}
          </button>
        </div>
      </fieldset>
    </FeedbackForm>
  );
}

function AccessForm({ member, action }: { member: DirectoryMember; action: UserDirectoryAction }) {
  const { feedback, dispatch, pending } = useDirectoryAction(action);
  const [reason, setReason] = useState('');
  const id = useId();
  const stopped = member.status === 'deactivated';
  const label = stopped ? 'アクセスを戻す' : 'アクセスを止める';

  return (
    <details className="user-action directory-access-action">
      <summary>{label}</summary>
      {!stopped && member.openTicketCount > 0 && (
        <div className="notice" role="note">
          <p>
            対応中の問い合わせを {member.openTicketCount} 件持っています。
            先に別の担当者へ振り直すことをお勧めします。
          </p>
        </div>
      )}
      <FeedbackForm
        action={dispatch}
        feedback={feedback}
        pending={pending}
        className="directory-form"
        aria-label={`${member.displayName}の${label}`}
      >
        <input type="hidden" name="userId" value={member.userId} />
        <fieldset disabled={pending} className="directory-form-grid">
          <legend>{label}</legend>
          <FormField>
            <label htmlFor={`${id}-reason`}>{stopped ? '戻す理由' : '止める理由'}</label>
            <p className="hint" id={`${id}-reason-hint`}>
              {stopped
                ? '例: 休職から復帰 / 誤って停止した'
                : '例: 退職 / 端末の紛失により一時停止'}
            </p>
            <input
              id={`${id}-reason`}
              name="reason"
              type="text"
              required
              maxLength={500}
              aria-describedby={`${id}-reason-hint`}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </FormField>
          {!stopped && (
            <p className="hint">
              ログイン中のセッションも失効します。問い合わせの履歴と担当の記録は残ります。
            </p>
          )}
          <div className="directory-form-actions">
            <button type="submit" className={stopped ? 'secondary' : 'danger'} disabled={pending}>
              {pending ? '反映しています…' : label}
            </button>
          </div>
        </fieldset>
      </FeedbackForm>
    </details>
  );
}

export function UserMemberActions({
  member,
  isSelf,
  actions,
}: {
  member: DirectoryMember;
  isSelf: boolean;
  actions: {
    grant: UserDirectoryAction;
    revoke: UserDirectoryAction;
    deactivate: UserDirectoryAction;
    reactivate: UserDirectoryAction;
  };
}) {
  const stopped = member.status === 'deactivated';
  const grantable = DIRECTORY_ROLES.filter((code) => !member.roleCodes.includes(code));
  const revocable = DIRECTORY_ROLES.filter((code) => member.roleCodes.includes(code));

  return (
    <div className="directory-member-actions">
      {member.temporaryRoles.length > 0 && (
        <ul className="temporary-roles" aria-label="期限付きの役割">
          {member.temporaryRoles.map((role) => (
            <li
              key={`${role.roleCode}:${role.validUntil}`}
              className={role.expiringSoon ? 'soon' : undefined}
            >
              {DIRECTORY_ROLE_LABELS[role.roleCode] ?? role.roleCode} は{' '}
              {formatDateTime(role.validUntil)} まで
              {role.expiringSoon && <strong>（あと {Math.max(role.daysRemaining, 0)} 日）</strong>}
            </li>
          ))}
        </ul>
      )}
      {stopped && member.deactivatedAt && (
        <p className="hint">{formatDateTime(member.deactivatedAt)} にアクセスを停止しました。</p>
      )}
      {!stopped && (
        <details className="user-action">
          <summary>役割を変える</summary>
          {grantable.length > 0 ? (
            <RoleForm action={actions.grant} member={member} mode="grant" options={grantable} />
          ) : (
            <p className="hint">この画面で追加できる役割はすべて付与されています。</p>
          )}
          {revocable.length > 0 && (
            <RoleForm action={actions.revoke} member={member} mode="revoke" options={revocable} />
          )}
        </details>
      )}
      {isSelf ? (
        <p className="hint">自分自身のアクセスは止められません。</p>
      ) : (
        <AccessForm
          key={member.status}
          member={member}
          action={stopped ? actions.reactivate : actions.deactivate}
        />
      )}
    </div>
  );
}
