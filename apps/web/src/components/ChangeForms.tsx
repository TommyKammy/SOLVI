'use client';
import { startTransition, useActionState, useState } from 'react';
import { FeedbackForm, FormField } from './FeedbackForm';
import { ContextLink } from './ContextLink';
import { saveChange, runChangeCommand } from '../app/changes/actions';
import type { ChangeOptions, ChangeDetail } from '../lib/api';
import type { FormFeedback } from '../lib/form-state';
import { jstInput } from '../lib/change-labels';
import { assetStateLabel } from '../lib/asset-labels';
import type { FormEvent } from 'react';
function dispatchForm(event: FormEvent<HTMLFormElement>, action: (form: FormData) => void) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  startTransition(() => action(data));
}
export function ChangePlanForm({
  options,
  current,
  userId,
  creationKey,
  commandKey,
  ticketId,
  assetId,
}: {
  options: ChangeOptions;
  current?: ChangeDetail['change'];
  userId: string;
  creationKey: string;
  commandKey: string;
  ticketId?: string;
  assetId?: string;
}) {
  const s = current?.snapshot;
  const [values, setValues] = useState<Record<string, string>>({
    title: s?.title ?? '',
    ticketId: s?.ticket.id ?? ticketId ?? '',
    ownerId:
      s?.owner.id ??
      (options.owners.some((o) => o.id === userId) ? userId : (options.owners[0]?.id ?? '')),
    approverId: s?.approver?.id ?? '',
    purpose: s?.purpose ?? '',
    impact: s?.impact ?? '',
    risk: s?.risk ?? 'low',
    implementationPlan: s?.implementationPlan ?? '',
    testPlan: s?.testPlan ?? '',
    backoutPlan: s?.backoutPlan ?? '',
    plannedStart: jstInput(s?.plannedStart ?? new Date().toISOString()),
    plannedEnd: jstInput(s?.plannedEnd ?? new Date(Date.now() + 3600000).toISOString()),
    reason: current ? '' : '初回計画',
  });
  const [selected, setSelected] = useState(
    s?.assets.map((a) => a.id) ?? (assetId ? [assetId] : []),
  );
  const [feedback, action, pending] = useActionState(saveChange.bind(null, current?.id ?? null), {
    message: '',
  } as FormFeedback);
  const set = (key: string, value: string) => setValues((v) => ({ ...v, [key]: value }));
  const candidates = [
    ...options.assets,
    ...(s?.assets ?? []).filter((a) => !options.assets.some((b) => a.id === b.id)),
  ];
  const field = (key: string, label: string, area = false, required = false) => (
    <FormField className="field" key={key}>
      <label htmlFor={`chg-${key}`}>
        {label}
        {required ? '（必須）' : ''}
      </label>
      {area ? (
        <textarea
          id={`chg-${key}`}
          name={key}
          value={values[key]}
          onChange={(e) => set(key, e.target.value)}
          rows={3}
          maxLength={4000}
        />
      ) : (
        <input
          id={`chg-${key}`}
          name={key}
          value={values[key]}
          onChange={(e) => set(key, e.target.value)}
          maxLength={key === 'title' ? 160 : 1000}
          required={required}
        />
      )}
    </FormField>
  );
  const example = () =>
    setValues((v) => ({
      ...v,
      title: v.title || '合成例: 監視設定の見直し',
      purpose: '合成例: 検証用の監視通知を見直す',
      impact: '合成資産だけを対象に想定影響を確認。実環境への変更なし。',
      implementationPlan: '合成例の変更手順と作業順を確認し、実施したものとして記録する。',
      testPlan: '合成の通知と復旧を確認した結果を記録する。',
      backoutPlan: '失敗時は仮の旧設定へ戻す手順を記録する。実機の設定変更は行わない。',
    }));
  return (
    <FeedbackForm
      feedback={feedback}
      pending={pending}
      method="post"
      onSubmit={(e) => dispatchForm(e, action)}
      className="stack"
    >
      <input type="hidden" name="creationKey" value={creationKey} />
      <input type="hidden" name="commandKey" value={commandKey} />
      <input type="hidden" name="expectedVersion" value={current?.version ?? 1} />
      <p>通常変更 · ローカルの計画と合成結果を保存します。申請には全計画が必要です。</p>
      {field('title', '変更のタイトル', false, true)}
      <FormField className="field">
        <label htmlFor="chg-ticket">元のチケット（必須）</label>
        <select
          id="chg-ticket"
          name="ticketId"
          value={values.ticketId}
          onChange={(e) => set('ticketId', e.target.value)}
          required
        >
          <option value="">チケットを選択</option>
          {[
            ...options.tickets,
            ...(s?.ticket && !options.tickets.some((t) => t.id === s.ticket.id) ? [s.ticket] : []),
          ].map((t) => (
            <option key={t.id} value={t.id}>
              {t.number} · {t.subject}
            </option>
          ))}
        </select>
        <p className="hint">
          候補は最新50件です。チケットの担当者画面から開くとそのチケットを選べます。
        </p>
      </FormField>
      <FormField name="assetIds">
        <fieldset>
          <legend>対象資産（1〜10件・必須）</legend>
          <p className="hint">
            活動中の資産の先頭50件と現在の対象です。保存時の資産版を承認対象に固定します。
          </p>
          {candidates.map((a) => (
            <label key={a.id} style={{ display: 'block', marginBottom: '.5rem' }}>
              <input
                type="checkbox"
                name="assetIds"
                value={a.id}
                checked={selected.includes(a.id)}
                disabled={a.state === 'retired' && !selected.includes(a.id)}
                onChange={(e) =>
                  setSelected((v) =>
                    e.target.checked ? [...v, a.id] : v.filter((id) => id !== a.id),
                  )
                }
              />{' '}
              {a.assetTag} · {a.name}（{assetStateLabel(a.state)} · 版{a.version}）
            </label>
          ))}
        </fieldset>
      </FormField>
      <FormField className="field">
        <label htmlFor="chg-owner">実施担当者（必須）</label>
        <select
          id="chg-owner"
          name="ownerId"
          value={values.ownerId}
          onChange={(e) => {
            set('ownerId', e.target.value);
            if (values.approverId === e.target.value) set('approverId', '');
          }}
          required
        >
          {s?.owner && !options.owners.some((o) => o.id === s.owner.id) && (
            <option value={s.owner.id}>{s.owner.name}（現在は担当対象外・再選択が必要）</option>
          )}
          {options.owners.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </FormField>
      <FormField className="field">
        <label htmlFor="chg-approver">承認者（申請時に必須）</label>
        <select
          id="chg-approver"
          name="approverId"
          value={values.approverId}
          onChange={(e) => set('approverId', e.target.value)}
        >
          <option value="">別の承認者を選択</option>
          {s?.approver && !options.approvers.some((a) => a.id === s.approver?.id) && (
            <option value={s.approver.id}>
              {s.approver.name}（現在は承認対象外・再選択が必要）
            </option>
          )}
          {options.approvers
            .filter((a) => a.id !== values.ownerId && a.id !== current?.createdBy)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
        </select>
        <p className="hint">作成者と実施担当者は自己承認できません。</p>
      </FormField>
      <button type="button" className="secondary" onClick={example} disabled={pending}>
        計画の合成例を入力する
      </button>
      {field('purpose', '目的', true)}
      {field('impact', '影響', true)}
      <FormField className="field">
        <label htmlFor="chg-risk">リスク</label>
        <select
          id="chg-risk"
          name="risk"
          value={values.risk}
          onChange={(e) => set('risk', e.target.value)}
        >
          <option value="low">低</option>
          <option value="medium">中</option>
          <option value="high">高</option>
        </select>
      </FormField>
      {field('implementationPlan', '実施計画', true)}
      {field('testPlan', 'テスト計画', true)}
      {field('backoutPlan', '切戻し計画', true)}
      {['plannedStart', 'plannedEnd'].map((key) => (
        <FormField className="field" key={key}>
          <label htmlFor={`chg-${key}`}>
            {key === 'plannedStart' ? '予定開始' : '予定終了'}（日本時間・JST）
          </label>
          <input
            type="datetime-local"
            id={`chg-${key}`}
            name={key}
            value={values[key]}
            onChange={(e) => set(key, e.target.value)}
          />
        </FormField>
      ))}
      {current && (
        <p className="hint">
          保存すると新しい計画版の下書きに戻り、これまでの承認では開始できなくなります。
        </p>
      )}
      {field('reason', current ? '変更理由' : '登録理由', false, true)}
      <div className="form-actions">
        <button disabled={pending}>
          {pending
            ? '保存しています…'
            : current
              ? '計画を保存し再承認の準備をする'
              : '変更計画を下書きで保存する'}
        </button>
        <ContextLink back href={current ? `/changes/${current.id}` : '/changes'}>
          キャンセルして戻る
        </ContextLink>
      </div>
    </FeedbackForm>
  );
}
const definitions: Record<string, { title: string; reason: string; button: string }> = {
  submit: {
    title: '承認を依頼する',
    reason: '計画と対象を確認して承認を依頼',
    button: 'この計画を承認者へ申請する',
  },
  approve: {
    title: '計画を承認する',
    reason: '計画・対象・切戻し手順を確認しました',
    button: 'この版の計画を承認する',
  },
  reject: { title: '計画を却下する', reason: '', button: '理由を添えて却下する' },
  schedule: { title: '予定を確定する', reason: '', button: '承認した対象と予定を確定する' },
  start: {
    title: '合成の実施開始を記録する',
    reason: '合成例の実施開始を記録',
    button: '対象を確認して実施開始を記録する',
  },
  result: { title: '合成の実施結果を記録する', reason: '', button: '実施結果を保存する' },
  pir: { title: '実施後レビュー（PIR）を記録する', reason: '', button: '実施後レビューを保存する' },
  cancel: { title: '変更を取り消す', reason: '', button: '理由を添えて取り消す' },
};
export function ChangeCommandForm({
  detail,
  kind,
  commandKey,
}: {
  detail: ChangeDetail;
  kind: string;
  commandKey: string;
}) {
  const [feedback, action, pending] = useActionState(
    runChangeCommand.bind(null, detail.change.id, kind),
    { message: '' } as FormFeedback,
  );
  const definition = definitions[kind]!;
  const [values, setValues] = useState<Record<string, string>>({
    reason: definition.reason,
    outcome: 'completed',
    summary: '',
    testResults: '',
    backoutReason: '',
    rootCause: '',
    lessons: '',
    prevention: '',
  });
  const [confirmed, setConfirmed] = useState(false),
    [backout, setBackout] = useState(false);
  const set = (key: string, value: string) => setValues((v) => ({ ...v, [key]: value }));
  const field = (key: string, label: string, area = false) => (
    <FormField className="field" key={key}>
      <label htmlFor={`${kind}-${key}`}>{label}（必須）</label>
      {area ? (
        <textarea
          id={`${kind}-${key}`}
          name={key}
          value={values[key]}
          onChange={(e) => set(key, e.target.value)}
          rows={3}
          required
          maxLength={4000}
        />
      ) : (
        <input
          id={`${kind}-${key}`}
          name={key}
          value={values[key]}
          onChange={(e) => set(key, e.target.value)}
          required
          maxLength={1000}
        />
      )}
    </FormField>
  );
  return (
    <FeedbackForm
      feedback={feedback}
      pending={pending}
      method="post"
      onSubmit={(e) => dispatchForm(e, action)}
      className="stack"
    >
      <h3>{definition.title}</h3>

      <input type="hidden" name="expectedVersion" value={detail.change.version} />
      <input type="hidden" name="commandKey" value={commandKey} />
      <input type="hidden" name="snapshotHash" value={detail.change.snapshotHash} />
      <input type="hidden" name="approvalId" value={detail.change.currentApprovalId ?? ''} />
      {kind === 'schedule' && (
        <>
          {detail.conflicts.map((c) => (
            <input key={c.id} type="hidden" name="conflictIds" value={c.id} />
          ))}
          {detail.conflicts.length > 0 ? (
            <div role="alert">
              <p>同じ資産の予定が重なっています。実施順を確認し、確定理由を記録してください。</p>
              <ul>
                {detail.conflicts.map((c) => (
                  <li key={c.id}>
                    <a href={`/changes/${c.id}`}>
                      {c.number} · {c.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p>現在、対象資産の予定の重複はありません。</p>
          )}
        </>
      )}
      {['schedule', 'start'].includes(kind) && (
        <label>
          <input
            type="checkbox"
            name="confirmed"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            required
          />{' '}
          承認した計画版・対象資産と現在の予定を確認しました。実環境への操作は行いません。
        </label>
      )}
      {kind === 'result' && (
        <>
          <p>合成の記録だけを保存します。外部変更は0件です。</p>
          <button
            type="button"
            className="secondary"
            disabled={pending}
            onClick={() => {
              setValues((v) => ({
                ...v,
                outcome: 'failed',
                summary: '合成例: テストで問題を確認し、変更を失敗として記録',
                testResults: '合成の復旧テストで期待する通知を確認できなかった',
                backoutReason: '合成例の旧設定へ切り戻したものとして記録',
              }));
              setBackout(true);
            }}
          >
            失敗と切戻しの合成例を入力する
          </button>
          <FormField className="field">
            <label htmlFor="result-outcome">結果</label>
            <select
              id="result-outcome"
              name="outcome"
              value={values.outcome}
              onChange={(e) => set('outcome', e.target.value)}
            >
              <option value="completed">成功</option>
              <option value="failed">失敗</option>
            </select>
          </FormField>
          {field('summary', '実施結果', true)}
          {field('testResults', 'テスト結果', true)}
          <label>
            <input
              type="checkbox"
              name="backoutPerformed"
              checked={backout}
              onChange={(e) => setBackout(e.target.checked)}
            />{' '}
            切戻しを実施したものとして記録する
          </label>
          {field('backoutReason', '切戻しの内容・実施しない理由', true)}
        </>
      )}
      {kind === 'pir' && (
        <>
          <button
            type="button"
            className="secondary"
            disabled={pending}
            onClick={() =>
              setValues((v) => ({
                ...v,
                rootCause: '合成例: 監視条件の確認不足',
                lessons: '合成の事前テストで通知と復旧の両方を確認する',
                prevention: '実施前チェックに復旧通知の確認を追加する',
              }))
            }
          >
            レビューの合成例を入力する
          </button>
          {field('rootCause', '原因・振り返り', true)}
          {field('lessons', '教訓', true)}
          {field('prevention', '再発防止', true)}
        </>
      )}
      {!['result', 'pir', 'start'].includes(kind) &&
        field(
          'reason',
          kind === 'reject'
            ? '却下理由'
            : kind === 'schedule'
              ? '予定を確定する理由'
              : kind === 'cancel'
                ? '取り消し理由'
                : '確認理由',
        )}
      {['result', 'pir', 'start'].includes(kind) && (
        <input type="hidden" name="reason" value={values.reason} />
      )}
      <button disabled={pending}>{pending ? '保存しています…' : definition.button}</button>
    </FeedbackForm>
  );
}
