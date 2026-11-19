import { formScope, formScopeError } from '../../../lib/form-scope';
import type { FormFeedback } from '../../../lib/form-state';
import { TicketWaitNotice } from '../../../components/TicketWaitNotice';
import {
  safeReturnTo,
  navigationRoles,
  ticketBackLabel,
  ticketEntryPrefix,
  ticketListOrigin,
  withReturnTo,
} from '../../../lib/navigation';
import { ContextLink } from '../../../components/ContextLink';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  api,
  requireSession,
  type AttachmentView,
  type CommentView,
  type WorkspaceView,
} from '../../../lib/api';
import { CommentThread, commentHistoryLabel } from '../../../components/CommentThread';
import { ReplyForm } from '../../../components/ReplyForm';
import { AttachmentList } from '../../../components/AttachmentList';
import { AttachmentForm } from '../../../components/AttachmentForm';
import { TicketAssetPanel } from '../../../components/TicketAssetPanel';
import { HashOpenDetails } from '../../../components/HashOpenDetails';
import { TicketAssistance } from '../../../components/TicketAssistance';
import { RelatedChangePanel } from '../../../components/RelatedChangePanel';
import { RelationList } from '../../../components/RelationList';
import { RelationForm } from '../../../components/RelationForm';
import { routeToGroup, reassess, addRelation } from './supplementary-actions';
import { TicketRoutingForm } from '../../../components/TicketRoutingForm';
import { AssessmentForm } from '../../../components/AssessmentForm';
import {
  stateLabel,
  kindLabel,
  priorityLabel,
  formatDateTime,
  formatRemaining,
} from '../../../lib/labels';

/**
 * 担当者の作業画面 (WP-P2-OPSUI-010 / WP-P2-UIX-046)。
 *
 * **実行できない操作をボタンとして出さない。** 押してからエラーを見せるのは、
 * 利用者に「何が正しいのか」を試行錯誤で探させることになる。
 * 実行できる遷移はAPIが状態から算出して返す(`availableActions`)。
 *
 * ただし**表示しないことを防御にしない**。APIは直接叩けるため、
 * 不正な遷移はサービス層が必ず拒否する。ここは使いやすさのための工夫である。
 *
 * UI v2では、左にやり取りと返信、右に項目と履歴を置いた。
 * 操作の種類・順序は変えていない。担当グループの変更は従来どおり送信ボタン式で、
 * 選べる値はAPIが返した候補だけである。
 */

export const dynamic = 'force-dynamic';

/**
 * 競合したときの行き先 (NFR-UX-004 / WP-P2-UISTATE-020)。
 *
 * **「失敗しました」で終わらせない。** 二人が同じ問い合わせを開いていて
 * 片方が先に変更した、というのは日常的に起きる。
 * そのとき利用者がやるべきことは「もう一度押す」ではなく
 * 「最新を読んでから考え直す」である。
 *
 * **モジュール直下に置く。** コンポーネントの中に置くと、
 * サーバアクションがこれを閉包に取り込もうとして
 * 「Functions cannot be passed directly to Client Components」で落ちる。
 * 閉包へ入れてよいのは**値**であって、関数ではない。
 */
function failWith(
  ticketId: string,
  problem: { type?: string; detail?: string; title: string },
  returnTo: string | null,
): never {
  if (problem.type?.endsWith('/stale'))
    redirect(withReturnTo(`/ops/${ticketId}?stale=1`, returnTo));
  const detail = problem.detail ?? problem.title;
  redirect(withReturnTo(`/ops/${ticketId}?actionError=${encodeURIComponent(detail)}`, returnTo));
}

type HistoryEntry = { key: string; at: string; label: string; detail?: string };

/**
 * 履歴は**すでに取得している結果だけ**から作る。
 * 状態遷移の監査ログを取るAPIはこの画面に無く、追加するとAPI変更になる。
 * 起票・解決・コメント・添付を新しい順に並べ、本文は繰り返さない。
 */
function ticketHistory(
  ticket: WorkspaceView['ticket'],
  comments: CommentView[],
  attachments: AttachmentView[],
  currentUserId: string,
): HistoryEntry[] {
  const actor = (authorId: string, isRequester?: boolean) =>
    authorId === currentUserId ? '自分' : isRequester ? '依頼者' : '担当者';
  const entries: HistoryEntry[] = [
    { key: 'created', at: ticket.createdAt, label: '起票', detail: ticket.number },
    ...(ticket.resolvedAt
      ? [
          {
            key: 'resolved',
            at: ticket.resolvedAt,
            label: '解決',
            detail: '依頼者の確認待ち',
          },
        ]
      : []),
    ...comments.map((comment) => ({
      key: `comment:${comment.id}`,
      at: comment.createdAt,
      label: commentHistoryLabel(comment.visibility, comment.authorIsRequester),
      detail: actor(comment.authorId, comment.authorIsRequester),
    })),
    ...attachments.map((attachment) => ({
      key: `attachment:${attachment.id}`,
      at: attachment.createdAt,
      label: '添付ファイルを追加',
      detail: `${attachment.fileName}（${actor(attachment.uploadedBy, attachment.uploadedBy === ticket.requesterId)}）`,
    })),
  ];
  return entries.sort((left, right) => right.at.localeCompare(left.at));
}

export default async function OpsWorkspace({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const returnTo = safeReturnTo(query.returnTo);
  const origin = ticketListOrigin(returnTo);
  const backLabel = ticketBackLabel(origin, Boolean(returnTo));
  const restoreFocus = origin?.hash.startsWith('#' + ticketEntryPrefix);

  // 未ログインはログイン画面へ、組織が未選択なら選択画面へ。
  // 判定は requireSession に閉じる(画面ごとに書くと必ず書き漏れる)。
  const session = await requireSession();
  if (
    !session.roles.some((role) => ['agent', 'org_admin', 'platform_admin'].includes(role.roleCode))
  )
    redirect('/');

  const result = await api.operatorWorkspaceDetail(id);
  if (!result.ok) {
    if (result.problem.status === 401) redirect('/login');
    if (result.problem.status === 403 || result.problem.status === 404) notFound();
    const retryQuery = new URLSearchParams();
    if (returnTo) retryQuery.set('returnTo', returnTo);
    let retryHref = '';
    try {
      if (typeof id === 'string' && id.length > 0 && id !== '.' && id !== '..') {
        const path = `/ops/${encodeURIComponent(id)}`;
        const target = new URL(path, 'https://solvi.local');
        if (target.origin === 'https://solvi.local' && target.pathname === path) {
          retryHref = path + (retryQuery.size ? '?' + retryQuery.toString() : '');
        }
      }
    } catch {
      // URIにできない入力には再取得リンクを出さない。
    }
    const message =
      result.problem.status === 400
        ? '問い合わせを指定する情報が正しくありません。対応待ちの一覧から選び直してください。'
        : '一時的に問い合わせを読み込めませんでした。時間をおいて、もう一度お試しください。';
    return (
      <main id="main" className="shell">
        <h1>問い合わせを読み込めませんでした</h1>
        <p role="alert">{message}</p>
        {retryHref && (
          <p>
            <a href={retryHref}>再取得する</a>
          </p>
        )}
        <p>
          <a href={returnTo ?? '/ops'}>{returnTo ? '元の画面へ戻る' : '対応待ちの一覧へ戻る'}</a>
        </p>
        {returnTo !== '/portal' && (
          <p>
            <a href="/portal">ポータルへ戻る</a>
          </p>
        )}
      </main>
    );
  }

  const {
    ticket,
    comments,
    attachments,
    availableActions,
    priorityIsDerived,
    availableGroups,
    sla,
  } = result.data;

  // 関連は別の問い合わせにする。workspace に混ぜると、関連の取得が失敗した
  // ときに本体まで開けなくなる。関連が見えないことは、対応そのものを
  // 止める理由にはならない。
  const [knowledge, relations, assistanceResult] = await Promise.all([
    api.knowledgeList(''),
    api.listRelations(id),
    ticket.kind === 'request' ? api.ticketAssistance(id) : null,
  ]);
  const assistance = assistanceResult?.ok ? assistanceResult.data.assistance : null;
  const assistanceUnavailable =
    assistanceResult?.ok === false && assistanceResult.problem.status >= 500;
  const assistanceHref = withReturnTo(`/ops/${id}#ticket-assistance`, returnTo);
  const relationItems = relations.ok ? relations.data.items : [];
  const unresolvedChildren = relations.ok ? relations.data.unresolvedChildren : [];

  async function decideAssistance(previous: FormFeedback, form: FormData): Promise<FormFeedback> {
    'use server';
    const attempt = (previous.attempt ?? 0) + 1;
    const scopeError = await formScopeError(form);
    if (scopeError) return { message: scopeError, attempt };
    const decision = form.get('decision');
    if (!assistance || (decision !== 'accepted' && decision !== 'rejected'))
      return { message: '提案を開き直し、判断を選んでください。', attempt };
    const recorded = await api.decideTicketAssistance(id, {
      decision,
      requestRevision: assistance.requestRevision,
      suggestionVersion: assistance.suggestionVersion,
    });
    if (!recorded.ok) {
      return {
        message:
          recorded.problem.status >= 500
            ? '送信結果を確認できませんでした。再読み込みして、判断が保存されているか確認してください。'
            : (recorded.problem.detail ?? recorded.problem.title),
        attempt,
      };
    }
    redirect(withReturnTo(`/ops/${id}?saved=1#ticket-assistance`, returnTo));
  }

  async function runTransition(formData: FormData): Promise<void> {
    'use server';
    const done = await api.transition(id, {
      to: String(formData.get('to') ?? ''),
      reason: String(formData.get('reason') ?? ''),
      expectedVersion: String(formData.get('expectedVersion') ?? ''),
    });
    if (!done.ok) failWith(id, done.problem, returnTo);
    revalidatePath(`/ops/${id}`);
    redirect(withReturnTo(`/ops/${id}`, returnTo));
  }

  async function removeAttachment(formData: FormData): Promise<void> {
    'use server';
    const done = await api.deleteAttachment(
      String(formData.get('attachmentId') ?? ''),
      String(formData.get('reason') ?? ''),
    );
    if (!done.ok) redirect(withReturnTo(`/ops/${id}?actionError=1`, returnTo));
    revalidatePath(`/ops/${id}`);
    redirect(withReturnTo(`/ops/${id}`, returnTo));
  }

  async function removeRelation(formData: FormData): Promise<void> {
    'use server';
    const done = await api.unlinkTicket(String(formData.get('relationId') ?? ''));
    if (!done.ok) redirect(withReturnTo(`/ops/${id}?actionError=1`, returnTo));
    revalidatePath(`/ops/${id}`);
    redirect(withReturnTo(`/ops/${id}`, returnTo));
  }

  async function takeOwnership(): Promise<void> {
    'use server';
    const done = await api.takeOwnership(id, ticket.version);
    if (!done.ok) failWith(id, done.problem, returnTo);
    revalidatePath(`/ops/${id}`);
    redirect(withReturnTo(`/ops/${id}`, returnTo));
  }

  const isMine = ticket.assigneeId === session.userId;
  const currentGroup = availableGroups.find((g) => g.id === ticket.assigneeGroupId);
  const history = ticketHistory(ticket, comments, attachments, session.userId);

  return (
    <main id="main" className="shell ticket-workspace ticket-workspace--v2">
      <HashOpenDetails />
      <Link className="fs-ticket-back" href={returnTo ?? '/ops'} scroll={!restoreFocus}>
        {backLabel}
      </Link>

      {query.replied !== undefined && (
        <p className="notice" role="status">
          投稿を保存しました。
        </p>
      )}
      {query.updated !== undefined && (
        <p className="notice" role="status">
          変更を保存しました。
        </p>
      )}
      <div className="fs-ticket-heading">
        <div>
          <h1>{ticket.subject}</h1>
          <p className="lead">
            受付番号 {ticket.number} ・ {kindLabel(ticket.kind)} ・ 優先度{' '}
            {priorityLabel(ticket.priority)}
          </p>
        </div>
        <div className="fs-ticket-quick-actions">
          <a href="#ticket-reply">返信する</a>
          <a href="#ticket-relations">関連付け</a>
          {assistance && <a href="#ticket-assistance">AI支援</a>}
        </div>
      </div>

      <nav className="fs-ticket-tabs" aria-label="チケットの表示">
        <a href="#ticket-detail">詳細</a>
        <a href="#ticket-conversation">やり取り</a>
        <a href="#ticket-reply">返信</a>
        <a href="#ticket-attachments">添付</a>
        <a href="#ticket-relations">関連・資産・変更</a>
      </nav>

      {typeof query.merged === 'string' && (
        <div className="notice" role="status">
          <h2 style={{ marginTop: 0 }}>{query.merged} をこの問い合わせへ統合しました</h2>
          <p style={{ margin: 0 }}>
            統合元のやり取りと添付は統合元に残っています。必要なら統合元を開いて確認してください。
          </p>
        </div>
      )}

      {query.stale !== undefined && (
        // **競合を「失敗」と一緒にしない** (NFR-UX-004)。
        // 二人が同じ問い合わせを開いていて片方が先に変更した、というのは
        // 日常的に起きる。利用者がやるべきことは「もう一度押す」ではなく
        // 「最新を読んでから考え直す」である。
        <div className="error-summary" role="alert" tabIndex={-1}>
          <h2>他の人がこの問い合わせを変更しました</h2>
          <p style={{ margin: 0 }}>
            あなたの操作は反映していません。この画面は最新の内容に更新されています。
            内容を確認したうえで、必要であればもう一度操作してください。
          </p>
        </div>
      )}

      {query.actionError !== undefined && (
        <div className="error-summary" role="alert" tabIndex={-1}>
          <h2>操作できませんでした</h2>
          <p style={{ margin: 0 }}>
            {typeof query.actionError === 'string' && query.actionError !== '1'
              ? query.actionError
              : '状況が変わっている可能性があります。最新の状態を確認してください。'}
          </p>
        </div>
      )}

      <TicketWaitNotice ticket={ticket} />

      <div className="workspace-grid ticket-workspace-grid">
        <section className="workspace-primary" id="ticket-detail" aria-label="問い合わせと会話">
          <h2>依頼内容</h2>
          <div className="body-text">{ticket.body}</div>

          {assistance && (
            <TicketAssistance
              key={`${formScope(session)}:${assistance.requestId}:${assistance.requestRevision}`}
              assistance={assistance}
              action={decideAssistance}
              scope={formScope(session)}
              ticketHref={assistanceHref}
              canReadAudit={navigationRoles(session).auditLog}
              saved={query.saved === '1'}
            />
          )}
          {assistanceUnavailable && <p role="status">AI支援プレビューを取得できませんでした。</p>}

          <h2 id="ticket-conversation">やり取り</h2>
          <CommentThread comments={comments} currentUserId={session.userId} />

          <h2 id="ticket-reply">返信・対応を記録する</h2>
          <ReplyForm
            key={`${formScope(session)}:${id}`}
            ticketId={id}
            scope={formScope(session)}
            replyContext={result.data.replyContext}
            canResolve={availableActions.some((action) => action.reason === 'resolve')}
            articles={knowledge.ok ? knowledge.data.items : []}
          />
          <details className="workspace-disclosure" id="ticket-attachments">
            <summary>添付ファイル</summary>
            <AttachmentList
              attachments={attachments}
              currentUserId={session.userId}
              canDeleteAny
              deleteAction={removeAttachment}
            />
            <AttachmentForm ticketId={id} canChooseVisibility />
          </details>
        </section>

        <aside className="workspace-secondary ticket-side" aria-label="状況と担当の操作">
          <section className="ticket-side-card" aria-labelledby="ticket-properties">
            <h2 id="ticket-properties">プロパティ</h2>
            <dl className="detail ticket-properties">
              <dt>状態</dt>
              <dd>
                <span className="state" data-state={ticket.state}>
                  {stateLabel(ticket.state)}
                </span>
              </dd>

              <dt>優先度</dt>
              <dd>
                <span className="priority-label" data-priority={ticket.priority}>
                  {priorityLabel(ticket.priority)}
                </span>
                {priorityIsDerived && <span className="hint"> 影響度と緊急度から算出</span>}
              </dd>

              <dt>解決期限</dt>
              <dd>
                <span className={sla.resolutionBreached ? 'ticket-sla breached' : 'ticket-sla'}>
                  {formatRemaining(sla.remainingSeconds)}
                </span>
              </dd>

              <dt>担当グループ</dt>
              <dd>
                {/* **グループと個人は別の軸である。** グループはキュー、個人は
                いま手を動かしている人。両方が入りうるし、片方だけでもよい。 */}
                {currentGroup ? currentGroup.name : 'どのグループにも振られていません'}
              </dd>

              <dt>担当者</dt>
              <dd>{ticket.assigneeId ? (isMine ? '自分' : '他の担当者') : '未割当'}</dd>

              <dt>依頼者</dt>
              <dd>
                {/* **IDを出さない。** 読めない値を見せても意味が無い。
                「他の問い合わせ」への導線としてだけ使う (FR-TKT-006)。 */}
                <Link href={`/ops?requester=${encodeURIComponent(ticket.requesterId)}`}>
                  この依頼者の他の問い合わせ
                </Link>
              </dd>

              <dt>受付日時</dt>
              <dd>{formatDateTime(ticket.createdAt)}</dd>

              <dt>関連資産</dt>
              <dd>
                <a href="#ticket-relations">関連する資産・変更を確認</a>
              </dd>
            </dl>
          </section>

          <section className="ticket-side-card" aria-labelledby="ticket-history-title">
            <h2 id="ticket-history-title">履歴</h2>
            <ol className="ticket-history">
              {history.map((entry) => (
                <li key={entry.key}>
                  <time dateTime={entry.at}>{formatDateTime(entry.at)}</time>
                  <span className="ticket-history-label">{entry.label}</span>
                  {entry.detail && <span className="hint">{entry.detail}</span>}
                </li>
              ))}
            </ol>
          </section>

          <section className="ticket-side-card" aria-labelledby="ticket-actions-title">
            <h2 id="ticket-actions-title">操作</h2>

            {unresolvedChildren.length > 0 && (
              // **止めない。知らせるだけ。** 子が別チームの担当で長期化することがあり、
              // 解決を拒否すると運用が詰まる。判断は人に残す(WP-P2-REL-009 §6)。
              <div className="notice" role="note">
                <h3 style={{ marginTop: 0 }}>まだ対応中の子の問い合わせがあります</h3>
                <ul style={{ marginBottom: 0 }}>
                  {unresolvedChildren.map((child) => (
                    <li key={child.ticketId}>
                      <ContextLink href={`/ops/${child.ticketId}`}>
                        {child.number} {child.subject}
                      </ContextLink>{' '}
                      — {stateLabel(child.state)}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="actions-row">
              {(!isMine || ticket.state === 'new') &&
                !['closed', 'cancelled', 'merged'].includes(ticket.state) && (
                  <form action={takeOwnership}>
                    <button type="submit">自分が引き受ける</button>
                  </form>
                )}
              {availableActions.length === 0 ? (
                <p className="empty" style={{ margin: 0 }}>
                  この状況で行える操作はありません。
                </p>
              ) : (
                availableActions
                  .filter((action) => !['resolve', 'assign'].includes(action.reason))
                  .map((action) => (
                    <form key={`${action.to}:${action.reason}`} action={runTransition}>
                      <input type="hidden" name="to" value={action.to} />
                      <input type="hidden" name="reason" value={action.reason} />
                      {/* 見ていた版。送り返して、その間の変更を検出する。 */}
                      <input type="hidden" name="expectedVersion" value={ticket.version} />
                      <button type="submit" className="secondary">
                        {action.label}
                      </button>
                    </form>
                  ))
              )}
            </div>

            {/* 期限 (FR-TKT-008)。**操作の手前に置く。**
            何をするか決める前に、いつまでかを知っている必要がある。 */}
            <div className={sla.resolutionBreached ? 'sla-panel breached' : 'sla-panel'}>
              <strong>解決の期限: {formatRemaining(sla.remainingSeconds)}</strong>
              <p className="hint" style={{ margin: '0.25rem 0 0' }}>
                {sla.responseBreached ? '初回応答の目標を超えています。' : '初回応答の目標内です。'}{' '}
                超過しても操作は止まりません。目標は計測のための値です。
              </p>
            </div>
          </section>

          <section className="ticket-side-card" aria-labelledby="ticket-routing-title">
            <h2 id="ticket-routing-title">担当グループを変更</h2>
            {/*
        **グループ割当は状態を動かさない。** キューに入っただけのチケットを
        「担当者が決まった」ことにすると、実際には誰も見ていないのに
        応答したことになってしまう。
      */}
            {typeof query.groupError === 'string' && (
              <div className="error-summary" role="alert" tabIndex={-1}>
                <h3 style={{ margin: '0 0 0.5rem' }}>振り先を変えられませんでした</h3>
                <p style={{ margin: 0 }}>{query.groupError}</p>
              </div>
            )}
            <TicketRoutingForm
              action={routeToGroup.bind(null, id)}
              expectedVersion={ticket.version}
              groupId={ticket.assigneeGroupId ?? ''}
              groups={availableGroups}
            />
          </section>

          <section className="ticket-side-card" aria-labelledby="ticket-assessment-title">
            <h2 id="ticket-assessment-title">優先度と影響</h2>
            <AssessmentForm
              impact={ticket.impact}
              urgency={ticket.urgency}
              priority={ticket.priority}
              priorityIsDerived={priorityIsDerived}
              action={reassess.bind(null, id)}
              expectedVersion={ticket.version}
              errorMessage={typeof query.assessError === 'string' ? query.assessError : undefined}
            />
          </section>

          <details className="workspace-disclosure ticket-side-card" id="ticket-relations">
            <summary>関連する問い合わせ・資産・変更</summary>
            <h2>関連する問い合わせ</h2>
            <RelationList relations={relationItems} canUnlink unlinkAction={removeRelation} />
            <RelationForm
              action={addRelation.bind(null, id)}
              errorMessage={
                typeof query.relationError === 'string' ? query.relationError : undefined
              }
            />
            {ticket.state !== 'merged' && (
              <p style={{ marginTop: '1rem' }}>
                {/* 統合は別の画面へ送る。ここにボタンを置くと、
              他の操作と同じ重さに見えてしまう。**取り消せない操作である。** */}
                <ContextLink href={`/ops/${id}/merge`}>
                  重複した問い合わせとして統合する
                </ContextLink>
              </p>
            )}

            <TicketAssetPanel ticketId={id} saved={query.assetSaved === '1'} />
            <RelatedChangePanel kind="ticket" id={id} />
          </details>
        </aside>
      </div>
    </main>
  );
}
