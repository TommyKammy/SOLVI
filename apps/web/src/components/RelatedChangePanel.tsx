import { ContextLink } from './ContextLink';
import { api } from '../lib/api';
import { changeStateLabel } from '../lib/change-labels';
import { formatDateTime } from '../lib/labels';
export async function RelatedChangePanel({ kind, id }: { kind: 'ticket' | 'asset'; id: string }) {
  const r = await api.relatedChanges(kind, id);
  if (!r.ok) return <p role="alert">関連する変更を読み込めませんでした。</p>;
  if (!r.data.canCreate && !r.data.items.length) return null;
  return (
    <section>
      <h2>関連する通常変更</h2>
      {r.data.canCreate && (
        <p>
          <ContextLink
            href={`/changes/new?${kind === 'ticket' ? 'ticketId' : 'assetId'}=${encodeURIComponent(id)}`}
          >
            この{kind === 'ticket' ? 'チケット' : '資産'}から変更計画を作成する
          </ContextLink>
        </p>
      )}
      <p>
        <ContextLink
          href={`/changes?${kind === 'ticket' ? 'ticketId' : 'assetId'}=${encodeURIComponent(id)}`}
        >
          関連する変更一覧を開く
        </ContextLink>
      </p>
      {r.data.items.length ? (
        <ul className="attachments">
          {r.data.items.map((c) => (
            <li key={c.id} className="attachment">
              <ContextLink href={`/changes/${c.id}`}>
                {c.number} · {c.title}
              </ContextLink>
              <p>
                {changeStateLabel(c.state)} ·{' '}
                {c.plannedStart ? formatDateTime(c.plannedStart) : '予定未入力'}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p>関連する変更計画はありません。</p>
      )}
    </section>
  );
}
