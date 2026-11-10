import {
  stateLabel,
  priorityLabel,
  kindLabel,
  FILTERABLE_STATES,
  FILTERABLE_PRIORITIES,
} from '../lib/labels';
import { removeTicketQueueCondition, ticketQueueConditions } from '../lib/ticket-queue';

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
  groupsUnavailable = false,
  variant = 'bar',
}: {
  applied: URLSearchParams;
  /** Existing API-authorized choices; never resolve missing IDs in another directory. */
  groups?: Array<{ id: string; name: string }>;
  groupsUnavailable?: boolean;
  /** panel: Freshservice-style right sidebar. bar: legacy horizontal filter bar. */
  variant?: 'bar' | 'panel';
}) {
  const selected = (name: string, value: string): boolean => applied.getAll(name).includes(value);
  const assignment = applied.get('assignment') ?? '';
  const group = applied.get('group') ?? '';
  const sla = applied.get('sla') ?? '';
  const sort = applied.get('sort') ?? '';
  const createdFrom = applied.get('createdFrom') ?? '';
  const createdTo = applied.get('createdTo') ?? '';
  const requester = applied.get('requester') ?? '';
  const missingGroup =
    group !== '' &&
    !['mine', 'ungrouped'].includes(group) &&
    !groups?.some((item) => item.id === group);
  const advancedCount = ticketQueueConditions(applied).filter(({ key }) =>
    ['state', 'kind', 'priority', 'createdFrom', 'createdTo', 'requester'].includes(key),
  ).length;
  const extraValues = (key: string, known: readonly string[]) =>
    [...new Set(applied.getAll(key))].filter((value) => value !== '' && !known.includes(value));

  return (
    <form
      id="ticket-filters"
      className={`filters ticket-filters ${
        variant === 'panel' ? 'ticket-filters-panel' : 'ticket-filters-compact'
      }`}
      aria-label="問い合わせの絞り込み"
      method="get"
      action="/ops"
    >
      {/* 検索欄を先頭に置く。担当者が最初にやりたいのは
          「同じような問い合わせが過去に無かったか」を確かめることである。
          過去を探せないと、同じ調査を何度も繰り返すことになる。 */}
      <div className="field search-field">
        <label htmlFor="keyword">キーワード</label>
        <span className="visually-hidden" id="keyword-hint">
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

      <div className="field">
        <label htmlFor="assignment">担当</label>
        <select id="assignment" name="assignment" defaultValue={assignment}>
          <option value="">すべて</option>
          <option value="mine">自分の担当</option>
          {/* 未割当を出すのは、これが「誰も見ていないもの」だからである。
              放置されると、依頼者は返事を待ち続けることになる。 */}
          <option value="unassigned">未割当</option>
          {!['', 'mine', 'unassigned'].includes(assignment) && (
            <option value={assignment}>不明な担当条件（選び直してください）</option>
          )}
        </select>
      </div>

      {/* 担当グループは日常的に使う条件のため、詳細な条件ではなく
          期限の直前に常時表示する。 */}
      {missingGroup ? (
        <div className="field">
          <span>担当グループ</span>
          <input type="hidden" name="group" value={group} />
          <p className="hint">
            {groupsUnavailable
              ? 'グループ候補を取得できませんでした。'
              : '選択済みグループが現在の候補にありません。'}
            現在のグループ条件を保持して検索します。
          </p>
          <a className="clear-filters" href={removeTicketQueueCondition(applied, 'group')}>
            グループの指定を外す
          </a>
        </div>
      ) : (
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
            {(groups ?? []).map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          {groupsUnavailable && (
            <p className="hint">
              グループ候補を取得できませんでした。自分のグループ・未割当は選べます。
            </p>
          )}
        </div>
      )}

      <div className="field">
        <label htmlFor="sla">期限</label>
        <select id="sla" name="sla" defaultValue={sla}>
          <option value="">すべて</option>
          {/* **超過しても業務は止めない**(SLAは計測指標であって統制ではない)。
              止めない代わりに、見つけられなければならない。 */}
          <option value="breached">期限を超過</option>
          {!['', 'breached'].includes(sla) && (
            <option value={sla}>不明な期限条件（選び直してください）</option>
          )}
        </select>
      </div>

      <div className="field">
        <label htmlFor="sort">並び順</label>
        <select id="sort" name="sort" defaultValue={sort === 'newest' ? '' : sort}>
          <option value="">新しい順</option>
          {/* 期限順は「残り時間の少ない順」。超過は負値なので
              最も遅れているものが先頭に来る。 */}
          <option value="deadline">期限が近い順</option>
          {!['', 'newest', 'deadline'].includes(sort) && (
            <option value={sort}>不明な並び順（選び直してください）</option>
          )}
        </select>
      </div>

      <div className="filter-actions">
        <button type="submit">絞り込む</button>
        <a className="clear-filters" href="/ops">
          条件を解除
        </a>
      </div>
      <details className="advanced-filters">
        <summary>
          詳細な条件
          {advancedCount > 0 && <span className="hint"> · {advancedCount}条件を指定</span>}
        </summary>
        <div className="advanced-filter-fields">
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
            {extraValues('state', FILTERABLE_STATES).map((value) => (
              <div className="choice" key={value}>
                <input
                  type="checkbox"
                  id={`extra-state-${value}`}
                  name="state"
                  value={value}
                  defaultChecked
                />
                <label htmlFor={`extra-state-${value}`}>{stateLabel(value)}（URLの条件）</label>
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
            {extraValues('kind', ['incident', 'request']).map((value) => (
              <div className="choice" key={value}>
                <input
                  type="checkbox"
                  id={`extra-kind-${value}`}
                  name="kind"
                  value={value}
                  defaultChecked
                />
                <label htmlFor={`extra-kind-${value}`}>{kindLabel(value)}（URLの条件）</label>
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
            {extraValues('priority', FILTERABLE_PRIORITIES).map((value) => (
              <div className="choice" key={value}>
                <input
                  type="checkbox"
                  id={`extra-priority-${value}`}
                  name="priority"
                  value={value}
                  defaultChecked
                />
                <label htmlFor={`extra-priority-${value}`}>
                  {priorityLabel(value)}（URLの条件）
                </label>
              </div>
            ))}
          </fieldset>

          <div className="field">
            <label htmlFor="createdFrom">受付日(から)</label>
            {/* 日付だけを受け取る。時刻まで指定させると、「9:00 から」と
            入れた人が前日の夜間を取りこぼす。 */}
            <input
              id="createdFrom"
              name="createdFrom"
              type={dateInputType(createdFrom)}
              defaultValue={createdFrom}
            />
          </div>

          <div className="field">
            <label htmlFor="createdTo">受付日(まで)</label>
            <span className="hint" id="created-to-hint">
              その日に受け付けた分まで含みます
            </span>
            <input
              id="createdTo"
              name="createdTo"
              type={dateInputType(createdTo)}
              defaultValue={createdTo}
              aria-describedby="created-to-hint"
            />
          </div>

          {/* 依頼者は画面から選ばせない。**在籍者の一覧は名簿である。**
          作業画面の「この依頼者の他の問い合わせ」から辿ってくる。
          指定されている間だけ、外せるように見せる。 */}
          {requester.trim().length > 0 && (
            <div className="field">
              <span>依頼者</span>
              <span className="hint">特定の依頼者で絞り込んでいます</span>
              <input id="requester" name="requester" type="hidden" value={requester} readOnly />
              <a className="clear-filters" href={removeTicketQueueCondition(applied, 'requester')}>
                依頼者の指定を外す
              </a>
            </div>
          )}
        </div>
      </details>
    </form>
  );
}

/** A date input blanks invalid URL values; retain them for correction and API validation. */
function dateInputType(value: string): 'date' | 'text' {
  if (!value) return 'date';
  const date = new Date(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
    ? 'date'
    : 'text';
}
