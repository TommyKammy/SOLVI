'use client';

import { useActionState, useState } from 'react';
import { FeedbackForm, FormField } from './FeedbackForm';
import { FormDraftRecovery } from './FormDraftRecovery';
import { draftKey, type DraftValues } from '../lib/form-draft';
import { ContextLink } from './ContextLink';
import { createTicket } from '../app/tickets/new/actions';

export function TicketForm({ kind, scope }: { kind: 'incident' | 'request'; scope: string }) {
  const [feedback, action, pending] = useActionState(createTicket, { message: '' });
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const incident = kind === 'incident';
  const baseline = { subject: '', body: '', impact: 'low', urgency: incident ? 'high' : 'medium' };
  const [impact, setImpact] = useState(baseline.impact);
  const [urgency, setUrgency] = useState(baseline.urgency);
  const formKey = `ticket:new:${kind}`;
  const restore = (v: DraftValues) => {
    if (v.subject !== undefined) setSubject(v.subject);
    if (v.body !== undefined) setBody(v.body);
    if (['low', 'medium', 'high'].includes(v.impact)) setImpact(v.impact);
    if (['low', 'medium', 'high'].includes(v.urgency)) setUrgency(v.urgency);
  };

  return (
    <FeedbackForm
      feedback={feedback}
      pending={pending}
      className="stack request-form"
      action={action}
      onSuccess={() => {
        try {
          sessionStorage.removeItem(draftKey(scope, formKey));
        } catch {
          /* disabled */
        }
      }}
      onReset={(event) => event.preventDefault()}
    >
      <input type="hidden" name="kind" value={kind} />
      <FormDraftRecovery
        scope={scope}
        formKey={formKey}
        version="new"
        baseline={baseline}
        values={{ subject, body, impact, urgency }}
        labels={{ subject: '件名', body: '内容', impact: '影響の範囲', urgency: '急ぎ具合' }}
        onRestore={restore}
      />

      <FormField className="field">
        <label htmlFor="subject">件名</label>
        <span className="hint" id="subject-hint">
          {incident ? '例: 経費精算システムにログインできない' : '例: 新入社員のアカウント作成'}
        </span>
        <input
          id="subject"
          name="subject"
          required
          maxLength={200}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          aria-describedby="subject-hint"
        />
      </FormField>
      <FormField className="field">
        <label htmlFor="body">内容</label>
        <span className="hint" id="body-hint">
          {incident
            ? 'いつから、何をしたときに、どうなるかをお知らせください。パスワードは記載しないでください。'
            : '必要な理由と希望する時期をお知らせください。'}
        </span>
        <textarea
          id="body"
          name="body"
          required
          maxLength={10000}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          aria-describedby="body-hint"
        />
      </FormField>
      <div className="form-columns">
        <FormField className="field">
          <label htmlFor="impact">影響の範囲</label>
          <select
            id="impact"
            name="impact"
            value={impact}
            onChange={(e) => setImpact(e.target.value)}
          >
            <option value="low">自分だけ困っている</option>
            <option value="medium">同じ部署の何人かが困っている</option>
            <option value="high">部署全体・全社が困っている</option>
          </select>
        </FormField>
        <FormField className="field">
          <label htmlFor="urgency">急ぎ具合</label>
          <select
            id="urgency"
            name="urgency"
            value={urgency}
            onChange={(e) => setUrgency(e.target.value)}
          >
            <option value="low">数日待てる</option>
            <option value="medium">今日中に解決したい</option>
            <option value="high">いま業務が止まっている</option>
          </select>
        </FormField>
      </div>
      <p className="hint">
        送信すると受付番号を発行します。担当者とのやり取りは問い合わせ詳細に残ります。
      </p>
      <div className="form-actions">
        <button type="submit" disabled={pending}>
          {pending ? '送信しています…' : incident ? '障害を報告する' : '依頼を送信する'}
        </button>
        <ContextLink back href="/portal">
          キャンセルして戻る
        </ContextLink>
      </div>
    </FeedbackForm>
  );
}
