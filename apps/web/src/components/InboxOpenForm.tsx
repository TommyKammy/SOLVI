'use client';
import { useActionState } from 'react';
import { FeedbackForm } from './FeedbackForm';
import { openInboxItem } from '../app/inbox/actions';
import type { InboxItem } from '../lib/api';
import type { FormFeedback } from '../lib/form-state';
import { ticketEntryId } from '../lib/navigation';
export function InboxOpenForm({
  item,
  restoreFocus = false,
}: {
  item: InboxItem;
  restoreFocus?: boolean;
}) {
  const [feedback, action, pending] = useActionState(openInboxItem, {
    message: '',
  } as FormFeedback);
  return (
    <FeedbackForm feedback={feedback} pending={pending} returnToCurrent action={action}>
      <input type="hidden" name="kind" value={item.kind} />
      <input type="hidden" name="id" value={item.id} />
      <input type="hidden" name="eventKey" value={item.eventKey} />

      <button
        type="submit"
        id={restoreFocus && item.kind === 'ticket' ? ticketEntryId(item.id) : undefined}
        disabled={pending}
      >
        {pending ? '更新を確認しています…' : item.nextAction}
      </button>
    </FeedbackForm>
  );
}
