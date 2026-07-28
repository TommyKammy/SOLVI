/**
 * 関連付けの追加 (WP-P2-RELUI-012)。
 *
 * **受付番号で指定する。** 担当者が画面で見ているのは番号であり、
 * UUID ではない。UUID を写させると写し間違いが起きるうえ、
 * 間違えたことにも気付けない(どちらも意味を読めない文字列だから)。
 */
export function RelationForm({
  action,
  errorMessage,
}: {
  action: (formData: FormData) => Promise<void>;
  errorMessage?: string;
}) {
  return (
    <form action={action} className="stack">
      {errorMessage && (
        <div className="error-summary" role="alert" tabIndex={-1}>
          <h3 style={{ margin: '0 0 0.5rem' }}>関連付けできませんでした</h3>
          <p style={{ margin: 0 }}>{errorMessage}</p>
        </div>
      )}

      <div className="field">
        <label htmlFor="relation-number">相手の受付番号</label>
        <span className="hint" id="relation-number-hint">
          例: INC-2026-000012
        </span>
        <input
          id="relation-number"
          name="targetTicketNumber"
          type="text"
          required
          maxLength={64}
          aria-describedby="relation-number-hint"
          autoComplete="off"
        />
      </div>

      <div className="field">
        <label htmlFor="relation-type">関係</label>
        {/*
          既定は「関連」。親子は「まとめる」という判断を含み、
          誤って作ると子の一覧に別件が並ぶ。危険でないほうを既定にする。
        */}
        <select id="relation-type" name="relationType" defaultValue="related">
          <option value="related">関連する問い合わせとして並べる</option>
          <option value="parent_of">この問い合わせの子にする(まとめる)</option>
        </select>
        <span className="hint">
          子にできるのは1段までです。子をさらに別の親にまとめることはできません。
        </span>
      </div>

      <button type="submit">関連付ける</button>
    </form>
  );
}
