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

export function AttachmentList({ attachments }: { attachments: AttachmentView[] }) {
  if (attachments.length === 0) {
    return <p className="empty">添付ファイルはありません。</p>;
  }

  return (
    <ul className="attachments">
      {attachments.map((attachment) => {
        const note = scanNote(attachment);
        const internal = attachment.visibility === 'internal';
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
          </li>
        );
      })}
    </ul>
  );
}
