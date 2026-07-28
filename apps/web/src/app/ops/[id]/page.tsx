import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api } from '../../../lib/api';
import { CommentThread } from '../../../components/CommentThread';
import { CommentForm } from '../../../components/CommentForm';
import { AttachmentList } from '../../../components/AttachmentList';
import { AttachmentForm } from '../../../components/AttachmentForm';
import {
  stateLabel,
  kindLabel,
  priorityLabel,
  levelLabel,
  formatDateTime,
} from '../../../lib/labels';

/**
 * 担当者の作業画面 (WP-P2-OPSUI-010)。
 *
 * **実行できない操作をボタンとして出さない。** 押してからエラーを見せるのは、
 * 利用者に「何が正しいのか」を試行錯誤で探させることになる。
 * 実行できる遷移はAPIが状態から算出して返す(`availableActions`)。
 *
 * ただし**表示しないことを防御にしない**。APIは直接叩けるため、
 * 不正な遷移はサービス層が必ず拒否する。ここは使いやすさのための工夫である。
 */

export const dynamic = 'force-dynamic';

export default async function OpsWorkspace({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;

  const session = await api.me();
  if (!session.ok) redirect('/login');

  const result = await api.workspace(id);
  if (!result.ok) {
    if (result.problem.status === 401) redirect('/login');
    notFound();
  }

  const { ticket, comments, attachments, availableActions } = result.data;

  async function postComment(formData: FormData): Promise<void> {
    'use server';
    const posted = await api.addComment(id, {
      visibility: String(formData.get('visibility') ?? 'public'),
      body: String(formData.get('body') ?? ''),
    });
    if (!posted.ok) {
      redirect(`/ops/${id}?commentError=1`);
    }
    revalidatePath(`/ops/${id}`);
    redirect(`/ops/${id}`);
  }

  async function runTransition(formData: FormData): Promise<void> {
    'use server';
    const done = await api.transition(id, {
      to: String(formData.get('to') ?? ''),
      reason: String(formData.get('reason') ?? ''),
    });
    if (!done.ok) {
      // 状態が既に変わっていた場合など。画面を作り直せば正しい選択肢が出る。
      redirect(`/ops/${id}?actionError=1`);
    }
    revalidatePath(`/ops/${id}`);
    redirect(`/ops/${id}`);
  }

  async function removeAttachment(formData: FormData): Promise<void> {
    'use server';
    const done = await api.deleteAttachment(
      String(formData.get('attachmentId') ?? ''),
      String(formData.get('reason') ?? ''),
    );
    if (!done.ok) redirect(`/ops/${id}?actionError=1`);
    revalidatePath(`/ops/${id}`);
    redirect(`/ops/${id}`);
  }

  async function takeOwnership(): Promise<void> {
    'use server';
    const me = await api.me();
    if (!me.ok) redirect('/login');
    const done = await api.assign(id, me.data.userId);
    if (!done.ok) redirect(`/ops/${id}?actionError=1`);
    revalidatePath(`/ops/${id}`);
    redirect(`/ops/${id}`);
  }

  const isMine = ticket.assigneeId === session.data.userId;

  return (
    <main id="main" className="shell">
      <p>
        <Link href="/ops">対応待ちの一覧へ戻る</Link>
      </p>

      <h1>{ticket.subject}</h1>
      <p className="lead">
        受付番号 {ticket.number} ・ {kindLabel(ticket.kind)} ・ 優先度{' '}
        {priorityLabel(ticket.priority)}
      </p>

      {query.actionError !== undefined && (
        <div className="error-summary" role="alert" tabIndex={-1}>
          <h2>操作できませんでした</h2>
          <p style={{ margin: 0 }}>
            状況が変わっている可能性があります。最新の状態を確認してください。
          </p>
        </div>
      )}

      <dl className="detail">
        <dt>状況</dt>
        <dd>
          <span className="state">{stateLabel(ticket.state)}</span>
        </dd>
        <dt>担当</dt>
        <dd>{ticket.assigneeId ? (isMine ? '自分' : '他の担当者') : '未割当'}</dd>
        <dt>影響 / 急ぎ具合</dt>
        <dd>
          {levelLabel(ticket.impact)} / {levelLabel(ticket.urgency)}
        </dd>
        <dt>受付日時</dt>
        <dd>{formatDateTime(ticket.createdAt)}</dd>
      </dl>

      <h2>操作</h2>
      <div className="actions-row">
        {!isMine && (
          <form action={takeOwnership}>
            <button type="submit">自分の担当にする</button>
          </form>
        )}
        {availableActions.length === 0 ? (
          <p className="empty" style={{ margin: 0 }}>
            この状況で行える操作はありません。
          </p>
        ) : (
          availableActions.map((action) => (
            <form key={`${action.to}:${action.reason}`} action={runTransition}>
              <input type="hidden" name="to" value={action.to} />
              <input type="hidden" name="reason" value={action.reason} />
              <button type="submit" className="secondary">
                {action.label}
              </button>
            </form>
          ))
        )}
      </div>

      <h2>依頼内容</h2>
      <div className="body-text">{ticket.body}</div>

      <h2>添付ファイル</h2>
      <AttachmentList
        attachments={attachments}
        currentUserId={session.data.userId}
        canDeleteAny
        deleteAction={removeAttachment}
      />
      <AttachmentForm ticketId={id} canChooseVisibility />

      <h2>やり取り</h2>
      <CommentThread comments={comments} currentUserId={session.data.userId} />

      <h2>投稿する</h2>
      <CommentForm
        action={postComment}
        canWriteInternal
        errorMessage={
          query.commentError !== undefined ? '内容を確認して、もう一度お試しください。' : undefined
        }
      />
    </main>
  );
}
