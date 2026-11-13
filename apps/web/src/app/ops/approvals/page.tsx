import Link from 'next/link';
import {
  api,
  requireSession,
  type ApprovalPreviewResult,
  type ApprovalRuleStepView,
} from '../../../lib/api';
import { isOrgAdmin } from '../../../lib/navigation';
import { formatDateTime, stateLabel } from '../../../lib/labels';
import {
  AUTHORITY_LABELS,
  approvalHref,
  approvalNoticeText,
  parseApprovalsQuery,
  resolverReasonText,
  resolvedFromLabel,
  stepLabel,
  summarizeApprovalSteps,
} from '../../../lib/approval-route';
import {
  createApprovalRuleAction,
  deactivateApprovalRuleAction,
  reviseApprovalRuleAction,
  updateApprovalRoutingAction,
} from './actions';

export const dynamic = 'force-dynamic';

/**
 * 承認ルール管理 (WP-P4-APR-016 段階A)。
 *
 * 組織の `org_admin` だけが、ルールの作成・版の追加・無効化・経路プレビュー・
 * 組織での有効化を行う。認可と検証はAPIが担い、この画面は表示を制御するだけである。
 * 保存済みの版は変更できないため、編集は新しい版の追加として示す。
 * 無効化と組織での切替は取り消せない操作として確認画面を挟む。
 */
export default async function ApprovalRulesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const session = await requireSession();
  if (!isOrgAdmin(session)) {
    return (
      <main id="main" className="shell">
        <h1>承認ルール</h1>
        <p className="empty">この画面を表示する権限がありません。組織の管理者へご連絡ください。</p>
        <Link href="/portal">利用者ポータルへ戻る</Link>
      </main>
    );
  }

  const { query, preview } = parseApprovalsQuery(raw);
  const scope = { userId: session.userId, organizationId: session.organizationId };
  const rulesResult = await api.approvalRules();
  const settingsResult = await api.approvalRouting();
  const membersResult = await api.listMembers();
  const catalogResult = await api.catalogAdmin();
  const unavailableResult = await api.serviceRequests('approverUnavailable=1');

  const error = typeof raw.error === 'string' ? raw.error.trim().slice(0, 500) : '';
  const notice = approvalNoticeText(raw.notice);

  if (!rulesResult.ok) {
    return (
      <main id="main" className="shell">
        <h1>承認ルール</h1>
        <section className="error-summary" role="alert">
          <h2>
            {rulesResult.problem.status === 403
              ? '承認ルールを表示する権限がありません'
              : rulesResult.problem.status === 404
                ? '承認ルールの機能を利用できません'
                : '承認ルールを読み込めませんでした'}
          </h2>
          <p>
            {rulesResult.problem.status === 404
              ? 'この環境では承認ルールの管理が有効になっていません。管理者へご連絡ください。'
              : '情報を取得できていないため、ルールの操作は表示していません。時間をおいて再度お試しください。'}
          </p>
          <Link href="/ops/approvals">一覧を再読み込み</Link>
        </section>
      </main>
    );
  }

  const rules = rulesResult.data.items;
  const settings = settingsResult.ok ? settingsResult.data.setting : null;
  const members = membersResult.ok ? membersResult.data.items : [];
  const activeMembers = members
    .filter((member) => member.status === 'active')
    .sort(
      (a, b) =>
        a.displayName.localeCompare(b.displayName, 'ja') || a.userId.localeCompare(b.userId),
    );
  const eligibleApprovers = activeMembers.filter((member) => member.roleCodes.includes('approver'));
  const publishedItems = catalogResult.ok
    ? catalogResult.data.items
        .filter((item) => item.active && item.publishedRevision !== null)
        .sort((a, b) => a.title.localeCompare(b.title, 'ja') || a.id.localeCompare(b.id))
    : [];
  const selected = query.rule ? (rules.find((rule) => rule.id === query.rule) ?? null) : null;
  const historyResult = selected ? await api.approvalRuleHistory(selected.id) : null;
  const history = historyResult?.ok ? historyResult.data.items : [];
  const currentSteps =
    selected === null
      ? []
      : (history.find((revision) => revision.revision === selected.currentRevision)?.steps ??
        selected.steps);
  const unresolvedResult =
    selected && query.unresolved ? await api.approvalRuleUnresolved(selected.id) : null;

  let previewResult: ApprovalPreviewResult | null = null;
  let previewError: string | null = null;
  if (preview.kind && !preview.requesterId) {
    previewError = '経路を確認する申請者を選んでください。';
  } else if (preview.kind === 'rule' && !preview.ruleId) {
    previewError = '経路を確認する承認ルールを選んでください。';
  } else if (preview.kind === 'item' && !preview.itemId) {
    previewError = '経路を確認するカタログ項目を選んでください。';
  } else if (preview.kind && preview.requesterId) {
    const result = await api.approvalPreview({
      requesterId: preview.requesterId,
      ...(preview.kind === 'rule' ? { ruleId: preview.ruleId } : { itemId: preview.itemId }),
    });
    if (result.ok) previewResult = result.data;
    else
      previewError = (
        result.problem.errors?.[0]?.message ??
        result.problem.detail ??
        result.problem.title ??
        '経路を確認できませんでした。'
      ).slice(0, 500);
  }

  const unavailable = unavailableResult.ok ? unavailableResult.data.items : [];
  const actionLinkStyle = {
    display: 'inline-block',
    minHeight: '24px',
    padding: '2px 0',
  } as const;

  return (
    <main id="main" className="shell directory-shell">
      <div className="directory-heading">
        <div>
          <h1>承認ルール</h1>
          <p>
            承認の段（固定承認者・上長・部署長）と、組織での使用を管理します。保存済みの版は変更できません。
          </p>
        </div>
        <div className="directory-heading-actions">
          <Link className="directory-cta secondary" href="/ops/approvals/changes">
            上長・部署長の変更履歴
          </Link>
        </div>
      </div>

      {notice && (
        <div className="notice directory-notice" id="approval-notice" role="status" tabIndex={-1}>
          <p>{notice}</p>
        </div>
      )}
      {error && (
        <div className="error-summary" id="approval-error" role="alert" tabIndex={-1} autoFocus>
          <h2>操作できませんでした</h2>
          <p>{error}</p>
        </div>
      )}

      <section
        className="directory-panel"
        id="approval-routing"
        aria-labelledby="approval-routing-title"
      >
        <h2 id="approval-routing-title">組織での使用</h2>
        {settings === null ? (
          <p className="hint" role="alert">
            組織の設定を読み込めませんでした。時間をおいて、画面を開き直してください。
          </p>
        ) : (
          <>
            <p>
              現在の状態: <strong>{settings.enabled ? '有効' : '無効'}</strong>
              {settings.updatedAt
                ? `（最後に切り替えた日時: ${formatDateTime(settings.updatedAt)}）`
                : '（まだ切り替えていません）'}
            </p>
            <p className="hint">
              行が無い組織では無効です。無効の間は、カタログ項目にルールを結び付けても、新しい申請では固定承認者の設定で経路を決めます。
            </p>
            {query.confirm === 'enable-routing' ? (
              <div className="notice" aria-labelledby="approval-enable-title">
                <h3 id="approval-enable-title">組織で承認ルールを有効にしますか</h3>
                <ol>
                  <li>
                    有効にすると、承認ルールを結び付けたカタログ項目の<strong>新しい申請</strong>
                    から経路が変わります。
                  </li>
                  <li>進行中の申請の経路は変わりません。</li>
                  <li>
                    上長・部署長の設定の変更は、
                    <Link href="/ops/approvals/changes">上長・部署長の変更履歴</Link>
                    で確認できます。
                  </li>
                </ol>
                <form
                  action={updateApprovalRoutingAction.bind(null, scope, query, true)}
                  className="actions-row"
                >
                  <button type="submit" id="approval-routing-submit">
                    有効にする
                  </button>
                  <Link
                    href={approvalHref(query, { confirm: null }) + '#approval-routing'}
                    style={actionLinkStyle}
                  >
                    やめる
                  </Link>
                </form>
              </div>
            ) : query.confirm === 'disable-routing' ? (
              <div className="notice" aria-labelledby="approval-disable-title">
                <h3 id="approval-disable-title">組織で承認ルールを使わない設定に戻しますか</h3>
                <p>
                  新しい申請ではルールを使わず、固定承認者の設定で経路を決めます。進行中の申請の経路は変わりません。
                </p>
                <form
                  action={updateApprovalRoutingAction.bind(null, scope, query, false)}
                  className="actions-row"
                >
                  <button type="submit" id="approval-routing-submit" className="danger">
                    無効にする
                  </button>
                  <Link
                    href={approvalHref(query, { confirm: null }) + '#approval-routing'}
                    style={actionLinkStyle}
                  >
                    やめる
                  </Link>
                </form>
              </div>
            ) : (
              <p>
                <Link
                  href={
                    approvalHref(query, {
                      confirm: settings.enabled ? 'disable-routing' : 'enable-routing',
                    }) + '#approval-routing'
                  }
                  id="approval-routing-toggle"
                  style={actionLinkStyle}
                >
                  {settings.enabled
                    ? '組織で承認ルールを使わない設定に戻す'
                    : '組織で承認ルールを有効にする'}
                </Link>
              </p>
            )}
          </>
        )}
      </section>

      <section aria-labelledby="approval-rules-title">
        <h2 id="approval-rules-title">承認ルールの一覧</h2>
        {rules.length === 0 ? (
          <p className="empty">
            まだ承認ルールがありません。下の「承認ルールを作成」から最初のルールを作成してください。
          </p>
        ) : (
          <div className="directory-table-wrap">
            <table className="directory-table">
              <caption>承認ルールの一覧</caption>
              <thead>
                <tr>
                  <th scope="col">コード</th>
                  <th scope="col">名称</th>
                  <th scope="col">状態</th>
                  <th scope="col">現在の版</th>
                  <th scope="col">段の要約</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.id} data-selected={rule.id === query.rule ? 'true' : undefined}>
                    <td data-label="コード">
                      <code>{rule.code}</code>
                    </td>
                    <td data-label="名称">
                      <Link
                        href={
                          approvalHref(query, { rule: rule.id, confirm: null, unresolved: false }) +
                          '#approval-rule-detail'
                        }
                        aria-label={`${rule.name} の詳細`}
                      >
                        {rule.name}
                      </Link>
                    </td>
                    <td data-label="状態">
                      {rule.active ? (
                        '有効'
                      ) : (
                        <span>
                          無効
                          <br />
                          <small>変更できません</small>
                        </span>
                      )}
                    </td>
                    <td data-label="現在の版">版{rule.currentRevision}</td>
                    <td data-label="段の要約">
                      {summarizeApprovalSteps(rule.steps, rule.stepsValid)}
                    </td>
                    <td data-label="操作">
                      <Link
                        href={
                          approvalHref(query, { rule: rule.id, confirm: null, unresolved: false }) +
                          '#approval-rule-detail'
                        }
                        style={actionLinkStyle}
                      >
                        詳細
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section
        className="directory-panel"
        id="approval-create"
        aria-labelledby="approval-create-title"
      >
        <h2 id="approval-create-title">承認ルールを作成</h2>
        <p className="hint">
          コードは英小文字から始まる64文字以内の英小文字・数字・ハイフンです。段は最大3段で、上から順に承認します。
        </p>
        {eligibleApprovers.length === 0 && (
          <p className="hint" role="alert">
            現在有効な承認者（承認者ロールを持つ利用者）がいません。固定承認者を含むルールを作る前に、利用者管理でロールを確認してください。
          </p>
        )}
        <form
          action={createApprovalRuleAction.bind(null, scope, query)}
          className="directory-form"
          aria-describedby={error ? 'approval-error' : undefined}
        >
          <fieldset className="directory-form-grid">
            <legend className="visually-hidden">承認ルールを作成</legend>
            <div className="field">
              <label htmlFor="approval-create-code">コード</label>
              <input
                id="approval-create-code"
                name="code"
                type="text"
                required
                maxLength={64}
                pattern="[a-z][a-z0-9-]*"
                aria-describedby="approval-create-code-hint"
                autoComplete="off"
              />
              <p className="hint" id="approval-create-code-hint">
                例: ui016-syn-2step。作成後は変更できません。
              </p>
            </div>
            <div className="field">
              <label htmlFor="approval-create-name">名称</label>
              <input
                id="approval-create-name"
                name="name"
                type="text"
                required
                maxLength={200}
                autoComplete="off"
              />
            </div>
          </fieldset>
          <ApprovalStepFields idPrefix="approval-create-step" approvers={eligibleApprovers} />
          <div className="directory-form-actions">
            <button type="submit" id="approval-create-submit">
              承認ルールを作成する
            </button>
          </div>
        </form>
      </section>

      {query.rule && !selected && (
        <p role="status">選択した承認ルールは表示できませんでした。一覧から選び直してください。</p>
      )}

      {selected && (
        <section
          className="directory-panel"
          id="approval-rule-detail"
          aria-labelledby="approval-rule-detail-title"
          tabIndex={-1}
        >
          <div className="directory-detail-heading">
            <h2 id="approval-rule-detail-title">{selected.name}</h2>
            <Link
              href={approvalHref(query, { rule: null, confirm: null, unresolved: false })}
              style={actionLinkStyle}
            >
              詳細を閉じる
            </Link>
          </div>
          <p>
            <code>{selected.code}</code> · {selected.active ? '有効' : '無効'} · 現在の版: 版
            {selected.currentRevision} · 更新: {formatDateTime(selected.updatedAt)}
          </p>
          <p>段の構成: {summarizeApprovalSteps(selected.steps, selected.stepsValid)}</p>

          {selected.active ? (
            <section aria-labelledby="approval-revise-title">
              <h3 id="approval-revise-title">新しい版を追加</h3>
              <p className="notice">
                保存済みの版は変更できません。下の内容は<strong>新しい版</strong>
                として追加され、現在の版{selected.currentRevision}
                はそのまま残ります。進行中の申請と保存済みの版の経路は変わりません。
              </p>
              <form
                action={reviseApprovalRuleAction.bind(null, scope, query, selected.id)}
                className="directory-form"
                aria-describedby={error ? 'approval-error' : undefined}
              >
                <input type="hidden" name="expectedRevision" value={selected.currentRevision} />
                <div className="field">
                  <label htmlFor="approval-revise-name">名称</label>
                  <input
                    id="approval-revise-name"
                    name="name"
                    type="text"
                    required
                    maxLength={200}
                    defaultValue={selected.name}
                    autoComplete="off"
                  />
                </div>
                <ApprovalStepFields
                  idPrefix="approval-revise-step"
                  approvers={eligibleApprovers}
                  defaults={currentSteps}
                />
                <div className="directory-form-actions">
                  <button type="submit" id="approval-revise-submit">
                    新しい版を追加する
                  </button>
                </div>
              </form>
            </section>
          ) : (
            <p className="empty">
              この承認ルールは無効化されています。変更はできません。必要な場合は新しいルールを作成してください。
            </p>
          )}

          <section aria-labelledby="approval-history-title">
            <h3 id="approval-history-title">版の履歴</h3>
            {historyResult && !historyResult.ok ? (
              <p className="hint" role="alert">
                版の履歴を読み込めませんでした。時間をおいて再度お試しください。
              </p>
            ) : history.length === 0 ? (
              <p className="empty">版の履歴を表示できません。</p>
            ) : (
              <div className="directory-table-wrap">
                <table className="directory-table">
                  <caption>承認ルールの版の履歴</caption>
                  <thead>
                    <tr>
                      <th scope="col">版</th>
                      <th scope="col">段の構成</th>
                      <th scope="col">作成者</th>
                      <th scope="col">作成日時</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((revision) => (
                      <tr key={revision.revision}>
                        <td data-label="版">
                          版{revision.revision}
                          {revision.revision === selected.currentRevision ? '（現在）' : ''}
                        </td>
                        <td data-label="段の構成">
                          {summarizeApprovalSteps(revision.steps, revision.stepsValid)}
                        </td>
                        <td data-label="作成者">{revision.createdByName ?? '確認できません'}</td>
                        <td data-label="作成日時">{formatDateTime(revision.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section aria-labelledby="approval-deactivate-title" id="approval-deactivate">
            <h3 id="approval-deactivate-title">承認ルールの無効化</h3>
            {selected.active ? (
              <>
                <p>
                  無効化すると元に戻せません。カタログ項目の結び付けは残りますが、新しい申請ではこのルールを使いません。
                </p>
                {query.confirm === 'deactivate' ? (
                  <div className="notice" aria-labelledby="approval-deactivate-confirm-title">
                    <h4 id="approval-deactivate-confirm-title">承認ルールを無効化しますか</h4>
                    <p>
                      {selected.name}（<code>{selected.code}</code>
                      ）を無効化します。この操作は取り消せません。
                    </p>
                    <form
                      action={deactivateApprovalRuleAction.bind(null, scope, query, selected.id)}
                      className="actions-row"
                    >
                      <button type="submit" id="approval-deactivate-submit" className="danger">
                        無効化する
                      </button>
                      <Link
                        href={approvalHref(query, { confirm: null }) + '#approval-rule-detail'}
                        style={actionLinkStyle}
                      >
                        やめる
                      </Link>
                    </form>
                  </div>
                ) : (
                  <p>
                    <Link
                      href={approvalHref(query, { confirm: 'deactivate' }) + '#approval-deactivate'}
                      id="approval-deactivate-link"
                      style={actionLinkStyle}
                    >
                      この承認ルールを無効化する
                    </Link>
                  </p>
                )}
              </>
            ) : (
              <p className="empty">この承認ルールは既に無効化されています。</p>
            )}
          </section>

          <section aria-labelledby="approval-unresolved-title" id="approval-unresolved">
            <h3 id="approval-unresolved-title">解決できない人の一覧</h3>
            <p className="hint">
              現在の有効な所属のうち、このルールで経路を解決できない人を表示します。上長・主部署・部署長の設定は利用者管理と部署管理で確認できます。
            </p>
            {query.unresolved ? (
              unresolvedResult && !unresolvedResult.ok ? (
                <p className="hint" role="alert">
                  {unresolvedResult.problem.status === 403
                    ? '解決できない人の一覧を表示する権限がありません。'
                    : '解決できない人の一覧を読み込めませんでした。時間をおいて再度お試しください。'}
                </p>
              ) : unresolvedResult?.ok ? (
                <>
                  <p>
                    対象: 現在の有効な所属 {unresolvedResult.data.scanned} 人 / 解決できない人{' '}
                    {unresolvedResult.data.items.length} 人
                  </p>
                  {unresolvedResult.data.items.length === 0 ? (
                    <p className="empty">
                      現在の有効な所属で、このルールの経路を解決できない人はいません。
                    </p>
                  ) : (
                    <div className="directory-table-wrap">
                      <table className="directory-table">
                        <caption>解決できない人の一覧</caption>
                        <thead>
                          <tr>
                            <th scope="col">利用者</th>
                            <th scope="col">理由</th>
                            <th scope="col">操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {unresolvedResult.data.items.map((item) => (
                            <tr key={item.userId}>
                              <td data-label="利用者">{item.displayName}</td>
                              <td data-label="理由">{resolverReasonText(item.reason)}</td>
                              <td data-label="操作">
                                <Link
                                  href={`/ops/users?selected=${encodeURIComponent(item.userId)}`}
                                  style={actionLinkStyle}
                                >
                                  利用者管理で確認する
                                </Link>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <p>
                    <Link
                      href={approvalHref(query, { unresolved: false }) + '#approval-unresolved'}
                      style={actionLinkStyle}
                    >
                      一覧を閉じる
                    </Link>
                  </p>
                </>
              ) : null
            ) : (
              <p>
                <Link
                  href={approvalHref(query, { unresolved: true }) + '#approval-unresolved'}
                  style={actionLinkStyle}
                >
                  解決できない人を表示する
                </Link>
              </p>
            )}
          </section>
        </section>
      )}

      <section
        className="directory-panel"
        id="approval-preview"
        aria-labelledby="approval-preview-title"
      >
        <h2 id="approval-preview-title">経路プレビュー</h2>
        <p className="hint">
          承認ルール、または公開済みのカタログ項目と申請者を選ぶと、誰が承認するかを段ごとに表示します。この操作は保存も申請もしません。
        </p>
        <form
          method="get"
          action="/ops/approvals"
          className="directory-form"
          aria-describedby={previewError ? 'approval-preview-error' : undefined}
        >
          {query.rule && <input type="hidden" name="rule" value={query.rule} />}
          <fieldset>
            <legend>経路を確認する対象</legend>
            <label>
              <input
                type="radio"
                name="previewKind"
                value="rule"
                defaultChecked={preview.kind !== 'item'}
              />{' '}
              承認ルール
            </label>{' '}
            <label>
              <input
                type="radio"
                name="previewKind"
                value="item"
                defaultChecked={preview.kind === 'item'}
              />{' '}
              公開済みのカタログ項目
            </label>
          </fieldset>
          <div className="directory-form-grid">
            <div className="field">
              <label htmlFor="approval-preview-rule">承認ルール</label>
              <p className="hint" id="approval-preview-rule-hint">
                「承認ルール」を選んだときに使います。無効なルールも経路の確認だけはできます。
              </p>
              <select
                id="approval-preview-rule"
                name="previewRuleId"
                defaultValue={preview.ruleId}
                aria-describedby="approval-preview-rule-hint"
              >
                <option value="">選択してください</option>
                {rules.map((rule) => (
                  <option key={rule.id} value={rule.id}>
                    {rule.code} — {rule.name}
                    {rule.active ? '' : '（無効）'}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="approval-preview-item">公開済みのカタログ項目</label>
              <p className="hint" id="approval-preview-item-hint">
                「公開済みのカタログ項目」を選んだときに使います。
                {catalogResult.ok ? '' : '現在、カタログ項目を読み込めませんでした。'}
              </p>
              <select
                id="approval-preview-item"
                name="previewItemId"
                defaultValue={preview.itemId}
                aria-describedby="approval-preview-item-hint"
              >
                <option value="">選択してください</option>
                {publishedItems.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="approval-preview-requester">申請者</label>
              <p className="hint" id="approval-preview-requester-hint">
                現在の有効な所属から選びます。表示名だけを使い、社員番号・役職・勤務地は表示しません。
              </p>
              <select
                id="approval-preview-requester"
                name="previewRequesterId"
                defaultValue={preview.requesterId}
                aria-describedby="approval-preview-requester-hint"
                required
              >
                <option value="">選択してください</option>
                {activeMembers.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.displayName}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="directory-form-actions">
            <button type="submit" id="approval-preview-submit">
              経路をプレビューする
            </button>
          </div>
        </form>

        {previewError && (
          <div className="error-summary" id="approval-preview-error" role="alert">
            <h3>経路を確認できませんでした</h3>
            <p>{previewError}</p>
          </div>
        )}
        {previewResult && (
          <section aria-labelledby="approval-preview-result-title" className="notice">
            <h3 id="approval-preview-result-title">プレビュー結果</h3>
            <p>
              申請者: <strong>{previewResult.requesterName ?? '表示名を確認できません'}</strong>
              {' · '}組織の承認ルール: {previewResult.ruleRoutingEnabled ? '有効' : '無効'}
              {previewResult.rule
                ? ` · ${previewResult.rule.code}（版${previewResult.rule.revision}）`
                : ' · ルールを使わない経路'}
            </p>
            {previewResult.resolved ? (
              previewResult.steps && previewResult.steps.length > 0 ? (
                <div className="directory-table-wrap">
                  <table className="directory-table">
                    <caption>承認の経路</caption>
                    <thead>
                      <tr>
                        <th scope="col">段</th>
                        <th scope="col">種別</th>
                        <th scope="col">承認者</th>
                        <th scope="col">解決方法</th>
                      </tr>
                    </thead>
                    <tbody>
                      {previewResult.steps.map((step) => (
                        <tr key={step.stepNo}>
                          <td data-label="段">段{step.stepNo}</td>
                          <td data-label="種別">
                            {AUTHORITY_LABELS[step.authorityType] ?? '種別を確認できません'}
                          </td>
                          <td data-label="承認者">
                            {step.approverName ?? '表示名を確認できません'}
                          </td>
                          <td data-label="解決方法">{resolvedFromLabel(step.resolvedFrom)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="empty">承認の段が返りませんでした。設定を確認してください。</p>
              )
            ) : (
              <p role="alert">
                <strong>経路を解決できません。</strong> {resolverReasonText(previewResult.reason)}
              </p>
            )}
          </section>
        )}
        {!previewResult && !previewError && preview.kind && (
          <p className="hint">条件を選んで「経路をプレビューする」を押してください。</p>
        )}
      </section>

      <section aria-labelledby="approval-unavailable-title" id="approval-unavailable">
        <h2 id="approval-unavailable-title">承認者不在の申請</h2>
        <p className="hint">
          現在の承認の段の承認者が、有効な所属ではない（固定承認者は承認者ロールも無い）申請です。状態は変わりません。自動で承認者を差し替えることもありません。
          <strong>
            申請者が内容を変更すると、新しい版でその時点の組織データから承認経路が解決し直されます。
          </strong>
          再割当の操作はこの画面にはありません。
        </p>
        {!unavailableResult.ok ? (
          <p className="hint" role="alert">
            承認者不在の申請を読み込めませんでした。時間をおいて再度お試しください。
          </p>
        ) : unavailable.length === 0 ? (
          <p className="empty">現在、承認者不在の申請はありません。</p>
        ) : (
          <>
            <p role="status">
              承認者不在の申請は {unavailableResult.data.total} 件です。
              {unavailableResult.data.total > unavailable.length
                ? `先頭 ${unavailable.length} 件を表示しています。`
                : ''}
            </p>
            <div className="directory-table-wrap">
              <table className="directory-table">
                <caption>承認者不在の申請</caption>
                <thead>
                  <tr>
                    <th scope="col">申請番号</th>
                    <th scope="col">件名</th>
                    <th scope="col">申請者</th>
                    <th scope="col">状態</th>
                    <th scope="col">更新日時</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {unavailable.map((request) => (
                    <tr key={request.id}>
                      <td data-label="申請番号">{request.number}</td>
                      <td data-label="件名">{request.title}</td>
                      <td data-label="申請者">{request.requesterName}</td>
                      <td data-label="状態">{stateLabel(request.state)}</td>
                      <td data-label="更新日時">{formatDateTime(request.updatedAt)}</td>
                      <td data-label="操作">
                        <Link
                          href={`/requests/${encodeURIComponent(request.id)}`}
                          style={actionLinkStyle}
                        >
                          詳細
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </main>
  );
}

/**
 * 段の入力。3段までを常に表示し、種別が「使用しない」の段は保存しない。
 * 種別ごとの入力は出し分けず、必要な項目だけを選ぶ形にする(JavaScript無しでも操作できる)。
 */
function ApprovalStepFields({
  idPrefix,
  approvers,
  defaults = [],
}: {
  idPrefix: string;
  approvers: Array<{ userId: string; displayName: string }>;
  defaults?: ApprovalRuleStepView[];
}) {
  return (
    <fieldset aria-describedby={`${idPrefix}-hint`}>
      <legend>承認の段（最大3段）</legend>
      <p className="hint" id={`${idPrefix}-hint`}>
        上から順に承認します。種別が「使用しない」の段は保存されません。空の段は末尾だけにできます。
      </p>
      {[0, 1, 2].map((index) => {
        const step = defaults[index];
        const type = step?.type ?? '';
        const approverId = step?.type === 'fixed' ? step.approverId : '';
        const onUnresolved = step?.type === 'manager' ? step.onUnresolved : 'reject';
        return (
          <fieldset key={index}>
            <legend>段{index + 1}</legend>
            <div className="directory-form-grid">
              <div className="field">
                <label htmlFor={`${idPrefix}-type-${index}`}>種別</label>
                <select
                  id={`${idPrefix}-type-${index}`}
                  name={`steps.${index}.type`}
                  defaultValue={type}
                >
                  <option value="">使用しない</option>
                  <option value="fixed">固定承認者</option>
                  <option value="manager">上長</option>
                  <option value="department_head">部署長</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor={`${idPrefix}-approver-${index}`}>固定承認者</label>
                <p className="hint" id={`${idPrefix}-approver-hint-${index}`}>
                  種別が「固定承認者」のときだけ使います。現在有効な承認者ロールを持つ利用者だけを候補にしています。
                </p>
                <select
                  id={`${idPrefix}-approver-${index}`}
                  name={`steps.${index}.approverId`}
                  defaultValue={approverId}
                  aria-describedby={`${idPrefix}-approver-hint-${index}`}
                >
                  <option value="">選択してください</option>
                  {approvers.map((approver) => (
                    <option key={approver.userId} value={approver.userId}>
                      {approver.displayName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor={`${idPrefix}-unresolved-${index}`}>上長を解決できないとき</label>
                <p className="hint" id={`${idPrefix}-unresolved-hint-${index}`}>
                  種別が「上長」のときだけ使います。部署長へ進む場合も、部署長がいなければ申請を拒否します。
                </p>
                <select
                  id={`${idPrefix}-unresolved-${index}`}
                  name={`steps.${index}.onUnresolved`}
                  defaultValue={onUnresolved}
                  aria-describedby={`${idPrefix}-unresolved-hint-${index}`}
                >
                  <option value="reject">申請を拒否する</option>
                  <option value="department_head">部署長へ進む</option>
                </select>
              </div>
            </div>
            <p className="hint">
              段{index + 1}の内容: {step ? stepLabel(step) : '使用しない'}
            </p>
          </fieldset>
        );
      })}
    </fieldset>
  );
}
