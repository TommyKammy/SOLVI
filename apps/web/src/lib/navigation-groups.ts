import type { navigationRoles } from './navigation';
import type { FreshserviceIconName } from '../components/FreshserviceIcon';
import type { InboxView } from './api';
import type { OperationsOverviewCounts } from './operations-overview';

/** サイドバーに併記する件数。取得できなかった項目は `null` にする。 */
export type NavigationCounts = {
  inbox: number | null;
  mine: number | null;
  breached: number | null;
};

export type NavigationCountTone = 'brand' | 'danger';

export type RailItem = {
  href: string;
  label: string;
  /** 検索パラメータ付きのリンクでも、現在地判定に使うパス。 */
  matchPath?: string;
  /** 取得できたときだけ付く件数。失敗時はプロパティ自体を持たない。 */
  count?: { value: number; tone?: NavigationCountTone };
};

export type RailGroup = {
  id: string;
  label: string;
  href: string;
  icon: FreshserviceIconName;
  items: RailItem[];
};

function item(
  href: string,
  label: string,
  matchPath?: string,
  count?: RailItem['count'],
): RailItem {
  return {
    href,
    label,
    ...(matchPath ? { matchPath } : {}),
    ...(count ? { count } : {}),
  };
}

function validCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * APIの応答から、サイドバーに出す件数だけを取り出す。
 *
 * 件数の出所は `api.inbox` と `api.ticketOverview` の2つに限る。
 * どちらかが失敗しても、もう一方の件数は出す。両方とも失敗したら
 * `undefined` を返し、呼び出し側は件数を出さない(エラーにもしない)。
 */
export function navigationCounts(
  inbox: Pick<InboxView, 'counts'> | null | undefined,
  overview: Pick<OperationsOverviewCounts, 'counts'> | null | undefined,
): NavigationCounts | undefined {
  const inboxCount =
    inbox &&
    validCount(inbox.counts?.ticket) &&
    validCount(inbox.counts?.approval) &&
    validCount(inbox.counts?.change)
      ? inbox.counts.ticket + inbox.counts.approval + inbox.counts.change
      : null;
  const mine = overview && validCount(overview.counts?.mine) ? overview.counts.mine : null;
  const breached =
    overview && validCount(overview.counts?.breached) ? overview.counts.breached : null;
  if (inboxCount === null && mine === null && breached === null) return undefined;
  return { inbox: inboxCount, mine, breached };
}

/**
 * ロールから左サイドバーの項目を組み立てる (WP-P2-UIX-025 / WP-P2-UIX-044)。
 *
 * **表示しないことを認可にしない。** ここは「押しても拒否される入口を並べない」
 * ための整理であり、API側の認可は別に残る。
 * 担当グループごとの件数は、グループ数ぶんのAPI呼び出しが増えるため出さない
 * (WP-P2-UIX-044 §14)。
 */
export function buildNavigationGroups(
  roles: ReturnType<typeof navigationRoles>,
  landing: string,
  counts?: NavigationCounts,
): RailGroup[] {
  const count = (key: keyof NavigationCounts, tone?: NavigationCountTone) => {
    const value = counts?.[key];
    if (!validCount(value)) return undefined;
    // 0件を赤や強調色にしない。0は異常ではない。
    return { value, ...(tone && value > 0 ? { tone } : {}) };
  };

  const dashboardItems: RailItem[] = roles.staff
    ? [item('/ops/overview', '運営状況')]
    : [item('/portal', '利用者ポータル')];

  const ticketItems: RailItem[] = [
    ...(roles.inbox ? [item('/inbox', '業務受信箱', undefined, count('inbox', 'brand'))] : []),
    ...(roles.staff
      ? [
          item('/ops', 'チケット対応'),
          item(
            '/ops?assignment=mine&state=assigned&state=in_progress&state=pending',
            '自分の担当',
            '/ops',
            count('mine'),
          ),
          item(
            '/ops?sla=breached&state=new&state=assigned&state=in_progress&state=pending',
            '解決期限超過',
            '/ops',
            count('breached', 'danger'),
          ),
        ]
      : []),
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
              ...(roles.orgAdmin ? [item('/ops/departments', '部署管理')] : []),
              item('/ops/groups', '担当グループ'),
              ...(roles.notifications ? [item('/ops/notifications', '通知状況')] : []),
              item('/ops/access-review', 'アクセスレビュー'),
              ...(roles.orgAdmin ? [item('/ops/approvals', '承認ルール')] : []),
            ],
          },
        ]
      : []),
    ...(roles.auditor
      ? [
          {
            id: 'audit',
            label: '監査',
            href: '/ops/approvals/changes',
            icon: 'change' as const,
            items: [item('/ops/approvals/changes', '承認の変更履歴')],
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
