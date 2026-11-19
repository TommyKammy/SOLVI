import { formatDateTime } from '../lib/labels';
import type { CommentView } from '../lib/api';

/**
 * 公開コメントの向きを、書き手が依頼者かどうかで言い分ける。
 *
 * **「依頼者への返信」を一律に付けない。** この欄は依頼者側の画面でも使われ、
 * 依頼者自身が書いたコメントまで「返信」に見えてしまう。
 * `authorIsRequester` は任意項目なので、無いときは向きを推測せず
 * 方向を含まない「公開コメント」とする。
 */
export function publicCommentDirection(authorIsRequester?: boolean): string {
  if (authorIsRequester === true) return '依頼者からのコメント';
  if (authorIsRequester === false) return '依頼者への返信';
  return '公開コメント';
}

/** 履歴の1行に使う文言。スレッドと同じ規則で向きを決める。 */
export function commentHistoryLabel(
  visibility: CommentView['visibility'],
  authorIsRequester?: boolean,
): string {
  return visibility === 'internal'
    ? '社内メモを追加'
    : `${publicCommentDirection(authorIsRequester)}を追加`;
}

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
  requesterView = false,
}: {
  comments: CommentView[];
  currentUserId: string;
  requesterView?: boolean;
}) {
  if (comments.length === 0) {
    return (
      <p className="empty">
        {requesterView
          ? '担当者から返信があると、ここに表示されます。'
          : 'まだやり取りはありません。'}
      </p>
    );
  }

  return (
    <ul className="comments">
      {comments.map((comment) => {
        const internal = comment.visibility === 'internal';
        return (
          <li key={comment.id} className={internal ? 'comment internal' : 'comment'}>
            <div className="meta">
              {/* 公開範囲を必ず文言で書く。色や罫線だけだと、
                  色覚特性のある利用者と白黒印刷で区別が消える。
                  UI v2では社内で使う言葉に合わせて「社内メモ」と表示する。 */}
              <span className="visibility-label">
                {internal
                  ? '社内メモ（依頼者には表示されません）'
                  : requesterView && comment.authorIsRequester === false
                    ? '担当者からの返信'
                    : publicCommentDirection(comment.authorIsRequester)}
              </span>
              <span>
                {comment.authorId === currentUserId
                  ? '自分'
                  : comment.authorIsRequester
                    ? '依頼者'
                    : '担当者'}
              </span>
              <time dateTime={comment.createdAt}>{formatDateTime(comment.createdAt)}</time>
            </div>
            <div className="body">{comment.body}</div>
            {comment.citation && (
              <p className="hint">
                引用記事:{' '}
                {comment.citation.available ? (
                  <a href={`/tickets/${comment.ticketId}/citations/${comment.id}`}>
                    {comment.citation.title}（版 {comment.citation.version}）
                  </a>
                ) : (
                  <>版 {comment.citation.version} の記録（現在は閲覧できません）</>
                )}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
