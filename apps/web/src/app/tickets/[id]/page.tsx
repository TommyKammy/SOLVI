import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { api } from '../../../lib/api';
import {
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

  const result = await api.getTicket(id);
  if (!result.ok) {
    if (result.problem.status === 401) redirect('/login');
    // 権限が無い場合も API は 404 を返す(存在秘匿)。
    // 画面側で 403 と 404 を区別しないことで、その方針を崩さない。
    notFound();
  }

  const ticket = result.data;

  return (
    <main id="main" className="shell">
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
            進捗はこの画面に反映されます。追加の連絡が必要な場合はご登録のメールアドレスへ
            お知らせします。
          </p>
        </div>
      )}

      <h1>{ticket.subject}</h1>
      <p className="lead">
        受付番号 {ticket.number} ・ {kindLabel(ticket.kind)}
      </p>

      <dl className="detail">
        <dt>状況</dt>
        <dd>
          <span className="state">{stateLabel(ticket.state)}</span>
        </dd>

        <dt>担当</dt>
        <dd>{ticket.assigned ? '担当者を割り当て済み' : '割り当て待ち'}</dd>

        <dt>優先度</dt>
        <dd>
          {priorityLabel(ticket.priority)}
          {/* 優先度は影響と緊急度から自動で決まる(FR-TKT-002)。
              「なぜこの優先度なのか」を示すことで、問い合わせを減らす。 */}
          <span className="hint">
            (影響: {levelLabel(ticket.impact)} / 急ぎ具合: {levelLabel(ticket.urgency)} から判定)
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

      <h2>お知らせいただいた内容</h2>
      <div className="body-text">{ticket.body}</div>

      <p style={{ marginTop: '2rem' }}>
        <Link href="/">ポータルへ戻る</Link>
      </p>
    </main>
  );
}
