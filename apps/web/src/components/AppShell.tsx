import { api } from '../lib/api';
import { formScope } from '../lib/form-scope';
import { navigationRoles } from '../lib/navigation';
import { buildNavigationGroups } from '../lib/navigation-groups';
import { AppFrame } from './AppFrame';
import { DraftSessionBoundary } from './DraftSessionBoundary';
import { OfflineNotice } from './OfflineNotice';

/**
 * FreshserviceのエージェントUIを参考にした共通シェル (WP-P2-UIX-025)。
 *
 * ルート・API・認可は変えない。ここが決めるのは「どの入口を、どの順で、
 * どの見た目で出すか」だけである。表示する項目はロールで絞り、
 * 押しても権限で拒否されるだけのメニューを並べない。
 */
export async function AppShell({ children }: { children: React.ReactNode }) {
  // GLPIの隔離試作はSOLVI API/PostgreSQLを必要としない。
  if (process.env.GLPI_UI_ENABLED === 'true' && process.env.NODE_ENV !== 'production') {
    return <div className="fs-glpi">{children}</div>;
  }

  const organizationsResult = await api.myOrganizations();
  if (!organizationsResult.ok) {
    return <PublicShell>{children}</PublicShell>;
  }

  const { selected, organizations } = organizationsResult.data;
  if (!selected) {
    return <PublicShell>{children}</PublicShell>;
  }

  const me = await api.me();
  if (!me.ok) {
    return <PublicShell>{children}</PublicShell>;
  }

  const roles = { ...navigationRoles(me.data) };
  if (roles.notifications) {
    // auth/me omits binding validity dates. The protected reader confirms current permission.
    const notifications = await api.notifications({
      status: 'all',
      direction: 'next',
      invalid: false,
    });
    roles.notifications = notifications.ok;
  }
  const currentOrganization = organizations.find((organization) => organization.id === selected);
  const landing = roles.staff ? '/ops/overview' : roles.auditor ? '/changes' : '/portal';

  const groups = buildNavigationGroups(roles, landing);

  return (
    <div className="fs-private">
      <DraftSessionBoundary scope={formScope(me.data)} />
      <OfflineNotice />
      <AppFrame
        groups={groups}
        staff={roles.staff}
        organizationName={currentOrganization?.name ?? null}
        canSwitchOrganization={organizations.length > 1}
      >
        {children}
      </AppFrame>
    </div>
  );
}

function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="fs-public">
      <OfflineNotice />
      <header className="fs-public-header">
        <a className="fs-public-brand" href="/login" aria-label="SOLVI ログイン">
          <span className="fs-public-mark" aria-hidden="true">
            S
          </span>
          <span>SOLVI</span>
        </a>
        <span className="fs-public-subtitle">社内サポートポータル</span>
      </header>
      <div className="fs-public-content">{children}</div>
      <footer className="fs-public-footer">SOLVI — 社内ITサービス管理</footer>
    </div>
  );
}
