import { ContextLink } from '../../../components/ContextLink';
import { redirect } from 'next/navigation';
import { requireSession } from '../../../lib/api';
import { KnowledgeEditor } from '../../../components/KnowledgeEditor';
export default async function NewKnowledge() {
  const session = await requireSession();
  if (!session.roles.some((r) => ['agent', 'org_admin', 'platform_admin'].includes(r.roleCode)))
    redirect('/knowledge');
  return (
    <main id="main" className="shell">
      <ContextLink back href="/knowledge?manage=1">
        記事の管理に戻る
      </ContextLink>
      <h1>新しい記事を書く</h1>
      <KnowledgeEditor />
    </main>
  );
}
