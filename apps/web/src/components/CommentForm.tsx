/**
 * コメント投稿フォーム (WP-P2-OPSUI-010)。
 *
 * 担当者には公開範囲の選択を出す。**既定は「公開コメント」**。
 *
 * 既定を内部メモにすると、依頼者へ返信したつもりの内容が届かず
 * 「返事が来ない」が起きる。逆に既定が公開でも、内部メモのつもりで書いた
 * 内容が漏れる危険はある — だが前者は毎回起き、後者は選択を誤ったときだけ起きる。
 * 頻度の高いほうを既定にし、危険なほうは明示的な選択を要求する。
 */
export function CommentForm({
  action,
  canWriteInternal,
  errorMessage,
}: {
  action: (formData: FormData) => Promise<void>;
  canWriteInternal: boolean;
  errorMessage?: string | undefined;
}) {
  return (
    <form className="stack" action={action}>
      {errorMessage && (
        <div className="error-summary" role="alert" tabIndex={-1}>
          <h2>投稿できませんでした</h2>
          <p style={{ margin: 0 }}>{errorMessage}</p>
        </div>
      )}

      {canWriteInternal ? (
        <fieldset className="visibility">
          <legend>この投稿を誰に見せるか</legend>
          <div className="choice">
            <input type="radio" id="vis-public" name="visibility" value="public" defaultChecked />
            <label htmlFor="vis-public">
              公開コメント
              <span className="note">依頼者に表示され、通知が届きます。</span>
            </label>
          </div>
          <div className="choice">
            <input type="radio" id="vis-internal" name="visibility" value="internal" />
            <label htmlFor="vis-internal">
              内部メモ
              <span className="note">
                担当者だけが見られます。依頼者には表示されず、通知も送られません。
              </span>
            </label>
          </div>
        </fieldset>
      ) : (
        <input type="hidden" name="visibility" value="public" />
      )}

      <div className="field">
        <label htmlFor="comment-body">内容</label>
        <textarea id="comment-body" name="body" maxLength={10000} required />
      </div>

      <button type="submit">投稿する</button>
    </form>
  );
}
