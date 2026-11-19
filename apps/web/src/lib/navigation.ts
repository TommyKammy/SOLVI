import type { SessionView } from './api';

export function navigationRoles(session: SessionView) {
  const has = (...codes: string[]) =>
    session.roles.some(
      (r) =>
        (r.organizationId === session.organizationId || r.organizationId === null) &&
        codes.includes(r.roleCode),
    );
  /**
   * 選択中の組織で有効な `org_admin` か。部署・プロフィールの変更は
   * `org_admin` だけができるため、管理メニューの導線もこの条件で出す。
   */
  const orgAdmin = session.roles.some(
    (r) => r.roleCode === 'org_admin' && r.organizationId === session.organizationId,
  );
  return {
    staff: has('agent', 'org_admin', 'platform_admin'),
    admin: has('org_admin', 'platform_admin'),
    orgAdmin,
    notifications: orgAdmin,
    inbox: has('agent', 'org_admin', 'platform_admin', 'approver'),
    changes: has('agent', 'org_admin', 'platform_admin', 'approver', 'auditor'),
    auditor: has('auditor'),
    auditLog: has('auditor', 'platform_auditor'),
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
  return navigationRoles(session).orgAdmin;
}

// 表示だけを指定する。管理・編集ルートは業務画面のままにする。
export function isPortalViewPath(pathname: string): boolean {
  return (
    /^\/(catalog|knowledge|requests)(\/[^/]+)?$/.test(pathname) &&
    pathname !== '/catalog/manage' &&
    pathname !== '/knowledge/new'
  );
}

export function isPortalView(value: unknown): boolean {
  return Array.isArray(value) ? value.includes('1') : value === '1';
}

export function portalViewHref(href: string, enabled = true): string {
  if (!enabled || !href.startsWith('/')) return href;
  const url = new URL(href, 'https://solvi.local');
  if (url.origin !== 'https://solvi.local' || !isPortalViewPath(url.pathname)) return href;
  url.searchParams.set('portal', '1');
  return url.pathname + url.search + url.hash;
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
  return portalViewHref(
    url.pathname + url.search + url.hash,
    isPortalViewPath(source.pathname) && isPortalView(source.searchParams.getAll('portal')),
  );
}

const ticketListLabels = {
  '/ops/overview': '運営状況',
  '/ops/reports': 'レポート',
  '/inbox': '業務受信箱',
  '/ops': 'チケット一覧',
};

export function ticketListOrigin(value: unknown): URL | null {
  const from = safeReturnTo(value);
  if (!from) return null;
  const url = new URL(from, 'https://solvi.local');
  return Object.hasOwn(ticketListLabels, url.pathname) ? url : null;
}

export const ticketEntryPrefix = 'ticket-entry-';
export const ticketEntryId = (id: string) => ticketEntryPrefix + id;
export const ticketListHeadingId = 'ticket-list-heading';

export function ticketReturnTo(value: unknown, id: string): string | null {
  const origin = ticketListOrigin(value);
  if (!origin) return safeReturnTo(value);
  origin.hash = ticketEntryId(id);
  return origin.pathname + origin.search + origin.hash;
}

export function ticketBackLabel(from: URL | null, hasReturnTo: boolean): string {
  if (from) {
    const label = ticketListLabels[from.pathname as keyof typeof ticketListLabels];
    if (label) return label + 'に戻る';
  }
  return hasReturnTo ? '元の画面に戻る' : 'チケット一覧に戻る';
}
