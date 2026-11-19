import { ContextLink } from '../../../components/ContextLink';
import { redirect } from 'next/navigation';
import { requireSession } from '../../../lib/api';
import { KnowledgeEditor } from '../../../components/KnowledgeEditor';
import { navigationRoles } from '../../../lib/navigation';
export default async function NewKnowledge() {
  const session = await requireSession();
  if (!navigationRoles(session).staff) redirect('/knowledge');
  return (
    <main id="main" className="shell service-workspace knowledge-article">
      <header className="support-page-heading">
        <div>
          <ContextLink className="support-back" back href="/knowledge?manage=1">
            記事の管理に戻る
          </ContextLink>
          <p className="service-heading-meta">担当者</p>
          <h1>新しい記事を書く</h1>
          <p className="lead">内容と閲覧範囲を確認し、下書きからレビューへ進みます。</p>
        </div>
      </header>
      <KnowledgeEditor />
    </main>
  );
}
