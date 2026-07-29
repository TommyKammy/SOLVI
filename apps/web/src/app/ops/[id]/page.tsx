import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api, requireSession } from '../../../lib/api';
import { CommentThread } from '../../../components/CommentThread';
import { CommentForm } from '../../../components/CommentForm';
import { AttachmentList } from '../../../components/AttachmentList';
import { AttachmentForm } from '../../../components/AttachmentForm';
import { RelationList } from '../../../components/RelationList';
import { RelationForm } from '../../../components/RelationForm';
import { AssessmentForm } from '../../../components/AssessmentForm';
import { stateLabel, kindLabel, priorityLabel, formatDateTime } from '../../../lib/labels';

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

  // 未ログインはログイン画面へ、組織が未選択なら選択画面へ。
  // 判定は requireSession に閉じる(画面ごとに書くと必ず書き漏れる)。
  const session = await requireSession();

  const result = await api.workspace(id);
  if (!result.ok) {
    if (result.problem.status === 401) redirect('/login');
    notFound();
  }

  const { ticket, comments, attachments, availableActions, priorityIsDerived, availableGroups } =
    result.data;

  // 関連は別の問い合わせにする。workspace に混ぜると、関連の取得が失敗した
  // ときに本体まで開けなくなる。関連が見えないことは、対応そのものを
  // 止める理由にはならない。
  const relations = await api.listRelations(id);
  const relationItems = relations.ok ? relations.data.items : [];
  const unresolvedChildren = relations.ok ? relations.data.unresolvedChildren : [];

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

  async function routeToGroup(formData: FormData): Promise<void> {
    'use server';
    const raw = String(formData.get('groupId') ?? '');
    const done = await api.assignGroup(id, raw.length > 0 ? raw : null);
    if (!done.ok) {
      const detail = done.problem.errors?.[0]?.message ?? done.problem.detail ?? done.problem.title;
      redirect(`/ops/${id}?groupError=${encodeURIComponent(detail)}`);
    }
    revalidatePath(`/ops/${id}`);
    redirect(`/ops/${id}`);
  }

  async function reassess(formData: FormData): Promise<void> {
    'use server';
    const done = await api.reassess(id, {
      impact: String(formData.get('impact') ?? ''),
      urgency: String(formData.get('urgency') ?? ''),
      reason: String(formData.get('reason') ?? ''),
    });
    if (!done.ok) {
      const detail = done.problem.errors?.[0]?.message ?? done.problem.detail ?? done.problem.title;
      redirect(`/ops/${id}?assessError=${encodeURIComponent(detail)}`);
    }
    revalidatePath(`/ops/${id}`);
    redirect(`/ops/${id}`);
  }

  async function addRelation(formData: FormData): Promise<void> {
    'use server';
    const linked = await api.linkTicket(id, {
      relationType: String(formData.get('relationType') ?? 'related'),
      targetTicketNumber: String(formData.get('targetTicketNumber') ?? ''),
    });
    if (!linked.ok) {
      const detail = linked.problem.detail ?? linked.problem.title;
      redirect(`/ops/${id}?relationError=${encodeURIComponent(detail)}`);
    }
    revalidatePath(`/ops/${id}`);
    redirect(`/ops/${id}`);
  }

  async function removeRelation(formData: FormData): Promise<void> {
    'use server';
    const done = await api.unlinkTicket(String(formData.get('relationId') ?? ''));
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

  const isMine = ticket.assigneeId === session.userId;
  const currentGroup = availableGroups.find((g) => g.id === ticket.assigneeGroupId);

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

      {typeof query.merged === 'string' && (
        <div className="notice" role="status">
          <h2 style={{ marginTop: 0 }}>{query.merged} をこの問い合わせへ統合しました</h2>
          <p style={{ margin: 0 }}>
            統合元のやり取りと添付は統合元に残っています。必要なら統合元を開いて確認してください。
          </p>
        </div>
      )}

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

        <dt>担当グループ</dt>
        <dd>
          {/* **グループと個人は別の軸である。** グループはキュー、個人は
              いま手を動かしている人。両方が入りうるし、片方だけでもよい。 */}
          {currentGroup ? currentGroup.name : 'どのグループにも振られていません'}
        </dd>
        <dt>受付日時</dt>
        <dd>{formatDateTime(ticket.createdAt)}</dd>
      </dl>

      <h2>操作</h2>

      {unresolvedChildren.length > 0 && (
        // **止めない。知らせるだけ。** 子が別チームの担当で長期化することがあり、
        // 解決を拒否すると運用が詰まる。判断は人に残す(WP-P2-REL-009 §6)。
        <div className="notice" role="note">
          <h3 style={{ marginTop: 0 }}>まだ対応中の子の問い合わせがあります</h3>
          <ul style={{ marginBottom: 0 }}>
            {unresolvedChildren.map((child) => (
              <li key={child.ticketId}>
                <Link href={`/ops/${child.ticketId}`}>
                  {child.number} {child.subject}
                </Link>{' '}
                — {stateLabel(child.state)}
              </li>
            ))}
          </ul>
        </div>
      )}

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

      <h2>振り先</h2>
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
      <form action={routeToGroup} className="stack" style={{ maxWidth: '28rem' }}>
        <div className="field">
          <label htmlFor="group-select">担当グループ</label>
          <span className="hint" id="group-select-hint">
            振り先を変えても、いまの担当者はそのままです
          </span>
          <select
            id="group-select"
            name="groupId"
            defaultValue={ticket.assigneeGroupId ?? ''}
            aria-describedby="group-select-hint"
          >
            <option value="">どのグループにも振らない</option>
            {availableGroups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}({group.memberCount}人)
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="secondary">
          振り先を変える
        </button>
      </form>

      <h2>見立て</h2>
      <AssessmentForm
        impact={ticket.impact}
        urgency={ticket.urgency}
        priority={ticket.priority}
        priorityIsDerived={priorityIsDerived}
        action={reassess}
        errorMessage={typeof query.assessError === 'string' ? query.assessError : undefined}
      />

      <h2>依頼内容</h2>
      <div className="body-text">{ticket.body}</div>

      <h2>関連する問い合わせ</h2>
      <RelationList relations={relationItems} canUnlink unlinkAction={removeRelation} />
      <RelationForm
        action={addRelation}
        errorMessage={typeof query.relationError === 'string' ? query.relationError : undefined}
      />
      {ticket.state !== 'merged' && (
        <p style={{ marginTop: '1rem' }}>
          {/* 統合は別の画面へ送る。ここにボタンを置くと、
              他の操作と同じ重さに見えてしまう。**取り消せない操作である。** */}
          <Link href={`/ops/${id}/merge`}>重複した問い合わせとして統合する</Link>
        </p>
      )}

      <h2>添付ファイル</h2>
      <AttachmentList
        attachments={attachments}
        currentUserId={session.userId}
        canDeleteAny
        deleteAction={removeAttachment}
      />
      <AttachmentForm ticketId={id} canChooseVisibility />

      <h2>やり取り</h2>
      <CommentThread comments={comments} currentUserId={session.userId} />

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
