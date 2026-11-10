'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { FreshserviceIcon } from './FreshserviceIcon';
import { LogoutForm } from './DraftSessionBoundary';
import { SupportFrame } from './SupportFrame';
import type { RailGroup, RailItem } from '../lib/navigation-groups';

type Props = {
  groups: RailGroup[];
  staff: boolean;
  organizationName: string | null;
  canSwitchOrganization: boolean;
  children: React.ReactNode;
};

function normalizedPath(href: string): string {
  const path = href.split('?')[0] ?? href;
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/** 詳細画面として扱うのは、UUIDまたは数値のIDが続く場合だけ。 */
const DETAIL_ID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|\d+)$/i;

function matchesPath(pathname: string, target: string): boolean {
  if (pathname === target) return true;
  if (!pathname.startsWith(`${target}/`)) return false;
  const next = pathname.slice(target.length + 1).split('/')[0] ?? '';
  return DETAIL_ID.test(next);
}

type SearchParamsLike = { get(name: string): string | null };

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
  return target.query.every(([key, value]) => search.get(key) === value);
}

function isActive(pathname: string, search: SearchParamsLike, item: RailItem): boolean {
  return matchesTarget(pathname, search, matchTarget(item));
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
  children,
}: Props) {
  const pathname = usePathname() ?? '/';
  const searchParams = useSearchParams();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const railItems = useRef(new Map<string, HTMLDivElement>());
  const current = findCurrent(pathname, searchParams, groups);

  useEffect(() => {
    setMobileOpen(false);
    // マウス操作で遷移したときは閉じる。キーボードでメニュー内のリンクを
    // 実行した場合は、フォーカスを隠れた要素に残さないよう開いたままにする。
    setOpenGroup((open) => {
      if (!open) return null;
      const item = railItems.current.get(open);
      return item && item.contains(document.activeElement) ? open : null;
    });
  }, [pathname]);

  useEffect(() => {
    if (!openGroup) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenGroup(null);
    };
    const onPointerDown = (event: PointerEvent) => {
      const item = railItems.current.get(openGroup);
      if (item && !item.contains(event.target as Node)) setOpenGroup(null);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [openGroup]);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      ) {
        return;
      }
      if (!searchRef.current) return;
      event.preventDefault();
      searchRef.current.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const currentDetail = (() => {
    if (!current) return null;
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
  // エージェントUIを使う(管理者の左レールから開いた場合に元の画面へ戻す)。
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
    <div className={`fs-app${mobileOpen ? ' fs-app--rail-open' : ''}`}>
      <button
        type="button"
        className="fs-rail-backdrop"
        aria-label="メニューを閉じる"
        tabIndex={mobileOpen ? 0 : -1}
        onClick={() => setMobileOpen(false)}
      />
      <aside className="fs-rail" aria-label="メインメニュー">
        <Link className="fs-rail-brand" href="/" aria-label="SOLVI ホーム">
          <span aria-hidden="true">S</span>
        </Link>
        <button
          type="button"
          className="fs-rail-close"
          aria-label="メニューを閉じる"
          onClick={() => setMobileOpen(false)}
        >
          ×
        </button>
        <nav className="fs-rail-nav" aria-label="業務メニュー">
          {groups.map((group) => {
            const active =
              current?.group.id === group.id ||
              group.items.some((item) => isActive(pathname, searchParams, item));
            return (
              <div
                className={`fs-rail-item${openGroup === group.id ? ' is-open' : ''}`}
                key={group.id}
                ref={(element) => {
                  if (element) railItems.current.set(group.id, element);
                  else railItems.current.delete(group.id);
                }}
                onPointerEnter={() => setOpenGroup(group.id)}
                onPointerLeave={() => {
                  const item = railItems.current.get(group.id);
                  // キーボードで中のリンクにフォーカスしている間は閉じない。
                  if (item && item.contains(document.activeElement)) return;
                  setOpenGroup((open) => (open === group.id ? null : open));
                }}
                onFocus={() => setOpenGroup(group.id)}
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setOpenGroup((open) => (open === group.id ? null : open));
                  }
                }}
              >
                <Link
                  href={group.href}
                  className={`fs-rail-link${active ? ' is-active' : ''}`}
                  aria-label={group.label}
                  aria-current={active ? 'page' : undefined}
                  onClick={(event) => {
                    // マウスで選んだ後はフォーカスを残さず、メニューを閉じる。
                    if (event.detail > 0) {
                      setOpenGroup(null);
                      event.currentTarget.blur();
                    }
                  }}
                >
                  <FreshserviceIcon name={group.icon} size={20} />
                </Link>
                <div className="fs-flyout" role="group" aria-label={group.label}>
                  <p className="fs-flyout-title">{group.label}</p>
                  <ul className="fs-flyout-list">
                    {group.items.map((item) => (
                      <li key={`${item.href}:${item.label}`}>
                        <Link
                          href={item.href}
                          aria-current={current?.item === item ? 'page' : undefined}
                          onClick={(event) => {
                            // クリック後もフォーカスが残ると、次のホバーで
                            // 前のメニューが重なって見える。マウス操作では閉じる。
                            if (event.detail > 0) {
                              setOpenGroup(null);
                              event.currentTarget.blur();
                            }
                          }}
                        >
                          {item.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            );
          })}
        </nav>
        <Link className="fs-rail-bottom" href="/settings/notifications" aria-label="自分の設定">
          <FreshserviceIcon name="settings" size={20} />
        </Link>
      </aside>

      <div className="fs-main">
        <header className="fs-topbar">
          <button
            type="button"
            className="fs-icon-button fs-rail-toggle"
            aria-expanded={mobileOpen}
            aria-controls="solvi-main-navigation"
            aria-label={mobileOpen ? 'メニューを閉じる' : 'メニューを開く'}
            onClick={() => setMobileOpen((open) => !open)}
          >
            <FreshserviceIcon name="menu" size={20} />
          </button>
          <div className="fs-breadcrumb" id="solvi-main-navigation">
            {current ? (
              <>
                <Link href={current.group.href}>{current.group.label}</Link>
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
            />
            <kbd aria-hidden="true">/</kbd>
          </form>

          <div className="fs-topbar-actions">
            <Link className="fs-create-button" href="/tickets/new">
              <span className="fs-create-icon" aria-hidden="true">
                <FreshserviceIcon name="plus" size={16} />
              </span>
              <span>作成する</span>
            </Link>
            <Link className="fs-icon-button" href="/knowledge" aria-label="ヘルプ" title="ヘルプ">
              <FreshserviceIcon name="help" size={20} />
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
