'use client';
import Link from 'next/link';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { FreshserviceIcon } from './FreshserviceIcon';
import { LogoutForm } from './DraftSessionBoundary';
import { SupportFrame } from './SupportFrame';
import { ThemeToggle } from './ThemeToggle';
import type { RailGroup, RailItem } from '../lib/navigation-groups';
import { safeReturnTo, ticketEntryPrefix, ticketListOrigin } from '../lib/navigation';

type Props = {
  groups: RailGroup[];
  staff: boolean;
  organizationName: string | null;
  canSwitchOrganization: boolean;
  /** 上部バーに出す日付。サーバーで作る(SSRとクライアントの食い違いを避ける)。 */
  todayLabel?: string;
  children: React.ReactNode;
};

function normalizedPath(href: string): string {
  const path = href.split('?')[0] ?? href;
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/** モバイル用サイドバーの表示条件。CSSの `max-width: 800px` と揃える。 */
const MOBILE_NAV_QUERY = '(max-width: 800px)';

/** 詳細画面として扱うのは、UUIDまたは数値のIDが続く場合だけ。 */
const DETAIL_ID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|\d+)$/i;

function matchesPath(pathname: string, target: string): boolean {
  if (pathname === target) return true;
  if (!pathname.startsWith(`${target}/`)) return false;
  const next = pathname.slice(target.length + 1).split('/')[0] ?? '';
  return DETAIL_ID.test(next);
}

type SearchParamsLike = {
  get(name: string): string | null;
  getAll?(name: string): string[];
};

type MatchTarget = {
  path: string;
  query: Array<[string, string]>;
};

/**
 * リンクの現在地判定に使うパスとクエリを返す。
 * `matchPath` はパスだけを上書きし、クエリは `href` から引き継ぐ。
 * 例: `/knowledge?manage=1` はパス `/knowledge` + `manage=1` として判定する。
 */
function matchTarget(item: Pick<RailItem, 'href' | 'matchPath'>): MatchTarget {
  const [rawPath, rawQuery = ''] = item.href.split('?');
  return {
    path: normalizedPath(item.matchPath ?? rawPath ?? item.href),
    query: [...new URLSearchParams(rawQuery)],
  };
}

function matchesTarget(pathname: string, search: SearchParamsLike, target: MatchTarget): boolean {
  if (!matchesPath(pathname, target.path)) return false;
  if (target.query.length === 0) return true;
  // `state` のように同じキーを複数回持つ条件は、値の集合が完全に一致した時だけ
  // 現在地とする。`get()` だけでは2件目以降を比較できない。
  const expected = new Map<string, string[]>();
  for (const [key, value] of target.query) {
    const values = expected.get(key);
    if (values) values.push(value);
    else expected.set(key, [value]);
  }
  for (const [key, values] of expected) {
    const actual = search.getAll ? search.getAll(key) : [search.get(key) ?? ''];
    if (actual.length !== values.length) return false;
    if (!values.every((value) => actual.includes(value))) return false;
  }
  return true;
}

const SUPPORT_ROOTS = ['/portal', '/catalog', '/knowledge', '/tickets', '/requests', '/settings'];
const SUPPORT_EXCLUDES = ['/catalog/manage', '/knowledge/new'];

/**
 * サポートポータルの利用者が遷移する画面かどうか (WP-P2-UIX-033)。
 * 管理・編集画面は、誤ってセルフサービス画面として扱わないよう除外する。
 */
function isSupportPath(pathname: string): boolean {
  const underRoot = SUPPORT_ROOTS.some(
    (root) => pathname === root || pathname.startsWith(`${root}/`),
  );
  if (!underRoot) return false;
  return !SUPPORT_EXCLUDES.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

function findCurrent(pathname: string, search: SearchParamsLike, groups: RailGroup[]) {
  let best: {
    group: RailGroup;
    item: RailItem | null;
    pathLength: number;
    queryLength: number;
  } | null = null;
  for (const group of groups) {
    const candidates: Array<{ item: RailItem | null; target: MatchTarget }> = [
      { item: null, target: matchTarget({ href: group.href }) },
      ...group.items.map((item) => ({ item, target: matchTarget(item) })),
    ];
    for (const candidate of candidates) {
      if (!matchesTarget(pathname, search, candidate.target)) continue;
      // パスが長いほど、クエリが多いほど「今ここ」として優先する。
      // 例: `/knowledge?manage=1` では「ナレッジ検索」より「ナレッジ管理」。
      const better =
        !best ||
        candidate.target.path.length > best.pathLength ||
        (candidate.target.path.length === best.pathLength &&
          (candidate.target.query.length > best.queryLength ||
            (candidate.target.query.length === best.queryLength &&
              candidate.item !== null &&
              best.item === null)));
      if (better) {
        best = {
          group,
          item: candidate.item,
          pathLength: candidate.target.path.length,
          queryLength: candidate.target.query.length,
        };
      }
    }
  }
  return best;
}

export function AppFrame({
  groups,
  staff,
  organizationName,
  canSwitchOrganization,
  todayLabel,
  children,
}: Props) {
  const pathname = usePathname() ?? '/';
  const searchParams = useSearchParams();
  const [mobileOpen, setMobileOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const wasMobileOpen = useRef(false);
  const ticketId = pathname.match(/^\/ops\/([^/]+)$/)?.[1];
  const returnTo = safeReturnTo(searchParams.get('returnTo'));
  const origin = ticketId && DETAIL_ID.test(ticketId) ? ticketListOrigin(returnTo) : null;
  const current = findCurrent(
    origin?.pathname ?? pathname,
    origin?.searchParams ?? searchParams,
    groups,
  );

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (mobileOpen) closeRef.current?.focus();
    else if (wasMobileOpen.current) toggleRef.current?.focus();
    wasMobileOpen.current = mobileOpen;
  }, [mobileOpen]);

  useEffect(() => {
    const media = window.matchMedia(MOBILE_NAV_QUERY);
    const onChange = () => {
      if (!media.matches) setMobileOpen(false);
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (!mobileOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [mobileOpen]);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen]);

  /** 開いたサイドバーの中からTabで抜けないようにする(UIX-030の挙動)。 */
  const trapSidebarFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!mobileOpen || event.key !== 'Tab') return;
    const focusable = Array.from(
      sidebarRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((element) => element.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
      const commandK = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';
      const slash = event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey;
      if (!commandK && !slash) return;
      if (slash && typing) return;
      if (!searchRef.current) return;
      event.preventDefault();
      searchRef.current.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const currentDetail = (() => {
    if (!current) return null;
    if (origin) return '問い合わせ詳細';
    if (current.item) {
      const target = matchTarget(current.item);
      if (pathname === target.path) return current.item.label;
      if (matchesPath(pathname, target.path)) return '詳細';
    }
    const groupTarget = normalizedPath(current.group.href);
    if (pathname !== groupTarget && matchesPath(pathname, groupTarget)) return '詳細';
    return null;
  })();

  // サポートポータルは依頼者のセルフサービス画面。スタッフは同じURLでも
  // エージェントUIを使う(管理者の左サイドバーから開いた場合に元の画面へ戻す)。
  if (pathname === '/portal' || (isSupportPath(pathname) && !staff)) {
    return (
      <SupportFrame
        groups={groups}
        organizationName={organizationName}
        canSwitchOrganization={canSwitchOrganization}
      >
        {children}
      </SupportFrame>
    );
  }

  return (
    <div className={`fs-app${mobileOpen ? ' fs-app--nav-open' : ''}`}>
      <button
        type="button"
        className="fs-sidebar-backdrop"
        aria-label="メニューを閉じる"
        tabIndex={mobileOpen ? 0 : -1}
        onClick={() => setMobileOpen(false)}
      />
      <aside
        className="fs-rail"
        id="solvi-main-navigation"
        aria-label="メインメニュー"
        ref={sidebarRef}
        onKeyDown={trapSidebarFocus}
      >
        <div className="fs-side-head">
          <Link className="fs-side-brand" href="/" aria-label="SOLVI ホーム">
            <span className="fs-side-mark" aria-hidden="true">
              <span />
            </span>
            <span className="fs-side-brand-text">
              <strong>SOLVI</strong>
              {organizationName && <span>{organizationName}</span>}
            </span>
          </Link>
          <button
            type="button"
            className="fs-side-close"
            aria-label="メニューを閉じる"
            ref={closeRef}
            onClick={() => setMobileOpen(false)}
          >
            ×
          </button>
        </div>

        <nav className="fs-side-menu" aria-label="業務メニュー">
          {groups.map((group) => (
            <section
              className="fs-side-section"
              key={group.id}
              aria-labelledby={`fs-side-heading-${group.id}`}
            >
              <h2 className="fs-side-heading" id={`fs-side-heading-${group.id}`}>
                {group.label}
              </h2>
              <ul className="fs-side-list">
                {group.items.map((entry) => {
                  const active = current?.item === entry;
                  const count = entry.count;
                  return (
                    <li key={`${entry.href}:${entry.label}`}>
                      <Link
                        href={entry.href}
                        className="fs-side-link"
                        aria-current={active ? (origin ? 'location' : 'page') : undefined}
                        aria-label={count ? `${entry.label} ${count.value}件` : undefined}
                        onClick={() => setMobileOpen(false)}
                      >
                        <span className="fs-side-label">{entry.label}</span>
                        {count && (
                          <span
                            className="fs-side-count"
                            data-tone={count.tone ?? undefined}
                            aria-hidden="true"
                          >
                            {count.value}
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </nav>

        <div className="fs-side-foot">
          <ThemeToggle />
        </div>
      </aside>

      <div className="fs-main" inert={mobileOpen ? true : undefined}>
        <header className="fs-topbar">
          <button
            type="button"
            className="fs-icon-button fs-side-toggle"
            aria-expanded={mobileOpen}
            aria-controls="solvi-main-navigation"
            aria-label={mobileOpen ? 'メニューを閉じる' : 'メニューを開く'}
            ref={toggleRef}
            onClick={() => setMobileOpen((open) => !open)}
          >
            <FreshserviceIcon name="menu" size={20} />
          </button>

          <div className="fs-topbar-location">
            <div className="fs-breadcrumb">
              {current ? (
                <>
                  <Link
                    href={(origin && returnTo) || current.group.href}
                    scroll={!origin?.hash.startsWith('#' + ticketEntryPrefix)}
                  >
                    {(origin && current.item?.label) || current.group.label}
                  </Link>
                  {currentDetail && currentDetail !== current.group.label && (
                    <>
                      <FreshserviceIcon name="chevron" size={14} />
                      <span aria-current="page">{currentDetail}</span>
                    </>
                  )}
                </>
              ) : (
                <span aria-current="page">SOLVI</span>
              )}
            </div>
            <p className="fs-topbar-meta">
              {organizationName && <span className="fs-topbar-org">{organizationName}</span>}
              <span>{todayLabel}</span>
            </p>
          </div>

          <form className="fs-global-search" action={staff ? '/ops' : '/knowledge'} method="get">
            <FreshserviceIcon name="search" size={18} />
            <label className="visually-hidden" htmlFor="fs-global-search-input">
              検索
            </label>
            <input
              id="fs-global-search-input"
              ref={searchRef}
              type="search"
              name="q"
              placeholder="検索"
              autoComplete="off"
              aria-keyshortcuts="/ Control+K Meta+K"
            />
            <kbd aria-hidden="true">⌘K</kbd>
          </form>

          <div className="fs-topbar-actions">
            <Link className="fs-create-button" href="/tickets/new" aria-label="新規チケット">
              <span className="fs-create-icon" aria-hidden="true">
                <FreshserviceIcon name="plus" size={16} />
              </span>
              <span>新規チケット</span>
            </Link>
            <Link
              className="fs-icon-button"
              href="/settings/notifications"
              aria-label="通知設定"
              title="通知設定"
            >
              <FreshserviceIcon name="bell" size={20} />
            </Link>
            <details className="fs-user-menu">
              <summary aria-label="ユーザーメニュー" title="ユーザーメニュー">
                <span className="fs-avatar" aria-hidden="true">
                  <FreshserviceIcon name="user" size={18} />
                </span>
              </summary>
              <div className="fs-user-popover">
                <div className="fs-user-popover-head">
                  <span className="fs-avatar fs-avatar--large" aria-hidden="true">
                    <FreshserviceIcon name="user" size={20} />
                  </span>
                  <div>
                    <strong>SOLVI アカウント</strong>
                    {organizationName && <span>{organizationName}</span>}
                  </div>
                </div>
                {organizationName && (
                  <div className="fs-user-org">
                    <FreshserviceIcon name="organization" size={16} />
                    <span>{organizationName}</span>
                  </div>
                )}
                <nav className="fs-user-links" aria-label="アカウント">
                  <Link href="/settings/notifications">自分の通知設定</Link>
                  <Link href="/settings/delegations">承認の委任</Link>
                  {canSwitchOrganization && (
                    <Link href="/select-organization">組織を切り替える</Link>
                  )}
                </nav>
                <div className="fs-user-logout">
                  <LogoutForm />
                </div>
              </div>
            </details>
          </div>
        </header>

        <div className="fs-content">{children}</div>
      </div>
    </div>
  );
}
