import { priorityLabel, levelLabel } from '../lib/labels';

/**
 * 影響度・緊急度の見直し (WP-P2-PRIO-013)。
 *
 * **優先度を直接いじらせない。** 影響の範囲と急ぎ具合を直すと、
 * 優先度はサーバが規則から導き直す。
 *
 * 申告時の値は依頼者の見立てであり、調べた結果と食い違うのが普通である。
 * 見直せないと、現場は「とりあえず緊急にして起票する」を覚える。
 *
 * 既定で閉じておく。日常的に使う操作ではなく、常に開いていると
 * 「対応を進める」ための操作が下へ押し出される。
 */

const LEVELS = ['low', 'medium', 'high'] as const;

export function AssessmentForm({
  impact,
  urgency,
  priority,
  priorityIsDerived,
  action,
  errorMessage,
}: {
  impact: string;
  urgency: string;
  priority: string;
  /** 保存されている優先度が規則どおりかどうか。 */
  priorityIsDerived: boolean;
  action: (formData: FormData) => Promise<void>;
  errorMessage?: string;
}) {
  return (
    <section className="assessment">
      <dl className="detail">
        <dt>優先度</dt>
        <dd>
          <strong>{priorityLabel(priority)}</strong>
          {/* **どこから来た値かを書く。** 「最優先」とだけ出ていると、
              誰かが決めた値なのか自動で決まった値なのか分からない。 */}
          <span className="hint" style={{ display: 'block' }}>
            影響 {levelLabel(impact)} × 急ぎ {levelLabel(urgency)} から決まっています
          </span>
        </dd>
      </dl>

      {!priorityIsDerived && (
        // 保存されている優先度が規則から導けない。**再現できない値**であり、
        // これを根拠に対応順を決めてはいけない。黙って表示しない。
        <div className="error-summary" role="alert">
          <h3 style={{ margin: '0 0 0.5rem' }}>優先度が規則と一致していません</h3>
          <p style={{ margin: 0 }}>
            影響と急ぎ具合から導かれる値と、保存されている優先度が食い違っています。
            見直しを行うと規則どおりに直ります。管理者へもご連絡ください。
          </p>
        </div>
      )}

      <details className="reassess">
        <summary>影響と急ぎ具合を見直す</summary>

        {errorMessage && (
          <div className="error-summary" role="alert" tabIndex={-1}>
            <h3 style={{ margin: '0 0 0.5rem' }}>見直せませんでした</h3>
            <p style={{ margin: 0 }}>{errorMessage}</p>
          </div>
        )}

        <form action={action} className="stack">
          <div className="field">
            <label htmlFor="assess-impact">影響の範囲</label>
            <span className="hint" id="assess-impact-hint">
              何人が困っているか。1人なら「低い」、部署全体なら「高い」
            </span>
            <select
              id="assess-impact"
              name="impact"
              defaultValue={impact}
              aria-describedby="assess-impact-hint"
            >
              {LEVELS.map((level) => (
                <option key={level} value={level}>
                  {levelLabel(level)}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="assess-urgency">急ぎ具合</label>
            <span className="hint" id="assess-urgency-hint">
              いつまでに直る必要があるか。回避策があるなら「低い」
            </span>
            <select
              id="assess-urgency"
              name="urgency"
              defaultValue={urgency}
              aria-describedby="assess-urgency-hint"
            >
              {LEVELS.map((level) => (
                <option key={level} value={level}>
                  {levelLabel(level)}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="assess-reason">見直した理由</label>
            {/* 理由は監査に残る。**優先度は SLA の期限を動かす** ので、
                「なぜ動かしたか」が残らない変更は作らない。 */}
            <span className="hint" id="assess-reason-hint">
              例: 調べたところ同じ事象が3部署で起きていた / 回避策が見つかった
            </span>
            <input
              id="assess-reason"
              name="reason"
              type="text"
              required
              maxLength={500}
              aria-describedby="assess-reason-hint"
            />
          </div>

          <p className="hint" style={{ margin: 0 }}>
            優先度は入力できません。影響と急ぎ具合から自動で決まります。
            期限もそれに合わせて変わります。
          </p>

          <button type="submit" className="secondary">
            見直す
          </button>
        </form>
      </details>
    </section>
  );
}
