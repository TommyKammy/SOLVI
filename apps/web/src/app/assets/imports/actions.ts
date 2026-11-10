'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { withReturnTo } from '../../../lib/navigation';
import { api, type AssetCsvInspection } from '../../../lib/api';
import type { FormFeedback } from '../../../lib/form-state';
export interface CsvFeedback extends FormFeedback {
  csv: string;
  inspection?: AssetCsvInspection;
}
export async function prepareCsv(previous: CsvFeedback, form: FormData): Promise<CsvFeedback> {
  const csv = String(form.get('csv') ?? '').replace(/\r\n?/g, '\n');
  if (form.get('intent') === 'inspect') {
    const r = await api.inspectAssetCsv(csv);
    return r.ok
      ? { message: '', csv, inspection: r.data }
      : {
          csv,
          attempt: (previous.attempt ?? 0) + 1,
          errors: r.problem.errors?.map((e) => ({ ...e, field: 'csv' })),
          message:
            r.problem.errors?.map((e) => e.message).join(' / ') ??
            r.problem.detail ??
            r.problem.title,
        };
  }
  const mapping = Object.fromEntries(
    Array.from(form.entries())
      .filter(([key]) => key.startsWith('map.'))
      .map(([key, val]) => [key.slice(4), String(val)]),
  );
  const r = await api.previewAssetCsv({
    csv,
    sourceKey: String(form.get('sourceKey') ?? ''),
    reason: String(form.get('reason') ?? ''),
    mapping,
  });
  if (!r.ok)
    return {
      ...previous,
      csv,
      attempt: (previous.attempt ?? 0) + 1,
      errors: r.problem.errors?.map((e) => ({
        ...e,
        field: e.field.replace(/^mapping\./, 'map.'),
      })),
      message:
        r.problem.errors?.map((e) => `${e.field}: ${e.message}`).join(' / ') ??
        r.problem.detail ??
        r.problem.title,
    };
  revalidatePath('/assets/imports');
  redirect(withReturnTo(`/assets/imports/${r.data.id}`, form.get('returnTo')));
}
export async function applyCsv(
  id: string,
  previous: FormFeedback,
  form: FormData,
): Promise<FormFeedback> {
  const r = await api.applyAssetImport(id, {
    planHash: String(form.get('planHash') ?? ''),
    confirmed: form.get('confirmed') === 'on',
  });
  if (!r.ok)
    return {
      errors: r.problem.errors,
      message:
        r.problem.errors?.map((e) => e.message).join(' / ') ?? r.problem.detail ?? r.problem.title,
      attempt: (previous.attempt ?? 0) + 1,
    };
  revalidatePath('/assets');
  revalidatePath('/assets/imports');
  revalidatePath(`/assets/imports/${id}`);
  for (const a of r.data.assets) revalidatePath(`/assets/${a.id}`);
  redirect(withReturnTo(`/assets/imports/${id}?applied=1`, form.get('returnTo')));
}
