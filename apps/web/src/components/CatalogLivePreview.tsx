'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  normalizeCatalogPreviewValues,
  validateCatalogPreviewConfig,
  validateCatalogPreviewInput,
  type CatalogPreviewConfig,
  type CatalogPreviewIssue,
} from '../lib/catalog-preview';
import styles from './CatalogLivePreview.module.css';
import { CatalogFieldInputs } from './CatalogFieldInputs';
import { catalogRequestFieldVisibility, type CatalogValues } from '@solvi/shared/catalog';

export type CatalogLivePreviewProps = CatalogPreviewConfig & { disabled?: boolean };

/** This form is a sibling of the editor form. It never saves or sends a request. */
export function CatalogLivePreview({ disabled = false, ...config }: CatalogLivePreviewProps) {
  const id = `catalog-try-${useId().replaceAll(':', '')}`;
  const [reason, setReason] = useState('');
  const [selectedDuration, setSelectedDuration] = useState<string>();
  const visibleRequestFields = catalogRequestFieldVisibility(config);
  // Once a common field is hidden, its previous sample must not reappear when enabled again.
  if (!visibleRequestFields.reason && reason !== '') setReason('');
  if (!visibleRequestFields.duration && selectedDuration !== undefined)
    setSelectedDuration(undefined);
  const fieldsSignature = JSON.stringify(config.fields);
  const [samples, setSamples] = useState(() => ({
    signature: fieldsSignature,
    fields: config.fields.map(({ key, type }) => ({ key, type })),
    values: {} as CatalogValues,
  }));
  const values = normalizeCatalogPreviewValues(samples.fields, config.fields, samples.values);
  // Commit the new definition before another interaction, so removed values cannot reappear.
  if (samples.signature !== fieldsSignature) {
    setSamples({
      signature: fieldsSignature,
      fields: config.fields.map(({ key, type }) => ({ key, type })),
      values,
    });
  }
  const [result, setResult] = useState<{
    signature: string;
    issues: CatalogPreviewIssue[];
  } | null>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const definition = validateCatalogPreviewConfig(config);
  const signature = JSON.stringify(config);
  const issues = result?.signature === signature ? result.issues : null;
  useEffect(() => {
    if (result !== null) feedback.current?.focus();
  }, [result]);
  const duration =
    selectedDuration === undefined
      ? String(definition.durations[0] ?? '')
      : definition.durations.includes(Number(selectedDuration))
        ? selectedDuration
        : '';
  const change = (next: CatalogValues) => {
    setSamples({
      signature: fieldsSignature,
      fields: config.fields.map(({ key, type }) => ({ key, type })),
      values: next,
    });
    setResult(null);
  };
  const issueFor = (key: string) => issues?.find((issue) => issue.field === key)?.message;
  const controlId = (index: number) => `${id}-field-${index}`;
  function test(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (disabled) return;
    setResult({
      signature,
      issues: validateCatalogPreviewInput(config, {
        ...(visibleRequestFields.reason ? { reason } : {}),
        ...(visibleRequestFields.duration ? { durationDays: Number(duration) } : {}),
        values,
      }),
    });
  }
  return (
    <aside className={styles.preview} aria-labelledby={`${id}-heading`}>
      <div className={styles.heading}>
        <h2 id={`${id}-heading`}>編集中のプレビュー</h2>
        <span className={styles.badge}>未保存の入力を反映</span>
      </div>
      <p className={styles.note}>
        利用者の見え方と入力条件を試せます。保存・公開・申請送信は行いません。
      </p>
      {definition.errors.length > 0 && (
        <details className={styles.configuration}>
          <summary>入力試験の前に設定を確認（{definition.errors.length}件）</summary>
          <ul>
            {definition.errors.map((issue, index) => (
              <li key={`${issue.field}-${index}`}>{issue.message}</li>
            ))}
          </ul>
        </details>
      )}
      <form
        onSubmit={test}
        noValidate
        aria-label="編集中フォームの入力試験"
        className={styles.form}
      >
        <h3>{config.title.trim() || 'サービス名を入力してください'}</h3>
        <p className={styles.description}>
          {config.description.trim() || 'ここに利用者への説明が表示されます。'}
        </p>
        <fieldset disabled={disabled} className={styles.controls}>
          <legend className="visually-hidden">利用者として入力を試す</legend>
          {visibleRequestFields.reason && (
            <div className={styles.field}>
              <label htmlFor={`${id}-reason`}>利用する理由（必須）</label>
              <textarea
                id={`${id}-reason`}
                value={reason}
                required
                maxLength={
                  Number.isInteger(config.maxReason) && config.maxReason > 0
                    ? config.maxReason
                    : undefined
                }
                aria-invalid={Boolean(issueFor('reason'))}
                aria-describedby={issueFor('reason') ? `${id}-reason-error` : undefined}
                onChange={(event) => {
                  setReason(event.target.value);
                  setResult(null);
                }}
              />
              {issueFor('reason') && (
                <p className={styles.error} id={`${id}-reason-error`}>
                  {issueFor('reason')}
                </p>
              )}
            </div>
          )}
          {visibleRequestFields.duration && (
            <div className={styles.field}>
              <label htmlFor={`${id}-days`}>希望する利用日数（必須）</label>
              <select
                id={`${id}-days`}
                value={duration}
                required
                aria-invalid={Boolean(issueFor('durationDays'))}
                aria-describedby={issueFor('durationDays') ? `${id}-days-error` : undefined}
                onChange={(event) => {
                  setSelectedDuration(event.target.value);
                  setResult(null);
                }}
              >
                <option value="">選んでください</option>
                {definition.durations.map((days) => (
                  <option value={days} key={days}>
                    {days}日
                  </option>
                ))}
              </select>
              {issueFor('durationDays') && (
                <p className={styles.error} id={`${id}-days-error`}>
                  {issueFor('durationDays')}
                </p>
              )}
            </div>
          )}
          <CatalogFieldInputs
            fields={config.fields}
            sections={config.sections}
            values={values}
            onChange={change}
            disabled={disabled}
            idPrefix={id}
            fieldId={(_field, index) => controlId(index)}
            namedControls={false}
            errors={issues ?? []}
          />
          <p className={styles.approver}>
            承認を依頼する相手：
            {config.approvers.find((person) => person.id === config.approver)?.name ?? '未設定'}
          </p>
          <div className={styles.actions}>
            <button type="submit" disabled={definition.errors.length > 0}>
              入力を試す
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setReason('');
                setSelectedDuration(undefined);
                setSamples({
                  signature: fieldsSignature,
                  fields: config.fields.map(({ key, type }) => ({ key, type })),
                  values: {},
                });
                setResult(null);
              }}
            >
              試験入力をクリアする
            </button>
          </div>
        </fieldset>
        {issues !== null && (
          <div
            className={issues.length ? styles.feedbackError : styles.feedbackSuccess}
            ref={feedback}
            tabIndex={-1}
            role="status"
          >
            {issues.length ? (
              <>
                <p>入力条件を確認してください。申請は送信されません。</p>
                <ul>
                  {issues.map((issue, index) => (
                    <li key={`${issue.field}-${index}`}>{issue.message}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p>入力を確認しました。申請は送信されません。</p>
            )}
          </div>
        )}
      </form>
    </aside>
  );
}
