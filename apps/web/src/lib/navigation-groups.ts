import type { navigationRoles } from './navigation';
import type { FreshserviceIconName } from '../components/FreshserviceIcon';

export type RailItem = {
  href: string;
  label: string;
  /** 検索パラメータ付きのリンクでも、現在地判定に使うパス。 */
  matchPath?: string;
};

export type RailGroup = {
  id: string;
  label: string;
  href: string;
  icon: FreshserviceIconName;
  items: RailItem[];
};

function item(href: string, label: string, matchPath?: string): RailItem {
  return { href, label, ...(matchPath ? { matchPath } : {}) };
}

/**
 * ロールから左レールの項目を組み立てる (WP-P2-UIX-025)。
 *
 * **表示しないことを認可にしない。** ここは「押しても拒否される入口を並べない」
 * ための整理であり、API側の認可は別に残る。
 */
export function buildNavigationGroups(
  roles: ReturnType<typeof navigationRoles>,
  landing: string,
): RailGroup[] {
  const dashboardItems: RailItem[] = roles.staff
    ? [item('/ops/overview', '運営状況')]
    : [item('/portal', '利用者ポータル')];

  const ticketItems: RailItem[] = [
    ...(roles.inbox ? [item('/inbox', '業務受信箱')] : []),
    ...(roles.staff ? [item('/ops', 'チケット対応')] : []),
    item('/tickets/new', '新規チケット'),
  ];

  return [
    {
      id: 'dashboard',
      label: 'ダッシュボード',
      href: landing,
      icon: 'dashboard',
      items: dashboardItems,
    },
    {
      id: 'tickets',
      label: 'チケット',
      href: roles.inbox ? '/inbox' : roles.staff ? '/ops' : '/portal',
      icon: 'ticket',
      items: ticketItems,
    },
    {
      id: 'knowledge',
      label: 'ナレッジ',
      href: '/knowledge',
      icon: 'book',
      items: [
        item('/knowledge', 'ナレッジ検索'),
        ...(roles.staff
          ? [
              item('/knowledge?manage=1', 'ナレッジ管理', '/knowledge'),
              item('/knowledge/new', '記事を作成'),
            ]
          : []),
      ],
    },
    {
      id: 'catalog',
      label: 'サービスカタログ',
      href: '/catalog',
      icon: 'grid',
      items: [
        item('/catalog', 'サービスカタログ'),
        item('/requests', '申請状況'),
        ...(roles.admin ? [item('/catalog/manage', 'カタログ管理')] : []),
      ],
    },
    {
      id: 'assets',
      label: roles.staff ? '資産' : '自分の資産',
      href: '/assets',
      icon: 'asset',
      items: roles.staff
        ? [
            item('/assets', '資産台帳'),
            item('/assets/imports', 'CSV取込'),
            item('/assets/new', '資産を登録'),
          ]
        : [item('/assets', '自分の資産')],
    },
    ...(roles.changes
      ? [
          {
            id: 'changes',
            label: '変更',
            href: '/changes',
            icon: 'change' as const,
            items: [item('/changes', '変更管理'), item('/changes/new', '変更を計画')],
          },
        ]
      : []),
    ...(roles.admin
      ? [
          {
            id: 'admin',
            label: '管理',
            href: '/ops/admin',
            icon: 'admin' as const,
            items: [
              item('/ops/admin', '管理ホーム'),
              item('/ops/users', '利用者管理'),
              item('/ops/groups', '担当グループ'),
              ...(roles.notifications ? [item('/ops/notifications', '通知状況')] : []),
              item('/ops/access-review', 'アクセスレビュー'),
            ],
          },
        ]
      : []),
    ...(roles.staff
      ? [
          {
            id: 'portal',
            label: '利用者ポータル',
            href: '/portal',
            icon: 'portal' as const,
            items: [item('/portal', '利用者ポータル')],
          },
        ]
      : []),
  ];
}
