'use client';

import { useActionState } from 'react';
import { FeedbackForm, FormField } from './FeedbackForm';
import { ConversationInputProtection } from './ConversationInputProtection';
import { useConversationInput } from '../lib/use-conversation-input';
import type { ReplyContext } from '../lib/api';
import type { FormFeedback } from '../lib/form-state';
import { sendReply } from '../app/ops/[id]/reply-actions';

export function ReplyForm({
  ticketId,
  scope,
  replyContext,
  canResolve,
  articles = [],
}: {
  ticketId: string;
  scope: string;
  replyContext: ReplyContext;
  canResolve: boolean;
  articles?: Array<{ id: string; contentVersion: number; title: string; audience: string }>;
}) {
  const [feedback, action, pending] = useActionState(sendReply.bind(null, ticketId), {
    message: '',
  } as FormFeedback);
  const formKey = `conversation:${ticketId}`;
  const input = useConversationInput(scope, formKey, replyContext, feedback);
  const { visibility, setVisibility } = input;
  const { body, citation } = input.draft;
  const updateDraft = input.update;
  return (
    <FeedbackForm
      feedback={feedback}
      pending={pending}
      className={`stack reply-panel ${visibility === 'internal' ? 'internal-composer' : 'public-composer'}`}
      action={action}
      onReset={(event) => event.preventDefault()}
    >
      <fieldset key={feedback.attempt ?? 0} className="visibility" disabled={pending}>
        <legend>投稿の公開範囲</legend>
        <div className="choice">
          <input
            id="reply-public"
            type="radio"
            name="visibility"
            value="public"
            checked={visibility === 'public'}
            onChange={() => setVisibility('public')}
          />
          <label htmlFor="reply-public">
            依頼者へ返信<span className="note">依頼者の画面に表示されます。</span>
          </label>
        </div>
        <div className="choice">
          <input
            id="reply-internal"
            type="radio"
            name="visibility"
            value="internal"
            checked={visibility === 'internal'}
            onChange={() => setVisibility('internal')}
          />
          <label htmlFor="reply-internal">
            内部メモ<span className="note">担当者だけが見られます。</span>
          </label>
        </div>
      </fieldset>
      <p className="hint" role="status">
        {visibility === 'public'
          ? 'この本文は依頼者の画面に表示されます。'
          : 'この本文は担当者だけに表示されます。'}
        公開返信と内部メモの入力は別々に保持し、切り替えても転記しません。
      </p>
      <FormField className="field">
        <label htmlFor="reply-body">
          {visibility === 'public' ? '依頼者への返信内容' : '内部メモの内容'}
        </label>
        <textarea
          id="reply-body"
          name="body"
          disabled={pending}
          required
          maxLength={10000}
          value={body}
          onChange={(e) => updateDraft({ body: e.target.value })}
          aria-describedby="reply-hint"
        />
        <span className="hint" id="reply-hint">
          解決する場合は、実施した対応と利用者に確認してほしい内容を記載してください。
        </span>
      </FormField>
      <FormField className="field">
        <label htmlFor="reply-citation">ナレッジ記事を引用する（任意）</label>
        <select
          id="reply-citation"
          name="citation"
          value={citation}
          onChange={(e) => updateDraft({ citation: e.target.value })}
          disabled={pending}
        >
          <option value="">引用しない</option>
          {articles
            .filter((a) => visibility === 'internal' || a.audience === 'organization')
            .map((a) => (
              <option key={a.id} value={`${a.id}:${a.contentVersion}`}>
                {a.title}（版 {a.contentVersion}）{a.audience === 'staff' ? '・担当者限定' : ''}
              </option>
            ))}
        </select>
        <span className="hint">
          送信時の公開版を固定して記録します。
          <a href="/knowledge" target="_blank" rel="noreferrer">
            記事の内容を別のタブで確認
          </a>
        </span>
      </FormField>
      <div className="actions-row">
        <button type="submit" name="outcome" value="reply" disabled={pending || input.changed}>
          {pending
            ? '保存しています…'
            : visibility === 'internal'
              ? '内部メモを保存する'
              : '返信する'}
        </button>
        {canResolve && visibility === 'public' && (
          <button
            type="submit"
            name="outcome"
            value="resolve"
            className="secondary"
            disabled={pending || input.changed}
          >
            返信して解決にする
          </button>
        )}
      </div>
      <ConversationInputProtection
        scope={scope}
        formKey={formKey}
        visibility={visibility}
        current={replyContext}
        draft={input.draft}
        changed={input.changed}
        pending={pending}
        feedback={feedback}
        restore={input.restore}
        reload={input.reload}
        acknowledge={input.acknowledge}
      />
    </FeedbackForm>
  );
}
