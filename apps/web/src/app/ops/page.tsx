import Link from 'next/link';
import { api, requireSession } from '../../lib/api';
import { stateLabel, kindLabel, priorityLabel, formatDateTime } from '../../lib/labels';
import { TicketFilters } from '../../components/TicketFilters';

/**
 * 担当者向けチケット一覧 (WP-P2-OPSUI-010)。
 *
 * 依頼者のトップとは**情報の密度を変える**(11.1)。
 * 依頼者は「自分の件がどうなったか」だけを知りたいが、
 * 担当者は「いま何から手を付けるか」を決める必要がある。
 * 優先度と受付日時を出し、未割当が分かるようにする。
 */

export const dynamic = 'force-dynamic';

export default async function OpsQueue({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  // 絞り込み条件を URLSearchParams へ組み直す。
  // 画面が組み立てた条件をそのままAPIへ渡し、応答の appliedFilter と
  // 突き合わせられるようにする。
  const filter = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (!['state', 'kind', 'priority', 'assignment', 'keyword'].includes(key)) continue;
    for (const v of Array.isArray(value) ? value : value ? [value] : []) {
      filter.append(key, v);
    }
  }
  const filtering = [...filter.keys()].length > 0;

  // 未ログインはログイン画面へ、組織が未選択なら選択画面へ。
  // 判定は requireSession に閉じる(画面ごとに書くと必ず書き漏れる)。
  const session = await requireSession();

  const isAgent = session.roles.some((r) =>
    ['agent', 'org_admin', 'platform_admin'].includes(r.roleCode),
  );
  if (!isAgent) {
    // 権限が無い利用者にはこの画面を見せない。
    // ただし**表示しないことを防御にしない** — APIは自分の分しか返さない。
    return (
      <main id="main" className="shell">
        <h1>担当者向けの画面</h1>
        <p className="empty">この画面を表示する権限がありません。</p>
        <p>
          <Link href="/">ポータルへ戻る</Link>
        </p>
      </main>
    );
  }

  const tickets = await api.listTickets(50, filter);
  // 絞り込みの選択肢に名前を出すために引く。失敗しても一覧は出す —
  // グループが見えないことは、対応そのものを止める理由にはならない。
  const groupList = await api.listGroups();
  const groups = groupList.ok ? groupList.data.items.map((g) => ({ id: g.id, name: g.name })) : [];

  return (
    <main id="main" className="shell">
      <h1>対応待ちの一覧</h1>
      <p className="lead">組織全体の問い合わせを、受付が新しい順に表示しています。</p>

      <TicketFilters applied={filter} groups={groups} />
      {session.roles.some((r) => ['org_admin', 'platform_admin'].includes(r.roleCode)) && (
        <p>
          <Link href="/ops/groups">担当グループを管理する</Link>
        </p>
      )}

      {filtering && (
        // **絞り込み中であることを本文で示す。** 件数だけだと、
        // 絞り込んでいることを忘れて「件数が減った」と誤解される。
        <p className="filter-notice" role="status">
          {filter.get('keyword')
            ? `「${filter.get('keyword')}」で検索中です。`
            : '絞り込み中です。'}
          すべて表示するには「条件を解除」を押してください。
        </p>
      )}

      {!tickets.ok ? (
        <p className="empty" role="status">
          一覧を取得できませんでした。時間をおいて再度お試しください。
        </p>
      ) : tickets.data.items.length === 0 ? (
        <p className="empty">
          {filtering
            ? filter.get('keyword')
              ? `「${filter.get('keyword')}」に一致する問い合わせはありません。別の言葉でお試しください。`
              : '条件に合う問い合わせはありません。条件を緩めてお試しください。'
            : '対応待ちの問い合わせはありません。'}
        </p>
      ) : (
        <table className="tickets">
          <caption style={{ textAlign: 'left', paddingBottom: '0.5rem' }}>
            全 {tickets.data.total} 件中 {tickets.data.items.length} 件を表示
          </caption>
          <thead>
            <tr>
              <th scope="col">受付番号</th>
              <th scope="col">件名</th>
              <th scope="col">種別</th>
              <th scope="col">優先度</th>
              <th scope="col">状況</th>
              <th scope="col">担当</th>
              <th scope="col">受付日時</th>
            </tr>
          </thead>
          <tbody>
            {tickets.data.items.map((ticket) => (
              <tr key={ticket.id}>
                <td>
                  <Link href={`/ops/${ticket.id}`}>{ticket.number}</Link>
                </td>
                <td>{ticket.subject}</td>
                <td>{kindLabel(ticket.kind)}</td>
                <td>{priorityLabel(ticket.priority)}</td>
                <td>
                  <span className="state">{stateLabel(ticket.state)}</span>
                </td>
                <td>
                  {/* 未割当を色ではなく文言で示す。
                      「空欄」だと、担当がいないのか表示漏れなのか分からない。 */}
                  {ticket.assigned ? '割当済み' : '未割当'}
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
