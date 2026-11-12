import type { SessionView } from './api';

export function navigationRoles(session: SessionView) {
  const has = (...codes: string[]) =>
    session.roles.some(
      (r) =>
        (r.organizationId === session.organizationId || r.organizationId === null) &&
        codes.includes(r.roleCode),
    );
  return {
    staff: has('agent', 'org_admin', 'platform_admin'),
    admin: has('org_admin', 'platform_admin'),
    notifications: session.roles.some(
      (r) => r.roleCode === 'org_admin' && r.organizationId === session.organizationId,
    ),
    inbox: has('agent', 'org_admin', 'platform_admin', 'approver'),
    changes: has('agent', 'org_admin', 'platform_admin', 'approver', 'auditor'),
    auditor: has('auditor'),
  };
}

/**
 * 選択中の組織で有効な `org_admin` か (WP-P4-IDM-013)。
 *
 * 部署・上長・主部署の変更APIは `org_admin` だけを受け付ける。
 * 画面の導線も**同じ条件**で出し、押すと必ず拒否される入口を並べない。
 * `navigationRoles().admin` は `platform_admin` を含むため、変更操作には使わない。
 */
export function isOrgAdmin(session: SessionView): boolean {
  return session.roles.some(
    (r) => r.roleCode === 'org_admin' && r.organizationId === session.organizationId,
  );
}

/** 戻り先はアプリの一覧と詳細だけ。任意URLへのredirectを作らない。 */
export function safeReturnTo(value: unknown, depth = 0): string | null {
  if (typeof value !== 'string' || value.length > 2000 || !value.startsWith('/')) return null;
  if (value.includes('\\') || Array.from(value).some((char) => char.charCodeAt(0) <= 32))
    return null;
  try {
    const url = new URL(value, 'https://solvi.local');
    if (url.origin !== 'https://solvi.local') return null;
    if (
      !/^\/(portal|inbox|ops|assets|changes|knowledge|catalog|requests|tickets)(\/[^?#]*)?$/.test(
        url.pathname,
      )
    )
      return null;
    // 一覧→詳細→編集/関連画面の復帰を保持し、入れ子の深さを制限する。
    const parent = depth < 3 ? safeReturnTo(url.searchParams.get('returnTo'), depth + 1) : null;
    if (parent) url.searchParams.set('returnTo', parent);
    else url.searchParams.delete('returnTo');
    url.searchParams.delete('saved');
    url.searchParams.delete('created');
    url.searchParams.delete('updated');
    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
}

export function withReturnTo(href: string, from: unknown): string {
  const returnTo = safeReturnTo(from);
  if (!returnTo) return href;
  const url = new URL(href, 'https://solvi.local');
  const source = new URL(returnTo, 'https://solvi.local');
  const target =
    url.pathname === source.pathname ? safeReturnTo(source.searchParams.get('returnTo')) : returnTo;
  if (target) url.searchParams.set('returnTo', target);
  else url.searchParams.delete('returnTo');
  return url.pathname + url.search + url.hash;
}
