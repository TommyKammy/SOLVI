import Link from 'next/link';
import { stateLabel } from '../lib/labels';
import type { RelationView } from '../lib/api';

/**
 * 関連するチケットの一覧 (WP-P2-RELUI-012)。
 *
 * **関係の向きを言葉で書く。** 「関連」「親」「子」という内部の呼び方を
 * そのまま出しても、担当者はどちらがどちらか分からない。
 * 「この問い合わせの原因になっている」「この問い合わせから分かれた」のように、
 * **読んだ人が次に何をすべきか分かる言い方**にする。
 */

const ROLE_LABEL: Record<RelationView['role'], string> = {
  related: '関連する問い合わせ',
  parent: 'まとめている問い合わせ(親)',
  child: 'この問い合わせから分かれたもの(子)',
};

export function RelationList({
  relations,
  canUnlink,
  unlinkAction,
}: {
  relations: RelationView[];
  /** 依頼者は見えるだけ。解除は担当者の操作である。 */
  canUnlink?: boolean;
  unlinkAction?: (formData: FormData) => Promise<void>;
}) {
  if (relations.length === 0) {
    return <p className="empty">関連付けられた問い合わせはありません。</p>;
  }

  return (
    <ul className="relations">
      {relations.map((relation) => (
        <li key={relation.relationId || relation.ticketId} className="relation">
          <div className="meta">
            <span className="relation-role">{ROLE_LABEL[relation.role]}</span>
            <span className="state">{stateLabel(relation.state)}</span>
          </div>
          {/* 番号と件名の両方を出す。番号だけだと何の件か分からず、
              件名だけだと会話や別画面で指し示せない。 */}
          <Link href={`/ops/${relation.ticketId}`}>
            {relation.number} {relation.subject}
          </Link>

          {canUnlink && unlinkAction && (
            <form action={unlinkAction} className="relation-unlink">
              <input type="hidden" name="relationId" value={relation.relationId} />
              {/* 解除は関連を消すだけで、チケットそのものには触れない。
                  取り消しがきくので理由は求めない(統合とはここが違う)。 */}
              <button type="submit" className="secondary">
                関連を解除する
              </button>
            </form>
          )}
        </li>
      ))}
    </ul>
  );
}
