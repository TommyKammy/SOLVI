import { api } from '../lib/api';
import { assetKindLabel, assetStateLabel } from '../lib/asset-labels';
import { formatDateTime } from '../lib/labels';
import { TicketAssetLinkForm, TicketAssetUnlinkForm } from './TicketAssetForms';
export async function TicketAssetPanel({
  ticketId,
  saved = false,
}: {
  ticketId: string;
  saved?: boolean;
}) {
  const r = await api.ticketAssets(ticketId);
  if (!r.ok)
    return (
      <section>
        <h2>対象資産</h2>
        <p role="status">資産の関連を読み込めませんでした。</p>
      </section>
    );
  const d = r.data;
  if (!d.canManage && !d.items.length) return null;
  return (
    <section>
      <h2>対象資産</h2>
      {saved && <p role="status">対象資産との関連を保存しました。</p>}
      {d.items.length ? (
        <ul className="attachments">
          {d.items.map((a) => (
            <li key={a.id} className="attachment">
              <p>
                {a.canOpen ? (
                  <a href={`/assets/${a.id}`}>
                    {a.assetTag} · {a.name}
                  </a>
                ) : (
                  <span>
                    {a.assetTag} · {a.name}
                  </span>
                )}
              </p>
              <p>
                {assetKindLabel(a.kind)} · {assetStateLabel(a.state)}
              </p>
              {!a.canOpen && <p className="hint">この資産の詳細は表示できません。</p>}
              {d.canManage && (
                <TicketAssetUnlinkForm
                  key={`${a.id}-${a.linkVersion}`}
                  ticketId={ticketId}
                  assetId={a.id}
                  version={a.linkVersion}
                />
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p>対象資産はまだ関連付けられていません。</p>
      )}
      {d.canManage && <TicketAssetLinkForm ticketId={ticketId} />}
      {!!d.history.length && (
        <details>
          <summary>資産との関連履歴（最新100件）</summary>
          <ul className="attachments">
            {d.history.map((e) => (
              <li key={e.id} className="attachment">
                <p>
                  {e.operation === 'linked' ? '追加' : '解除'} ·{' '}
                  <a href={`/assets/${e.assetId}`}>
                    {e.assetTag} · {e.name}
                  </a>{' '}
                  · {formatDateTime(e.createdAt)} · {e.actorName}
                </p>
                <p style={{ whiteSpace: 'pre-wrap' }}>{e.reason}</p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
