import { formatDateTime } from '../lib/labels';
import type { AttachmentView } from '../lib/api';

/**
 * 添付の一覧 (WP-P2-SCAN-011)。
 *
 * **スキャン中であることを隠さない。**
 *
 * 「まだ開けません」とだけ出すと、利用者は壊れていると思って
 * 同じファイルを何度も送り直す。何が起きていて、いつ開けるようになるのかを書く。
 *
 * 開けるかどうかの判断は API が `downloadable` として返す。
 * 画面が `scanStatus` を解釈して判断すると、状態が増えたときに
 * 画面ごとに判断が分かれる。
 */

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** スキャン状態の説明。**内部の状態名を出さない。** */
function scanNote(attachment: AttachmentView): { label: string; detail: string } | null {
  switch (attachment.scanStatus) {
    case 'clean':
      return null;
    case 'pending':
      return {
        label: 'ウイルスチェック中',
        detail: '確認が終わるまで開けません。しばらくしてから再度ご覧ください。',
      };
    case 'infected':
      return {
        label: '安全でないファイル',
        detail: 'ウイルスが検出されたため開けません。担当者へご連絡ください。',
      };
    default:
      return { label: '確認中', detail: 'しばらくしてから再度ご覧ください。' };
  }
}

export function AttachmentList({
  attachments,
  currentUserId,
  canDeleteAny,
  deleteAction,
}: {
  attachments: AttachmentView[];
  currentUserId?: string;
  /** 担当者は組織内の添付を削除できる。 */
  canDeleteAny?: boolean;
  deleteAction?: (formData: FormData) => Promise<void>;
}) {
  if (attachments.length === 0) {
    return <p className="empty">添付ファイルはありません。</p>;
  }

  return (
    <ul className="attachments">
      {attachments.map((attachment) => {
        const note = scanNote(attachment);
        const internal = attachment.visibility === 'internal';
        // 消せるのは「自分が添付したもの」と「担当者が組織内のもの」。
        // 依頼者が担当者の添付を消せると、対応の記録を一方的に削れてしまう。
        const canDelete =
          deleteAction !== undefined &&
          (canDeleteAny === true || attachment.uploadedBy === currentUserId);
        return (
          <li key={attachment.id} className={internal ? 'attachment internal' : 'attachment'}>
            <div className="meta">
              {internal && (
                <span className="visibility-label">内部添付(依頼者には表示されません)</span>
              )}
              <span>{formatSize(attachment.sizeBytes)}</span>
              <time dateTime={attachment.createdAt}>{formatDateTime(attachment.createdAt)}</time>
            </div>

            {attachment.downloadable ? (
              // ダウンロードは毎回サーバへ問い合わせて署名を発行する。
              // 画面に署名付きURLを埋め込むと、ページを共有しただけで
              // 有効期限まで誰でも取得できてしまう。
              <a href={`/attachments/${attachment.id}`}>{attachment.fileName}</a>
            ) : (
              <>
                <span className="file-name-disabled">{attachment.fileName}</span>
                {note && (
                  <p
                    className={attachment.scanStatus === 'infected' ? 'field-error' : 'hint'}
                    style={{ margin: '0.25rem 0 0' }}
                  >
                    <strong>{note.label}</strong> — {note.detail}
                  </p>
                )}
              </>
            )}

            {canDelete && deleteAction && (
              // **取り消せない操作なので、理由の入力を挟む。**
              // ボタン1つで消せると、誤操作でも消えてしまう。
              // 理由は監査に残り、「誤添付」と「証拠隠滅」を後から区別する材料になる。
              <details className="delete-attachment">
                <summary>この添付を削除する</summary>
                <form action={deleteAction} className="stack">
                  <input type="hidden" name="attachmentId" value={attachment.id} />
                  <div className="field">
                    <label htmlFor={`reason-${attachment.id}`}>削除の理由</label>
                    <span className="hint" id={`reason-hint-${attachment.id}`}>
                      例: 誤って別のファイルを添付した / 他の方の情報が写っていた
                    </span>
                    <input
                      id={`reason-${attachment.id}`}
                      name="reason"
                      type="text"
                      required
                      maxLength={500}
                      aria-describedby={`reason-hint-${attachment.id}`}
                    />
                  </div>
                  <p className="field-error" style={{ margin: 0 }}>
                    削除すると元に戻せません。ファイルの実体は完全に削除されます。
                  </p>
                  <button type="submit" className="danger">
                    削除する
                  </button>
                </form>
              </details>
            )}
          </li>
        );
      })}
    </ul>
  );
}
