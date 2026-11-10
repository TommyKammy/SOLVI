export type DraftValues = Record<string, string>;
export interface FormDraft {
  schema: 1;
  scope: string;
  expiresAt: number;
  savedAt: number;
  version: string;
  baseline: DraftValues;
  values: DraftValues;
}
export const DRAFT_PREFIX = 'solvi:draft:v1:';
export const DRAFT_TTL = 2 * 60 * 60 * 1000;
const scopeKey = DRAFT_PREFIX + 'scope';

export function clearFormDrafts() {
  // Only this feature's keys; never erase another application's storage.
  for (const key of Object.keys(sessionStorage))
    if (key.startsWith(DRAFT_PREFIX)) sessionStorage.removeItem(key);
}
export function bindDraftScope(scope: string) {
  const previous = sessionStorage.getItem(scopeKey);
  if (previous && previous !== scope) clearFormDrafts();
  sessionStorage.setItem(scopeKey, scope);
}
export function draftKey(scope: string, formKey: string) {
  return DRAFT_PREFIX + scope + ':' + formKey;
}
export function readFormDraft(key: string, scope: string): FormDraft | null {
  const raw = sessionStorage.getItem(key);
  if (!raw) return null;
  try {
    if (raw.length > 100000 || new TextEncoder().encode(raw).byteLength > 100000)
      throw new Error('size');
    const d = JSON.parse(raw) as FormDraft;
    const dict = (v: unknown) =>
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      Object.entries(v).every(
        ([k, value]) =>
          !['__proto__', 'constructor', 'prototype'].includes(k) && typeof value === 'string',
      );
    if (
      d.schema !== 1 ||
      d.scope !== scope ||
      typeof d.version !== 'string' ||
      !Number.isFinite(d.savedAt) ||
      !Number.isFinite(d.expiresAt) ||
      d.savedAt > Date.now() ||
      d.expiresAt <= Date.now() ||
      d.expiresAt - d.savedAt !== DRAFT_TTL ||
      !dict(d.values) ||
      !dict(d.baseline)
    )
      throw new Error('invalid');
    return d;
  } catch {
    sessionStorage.removeItem(key);
    return null;
  }
}
export async function currentDraftScope(): Promise<string | null> {
  const result = await fetch('/api/draft-scope', { cache: 'no-store' });
  if (result.status === 401 || result.status === 403) return null;
  if (!result.ok) throw new Error('scope unavailable');
  const data = (await result.json()) as { scope: string };
  if (typeof data.scope !== 'string') throw new Error('invalid scope');
  return data.scope;
}
