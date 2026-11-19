import { ContextLink } from '../../../components/ContextLink';
import { notFound } from 'next/navigation';
import { api, requireSession } from '../../../lib/api';
import { formScope } from '../../../lib/form-scope';
import { RequestForm } from '../../../components/RequestForms';
import { safeReturnTo } from '../../../lib/navigation';
import { HIGH_RISK_APPROVAL_NOTICE } from '../../../lib/approval-route';
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
  // 承認ルールで経路が決まる項目だけ、本人を申請者とした経路を読む(読み取り専用)。
  const routeResult = item.definition.approval?.ruleId
    ? await api.catalogApprovalRoute(item.id)
    : null;
  return (
    <main id="main" className="shell catalog-application">
      <header className="support-page-heading">
        <div>
          <ContextLink back href="/catalog" className="support-back">
            カタログへ戻る
          </ContextLink>
          <p className="support-ticket-number">公開版 {item.version}</p>
          <h1>{item.title}</h1>
          <p className="lead">{item.description}</p>
        </div>
      </header>
      <p className="hint">ローカル模擬申請です。進捗と判断結果は「申請の状況」で確認できます。</p>
      {item.highRisk === true && (
        <p className="notice" role="note">
          {HIGH_RISK_APPROVAL_NOTICE}
        </p>
      )}
      <RequestForm
        scope={formScope(session)}
        item={item}
        approvers={result.data.approvers}
        {...(routeResult ? { route: routeResult.ok ? routeResult.data : null } : {})}
      />
    </main>
  );
}
