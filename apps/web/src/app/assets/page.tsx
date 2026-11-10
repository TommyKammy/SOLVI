import { TableRegion } from '../../components/TableRegion';
import { ContextLink } from '../../components/ContextLink';
import Link from 'next/link';
import { api, requireSession } from '../../lib/api';
import { assetStateLabel, assetKindLabel } from '../../lib/asset-labels';
import styles from './assets.module.css';
export default async function AssetsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession();
  const p = await searchParams;
  const query = new URLSearchParams();
  for (const key of ['q', 'state', 'kind', 'assignment', 'page'])
    if (typeof p[key] === 'string' && p[key]) query.set(key, p[key]);
  const refresh = '/assets' + (query.size ? '?' + query.toString() : '');
  const r = await api.assets(query.toString());
  if (!r.ok) {
    const message =
      r.problem.status === 401
        ? 'ログインの有効期限が切れた可能性があります。再取得しても表示できない場合は、ポータルからログインし直してください。'
        : r.problem.status === 403
          ? 'この組織の資産一覧を表示する権限がありません。選択中の組織を確認するか、管理者にご相談ください。'
          : r.problem.status === 404
            ? '資産一覧を表示できません。対象や機能が現在利用できない可能性があります。ポータルへ戻ってご確認ください。'
            : r.problem.status === 400
              ? '資産一覧の検索条件を確認できませんでした。条件を解除して開き直してください。'
              : '資産一覧を取得できませんでした。時間をおいて、同じ条件で再取得してください。';
    return (
      <main id="main" className="shell">
        <h1>資産</h1>
        <p role="alert">{message}</p>
        <p>
          <a href={refresh}>同じ条件で再取得する</a>
          {r.problem.status === 400 && (
            <>
              {' · '}
              <a href="/assets">条件を解除する</a>
            </>
          )}
          {' · '}
          <a href="/portal">ポータルへ戻る</a>
        </p>
      </main>
    );
  }
  const d = r.data;
  const filtering =
    Boolean(query.get('q')?.trim()) ||
    Boolean(query.get('state')) ||
    Boolean(query.get('kind')) ||
    ['mine', 'unassigned'].includes(query.get('assignment') ?? '');
  const pageLink = (n: number) => {
    const q = new URLSearchParams(query);
    q.set('page', String(n));
    return '/assets?' + q.toString();
  };
  return (
    <main id="main" className="shell">
      <h1>{d.canReadAll ? '資産台帳' : '自分の資産'}</h1>
      <p>
        {d.canReadAll
          ? '組織の資産と利用状況を管理します。'
          : '現在自分に割り当てられている資産を表示します。'}{' '}
        手入力と確認付きCSV取込に対応しています。
      </p>
      {d.canManage && (
        <p>
          <ContextLink href="/assets/new">新しい資産を登録する</ContextLink>
        </p>
      )}
      {d.canReadAll && (
        <p>
          <ContextLink href="/assets/imports">CSV取込と履歴</ContextLink>
        </p>
      )}
      <form method="get" className="filters" aria-label="資産の検索">
        <div className="field">
          <label htmlFor="asset-search">タグ・名前・モデル・シリアル・ホスト名・利用者で検索</label>
          <input
            type="text"
            id="asset-search"
            name="q"
            defaultValue={query.get('q') ?? ''}
            maxLength={200}
          />
        </div>
        <div className="field">
          <label htmlFor="asset-filter-kind">種別</label>
          <select id="asset-filter-kind" name="kind" defaultValue={query.get('kind') ?? ''}>
            <option value="">すべて</option>
            {d.kinds.map((k) => (
              <option key={k.code} value={k.code}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="asset-filter-state">状態</label>
          <select id="asset-filter-state" name="state" defaultValue={query.get('state') ?? ''}>
            <option value="">すべて</option>
            {d.states.map((s) => (
              <option key={s.code} value={s.code}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        {d.canReadAll && (
          <div className="field">
            <label htmlFor="asset-filter-user">利用者の割当</label>
            <select
              id="asset-filter-user"
              name="assignment"
              defaultValue={query.get('assignment') ?? 'all'}
            >
              <option value="all">すべて</option>
              <option value="mine">自分</option>
              <option value="unassigned">割当なし</option>
            </select>
          </div>
        )}
        <button>検索する</button>
        <Link href="/assets">解除する</Link>
      </form>
      <p role="status">
        {filtering ? '絞り込み中 · ' : ''}全{d.total}件 · {d.page}ページ目（1ページ{d.pageSize}件）
      </p>
      <p>
        <a href={refresh}>資産一覧を更新する</a>
      </p>
      {d.items.length ? (
        <>
          <p>
            表が画面に収まらない場合は、横にスクロールするとすべての列を確認できます。キーボードでは表にフォーカスして左右矢印キーで移動します。
          </p>
          <TableRegion label="資産一覧">
            <table className={`tickets ${styles.table}`}>
              <caption className="visually-hidden">閲覧できる資産</caption>
              <colgroup>
                <col className={styles.titleColumn} />
                <col className={styles.kindColumn} />
                <col className={styles.stateColumn} />
                <col className={styles.userColumn} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">タグ・資産名</th>
                  <th scope="col">種別</th>
                  <th scope="col">状態</th>
                  <th scope="col">利用者</th>
                </tr>
              </thead>
              <tbody>
                {d.items.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <ContextLink href={`/assets/${a.id}`}>
                        {a.assetTag} · {a.name}
                      </ContextLink>
                    </td>
                    <td>{assetKindLabel(a.kind)}</td>
                    <td>
                      <span className="state" data-state={a.state}>
                        {assetStateLabel(a.state)}
                      </span>
                    </td>
                    <td>{a.assignedUserName ?? '割当なし'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableRegion>
        </>
      ) : (
        <p>
          {d.total > 0
            ? 'このページに資産はありません。最初のページへ戻ってください。'
            : filtering
              ? '条件に合う資産はありません。条件を解除するか、検索条件を見直してください。'
              : '表示できる資産はまだありません。'}
        </p>
      )}
      <nav aria-label="資産のページ" className="actions-row">
        {!d.items.length && d.total > 0 && <a href={pageLink(1)}>最初のページへ</a>}
        {d.page > 1 && <Link href={pageLink(d.page - 1)}>前のページへ</Link>}
        {d.page * d.pageSize < d.total && <Link href={pageLink(d.page + 1)}>次のページへ</Link>}
      </nav>
    </main>
  );
}
