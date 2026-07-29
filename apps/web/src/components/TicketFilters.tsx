import {
  stateLabel,
  priorityLabel,
  kindLabel,
  FILTERABLE_STATES,
  FILTERABLE_PRIORITIES,
} from '../lib/labels';

/**
 * 一覧の絞り込み (WP-P2-OPSUI-010)。
 *
 * **GET のフォームにする。** 絞り込みはURLに現れるべきである。
 * URLに出れば、同じ条件を同僚へ共有でき、ブラウザの戻るも効き、
 * 「よく使う条件」をブックマークできる。POST にすると全部できなくなる。
 *
 * 未選択を「すべて」として扱う。既定で絞り込まないのは、
 * **見えていないものがあることに気付けない**状態を作らないため。
 */
export function TicketFilters({
  applied,
  groups,
}: {
  applied: URLSearchParams;
  /** 振り先の候補。無ければグループの絞り込み自体を出さない。 */
  groups?: Array<{ id: string; name: string }>;
}) {
  const selected = (name: string, value: string): boolean => applied.getAll(name).includes(value);
  const assignment = applied.get('assignment') ?? '';
  const group = applied.get('group') ?? '';

  return (
    <form className="filters" method="get" action="/ops">
      {/* 検索欄を先頭に置く。担当者が最初にやりたいのは
          「同じような問い合わせが過去に無かったか」を確かめることである。
          過去を探せないと、同じ調査を何度も繰り返すことになる。 */}
      <div className="field search-field">
        <label htmlFor="keyword">キーワード</label>
        <span className="hint" id="keyword-hint">
          受付番号・件名・内容から探します。
        </span>
        <input
          id="keyword"
          name="keyword"
          type="search"
          defaultValue={applied.get('keyword') ?? ''}
          maxLength={200}
          aria-describedby="keyword-hint"
        />
      </div>

      <fieldset className="filter-group">
        <legend>状況</legend>
        {FILTERABLE_STATES.map((state) => (
          <div className="choice" key={state}>
            <input
              type="checkbox"
              id={`state-${state}`}
              name="state"
              value={state}
              defaultChecked={selected('state', state)}
            />
            <label htmlFor={`state-${state}`}>{stateLabel(state)}</label>
          </div>
        ))}
      </fieldset>

      <fieldset className="filter-group">
        <legend>種別</legend>
        {(['incident', 'request'] as const).map((kind) => (
          <div className="choice" key={kind}>
            <input
              type="checkbox"
              id={`kind-${kind}`}
              name="kind"
              value={kind}
              defaultChecked={selected('kind', kind)}
            />
            <label htmlFor={`kind-${kind}`}>{kindLabel(kind)}</label>
          </div>
        ))}
      </fieldset>

      <fieldset className="filter-group">
        <legend>優先度</legend>
        {FILTERABLE_PRIORITIES.map((priority) => (
          <div className="choice" key={priority}>
            <input
              type="checkbox"
              id={`priority-${priority}`}
              name="priority"
              value={priority}
              defaultChecked={selected('priority', priority)}
            />
            <label htmlFor={`priority-${priority}`}>{priorityLabel(priority)}</label>
          </div>
        ))}
      </fieldset>

      <div className="field">
        <label htmlFor="assignment">担当</label>
        <select id="assignment" name="assignment" defaultValue={assignment}>
          <option value="">すべて</option>
          <option value="mine">自分の担当</option>
          {/* 未割当を出すのは、これが「誰も見ていないもの」だからである。
              放置されると、依頼者は返事を待ち続けることになる。 */}
          <option value="unassigned">未割当</option>
        </select>
      </div>

      {groups !== undefined && groups.length > 0 && (
        <div className="field">
          <label htmlFor="group">担当グループ</label>
          <select id="group" name="group" defaultValue={group}>
            <option value="">すべて</option>
            {/* **「自分のグループ」を先頭に置く。** 担当者が日常的に見るのは
                自分のキューであり、他のグループを覗くのは例外的な操作である。 */}
            <option value="mine">自分のグループ</option>
            {/* どこにも振られていないものは、誰も見ていない可能性が高い。
                探せないと**放置されたことに気付けない**。 */}
            <option value="ungrouped">グループ未割当</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="filter-actions">
        <button type="submit">絞り込む</button>
        {/* 解除は空のGETで行う。「すべて外す」を手作業でやらせない。 */}
        <a className="clear-filters" href="/ops">
          条件を解除
        </a>
      </div>
    </form>
  );
}
