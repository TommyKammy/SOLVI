import Link from 'next/link';
import { redirect } from 'next/navigation';
import { api } from '../lib/api';
import { stateLabel, kindLabel, formatDateTime } from '../lib/labels';

/**
 * Portal トップ (WP-P2-PORTAL-002)。
 *
 * 主要な行動を**2つに絞る**(11.4)。「何ができるか」を並べると
 * 利用者は選べず、結局これまでどおり電話やチャットで済ませてしまう。
 *
 * 障害の報告と依頼を分けているのは、緊急度の扱いが違うためである。
 * 同じ入口にすると、止まっている業務が依頼の列に埋もれる。
 */

export const dynamic = 'force-dynamic';

export default async function PortalHome() {
  const session = await api.me();
  if (!session.ok) redirect('/login');

  const tickets = await api.listTickets(10);

  return (
    <main id="main" className="shell">
      <h1>お困りごとを解決します</h1>
      <p className="lead">障害の報告と依頼を受け付けています。状況はこの画面で確認できます。</p>

      <h2>はじめる</h2>
      <ul className="actions">
        <li>
          <Link className="action-card" href="/tickets/new?kind=incident">
            <span className="title">障害を報告する</span>
            <span className="desc">
              いま業務が止まっている、動かない、エラーが出ている場合はこちら。
            </span>
          </Link>
        </li>
        <li>
          <Link className="action-card" href="/tickets/new?kind=request">
            <span className="title">依頼する</span>
            <span className="desc">アカウントの追加、権限の変更、機器の手配などはこちら。</span>
          </Link>
        </li>
      </ul>

      <h2>最近の問い合わせ</h2>
      {!tickets.ok ? (
        <p className="empty" role="status">
          問い合わせの一覧を取得できませんでした。時間をおいて再度お試しください。
        </p>
      ) : tickets.data.items.length === 0 ? (
        <p className="empty">
          まだ問い合わせはありません。上のボタンから報告・依頼を開始できます。
        </p>
      ) : (
        <table className="tickets">
          <caption className="hint" style={{ textAlign: 'left', paddingBottom: '0.5rem' }}>
            {tickets.data.scope === 'own'
              ? 'ご自身が起票した問い合わせを表示しています'
              : '組織全体の問い合わせを表示しています'}
            (全 {tickets.data.total} 件中 {tickets.data.items.length} 件)
          </caption>
          <thead>
            <tr>
              <th scope="col">受付番号</th>
              <th scope="col">件名</th>
              <th scope="col">種別</th>
              <th scope="col">状況</th>
              <th scope="col">受付日時</th>
            </tr>
          </thead>
          <tbody>
            {tickets.data.items.map((ticket) => (
              <tr key={ticket.id}>
                <td>
                  <Link href={`/tickets/${ticket.id}`}>{ticket.number}</Link>
                </td>
                <td>{ticket.subject}</td>
                <td>{kindLabel(ticket.kind)}</td>
                <td>
                  {/* 状態は色ではなく文言で伝える。色だけだと白黒印刷や
                      色覚特性のある利用者に情報が届かない。 */}
                  <span className="state">{stateLabel(ticket.state)}</span>
                </td>
                <td>{formatDateTime(ticket.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
