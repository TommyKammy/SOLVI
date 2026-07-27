'use client';

import { useState, useTransition } from 'react';

/**
 * 添付のアップロード (WP-P2-SCAN-011)。
 *
 * ブラウザから**オブジェクトストレージへ直接 PUT する**。
 * アプリを経由させると、大きなファイルでプロセスが詰まり、
 * 同時に何人かが送っただけで他のリクエストが待たされる。
 *
 * 手順:
 *   1. サーバへメタデータを送り、署名付きURLを受け取る(ここで検証される)
 *   2. そのURLへ直接 PUT する
 *   3. 画面を作り直す(スキャン中として表示される)
 *
 * **検証はURLを出す前に行われる。** 出してしまってから拒否しても、
 * 実体は既に保存されている。
 */
export function AttachmentForm({
  ticketId,
  canChooseVisibility,
}: {
  ticketId: string;
  canChooseVisibility: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [, startTransition] = useTransition();

  async function onSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    const form = event.currentTarget;
    const data = new FormData(form);
    const file = data.get('file');
    if (!(file instanceof File) || file.size === 0) {
      setError('ファイルを選んでください。');
      return;
    }

    setUploading(true);
    try {
      const requested = await fetch(`/api/tickets/${ticketId}/attachments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fileName: file.name,
          contentType: file.type,
          sizeBytes: file.size,
          visibility: String(data.get('visibility') ?? 'public'),
        }),
      });

      if (!requested.ok) {
        const problem = await requested.json().catch(() => ({}));
        // 検証エラーは項目ごとの文言をそのまま出す。
        // 「アップロードできません」だけだと、何を直せばよいか分からない。
        const detail = problem.errors?.[0]?.message ?? problem.title ?? 'アップロードできません。';
        setError(detail);
        return;
      }

      const { uploadUrl } = await requested.json();
      const put = await fetch(uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { 'content-type': file.type || 'application/octet-stream' },
      });
      if (!put.ok) {
        setError('ファイルの送信に失敗しました。時間をおいて再度お試しください。');
        return;
      }

      form.reset();
      startTransition(() => {
        // 画面を作り直してスキャン中の表示を出す
        window.location.reload();
      });
    } catch {
      setError('通信に失敗しました。時間をおいて再度お試しください。');
    } finally {
      setUploading(false);
    }
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      {error && (
        <div className="error-summary" role="alert" tabIndex={-1}>
          <h2>添付できませんでした</h2>
          <p style={{ margin: 0 }}>{error}</p>
        </div>
      )}

      <div className="field">
        <label htmlFor="attachment-file">ファイル</label>
        <span className="hint" id="attachment-hint">
          画面の写真やエラーの表示を添えていただくと、確認が早くなります。
          25MBまで。実行できる形式のファイルは添付できません。
        </span>
        <input
          id="attachment-file"
          name="file"
          type="file"
          required
          aria-describedby="attachment-hint"
        />
      </div>

      {canChooseVisibility && (
        <fieldset className="visibility">
          <legend>この添付を誰に見せるか</legend>
          <div className="choice">
            <input type="radio" id="att-public" name="visibility" value="public" defaultChecked />
            <label htmlFor="att-public">
              公開
              <span className="note">依頼者にも表示されます。</span>
            </label>
          </div>
          <div className="choice">
            <input type="radio" id="att-internal" name="visibility" value="internal" />
            <label htmlFor="att-internal">
              内部のみ
              <span className="note">担当者だけが見られます。</span>
            </label>
          </div>
        </fieldset>
      )}

      <button type="submit" disabled={uploading}>
        {uploading ? '送信しています…' : '添付する'}
      </button>
    </form>
  );
}
