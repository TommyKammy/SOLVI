'use client';
import Link from 'next/link';
import { useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

type Roles = {
  staff: boolean;
  admin: boolean;
  inbox: boolean;
  changes: boolean;
  auditor: boolean;
  notifications?: boolean;
};
export function AppNavigation({ roles }: { roles: Roles }) {
  const [expanded, setExpanded] = useState(false);
  const path = usePathname();
  const params = useSearchParams();
  const directoryRole = params.getAll('role').length === 1 ? params.get('role') : null;
  const links = (items: Array<[string, string]>) =>
    items.map(([href, label]) => {
      const url = new URL(href, 'https://solvi.local');
      const active =
        (path === url.pathname ||
          path.startsWith(url.pathname + '/') ||
          (url.pathname === '/portal' && path.startsWith('/tickets/'))) &&
        (url.pathname !== '/catalog' || !path.startsWith('/catalog/manage')) &&
        (url.pathname !== '/ops' ||
          (!path.startsWith('/ops/users') &&
            !path.startsWith('/ops/groups') &&
            !path.startsWith('/ops/overview') &&
            !path.startsWith('/ops/notifications'))) &&
        (url.pathname !== '/knowledge' ||
          (params.get('manage') === '1' || path === '/knowledge/new') ===
            url.searchParams.has('manage')) &&
        (url.pathname !== '/ops/users' ||
          (url.searchParams.has('role')
            ? directoryRole === url.searchParams.get('role')
            : !['requester', 'agent'].includes(directoryRole ?? '')));
      return (
        <Link
          key={href}
          href={href}
          onClick={() => setExpanded(false)}
          aria-current={active ? 'page' : undefined}
          className={
            url.pathname === '/ops/users' && url.searchParams.has('role')
              ? 'navigation-subitem'
              : undefined
          }
        >
          {label}
        </Link>
      );
    });
  return (
    <div className="app-navigation">
      <button
        type="button"
        className="secondary navigation-toggle"
        aria-expanded={expanded}
        aria-controls="workspace-navigation"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? 'メニューを閉じる' : 'メニューを開く'}
      </button>
      <div id="workspace-navigation" className={`navigation-groups${expanded ? ' expanded' : ''}`}>
        {(roles.inbox || roles.changes) && (
          <nav className="navigation-group" aria-label="担当業務">
            <span className="navigation-label">
              {roles.staff ? '担当業務' : roles.inbox ? '承認業務' : '業務の参照'}
            </span>
            {links([
              ...(roles.inbox ? [['/inbox', '業務受信箱'] as [string, string]] : []),
              ...(roles.staff
                ? ([
                    ['/ops/overview', '運営状況'],
                    ['/ops', 'チケット対応'],
                    ['/assets', '資産台帳'],
                    ['/knowledge?manage=1', 'ナレッジ管理'],
                  ] as [string, string][])
                : []),
              ...(roles.inbox ? [['/requests', '申請・承認状況'] as [string, string]] : []),
              ...(roles.changes ? [['/changes', '変更管理'] as [string, string]] : []),
            ])}
          </nav>
        )}
        {roles.admin && (
          <nav className="navigation-group" aria-label="組織の管理">
            <span className="navigation-label">組織の管理</span>
            {links([
              ['/ops/users', '利用者管理'],
              ['/ops/users?role=requester', 'リクエスター'],
              ['/ops/users?role=agent', 'オペレーター'],
              ['/ops/groups', '担当グループ'],
              ['/catalog/manage', 'カタログ管理'],
              ...(roles.notifications
                ? [['/ops/notifications', '通知状況'] as [string, string]]
                : []),
            ])}
          </nav>
        )}
        <nav className="navigation-group" aria-label="相談・申請">
          <span className="navigation-label">相談・申請</span>
          {links([
            ['/portal', '利用者ポータル'],
            ['/knowledge', 'ナレッジ検索'],
            ['/catalog', 'サービスカタログ'],
            ...(!roles.inbox ? [['/requests', '申請状況'] as [string, string]] : []),
            ...(!roles.staff ? [['/assets', '自分の資産'] as [string, string]] : []),
          ])}
        </nav>
      </div>
    </div>
  );
}

const sections: Record<string, [string, string]> = {
  portal: ['/portal', '利用者ポータル'],
  tickets: ['/portal', '自分の問い合わせ'],
  inbox: ['/inbox', '業務受信箱'],
  ops: ['/ops', 'チケット対応'],
  assets: ['/assets', '資産'],
  changes: ['/changes', '変更管理'],
  knowledge: ['/knowledge', 'ナレッジ'],
  catalog: ['/catalog', 'サービスカタログ'],
  requests: ['/requests', '申請状況'],
  settings: ['/settings/notifications', '自分の通知設定'],
};
export function RouteContext() {
  const path = usePathname();
  const params = useSearchParams();
  const parts = path.split('/').filter(Boolean);
  let section = sections[parts[0]];
  if (!section) return null;
  if (path.startsWith('/catalog/manage')) section = ['/catalog/manage', 'カタログ管理'];
  if (path.startsWith('/ops/users')) section = ['/ops/users', '利用者管理'];
  if (path.startsWith('/ops/groups')) section = ['/ops/groups', '担当グループ'];
  if (path.startsWith('/ops/overview')) section = ['/ops/overview', '運営状況'];
  if (path.startsWith('/ops/notifications')) section = ['/ops/notifications', '通知状況'];
  if (parts[0] === 'knowledge' && (params.get('manage') === '1' || path === '/knowledge/new'))
    section = ['/knowledge?manage=1', 'ナレッジ管理'];
  const detail = path !== section[0].split('?')[0];
  const label = parts.at(-1) === 'new' ? '新規作成' : parts.at(-1) === 'edit' ? '編集' : '詳細';
  return (
    <nav className="route-context" aria-label="現在地">
      {detail ? (
        <Link href={section[0]}>{section[1]}</Link>
      ) : (
        <span aria-current="page">{section[1]}</span>
      )}
      {detail && (
        <>
          <span aria-hidden="true"> / </span>
          <span aria-current="page">{label}</span>
        </>
      )}
    </nav>
  );
}
