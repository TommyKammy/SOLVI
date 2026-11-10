import { api, requireSession } from '../../../../lib/api';
import { notFound } from 'next/navigation';
import { ContextLink } from '../../../../components/ContextLink';
import { CatalogQuestionSetForm } from '../../../../components/CatalogQuestionSetForm';
import { formatDateTime } from '../../../../lib/labels';
export const dynamic = 'force-dynamic';
export default async function QuestionSetsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string }>;
}) {
  await requireSession();
  const [sets, management] = await Promise.all([
    api.catalogQuestionSets(),
    api.catalogManagementRead(),
  ]);
  if (!sets.ok || !management.ok) {
    const status = !sets.ok
      ? sets.problem.status
      : !management.ok
        ? management.problem.status
        : 503;
    if ([403, 404].includes(status)) notFound();
    return (
      <main id="main" className="shell">
        <h1>共有項目セットを読み込めませんでした</h1>
        <p role="alert">権限と接続を確認して、再度お試しください。</p>
        <a href="/catalog/manage/question-sets">再読み込み</a>
        <p>
          <a href="/catalog/manage">カタログ管理へ戻る</a>
        </p>
      </main>
    );
  }
  return (
    <main id="main" className="shell">
      <ContextLink back href="/catalog/manage">
        カタログ管理へ戻る
      </ContextLink>
      <h1>共有項目セット</h1>
      <p>
        よく使う質問を保存し、サービスの作成時に挿入できます。セットを更新しても挿入済みのサービスは変わりません。
      </p>
      {(await searchParams).saved === '1' && (
        <p role="status" className="success">
          共有項目セットを保存しました。
        </p>
      )}
      {sets.data.canManage && <CatalogQuestionSetForm sources={management.data.items} />}
      <h2>保存したセット</h2>
      {!sets.data.items.length && (
        <p>共有項目セットはまだありません。管理者が保存したサービスの質問から作成できます。</p>
      )}
      <ul className="attachments">
        {sets.data.items.map((item) => (
          <li key={item.id} id={`set-${item.id}`} className="attachment">
            <h3>{item.title}</h3>
            <p>{item.description}</p>
            <p>
              版{item.revision} · {item.fields.length}項目 · 最終更新{' '}
              {formatDateTime(item.updatedAt)}
            </p>
            <ul>
              {item.fields.map((field) => (
                <li key={field.key}>{field.label}</li>
              ))}
            </ul>
            {sets.data.canManage && (
              <details>
                <summary>このセットを更新する</summary>
                <CatalogQuestionSetForm item={item} sources={management.data.items} />
              </details>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
