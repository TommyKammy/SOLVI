'use server';
import { redirect } from 'next/navigation';
import { withReturnTo } from '../../lib/navigation';
import { revalidatePath } from 'next/cache';
import { api, type AssetView } from '../../lib/api';
import type { FormFeedback } from '../../lib/form-state';
export async function saveAsset(
  id: string | null,
  previous: FormFeedback,
  form: FormData,
): Promise<FormFeedback> {
  const values = Object.fromEntries(
    [
      'assetTag',
      'name',
      'kind',
      'state',
      'model',
      'serialNumber',
      'hostname',
      'vendor',
      'assignedUserId',
      'location',
      'internalNotes',
      'reason',
    ].map((k) => [k, String(form.get(k) ?? '')]),
  );
  const input = { ...values, assignedUserId: values.assignedUserId || null };
  const r = id
    ? await api.editAsset(id, { ...input, expectedVersion: Number(form.get('expectedVersion')) })
    : await api.createAsset(input);
  if (!r.ok)
    return {
      message: r.problem.detail ?? r.problem.title,
      errors:
        r.problem.errors ??
        (r.problem.detail?.includes('資産タグまたはシリアル番号はすでに')
          ? (values.serialNumber.trim() ? ['assetTag', 'serialNumber'] : ['assetTag']).map(
              (field) => ({
                field,
                message:
                  '資産タグまたはシリアル番号が既存資産と重複しています。台帳を確認して、重複した値を変更してください。',
              }),
            )
          : undefined),
      attempt: (previous.attempt ?? 0) + 1,
      values,
    };
  revalidatePath('/assets');
  revalidatePath(`/assets/${r.data.id}`);
  redirect(withReturnTo(`/assets/${r.data.id}?saved=1`, form.get('returnTo')));
}
export interface AssetSearchFeedback {
  message: string;
  items: AssetView[];
  query: string;
  searched: boolean;
}
export async function searchLinkAssets(
  _previous: AssetSearchFeedback,
  form: FormData,
): Promise<AssetSearchFeedback> {
  const query = String(form.get('q') ?? '');
  const r = await api.assets(new URLSearchParams({ q: query }).toString());
  if (!r.ok)
    return { message: r.problem.detail ?? r.problem.title, items: [], query, searched: true };
  return {
    message: r.data.total > 25 ? '先頭25件を表示しています。検索語を絞ってください。' : '',
    items: r.data.items.filter((a) => a.state !== 'retired'),
    query,
    searched: true,
  };
}
export async function linkTicketAsset(
  ticketId: string,
  previous: FormFeedback,
  form: FormData,
): Promise<FormFeedback> {
  const assetId = String(form.get('assetId') ?? ''),
    reason = String(form.get('reason') ?? '');
  const r = await api.linkAsset(ticketId, { assetId, reason });
  if (!r.ok)
    return {
      message: r.problem.errors?.[0]?.message ?? r.problem.detail ?? r.problem.title,
      attempt: (previous.attempt ?? 0) + 1,
      values: { assetId, reason },
      errors: r.problem.errors,
    };
  revalidatePath(`/ops/${ticketId}`);
  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath(`/assets/${assetId}`);
  redirect(withReturnTo(`/ops/${ticketId}?assetSaved=1`, form.get('returnTo')));
}
export async function unlinkTicketAsset(
  ticketId: string,
  assetId: string,
  previous: FormFeedback,
  form: FormData,
): Promise<FormFeedback> {
  const r = await api.unlinkAsset(ticketId, assetId, {
    reason: String(form.get('reason') ?? ''),
    expectedVersion: Number(form.get('expectedVersion')),
  });
  if (!r.ok)
    return {
      message: r.problem.errors?.[0]?.message ?? r.problem.detail ?? r.problem.title,
      attempt: (previous.attempt ?? 0) + 1,
      errors: r.problem.errors,
    };
  revalidatePath(`/ops/${ticketId}`);
  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath(`/assets/${assetId}`);
  redirect(withReturnTo(`/ops/${ticketId}?assetSaved=1`, form.get('returnTo')));
}
