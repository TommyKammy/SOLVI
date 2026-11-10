'use client';
import { useActionState, useState } from 'react';
import { FeedbackForm, FormField } from './FeedbackForm';
import { ContextLink } from './ContextLink';
import { saveAsset } from '../app/assets/actions';
import type { AssetOptions, AssetView } from '../lib/api';
import type { FormFeedback } from '../lib/form-state';
export function AssetForm({ options, asset }: { options: AssetOptions; asset?: AssetView }) {
  const [feedback, action, pending] = useActionState(saveAsset.bind(null, asset?.id ?? null), {
    message: '',
  } as FormFeedback);
  const [values, setValues] = useState<Record<string, string>>({
    assetTag: asset?.assetTag ?? '',
    name: asset?.name ?? '',
    kind: asset?.kind ?? 'pc',
    state: asset?.state ?? 'stocked',
    model: asset?.model ?? '',
    serialNumber: asset?.serialNumber ?? '',
    hostname: asset?.hostname ?? '',
    vendor: asset?.vendor ?? '',
    assignedUserId: asset?.assignedUserId ?? '',
    location: asset?.location ?? '',
    internalNotes: asset?.internalNotes ?? '',
    reason: asset ? '' : '初回登録',
  });
  const set = (key: string, value: string) => {
    if (pending) return;
    setValues((v) => ({ ...v, [key]: value }));
  };
  const required = options.kinds.find((t) => t.code === values.kind)?.requiredFields ?? [];
  const allowedAssignment = ['in_use', 'repair'].includes(values.state);
  const text = (key: string, label: string, maxLength: number, mandatory = false) => (
    <FormField className="field" key={key}>
      <label htmlFor={`asset-${key}`}>
        {label}
        {mandatory ? '（必須）' : ''}
      </label>
      <input
        id={`asset-${key}`}
        name={key}
        type="text"
        value={values[key]}
        disabled={pending}
        onChange={(e) => set(key, e.target.value)}
        maxLength={maxLength}
        required={mandatory}
      />
    </FormField>
  );
  return (
    <FeedbackForm feedback={feedback} pending={pending} action={action} className="stack">
      <input type="hidden" name="expectedVersion" value={asset?.version ?? 1} />
      {text('assetTag', '資産タグ', 64, true)}
      {text('name', '資産名', 160, true)}
      <FormField className="field">
        <label htmlFor="asset-kind">種別</label>
        <select
          id="asset-kind"
          name="kind"
          value={values.kind}
          onChange={(e) => set('kind', e.target.value)}
          disabled={pending || !!asset}
        >
          {options.kinds.map((k) => (
            <option key={k.code} value={k.code}>
              {k.label}
            </option>
          ))}
        </select>
        {asset && (
          <>
            <input type="hidden" name="kind" value={values.kind} />
            <p className="hint">登録後は種別を変更できません。</p>
          </>
        )}
      </FormField>
      {options.fields.map((f) => text(f.key, f.label, 160, required.includes(f.key)))}
      <FormField className="field">
        <label htmlFor="asset-state">状態</label>
        <select
          id="asset-state"
          name="state"
          value={values.state}
          disabled={pending}
          onChange={(e) => {
            if (pending) return;
            setValues((v) => ({
              ...v,
              state: e.target.value,
              assignedUserId: ['stocked', 'retired'].includes(e.target.value)
                ? ''
                : v.assignedUserId,
            }));
          }}
        >
          {options.states
            .filter((s) => asset?.state !== 'retired' || s.code === 'retired')
            .map((s) => (
              <option key={s.code} value={s.code}>
                {s.label}
              </option>
            ))}
        </select>
        <p className="hint">廃止後は再稼働できません。履歴と関連チケットは残ります。</p>
      </FormField>
      <FormField className="field">
        <label htmlFor="asset-assigned">利用者</label>
        <select
          id="asset-assigned"
          name="assignedUserId"
          value={allowedAssignment ? values.assignedUserId : ''}
          onChange={(e) => set('assignedUserId', e.target.value)}
          disabled={pending || !allowedAssignment}
          required={values.state === 'in_use'}
        >
          <option value="">割当なし</option>
          {options.members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        {!allowedAssignment && <input type="hidden" name="assignedUserId" value="" />}
        <p className="hint">使用中は利用者が必須です。在庫・廃止では割当を外します。</p>
      </FormField>
      {text('location', '保管場所（担当者のみ）', 200)}
      <FormField className="field">
        <label htmlFor="asset-notes">内部メモ（担当者のみ）</label>
        <textarea
          id="asset-notes"
          name="internalNotes"
          disabled={pending}
          value={values.internalNotes}
          onChange={(e) => set('internalNotes', e.target.value)}
          maxLength={4000}
        />
      </FormField>
      <FormField className="field">
        <label htmlFor="asset-reason">{asset ? '変更する理由' : '登録の理由'}</label>
        <textarea
          id="asset-reason"
          name="reason"
          disabled={pending}
          value={values.reason}
          onChange={(e) => set('reason', e.target.value)}
          required
          maxLength={1000}
        />
      </FormField>
      <p className="hint">手入力の検証用台帳です。実端末の情報取得や外部同期は行いません。</p>
      <div className="form-actions">
        <button disabled={pending}>
          {pending ? '保存しています…' : asset ? '変更と履歴を保存する' : '資産を登録する'}
        </button>
        <ContextLink back href={asset ? `/assets/${asset.id}` : '/assets'}>
          キャンセルして戻る
        </ContextLink>
      </div>
    </FeedbackForm>
  );
}
