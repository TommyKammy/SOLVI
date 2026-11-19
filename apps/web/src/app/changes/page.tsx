import styles from './changes.module.css';
import { TableRegion } from '../../components/TableRegion';
import { ContextLink } from '../../components/ContextLink';
import { api, requireSession } from '../../lib/api';
import { changeStates, changeStateLabel, jstInput } from '../../lib/change-labels';
import { formatDateTime } from '../../lib/labels';
export default async function ChangesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession();
  const p = await searchParams,
    q = new URLSearchParams();
  for (const k of ['q', 'state', 'assetId', 'ticketId', 'needsPir', 'page', 'from', 'to'])
    if (typeof p[k] === 'string' && p[k]) q.set(k, p[k]);
  for (const [field, target] of [
    ['fromJst', 'from'],
    ['toJst', 'to'],
  ] as const) {
    if (typeof p[field] === 'string' && p[field]) {
      const date = new Date(p[field] + '+09:00');
      q.set(target, Number.isNaN(date.getTime()) ? p[field] : date.toISOString());
    }
  }
  const refresh = '/changes' + (q.size ? '?' + q.toString() : '');
  const r = await api.changes(q.toString());
  if (!r.ok) {
    const message =
      r.problem.status === 401
        ? 'ログインの有効期限が切れた可能性があります。再取得しても表示できない場合は、ポータルからログインし直してください。'
        : r.problem.status === 403
          ? 'この組織の変更一覧を表示する権限がありません。選択中の組織を確認するか、管理者にご相談ください。'
          : r.problem.status === 404
            ? '変更一覧を表示できません。対象や機能が現在利用できない可能性があります。ポータルへ戻ってご確認ください。'
            : r.problem.status === 400
              ? '変更一覧の検索条件を確認できませんでした。条件を解除して開き直してください。'
              : '変更一覧を取得できませんでした。時間をおいて、同じ条件で再取得してください。';
    return (
      <main id="main" className="shell">
        <h1>変更管理</h1>
        <p role="alert">{message}</p>
        <p>
          <a href={refresh}>同じ条件で再取得する</a>
          {r.problem.status === 400 && (
            <>
              {' · '}
              <a href="/changes">条件を解除する</a>
            </>
          )}
          {' · '}
          <a href="/portal">ポータルへ戻る</a>
        </p>
      </main>
    );
  }
  const filtering =
    Boolean(q.get('q')?.trim()) ||
    ['state', 'assetId', 'ticketId', 'from', 'to'].some((key) => Boolean(q.get(key))) ||
    q.get('needsPir') === '1';
  const d = r.data,
    pageLink = (page: number) => {
      const next = new URLSearchParams(q);
      next.set('page', String(page));
      return '/changes?' + next.toString();
    };
  return (
    <main id="main" className="shell service-workspace asset-change-workflow">
      <header className="support-page-heading">
        <div>
          <p className="service-heading-meta">通常変更 · 合成の実施結果</p>
          <h1>変更管理</h1>
        </div>
        {d.canCreate && (
          <ContextLink href="/changes/new" className="support-action support-action--primary">
            通常変更の計画を作成する
          </ContextLink>
        )}
      </header>
      {(q.has('assetId') || q.has('ticketId')) && (
        <p role="status">
          {q.has('assetId') ? '資産' : 'チケット'}
          から開いた関連変更に絞り込んでいます。条件を解除すると全件を確認できます。
        </p>
      )}
      <form method="get" className="filters service-filter" aria-label="変更の検索">
        <div className="field service-search-field">
          <label htmlFor="change-q">番号・タイトル・元チケットで検索</label>
          <input
            id="change-q"
            type="search"
            name="q"
            defaultValue={q.get('q') ?? ''}
            maxLength={200}
          />
        </div>
        <div className="field">
          <label htmlFor="change-state">現在の状態</label>
          <select id="change-state" name="state" defaultValue={q.get('state') ?? ''}>
            <option value="">すべて</option>
            {changeStates.map((s) => (
              <option key={s.code} value={s.code}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="change-pir">実施後レビュー</label>
          <select id="change-pir" name="needsPir" defaultValue={q.get('needsPir') ?? '0'}>
            <option value="0">すべて</option>
            <option value="1">失敗・PIR未記入</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="change-from">予定の検索開始（JST）</label>
          <input
            id="change-from"
            type="datetime-local"
            name="fromJst"
            defaultValue={jstInput(q.get('from'))}
          />
        </div>
        <div className="field">
          <label htmlFor="change-to">予定の検索終了（JST）</label>
          <input
            id="change-to"
            type="datetime-local"
            name="toJst"
            defaultValue={jstInput(q.get('to'))}
          />
        </div>
        {['assetId', 'ticketId'].map((k) =>
          q.get(k) ? <input key={k} type="hidden" name={k} value={q.get(k)!} /> : null,
        )}
        <button>絞り込む</button>
        <a href="/changes">解除する</a>
      </form>
      <div className="service-list-toolbar">
        <h2 role="status">
          {`${filtering ? '絞り込み中' : '変更'} · 全${d.total}件${d.page > 1 ? ` · ${d.page}ページ目` : ''}`}
        </h2>
        <div className="service-heading-actions">
          <a href={refresh}>変更一覧を更新する</a>
        </div>
      </div>
      {d.items.length > 0 && (
        <TableRegion label="変更計画一覧" className="table-scroll service-table-scroll">
          <table className={`work-table service-data-table ${styles.table}`}>
            <caption className="visually-hidden">変更計画と予定</caption>
            <thead>
              <tr>
                <th scope="col">変更番号</th>
                <th scope="col">計画名</th>
                <th scope="col">対象資産</th>
                <th scope="col">状態</th>
                <th scope="col">予定（JST）・担当者</th>
                <th scope="col">元チケット</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((ch) => (
                <tr key={ch.id}>
                  <th scope="row">{ch.number}</th>
                  <td>
                    <ContextLink href={`/changes/${ch.id}`}>{ch.title}</ContextLink>
                  </td>
                  <td>{ch.assets.map((a) => a.assetTag).join(' / ') || '—'}</td>
                  <td>
                    <span className="state" data-state={ch.state}>
                      {changeStateLabel(ch.state)}
                    </span>
                  </td>
                  <td>
                    {ch.plannedStart ? formatDateTime(ch.plannedStart) : '開始未定'}
                    <br />
                    {ch.plannedEnd ? formatDateTime(ch.plannedEnd) : '終了未定'}
                    <br />
                    {ch.ownerName}
                  </td>
                  <td>{ch.ticket.number}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableRegion>
      )}
      {!d.items.length && (
        <p className="service-empty">
          {d.total > 0
            ? 'このページに変更はありません。最初のページへ戻ってください。'
            : filtering
              ? '条件に合う変更はありません。条件を解除するか、検索条件を見直してください。'
              : '表示できる変更はまだありません。'}
        </p>
      )}
      <nav className="actions-row" aria-label="変更一覧のページ">
        {!d.items.length && d.total > 0 && <a href={pageLink(1)}>最初のページへ</a>}
        {d.page > 1 && <a href={pageLink(d.page - 1)}>前のページへ</a>}
        {d.page * d.pageSize < d.total && <a href={pageLink(d.page + 1)}>次のページへ</a>}
      </nav>
    </main>
  );
}
