import Link from 'next/link';
import { requireSession } from '../../../lib/api';
import { isOrgAdmin, navigationRoles } from '../../../lib/navigation';
import { FreshserviceIcon, type FreshserviceIconName } from '../../../components/FreshserviceIcon';
import { AdminDenied } from '../../../components/AdminWorkspace';
import { adminViewPath } from '../../../lib/admin-recovery';

export const dynamic = 'force-dynamic';

type AdminCard = {
  href: string;
  title: string;
  description: string;
  icon: FreshserviceIconName;
  visible?: boolean;
};

export default async function AdminHome() {
  const session = await requireSession(adminViewPath('/ops/admin'));
  const roles = navigationRoles(session);
  const orgAdmin = isOrgAdmin(session);

  if (!roles.admin && !roles.auditor) return <AdminDenied title="管理" canOpenHome={false} />;

  const groups: Array<{ title: string; items: AdminCard[] }> = [
    {
      title: '組織と利用者',
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
      ],
    },
    {
      title: roles.admin ? '承認と運用' : 'アクセスの監査',
      items: [
        {
          href: '/ops/approvals',
          title: '承認ルール',
          description: '承認の段、経路プレビュー、組織での使用を管理します。',
          icon: 'change',
          visible: orgAdmin,
        },
        {
          href: '/ops/notifications',
          title: '通知状況',
          description: '通知の記録・失敗・手動再試行を確認します。',
          icon: 'bell',
          visible: roles.notifications,
        },
        {
          href: '/ops/access-review',
          title: 'アクセスレビュー',
          description: roles.admin
            ? '付与された役割を見直し、判断と理由を記録します。'
            : 'レビューの進捗と保存済みの判断を閲覧できます。',
          icon: 'change',
        },
      ],
    },
    {
      title: 'サービスデスク設定',
      items: [
        {
          href: '/catalog/manage',
          title: 'カタログ管理',
          description: 'サービス項目・フォーム定義・公開状態を管理します。',
          icon: 'grid',
        },
        {
          href: '/assets/imports',
          title: '資産CSV取込',
          description: 'CSVの列対応・差分・不正行を確認して取り込みます。',
          icon: 'asset',
        },
      ],
    },
  ];

  return (
    <main id="main" className="shell fs-admin admin-workspace">
      <div className="page-heading">
        <div>
          <h1>管理ホーム</h1>
          <p className="hint">
            {orgAdmin
              ? '組織管理者'
              : roles.admin
                ? 'プラットフォーム管理者'
                : '監査担当者 · 閲覧のみ'}
          </p>
        </div>
      </div>

      {groups.map((group) => {
        const items = group.items.filter(
          (item) => item.visible !== false && (roles.admin || item.href === '/ops/access-review'),
        );
        if (items.length === 0) return null;
        return (
          <section
            className="fs-admin-section"
            key={group.title}
            aria-labelledby={`admin-${group.title}`}
          >
            <div className="fs-admin-section-heading">
              <h2 id={`admin-${group.title}`}>{group.title}</h2>
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
