'use client';
import { useActionState, useState } from 'react';
import { FeedbackForm, FormField } from './FeedbackForm';
import type { FormFeedback } from '../lib/form-state';
export function TicketRoutingForm({
  action,
  expectedVersion,
  groupId,
  groups,
}: {
  action: (previous: FormFeedback, form: FormData) => Promise<FormFeedback>;
  expectedVersion: string;
  groupId: string;
  groups: Array<{ id: string; name: string; memberCount: number }>;
}) {
  const [feedback, dispatch, pending] = useActionState(action, { message: '' } as FormFeedback);
  const [selectedGroup, setGroup] = useState(groupId);
  return (
    <FeedbackForm
      action={dispatch}
      feedback={feedback}
      pending={pending}
      className="stack"
      style={{ maxWidth: '28rem' }}
    >
      <input type="hidden" name="expectedVersion" value={expectedVersion} />
      <FormField>
        <label htmlFor="group-select">担当グループ</label>
        <span className="hint" id="group-select-hint">
          振り先を変えても、いまの担当者はそのままです
        </span>
        <select
          id="group-select"
          name="groupId"
          value={selectedGroup}
          onChange={(e) => setGroup(e.target.value)}
          aria-describedby="group-select-hint"
        >
          <option value="">どのグループにも振らない</option>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}({group.memberCount}人)
            </option>
          ))}
        </select>
      </FormField>
      <button type="submit" className="secondary" disabled={pending}>
        {pending ? '保存しています…' : '振り先を変える'}
      </button>
    </FeedbackForm>
  );
}
