import { ContextLink } from '../../../components/ContextLink';
import { notFound } from 'next/navigation';
import { api, requireSession } from '../../../lib/api';
import { assetStateLabel, assetKindLabel } from '../../../lib/asset-labels';
import { formatDateTime, stateLabel } from '../../../lib/labels';
import { RelatedChangePanel } from '../../../components/RelatedChangePanel';
import { AssetRevisionChanges } from '../../../components/AssetRevisionChanges';
import { safeReturnTo } from '../../../lib/navigation';
export default async function AssetPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession();
  const { id } = await params;
  const r = await api.asset(id);
  if (!r.ok) {
    if (r.problem.status === 404) notFound();
    const query = await searchParams;
    const returnTo = safeReturnTo(query.returnTo);
    const retryQuery = new URLSearchParams();
    if (returnTo) retryQuery.set('returnTo', returnTo);
    const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const retryHref = validId
      ? `/assets/${encodeURIComponent(id)}${retryQuery.size ? '?' + retryQuery.toString() : ''}`
      : '';
    const message =
      r.problem.status === 401
        ? 'ログイン状態を確認できませんでした。ログインし直してから、もう一度お試しください。'
        : r.problem.status === 403
          ? 'この資産を表示する権限がありません。必要な場合は管理者に確認してください。'
          : r.problem.status === 400
            ? '資産を指定する情報が正しくありません。一覧から資産を選び直してください。'
            : '一時的に資産を取得できませんでした。時間をおいて、もう一度お試しください。';
    return (
      <main id="main" className="shell">
        <h1>資産を読み込めませんでした</h1>
        <p role="alert">{message}</p>
        {validId && (
          <p>
            <a href={retryHref}>再取得する</a>
          </p>
        )}
        <p>
          <a href={returnTo ?? '/assets'}>{returnTo ? '元の画面へ戻る' : '資産一覧へ戻る'}</a>
        </p>
        <p>
          <a href="/portal">ポータルへ戻る</a>
        </p>
      </main>
    );
  }
  const d = r.data,
    a = d.asset,
    p = await searchParams;
  const revisionsByVersion = new Map(d.revisions.map((revision) => [revision.version, revision]));
  return (
    <main id="main" className="shell">
      <ContextLink back href="/assets">
        資産一覧へ戻る
      </ContextLink>
      <h1>
        {a.assetTag} · {a.name}
      </h1>
      {p.saved === '1' && <p role="status">資産と履歴を保存しました。</p>}
      {d.canManage && (
        <p>
          <ContextLink href={`/assets/${id}/edit`}>資産・状態・利用者を編集する</ContextLink>
        </p>
      )}
      <dl className="detail">
        <dt>種別</dt>
        <dd>{assetKindLabel(a.kind)}</dd>
        <dt>状態</dt>
        <dd>{assetStateLabel(a.state)}</dd>
        <dt>利用者</dt>
        <dd>{a.assignedUserName ?? '割当なし'}</dd>
        <dt>モデル・サービス名</dt>
        <dd>{a.model || '未入力'}</dd>
        <dt>シリアル番号</dt>
        <dd>{a.serialNumber || '未入力'}</dd>
        <dt>ホスト名</dt>
        <dd>{a.hostname || '未入力'}</dd>
        <dt>メーカー・提供元</dt>
        <dd>{a.vendor || '未入力'}</dd>
        <dt>情報源</dt>
        <dd>{a.sourceKind === 'csv' ? 'CSV取込' : '手入力'}（初回登録）</dd>
        <dt>更新日時</dt>
        <dd>
          {formatDateTime(a.updatedAt)}（版{a.version}）
        </dd>
        {a.location !== undefined && (
          <>
            <dt>保管場所（担当者のみ）</dt>
            <dd>{a.location || '未入力'}</dd>
          </>
        )}
      </dl>
      {a.internalNotes !== undefined && (
        <>
          <h2>内部メモ</h2>
          <p style={{ whiteSpace: 'pre-wrap' }}>{a.internalNotes || '未入力'}</p>
        </>
      )}
      <RelatedChangePanel kind="asset" id={id} />
      <h2>関連するチケット</h2>
      <p className="hint">
        閲覧できるチケットを最新100件表示します。担当者はチケット画面から関連を追加・解除できます。
      </p>
      {d.tickets.length ? (
        <ul className="attachments">
          {d.tickets.map((t) => (
            <li key={t.id} className="attachment">
              <a href={`/${d.canManage ? 'ops' : 'tickets'}/${t.id}`}>
                {t.number} · {t.subject}
              </a>
              <p>{stateLabel(t.state)}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p>現在関連するチケットはありません。</p>
      )}
      {!!d.relationHistory.length && (
        <details>
          <summary>チケットとの関連履歴（最新100件）</summary>
          <ul className="attachments">
            {d.relationHistory.map((e) => (
              <li key={e.id} className="attachment">
                <p>
                  {e.operation === 'linked' ? '追加' : '解除'} ·{' '}
                  <a href={`/${d.canManage ? 'ops' : 'tickets'}/${e.ticketId}`}>{e.number}</a> ·{' '}
                  {formatDateTime(e.createdAt)} · {e.actorName}
                </p>
                <p style={{ whiteSpace: 'pre-wrap' }}>{e.reason}</p>
              </li>
            ))}
          </ul>
        </details>
      )}
      {!!d.revisions.length && (
        <>
          <h2>資産の変更履歴</h2>
          <ul className="attachments">
            {d.revisions.map((v) => (
              <li key={v.version} className="attachment">
                <p>
                  版{v.version} · {formatDateTime(v.createdAt)} · {v.actorName}
                </p>
                <p style={{ whiteSpace: 'pre-wrap' }}>{v.reason}</p>
                <p>
                  {assetStateLabel(v.snapshot.state)} · {v.snapshot.assignedUserName ?? '割当なし'}
                </p>
                <AssetRevisionChanges
                  revision={v}
                  previous={revisionsByVersion.get(v.version - 1)}
                />
                <details>
                  <summary>この版の内容を見る</summary>
                  <dl className="detail">
                    <dt>タグ・資産名</dt>
                    <dd>
                      {v.snapshot.assetTag} · {v.snapshot.name}
                    </dd>
                    <dt>モデル・サービス名</dt>
                    <dd>{v.snapshot.model || '未入力'}</dd>
                    <dt>シリアル</dt>
                    <dd>{v.snapshot.serialNumber || '未入力'}</dd>
                    <dt>ホスト名</dt>
                    <dd>{v.snapshot.hostname || '未入力'}</dd>
                    <dt>提供元</dt>
                    <dd>{v.snapshot.vendor || '未入力'}</dd>
                    <dt>保管場所</dt>
                    <dd>{v.snapshot.location || '未入力'}</dd>
                    <dt>内部メモ</dt>
                    <dd style={{ whiteSpace: 'pre-wrap' }}>
                      {v.snapshot.internalNotes || '未入力'}
                    </dd>
                  </dl>
                </details>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
