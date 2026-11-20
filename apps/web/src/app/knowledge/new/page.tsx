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
      <h1 className="work-page-title">新しい記事を書く</h1>
      <div className="work-page-tools">
        <ContextLink className="support-back" back href="/knowledge?manage=1">
          記事の管理に戻る
        </ContextLink>
      </div>
      <KnowledgeEditor />
    </main>
  );
}
