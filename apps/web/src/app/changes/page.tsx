import { TableRegion } from '../../components/TableRegion';
import { ContextLink } from '../../components/ContextLink';
import { api, requireSession } from '../../lib/api';
import { changeStates, changeStateLabel, jstInput } from '../../lib/change-labels';
import { formatDateTime } from '../../lib/labels';
import styles from './changes.module.css';
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
    <main id="main" className="shell">
      <h1>変更管理</h1>
      <p>通常変更の計画・承認・予定と合成の実施結果を管理します。日時は日本時間（JST）です。</p>
      {d.canCreate && (
        <p>
          <ContextLink href="/changes/new">通常変更の計画を作成する</ContextLink>
        </p>
      )}
      {(q.has('assetId') || q.has('ticketId')) && (
        <p role="status">
          {q.has('assetId') ? '資産' : 'チケット'}
          から開いた関連変更に絞り込んでいます。条件を解除すると全件を確認できます。
        </p>
      )}
      <form method="get" className="filters" aria-label="変更の検索">
        <div className="field">
          <label htmlFor="change-q">番号・タイトル・元チケットで検索</label>
          <input id="change-q" name="q" defaultValue={q.get('q') ?? ''} maxLength={200} />
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
      <p role="status">
        {filtering ? '絞り込み中 · ' : ''}全{d.total}件 · {d.page}ページ目
      </p>
      <p>
        <a href={refresh}>変更一覧を更新する</a>
      </p>
      <p>
        表が画面に収まらない場合は、横にスクロールするとすべての列を確認できます。キーボードでは表にフォーカスして左右矢印キーで移動します。
      </p>
      <TableRegion label="変更計画一覧">
        <table className={`tickets ${styles.table}`}>
          <caption>変更計画と予定</caption>
          <colgroup>
            <col className={styles.titleColumn} />
            <col className={styles.stateColumn} />
            <col className={styles.scheduleColumn} />
            <col className={styles.relatedColumn} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">変更</th>
              <th scope="col">現在の状態</th>
              <th scope="col">予定（JST）・担当者</th>
              <th scope="col">元チケット・対象資産</th>
            </tr>
          </thead>
          <tbody>
            {d.items.map((ch) => (
              <tr key={ch.id}>
                <td>
                  <ContextLink href={`/changes/${ch.id}`}>
                    {ch.number} · {ch.title}
                  </ContextLink>
                </td>
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
                <td>
                  {ch.ticket.number}
                  <br />
                  {ch.assets.map((a) => a.assetTag).join(' / ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableRegion>
      {!d.items.length && (
        <p>
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
