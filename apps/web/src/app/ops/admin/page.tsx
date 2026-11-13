import Link from 'next/link';
import { requireSession } from '../../../lib/api';
import { isOrgAdmin, navigationRoles } from '../../../lib/navigation';
import { FreshserviceIcon, type FreshserviceIconName } from '../../../components/FreshserviceIcon';

export const dynamic = 'force-dynamic';

type AdminCard = {
  href: string;
  title: string;
  description: string;
  icon: FreshserviceIconName;
  visible?: boolean;
};

export default async function AdminHome() {
  const session = await requireSession();
  const roles = navigationRoles(session);
  const orgAdmin = isOrgAdmin(session);

  if (!roles.admin) {
    return (
      <main id="main" className="shell fs-admin">
        <h1>管理</h1>
        <p className="overview-message" role="alert">
          管理画面を表示する権限がありません。
        </p>
        <Link href="/portal">利用者ポータルへ戻る</Link>
      </main>
    );
  }

  const groups: Array<{ title: string; description: string; items: AdminCard[] }> = [
    {
      title: 'アカウント設定',
      description: 'サービスデスクのカタログ、通知、資産取込を管理します。',
      items: [
        {
          href: '/catalog/manage',
          title: 'カタログ管理',
          description: 'サービス項目・フォーム定義・公開状態を管理します。',
          icon: 'grid',
        },
        {
          href: '/ops/notifications',
          title: '通知状況',
          description: '通知の記録・失敗・手動再試行を確認します。',
          icon: 'bell',
          visible: roles.notifications,
        },
        {
          href: '/assets/imports',
          title: '資産CSV取込',
          description: 'CSVの列対応・差分・不正行を確認して取り込みます。',
          icon: 'asset',
        },
      ],
    },
    {
      title: 'ユーザー管理',
      description: '利用者、担当グループ、役割のレビューを管理します。',
      items: [
        {
          href: '/ops/users',
          title: '利用者管理',
          description: '在籍者・役割・アクセス状態を確認します。',
          icon: 'admin',
        },
        {
          href: '/ops/departments',
          title: '部署管理',
          description: '部署の階層、メンバー、部署長を管理します。',
          icon: 'admin',
          visible: orgAdmin,
        },
        {
          href: '/ops/groups',
          title: '担当グループ',
          description: '問い合わせを受けるキューとメンバーを管理します。',
          icon: 'admin',
        },
        {
          href: '/ops/access-review',
          title: 'アクセスレビュー',
          description: '現在の役割を1件ずつ見直し、必要なら失効させます。',
          icon: 'change',
        },
        {
          href: '/ops/approvals',
          title: '承認ルール',
          description: '承認の段、経路プレビュー、組織での使用を管理します。',
          icon: 'change',
          visible: orgAdmin,
        },
      ],
    },
  ];

  return (
    <main id="main" className="shell fs-admin">
      <div className="page-heading">
        <div>
          <h1>管理</h1>
          <p className="hint">
            選択中の組織に適用される管理機能です。操作できる範囲は役割によって異なります。
          </p>
        </div>
      </div>

      {groups.map((group) => {
        const items = group.items.filter((item) => item.visible !== false);
        if (items.length === 0) return null;
        return (
          <section
            className="fs-admin-section"
            key={group.title}
            aria-labelledby={`admin-${group.title}`}
          >
            <div className="fs-admin-section-heading">
              <h2 id={`admin-${group.title}`}>{group.title}</h2>
              <p className="hint">{group.description}</p>
            </div>
            <ul className="fs-admin-grid">
              {items.map((item) => (
                <li key={item.href}>
                  <Link className="fs-admin-card" href={item.href}>
                    <span className="fs-admin-icon" aria-hidden="true">
                      <FreshserviceIcon name={item.icon} size={20} />
                    </span>
                    <span className="fs-admin-card-body">
                      <strong>{item.title}</strong>
                      <span>{item.description}</span>
                    </span>
                    <FreshserviceIcon name="chevron" size={16} />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </main>
  );
}
