'use client';
import { createContext, useContext, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { FreshserviceIcon } from './FreshserviceIcon';
import { LogoutForm } from './DraftSessionBoundary';
import { ThemeToggle } from './ThemeToggle';
import type { RailGroup } from '../lib/navigation-groups';
import { isPortalView, isPortalViewPath, portalViewHref } from '../lib/navigation';

type Props = {
  organizationName: string | null;
  canSwitchOrganization: boolean;
  groups: RailGroup[];
  children: React.ReactNode;
};

function closeDetails(event: React.MouseEvent<HTMLAnchorElement>) {
  const details = event.currentTarget.closest('details');
  if (details) details.open = false;
}

function closeDetailsOnEscape(event: KeyboardEvent<HTMLDetailsElement>) {
  const details = event.currentTarget;
  if (event.key !== 'Escape' || !details.open) return;
  event.preventDefault();
  details.open = false;
  details.querySelector('summary')?.focus();
}

const portalLinks = [
  { href: '/portal', label: 'ホーム' },
  { href: '/portal?tab=tickets', label: '自分の問い合わせ' },
  { href: '/catalog', label: 'サービスカタログ' },
  { href: '/requests?view=mine', label: '申請の状況' },
  { href: '/knowledge', label: 'ヘルプ記事' },
];
const portalTabLinks = new Map([
  ['tickets', '/portal?tab=tickets'],
  ['requests', '/requests?view=mine'],
  ['services', '/catalog'],
]);

const SupportOrganization = createContext<string | null>(null);

export function SupportOrganizationLabel() {
  const organization = useContext(SupportOrganization);
  return (
    <p className="support-hero-context">
      {organization ? `${organization} · ITサポート` : 'ITサポート'}
    </p>
  );
}

/**
 * サポートポータル専用のヘッダーとロール別メニュー。
 */
export function SupportFrame({ organizationName, canSwitchOrganization, groups, children }: Props) {
  const pathname = usePathname() ?? '/';
  const query = useSearchParams();
  const isPortalHome = pathname === '/portal';
  const isTicketPage = /^\/tickets\/[^/]+$/.test(pathname);
  const tab = query.get('tab');
  const isPortalWorkflow = isPortalViewPath(pathname);
  const requesterFlow =
    isTicketPage ||
    (isPortalHome && tab !== 'requests' && tab !== 'services') ||
    (isPortalWorkflow && isPortalView(query.getAll('portal')));
  // Reuse the existing role-scoped menu; staff alone excludes approvers and auditors.
  const workLinks = groups
    .flatMap((group) => group.items)
    .filter((item) => ['/inbox', '/assets', '/changes'].includes(item.href));
  const inbox = workLinks.find((item) => item.href === '/inbox');
  const activeLink = isPortalHome
    ? (portalTabLinks.get(tab ?? '') ?? '/portal')
    : pathname === '/tickets/new'
      ? '/portal'
      : isTicketPage
        ? '/portal?tab=tickets'
        : pathname.startsWith('/requests')
          ? '/requests?view=mine'
          : '/' + pathname.split('/')[1];
  const currentType = isPortalHome || activeLink.split('?')[0] === pathname ? 'page' : 'location';

  const menu = (
    <details className="fs-support-menu" onKeyDown={closeDetailsOnEscape}>
      <summary aria-label="サポートポータルのメニュー" title="メニュー">
        <FreshserviceIcon name="menu" size={22} />
      </summary>
      <nav className="fs-support-menu-panel" aria-label="サポートポータルのメニュー">
        <p className="fs-support-menu-title">サポート</p>
        {portalLinks.map(({ href, label }) => (
          <Link
            key={href}
            href={portalViewHref(href)}
            aria-current={activeLink === href ? currentType : undefined}
            onClick={closeDetails}
          >
            {label}
          </Link>
        ))}
        <Link href="/settings/notifications" onClick={closeDetails}>
          通知設定
        </Link>
        <Link href="/settings/delegations" onClick={closeDetails}>
          承認の委任
        </Link>
        {workLinks.length > 0 && (
          <>
            <p className="fs-support-menu-title fs-support-menu-title--staff">担当業務</p>
            {workLinks.map((item) => (
              <Link key={item.href} href={item.href} onClick={closeDetails}>
                {item.label}
              </Link>
            ))}
          </>
        )}
      </nav>
    </details>
  );

  return (
    <div
      className={`fs-support${isPortalHome ? '' : ' fs-support--subpage'}${requesterFlow ? ' fs-support--requester-flow' : ''}`}
    >
      <header className="fs-support-header">
        <div className="fs-support-header-inner">
          <div className="fs-support-header-left">
            {!requesterFlow && menu}
            <Link className="fs-support-brand" href="/portal" aria-label="SOLVI サポートポータル">
              <span className="fs-side-mark" aria-hidden="true" />
              <span className="fs-support-brand-text">
                <strong>SOLVI</strong>
                <span>サポートポータル</span>
              </span>
            </Link>
          </div>
          <nav className="fs-support-nav" aria-label="依頼者メニュー">
            {portalLinks.map(({ href, label }) => (
              <Link
                key={href}
                href={portalViewHref(href)}
                aria-current={activeLink === href ? currentType : undefined}
              >
                {label}
              </Link>
            ))}
          </nav>
          <div className="fs-support-header-right">
            {requesterFlow ? (
              menu
            ) : (
              <Link
                className="fs-support-icon-button"
                href="/settings/notifications"
                aria-label="通知設定"
                title="通知設定"
              >
                <FreshserviceIcon name="bell" size={20} />
              </Link>
            )}
            <details className="fs-user-menu fs-support-user" onKeyDown={closeDetailsOnEscape}>
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
                  {inbox && <Link href={inbox.href}>{inbox.label}</Link>}
                </nav>
                <div className="fs-user-logout">
                  {!requesterFlow && <ThemeToggle />}
                  <LogoutForm />
                </div>
              </div>
            </details>
            {requesterFlow && <ThemeToggle compact />}
          </div>
        </div>
      </header>
      <SupportOrganization.Provider value={organizationName}>
        {isPortalHome ? (
          children
        ) : (
          <div
            className={`fs-support-content${isTicketPage ? ' fs-support-content--ticket' : isPortalWorkflow ? ' fs-support-content--workflow' : ''}`}
          >
            {children}
          </div>
        )}
      </SupportOrganization.Provider>
      <footer className="support-footer">SOLVI · 社内ITサービス管理</footer>
    </div>
  );
}
