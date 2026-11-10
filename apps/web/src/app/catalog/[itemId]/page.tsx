import { ContextLink } from '../../../components/ContextLink';
import { notFound } from 'next/navigation';
import { api, requireSession } from '../../../lib/api';
import { formScope } from '../../../lib/form-scope';
import { RequestForm } from '../../../components/RequestForms';
import { safeReturnTo } from '../../../lib/navigation';
export default async function CatalogItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ itemId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const { itemId } = await params;
  const result = await api.catalogRequestOptions();
  if (!result.ok) {
    const query = await searchParams;
    const returnTo = safeReturnTo(query.returnTo);
    let retryHref: string | null = null;
    if (itemId && itemId !== '.' && itemId !== '..') {
      try {
        retryHref =
          `/catalog/${encodeURIComponent(itemId)}` +
          (returnTo ? `?${new URLSearchParams({ returnTo })}` : '');
      } catch {
        // URI符号化できない値では、同じ画面への再取得リンクだけを省く。
      }
    }
    const status = result.problem.status;
    const message =
      status === 401
        ? 'ログイン状態を確認できませんでした。ログインし直してから、もう一度お試しください。'
        : status === 403
          ? 'このサービスを表示する権限がありません。選択中の組織を確認するか、管理者にご相談ください。'
          : status === 400
            ? 'サービスの取得条件を確認できませんでした。カタログから選び直してください。'
            : status === 404
              ? '現在サービスカタログを利用できません。時間をおいて、もう一度お試しください。'
              : '一時的に申請画面を読み込めませんでした。時間をおいて、もう一度お試しください。';
    return (
      <main id="main" className="shell">
        <h1>申請画面を表示できません</h1>
        <p role="alert">{message}</p>
        <p className="actions">
          {retryHref && <a href={retryHref}>再取得する</a>}
          <a href={returnTo ?? '/catalog'}>{returnTo ? '元の画面へ戻る' : 'カタログへ戻る'}</a>
          <a href="/portal">ポータルへ戻る</a>
        </p>
      </main>
    );
  }
  const item = result.data.items.find((i) => i.id === itemId);
  if (!item) notFound();
  return (
    <main id="main" className="shell">
      <ContextLink back href="/catalog">
        カタログへ戻る
      </ContextLink>
      <h1>{item.title}</h1>
      <p className="notice">
        ローカル模擬申請です。承認後も実アカウント作成・Box権限付与・機器の貸出は行いません。
      </p>
      <p>{item.description}</p>
      <p className="hint">
        必要事項を入力 → 固定の承認者が確認 →
        IT担当者が模擬結果を記録。状況は「申請状況」で確認できます。希望日の入力による在庫予約や、実際の貸出は行いません。
      </p>
      <RequestForm scope={formScope(session)} item={item} approvers={result.data.approvers} />
    </main>
  );
}
