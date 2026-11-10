'use server';
import { redirect } from 'next/navigation';
import { withReturnTo } from '../../lib/navigation';
import { revalidatePath } from 'next/cache';
import { api } from '../../lib/api';
import type { FormFeedback } from '../../lib/form-state';
function isoJst(value: string) {
  if (!value) return null;
  const date = new Date(value + '+09:00');
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}
export async function saveChange(
  id: string | null,
  previous: FormFeedback,
  form: FormData,
): Promise<FormFeedback> {
  const keys = [
    'title',
    'ticketId',
    'ownerId',
    'approverId',
    'purpose',
    'impact',
    'risk',
    'implementationPlan',
    'testPlan',
    'backoutPlan',
    'reason',
  ];
  const fields = Object.fromEntries(keys.map((k) => [k, String(form.get(k) ?? '')]));
  const body = {
    ...fields,
    type: 'normal',
    approverId: fields.approverId || null,
    assetIds: form.getAll('assetIds').map(String),
    plannedStart: isoJst(String(form.get('plannedStart') ?? '')),
    plannedEnd: isoJst(String(form.get('plannedEnd') ?? '')),
  };
  const r = id
    ? await api.changeCommand(id, 'edit', {
        ...body,
        expectedVersion: Number(form.get('expectedVersion')),
        commandKey: String(form.get('commandKey') ?? ''),
      })
    : await api.createChange({ ...body, creationKey: String(form.get('creationKey') ?? '') });
  if (!r.ok)
    return {
      message: r.problem.detail ?? r.problem.title,
      errors: r.problem.errors,
      attempt: (previous.attempt ?? 0) + 1,
    };
  revalidatePath('/changes');
  revalidatePath(`/changes/${r.data.id}`);
  redirect(withReturnTo(`/changes/${r.data.id}?saved=1`, form.get('returnTo')));
}
export async function runChangeCommand(
  id: string,
  action: string,
  previous: FormFeedback,
  form: FormData,
): Promise<FormFeedback> {
  const body: Record<string, unknown> = {
    expectedVersion: Number(form.get('expectedVersion')),
    commandKey: String(form.get('commandKey') ?? ''),
    reason: String(form.get('reason') ?? ''),
  };
  if (['approve', 'reject', 'schedule', 'start'].includes(action)) {
    body.approvalId = String(form.get('approvalId') ?? '');
    body.snapshotHash = String(form.get('snapshotHash') ?? '');
  }
  if (['schedule', 'start'].includes(action)) body.confirmed = form.get('confirmed') === 'on';
  if (action === 'schedule') body.conflictIds = form.getAll('conflictIds').map(String);
  if (action === 'result')
    for (const k of ['outcome', 'summary', 'testResults', 'backoutReason'])
      body[k] = String(form.get(k) ?? '');
  if (action === 'result') body.backoutPerformed = form.get('backoutPerformed') === 'on';
  if (action === 'pir')
    for (const k of ['rootCause', 'lessons', 'prevention']) body[k] = String(form.get(k) ?? '');
  const r = await api.changeCommand(id, action, body);
  if (!r.ok)
    return {
      message: r.problem.detail ?? r.problem.title,
      errors: r.problem.errors,
      attempt: (previous.attempt ?? 0) + 1,
    };
  revalidatePath('/changes');
  revalidatePath(`/changes/${id}`);
  redirect(withReturnTo(`/changes/${id}?saved=1`, form.get('returnTo')));
}
