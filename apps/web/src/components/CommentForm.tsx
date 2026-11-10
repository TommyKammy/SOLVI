'use client';
import { useActionState } from 'react';
import { postPublicComment } from '../app/tickets/[id]/comment-actions';
import { ConversationInputProtection } from './ConversationInputProtection';
import { useConversationInput } from '../lib/use-conversation-input';
import type { ReplyContext } from '../lib/api';
import { FeedbackForm, FormField } from './FeedbackForm';
import type { FormFeedback } from '../lib/form-state';
export function CommentForm({
  ticketId,
  scope,
  replyContext,
  errorMessage,
}: {
  ticketId: string;
  scope: string;
  replyContext: ReplyContext;
  errorMessage?: string;
}) {
  const [feedback, action, pending] = useActionState(postPublicComment.bind(null, ticketId), {
    message: errorMessage ?? '',
  } as FormFeedback);
  const formKey = `conversation:${ticketId}`;
  const input = useConversationInput(scope, formKey, replyContext, feedback);
  const { body } = input.draft;
  return (
    <FeedbackForm feedback={feedback} pending={pending} className="stack" action={action}>
      <FormField>
        <label htmlFor="comment-body">担当者へ追加で知らせる内容</label>
        <textarea
          id="comment-body"
          name="body"
          disabled={pending}
          value={body}
          onChange={(event) => input.update({ body: event.target.value })}
          maxLength={10000}
          required
        />
        <p className="hint">この内容は担当者とのやり取りに表示されます。</p>
      </FormField>
      <button disabled={pending || input.changed}>
        {pending ? '送信しています…' : '追加内容を送信する'}
      </button>
      <ConversationInputProtection
        scope={scope}
        formKey={formKey}
        visibility="public"
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
