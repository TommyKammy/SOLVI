'use client';
import Link from 'next/link';
import { FreshserviceIcon } from './FreshserviceIcon';
import { LogoutForm } from './DraftSessionBoundary';

type Props = {
  organizationName: string | null;
  canSwitchOrganization: boolean;
  staff: boolean;
  children: React.ReactNode;
};

function closeDetails(event: React.MouseEvent<HTMLAnchorElement>) {
  const details = event.currentTarget.closest('details');
  if (details) details.open = false;
}

/**
 * サポートポータル専用シェル (WP-P2-UIX-032)。
 *
 * エージェント画面の左レールは出さない。Freshserviceのサポートポータルと
 * 同じく、ヒーローの上に重なる透過ヘッダーだけを置く。
 */
export function SupportFrame({ organizationName, canSwitchOrganization, staff, children }: Props) {
  return (
    <div className="fs-support">
      <header className="fs-support-header">
        <div className="fs-support-header-left">
          <details className="fs-support-menu">
            <summary aria-label="サポートポータルのメニュー" title="メニュー">
              <FreshserviceIcon name="menu" size={22} />
            </summary>
            <nav className="fs-support-menu-panel" aria-label="サポートポータルのメニュー">
              <p className="fs-support-menu-title">サポート</p>
              <Link href="/portal" onClick={closeDetails}>
                ホーム
              </Link>
              <Link href="/portal?tab=tickets" onClick={closeDetails}>
                自分の問い合わせ
              </Link>
              <Link href="/requests?view=mine" onClick={closeDetails}>
                申請の状況
              </Link>
              <Link href="/catalog" onClick={closeDetails}>
                サービスカタログ
              </Link>
              <Link href="/knowledge" onClick={closeDetails}>
                ナレッジ
              </Link>
              <Link href="/settings/notifications" onClick={closeDetails}>
                通知設定
              </Link>
              {staff && (
                <>
                  <p className="fs-support-menu-title fs-support-menu-title--staff">担当業務</p>
                  <Link href="/inbox" onClick={closeDetails}>
                    担当業務へ
                  </Link>
                </>
              )}
            </nav>
          </details>
          <Link className="fs-support-brand" href="/portal" aria-label="SOLVI サポートポータル">
            <span className="fs-support-brand-mark" aria-hidden="true">
              S
            </span>
            <span>SOLVI</span>
          </Link>
          {organizationName && <span className="fs-support-org">{organizationName}</span>}
        </div>
        <div className="fs-support-header-right">
          <Link
            className="fs-support-icon-button"
            href="/settings/notifications"
            aria-label="通知設定"
            title="通知設定"
          >
            <FreshserviceIcon name="bell" size={20} />
          </Link>
          <details className="fs-user-menu fs-support-user">
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
                {canSwitchOrganization && <Link href="/select-organization">組織を切り替える</Link>}
                {staff && <Link href="/inbox">担当業務へ</Link>}
              </nav>
              <div className="fs-user-logout">
                <LogoutForm />
              </div>
            </div>
          </details>
        </div>
      </header>
      {children}
    </div>
  );
}
