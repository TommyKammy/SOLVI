import { formatDateTime } from '../lib/labels';
import type { CommentView } from '../lib/api';

/**
 * コメント欄 (WP-P2-OPSUI-010)。
 *
 * **依頼者にはそもそも内部メモが渡ってこない。** 除外はAPI側で行っており、
 * この画面は受け取ったものを描くだけである。
 * 画面でフィルタする作りにすると、別の画面が同じフィルタを書き忘れた時点で漏れる。
 *
 * 担当者の画面では内部メモを**強く区別して**表示する。
 * 誤って内部メモへ依頼者向けの返信を書くと「返事が来ない」になり、
 * 逆に公開コメントへ内部の推測を書くと取り返しがつかない。
 */
export function CommentThread({
  comments,
  currentUserId,
}: {
  comments: CommentView[];
  currentUserId: string;
}) {
  if (comments.length === 0) {
    return <p className="empty">まだやり取りはありません。</p>;
  }

  return (
    <ul className="comments">
      {comments.map((comment) => {
        const internal = comment.visibility === 'internal';
        return (
          <li key={comment.id} className={internal ? 'comment internal' : 'comment'}>
            <div className="meta">
              {/* 公開範囲を必ず文言で書く。色や罫線だけだと、
                  色覚特性のある利用者と白黒印刷で区別が消える。 */}
              <span className="visibility-label">
                {internal ? '内部メモ(依頼者には表示されません)' : '公開コメント'}
              </span>
              <span>{comment.authorId === currentUserId ? '自分' : '担当者'}</span>
              <time dateTime={comment.createdAt}>{formatDateTime(comment.createdAt)}</time>
            </div>
            <div className="body">{comment.body}</div>
          </li>
        );
      })}
    </ul>
  );
}
