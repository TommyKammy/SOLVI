import React from 'react';
import Link from 'next/link';
import { api, type SessionView } from '../lib/api';
import { navigationRoles } from '../lib/navigation';
import { buildNavigationGroups } from '../lib/navigation-groups';

const adminAreas = [
  'users',
  'departments',
  'groups',
  'approvals',
  'notifications',
  'access-review',
] as const;

export async function adminOrganizationName(session: SessionView) {
  try {
    const organizations = await api.myOrganizations();
    return organizations.ok
      ? organizations.data.organizations.find((org) => org.id === session.organizationId)?.name
      : undefined;
  } catch {
    return undefined;
  }
}

export function AdminPageHeader({
  session,
  title,
  area,
  actions,
  organizationName,
}: {
  session: SessionView;
  title: string;
  area?: (typeof adminAreas)[number];
  actions?: React.ReactNode;
  organizationName?: string;
}) {
  const roles = navigationRoles(session);
  const role = roles.orgAdmin
    ? '組織管理者'
    : roles.admin
      ? 'プラットフォーム管理者'
      : '監査担当者';
  const items =
    buildNavigationGroups(roles, '/ops/admin').find((group) => group.id === 'admin')?.items ?? [];

  return (
    <>
      <h1 className="work-page-title">{title}</h1>
      <div className="work-page-tools">
        <div className="admin-context-banner">
          {organizationName && <span>{organizationName}</span>}
          <span>表示役割</span>
          <strong>{role}</strong>
          {!roles.admin && <span>閲覧のみ</span>}
        </div>
        {actions && <div className="admin-heading-actions">{actions}</div>}
      </div>
      {area && (
        <nav className="admin-feature-tabs" aria-label="管理機能">
          <Link href="/ops/admin" prefetch={false}>
            管理ホーム
          </Link>
          {adminAreas.map((section) => {
            const item = items.find((entry) => entry.href === `/ops/${section}`);
            return item ? (
              <Link
                key={item.href}
                href={item.href}
                prefetch={false}
                aria-current={section === area ? 'page' : undefined}
              >
                {item.label}
              </Link>
            ) : null;
          })}
        </nav>
      )}
    </>
  );
}

function AdminPermissionNotice({ canOpenHome }: { canOpenHome: boolean }) {
  return (
    <section className="admin-permission" role="alert">
      <p>この画面を表示する権限がありません。組織の管理者へご連絡ください。</p>
      <div className="form-actions">
        {canOpenHome && <Link href="/ops/admin">管理ホームへ戻る</Link>}
        <Link href="/portal">利用者ポータルへ戻る</Link>
      </div>
    </section>
  );
}

export function AdminDenied({
  title,
  canOpenHome,
  administration = false,
  permissionTitle = 'この画面を表示する権限がありません。',
}: {
  title: string;
  canOpenHome: boolean;
  administration?: boolean;
  permissionTitle?: string;
}) {
  if (administration) {
    return (
      <main id="main" className="shell admin-workspace">
        <div role="alert">
          <header className="admin-page-header">
            <div>
              <p className="admin-page-meta">{title}</p>
              <h1>{permissionTitle}</h1>
            </div>
          </header>
          <section className="admin-permission admin-recovery-panel">
            <h2>閲覧できる画面に戻る</h2>
            <p>この機能の利用権限については、組織の管理者へご連絡ください。</p>
            <div className="form-actions">
              {canOpenHome && (
                <Link className="directory-cta" href="/ops/admin">
                  管理ホームへ戻る
                </Link>
              )}
              <Link className="directory-cta secondary" href="/portal">
                利用者ポータルへ戻る
              </Link>
            </div>
          </section>
        </div>
      </main>
    );
  }
  return (
    <main id="main" className="shell admin-workspace">
      <h1>{title}</h1>
      <AdminPermissionNotice canOpenHome={canOpenHome} />
    </main>
  );
}
