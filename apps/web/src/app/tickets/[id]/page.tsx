import { formScope } from '../../../lib/form-scope';
import { TicketWaitNotice } from '../../../components/TicketWaitNotice';
import { safeReturnTo, withReturnTo } from '../../../lib/navigation';
import { ContextLink } from '../../../components/ContextLink';
import { notFound, redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api, requireSession } from '../../../lib/api';
import { CommentThread } from '../../../components/CommentThread';
import { CommentForm } from '../../../components/CommentForm';
import { AttachmentList } from '../../../components/AttachmentList';
import { AttachmentForm } from '../../../components/AttachmentForm';
import { TicketAssetPanel } from '../../../components/TicketAssetPanel';
import { RelationList } from '../../../components/RelationList';
import {
  formatRemaining,
  stateLabel,
  kindLabel,
  priorityLabel,
  levelLabel,
  formatDateTime,
} from '../../../lib/labels';

/**
 * 受付完了 / 問い合わせ詳細 (WP-P2-PORTAL-002)。
 *
 * 送信直後の画面で最も大事なのは「**受け付けられたことが分かる**」ことである。
 * 受付番号を大きく出し、次に何が起きるかを書く。これが無いと、
 * 利用者は届いたか不安になり、同じ内容を電話でもう一度伝えてくる。
 */

export const dynamic = 'force-dynamic';

export default async function TicketDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const justCreated = query.created !== undefined;

  // 未ログインはログイン画面へ、組織が未選択なら選択画面へ。
  // 判定は requireSession に閉じる(画面ごとに書くと必ず書き漏れる)。
  const session = await requireSession();

  const result = await api.ticketDetail(id);
  if (!result.ok) {
    if (result.problem.status === 401) redirect('/login');
    // 権限が無い場合も API は 404 を返す(存在秘匿)。
    // 画面側で 403 と 404 を区別しないことで、その方針を崩さない。
    if (result.problem.status === 403 || result.problem.status === 404) notFound();
    const returnTo = safeReturnTo(query.returnTo);
    const retryQuery = new URLSearchParams();
    if (returnTo) retryQuery.set('returnTo', returnTo);
    let encodedId = '';
    try {
      if (typeof id === 'string' && id.length > 0 && id !== '.' && id !== '..') {
        encodedId = encodeURIComponent(id);
      }
    } catch {
      // URIにできない入力には再取得リンクを出さない。
    }
    const retryHref = encodedId
      ? `/tickets/${encodedId}${retryQuery.size ? '?' + retryQuery.toString() : ''}`
      : '';
    const message =
      result.problem.status === 400
        ? '問い合わせを指定する情報が正しくありません。一覧から選び直してください。'
        : '一時的に問い合わせを読み込めませんでした。時間をおいて、もう一度お試しください。';
    return (
      <main id="main" className="shell">
        <h1>問い合わせを読み込めませんでした</h1>
        <p role="alert">{message}</p>
        {encodedId && (
          <p>
            <a href={retryHref}>再取得する</a>
          </p>
        )}
        <p>
          <a href={returnTo ?? '/portal'}>{returnTo ? '元の画面へ戻る' : '問い合わせ一覧へ戻る'}</a>
        </p>
        <p>
          <a href="/portal">ポータルへ戻る</a>
        </p>
      </main>
    );
  }

  const ticket = result.data;

  // コメント一覧。**内部メモの除外はAPI側が行う。**
  // 依頼者のセッションでは、そもそも内部メモが返ってこない。
  const commentResult = await api.listComments(id);
  const comments = commentResult.ok ? commentResult.data.items : [];

  // 内部添付は API 側で除外される。画面はフィルタしない。
  const attachmentResult = await api.listAttachments(id);
  const attachments = attachmentResult.ok ? attachmentResult.data.items : [];

  // 関連する問い合わせ。**依頼者にも見せる。**
  // 「同じ件でもう1つ出してしまった」ときに、どちらが生きているのか
  // 依頼者自身が分からないと、担当者へ問い合わせる手間が増える。
  // 相手が権限外なら API が返さないので、画面はそのまま並べてよい。
  const relationResult = await api.listRelations(id);
  const relations = relationResult.ok ? relationResult.data.items : [];

  async function reopen(): Promise<void> {
    'use server';
    const done = await api.transition(id, { to: 'in_progress', reason: 'reopen' });
    if (!done.ok) {
      const detail = done.problem.detail ?? done.problem.title;
      redirect(
        withReturnTo(`/tickets/${id}?reopenError=${encodeURIComponent(detail)}`, query.returnTo),
      );
    }
    revalidatePath(`/tickets/${id}`);
    redirect(withReturnTo(`/tickets/${id}`, query.returnTo));
  }

  async function removeAttachment(formData: FormData): Promise<void> {
    'use server';
    const done = await api.deleteAttachment(
      String(formData.get('attachmentId') ?? ''),
      String(formData.get('reason') ?? ''),
    );
    if (!done.ok) redirect(withReturnTo(`/tickets/${id}?commentError=1`, query.returnTo));
    revalidatePath(`/tickets/${id}`);
    redirect(withReturnTo(`/tickets/${id}`, query.returnTo));
  }

  return (
    <main id="main" className="shell ticket-workspace">
      {justCreated && (
        <div
          className="error-summary"
          style={{ borderColor: 'var(--accent)', background: 'var(--surface)' }}
          role="status"
          tabIndex={-1}
          autoFocus
        >
          <h2 style={{ color: 'var(--accent)' }}>受け付けました</h2>
          <p style={{ margin: 0 }}>
            受付番号は <strong>{ticket.number}</strong> です。担当者が内容を確認し、
            進捗と追加の連絡はこの画面で確認できます。
          </p>
        </div>
      )}

      <h1>{ticket.subject}</h1>
      <p className="lead">
        受付番号 {ticket.number} ・ {kindLabel(ticket.kind)}
      </p>

      <TicketWaitNotice
        ticket={ticket}
        requester={
          !session.roles.some((role) =>
            ['agent', 'org_admin', 'auditor', 'platform_admin'].includes(role.roleCode),
          )
        }
      />

      <div className="workspace-grid">
        <section className="workspace-primary" aria-label="問い合わせと会話">
          <h2>お知らせいただいた内容</h2>
          <div className="body-text">{ticket.body}</div>

          <h2>やり取り</h2>
          <CommentThread comments={comments} currentUserId={session.userId} />

          <h2>追加でお知らせする</h2>
          {query.commentSaved === '1' && (
            <p role="status" className="success">
              追加内容を送信しました。
            </p>
          )}
          <p className="lead">
            状況が変わった場合や、担当者への補足があればこちらへお書きください。
          </p>
          {commentResult.ok ? (
            <CommentForm
              key={`${formScope(session)}:${id}`}
              ticketId={id}
              scope={formScope(session)}
              replyContext={commentResult.data.replyContext}
              errorMessage={
                query.commentError !== undefined
                  ? '内容を確認して、もう一度お試しください。'
                  : undefined
              }
            />
          ) : (
            <p role="alert">
              やり取りを読み込めませんでした。画面を再読込してから入力してください。
            </p>
          )}

          <details className="workspace-disclosure">
            <summary>添付ファイル</summary>
            {/* 依頼者が消せるのは自分が添付したものだけ。
          担当者の添付を消せると、対応の記録を一方的に削れてしまう。 */}
            <AttachmentList
              attachments={attachments}
              currentUserId={session.userId}
              deleteAction={removeAttachment}
            />
            <AttachmentForm ticketId={id} canChooseVisibility={false} />
          </details>
        </section>
        <aside className="workspace-secondary" aria-label="問い合わせの状況">
          <dl className="detail">
            <dt>状況</dt>
            <dd>
              <span className="state" data-state={ticket.state}>
                {stateLabel(ticket.state)}
              </span>
            </dd>

            <dt>担当</dt>
            <dd>{ticket.assigned ? '担当者を割り当て済み' : '割り当て待ち'}</dd>

            <dt>優先度</dt>
            <dd>
              {priorityLabel(ticket.priority)}
              {/* 優先度は影響と緊急度から自動で決まる(FR-TKT-002)。
              「なぜこの優先度なのか」を示すことで、問い合わせを減らす。 */}
              <span className="hint">
                (影響: {levelLabel(ticket.impact)} / 急ぎ具合: {levelLabel(ticket.urgency)}{' '}
                から判定)
              </span>
            </dd>

            <dt>受付日時</dt>
            <dd>{formatDateTime(ticket.createdAt)}</dd>

            {ticket.resolvedAt && (
              <>
                <dt>解決日時</dt>
                <dd>{formatDateTime(ticket.resolvedAt)}</dd>
              </>
            )}
          </dl>

          {ticket.sla && ticket.state !== 'closed' && ticket.state !== 'cancelled' && (
            // **依頼者にも期限を見せる。** 「いつまでに返ってくるか」は
            // 依頼者が最も知りたいことであり、見えないと
            // 「まだですか」という問い合わせが増える。
            <div className={ticket.sla.breached ? 'sla-panel breached' : 'sla-panel'}>
              <strong>対応の目安: {formatRemaining(ticket.sla.remainingSeconds ?? 0)}</strong>
              <p className="hint" style={{ margin: '0.25rem 0 0' }}>
                {ticket.sla.breached
                  ? '目安の時間を過ぎています。お待たせしており申し訳ありません。状況は担当者が確認しています。'
                  : '優先度に応じた目安です。状況により前後することがあります。'}
              </p>
            </div>
          )}

          {ticket.state === 'resolved' && (
            <>
              <h2>解決していない場合</h2>
              {/*
            **これが無いと、依頼者は同じ件で新規に起票し直すしかない。**
            履歴が分断され、担当側から見ても再発なのか未解決なのか区別できなくなる。

            期限(解決から14日)の判定はAPIが行う。画面で日数を数えると、
            規則を2か所に持つことになり、片方だけ変わったときに食い違う。
          */}
              <p className="lead">
                解決したことになっていますが直っていない場合は、こちらから対応の再開を
                お願いできます。解決から14日を過ぎた場合は、あらためて新しく お問い合わせください。
              </p>

              {typeof query.reopenError === 'string' && (
                <div className="error-summary" role="alert" tabIndex={-1}>
                  <h3 style={{ margin: '0 0 0.5rem' }}>再開できませんでした</h3>
                  <p style={{ margin: 0 }}>{query.reopenError}</p>
                </div>
              )}

              <form action={reopen}>
                <button type="submit" className="secondary">
                  まだ解決していないと伝える
                </button>
              </form>
            </>
          )}

          <details className="workspace-disclosure">
            <summary>関連する問い合わせと資産</summary>
            {relations.length > 0 && (
              <>
                <h2>関連する問い合わせ</h2>
                {/* 解除も統合も担当者の操作である。依頼者には出さない。 */}
                <RelationList relations={relations} />
              </>
            )}

            <TicketAssetPanel ticketId={id} />
          </details>
        </aside>
      </div>
      <p style={{ marginTop: '2rem' }}>
        <ContextLink back href="/portal">
          ポータルへ戻る
        </ContextLink>
      </p>
    </main>
  );
}
