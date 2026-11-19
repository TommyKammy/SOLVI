import Link from 'next/link';
import { notFound } from 'next/navigation';
import { api, requireSession, type CatalogItem } from '../../../lib/api';
import { formatDateTime } from '../../../lib/labels';
import { CatalogValueSummary } from '../../../components/CatalogValueSummary';
import { CatalogChecklistForm } from '../../../components/CatalogChecklistForm';
import { formScope } from '../../../lib/form-scope';
import { RequestForm, RequestActions } from '../../../components/RequestForms';
import { safeReturnTo } from '../../../lib/navigation';
import {
  authorityLabel,
  displayStepState,
  HIGH_RISK_APPROVAL_NOTICE,
  reassignmentRecords,
  requestApprovalTimeline,
  requestHistoryVersions,
  stepStateLabel,
} from '../../../lib/approval-route';
const labels: Record<string, string> = {
  pending: '承認待ち',
  approved: '承認済み・模擬実行待ち',
  rejected: '却下',
  invalidated: '無効・再承認が必要',
  completed: '模擬実行完了',
  cancelled: '取消',
  expired: '期限切れ',
};
/** 承認行の状態。申請全体の状態(模擬実行待ちなど)とは混ぜない。 */
const approvalStateLabels: Record<string, string> = {
  pending: '承認待ち',
  approved: '承認済み',
  rejected: '却下',
  invalidated: '無効',
  cancelled: '取消',
  expired: '期限切れ',
};
export default async function RequestPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const { id } = await params;
  const result = await api.requestDetail(id);
  if (!result.ok) {
    if (result.problem.status === 404) notFound();
    const query = await searchParams;
    const returnTo = safeReturnTo(query.returnTo);
    const retryQuery = new URLSearchParams();
    if (returnTo) retryQuery.set('returnTo', returnTo);
    const validId =
      typeof id === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const retryHref = validId
      ? `/requests/${encodeURIComponent(id)}${retryQuery.size ? '?' + retryQuery.toString() : ''}`
      : '';
    const message =
      result.problem.status === 400
        ? '申請を指定する情報が正しくありません。申請一覧から選び直してください。'
        : result.problem.status === 401
          ? 'ログイン状態を確認できませんでした。ログインし直してから、もう一度お試しください。'
          : result.problem.status === 403
            ? 'この申請を表示する権限がありません。選択中の組織を確認するか、管理者にご相談ください。'
            : '一時的に申請を読み込めませんでした。時間をおいて、もう一度お試しください。';
    return (
      <main id="main" className="shell">
        <h1>申請を読み込めませんでした</h1>
        <p role="alert">{message}</p>
        {validId && (
          <p>
            <a href={retryHref}>再取得する</a>
          </p>
        )}
        <p>
          <a href={returnTo ?? '/requests'}>{returnTo ? '元の画面へ戻る' : '申請一覧へ戻る'}</a>
        </p>
        <p>
          <a href="/portal">ポータルへ戻る</a>
        </p>
      </main>
    );
  }
  const data = result.data,
    q = data.request,
    s = q.snapshot,
    own = q.requesterId === session.userId,
    staff = session.roles.some((r) =>
      ['agent', 'org_admin', 'platform_admin'].includes(r.roleCode),
    ),
    admin = session.roles.some((r) => ['org_admin', 'platform_admin'].includes(r.roleCode));
  // 自分宛てかどうかはAPIが返す現在のステップの承認者で判定する(ロールでは判定しない)。
  // 上長・部署長は approver ロールを持たない(ADR-0023 §2 / §5)。
  // 描画の間に期限を過ぎても、行が pending のまま期限を過ぎた場合と
  // expired になった場合で表示が変わらないように、同じ規則で導出する。
  const now = Date.now();
  const assigned = data.approval.approver_id === session.userId && !own,
    expired = new Date(data.approval.expires_at).getTime() <= now;
  // 代理で見ている場合は、APIが返す `currentDelegation` だけで判断する
  // (委任の一覧や期間を画面で組み立て直さない / ADR-0025 §3・§5)。
  const delegatedToMe = data.currentDelegation ?? null;
  const canApproveNow =
    !own && (assigned || delegatedToMe !== null) && q.state === 'pending' && !expired;
  const item: CatalogItem = { ...s.item, description: '', definition: s.item.definition };
  const query = await searchParams;
  const returnTo = safeReturnTo(query.returnTo);
  const backHref = returnTo ?? (own ? '/requests?view=mine' : '/requests?view=approvals');
  const fromInbox = new URL(backHref, 'https://solvi.local').pathname === '/inbox';
  const created = own && query.created === '1';
  const canRevoke = !own && (assigned || admin) && q.state === 'approved';
  const canSimulate =
    staff &&
    q.state === 'approved' &&
    !expired &&
    !data.fulfillment?.checks.some((check) => check.required && !check.completed);
  const editable = own && !['completed', 'cancelled'].includes(q.state);
  // 変更フォームでも経路を表示する。ルールで決まる項目だけ、本人を申請者として読む。
  const editRuleId = s.item.definition.approval?.ruleId ?? null;
  const editRouteResult = editable && editRuleId ? await api.catalogApprovalRoute(s.item.id) : null;
  const timelineSteps = (
    data.effectiveSteps ??
    data.steps ??
    (data.approval
      ? [
          {
            stepNo: 1,
            state: data.approval.state,
            approverName: data.approverName,
            authorityType: 'legacy',
            reason: data.approval.reason,
            decidedAt: null,
            expiresAt: data.approval.expires_at,
          },
        ]
      : [])
  ).map((step) => ({
    ...step,
    state: displayStepState(step.state, step.expiresAt, now) ?? step.state,
  }));
  const timeline = requestApprovalTimeline({
    route: data.route ?? null,
    // 段ごとの有効な世代のステップ。再割当で置き換えられた旧世代の行は
    // 現在の段として使わない(APIの effectiveSteps が無い場合は従来の steps)。
    steps: timelineSteps,
  });
  const versions = requestHistoryVersions(data.history, q.revision);
  // 再割当の記録は世代の行だけから作り、時刻の順に出す(申請者にも見える)。
  const reassignments = reassignmentRecords(data.routeGenerations);
  return (
    <main id="main" className="shell request-review">
      <header className="support-page-heading">
        <div>
          <Link className="support-back" href={backHref}>
            {fromInbox
              ? '業務受信箱に戻る'
              : returnTo && !backHref.startsWith('/requests')
                ? '元の画面に戻る'
                : '申請一覧に戻る'}
          </Link>
          <p className="support-ticket-number request-identifiers">
            {q.number && (
              <span>
                申請番号 <strong>{q.number}</strong>
              </span>
            )}
            <span>公開版 {s.item.version}</span>
            <span>申請内容版 {q.revision}</span>
          </p>
          <h1>{s.item.title}</h1>
        </div>
      </header>
      {created && (
        <div className="support-ticket-receipt" role="status">
          <h2>申請を受け付けました</h2>
          {q.number && (
            <p>
              申請番号 <strong>{q.number}</strong>
            </p>
          )}
          <p>判断結果は「自分の申請」から確認できます。</p>
          <Link className="support-back" href="/requests?view=mine">
            自分の申請を見る
          </Link>
        </div>
      )}
      {query.saved === '1' && (
        <p role="status" className="success">
          申請の状態を保存しました。
        </p>
      )}
      {data.highRisk === true && (
        <p className="notice" id="request-detail-high-risk-note" role="note">
          {HIGH_RISK_APPROVAL_NOTICE}
        </p>
      )}
      {delegatedToMe && q.state === 'pending' && !expired && (
        <p role="status" className="notice" data-delegated-to-me="true">
          {delegatedToMe.delegatorName}
          さんの代理で承認・却下できます。委任された範囲は、この方宛ての承認のすべてです。
        </p>
      )}
      {own && q.state === 'pending' && data.approverUnavailable === true && (
        <p role="status" className="notice">
          承認者が不在です。下の「申請内容を変更して再承認を依頼する」から内容を変更して、再承認を依頼してください。
        </p>
      )}
      <div className="request-review-layout">
        <div className="request-review-body">
          <section className="request-review-panel" aria-labelledby="request-input-title">
            <h2 id="request-input-title">申請内容</h2>
            <dl className="request-summary-details">
              <dt>申請者</dt>
              <dd>{data.requesterName}</dd>
              <dt>指定された承認者</dt>
              <dd>{data.approverName}</dd>
              {s.inputs.durationDays !== undefined && (
                <>
                  <dt>利用日数</dt>
                  <dd>{s.inputs.durationDays}日</dd>
                </>
              )}
              {s.inputs.reason !== undefined && (
                <>
                  <dt>理由</dt>
                  <dd style={{ whiteSpace: 'pre-wrap' }}>{s.inputs.reason}</dd>
                </>
              )}
              <dt>承認の期限</dt>
              <dd>
                {formatDateTime(data.approval.expires_at)}
                {expired &&
                  ['pending', 'approved'].includes(q.state) &&
                  '（期限切れ。変更・再承認が必要です）'}
              </dd>
            </dl>
            <CatalogValueSummary
              fields={s.item.definition.fields ?? []}
              sections={s.item.definition.sections}
              values={s.inputs.values ?? {}}
            />
          </section>
          <RequestActions
            key={`actions-${q.version}`}
            request={data}
            canApprove={canApproveNow}
            canRevoke={canRevoke}
            canSimulate={canSimulate}
          />
        </div>
        <section
          className="request-review-panel request-review-progress"
          aria-labelledby="approval-timeline-title"
        >
          <div className="support-progress-heading">
            <h2 id="approval-timeline-title">承認の経過</h2>
            <span
              className="state"
              data-state={expired && q.state === 'pending' ? 'expired' : q.state}
            >
              {expired && q.state === 'pending' ? '承認期限切れ' : (labels[q.state] ?? q.state)}
            </span>
          </div>
          <p className="hint">ローカルの模擬申請です。実際の権限付与や外部変更は行いません。</p>
          {timeline.length > 0 ? (
            <ol className="attachments" aria-label="承認の経過">
              {timeline.map((step) => (
                <li
                  key={`step-${step.stepNo}`}
                  className="attachment"
                  aria-current={
                    !step.pendingCreation && step.state === 'pending' ? 'step' : undefined
                  }
                >
                  <p>
                    <strong>
                      段{step.stepNo}（{authorityLabel(step.authorityType)}）
                    </strong>
                    {' · '}
                    {step.pendingCreation ? '前の段の承認後に依頼' : stepStateLabel(step.state)}
                    {!step.pendingCreation && step.approverName && (
                      <>
                        {' · 承認者: '}
                        {step.approverName}
                        {step.delegated && step.decidedByName
                          ? `（代理: ${step.decidedByName}）`
                          : ''}
                      </>
                    )}
                  </p>
                  {step.pendingCreation && <p className="hint">前の段の承認後に依頼します。</p>}
                  {!step.pendingCreation && step.decidedAt && (
                    <p>決定日時: {formatDateTime(step.decidedAt)}</p>
                  )}
                  {!step.pendingCreation && step.reason && (
                    <p style={{ whiteSpace: 'pre-wrap' }}>理由: {step.reason}</p>
                  )}
                  {!step.pendingCreation && step.expiresAt && (
                    <p className="hint">期限: {formatDateTime(step.expiresAt)}</p>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <p className="hint">承認の経過はまだありません。</p>
          )}
          {reassignments.length > 0 && (
            <section aria-labelledby="reassignment-records-title">
              <h3 id="reassignment-records-title">再割当の記録</h3>
              <ol className="attachments" aria-label="再割当の記録">
                {reassignments.map((record) => (
                  <li key={`reassign-${record.routeGeneration}`} className="attachment">
                    <p>
                      <strong>段{record.invalidatedStepNo}の承認者を再割当</strong>
                      {' · '}
                      {formatDateTime(record.createdAt)}
                    </p>
                    <p>実行者: {record.createdByName ?? '確認できません'}</p>
                    <p style={{ whiteSpace: 'pre-wrap' }}>理由: {record.reason}</p>
                    <p>
                      無効になったステップ: 段{record.invalidatedStepNo}（
                      {record.invalidatedApproverName ?? '承認者を確認できません'}）
                    </p>
                    <p>新しい承認者: {record.newApproverName ?? '承認者を確認できません'}</p>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </section>
      </div>
      {data.fulfillment && (
        <CatalogChecklistForm
          requestId={q.id}
          requestRevision={q.revision}
          fulfillment={data.fulfillment}
        />
      )}
      {(own || staff) && (
        <p>
          <a href={`/${staff ? 'ops' : 'tickets'}/${q.ticketId}`}>関連する依頼チケットを開く</a>
        </p>
      )}
      {editable && (
        <details>
          <summary>申請内容を変更して再承認を依頼する</summary>
          <RequestForm
            scope={formScope(session)}
            key={q.version}
            item={item}
            approvers={data.approvers}
            request={data}
            {...(editRouteResult
              ? { route: editRouteResult.ok ? editRouteResult.data : null }
              : {})}
          />
        </details>
      )}
      {staff &&
        q.state === 'approved' &&
        !expired &&
        data.fulfillment?.checks.some((check) => check.required && !check.completed) && (
          <p role="status" className="notice">
            必須の作業チェックを完了すると、模擬結果を記録できます。
          </p>
        )}
      <h2>承認の記録</h2>
      <ul className="attachments">
        {versions.map((version) => (
          <li key={`revision-${version.revision}`} className="attachment">
            <p>
              申請内容 {version.revision} ·{' '}
              {approvalStateLabels[version.state] ?? '状態を確認できません'}
              {version.decidedAt && ` · ${formatDateTime(version.decidedAt)}`}
            </p>
            {version.current && version.rows.length === 1 && version.rows[0]!.reason && (
              <p style={{ whiteSpace: 'pre-wrap' }}>{version.rows[0]!.reason}</p>
            )}
            <details>
              <summary>この版の申請内容を見る</summary>
              {version.rows.length === 1 && (
                <p>
                  承認者: {version.rows[0]!.approverName}
                  {version.rows[0]!.delegated && version.rows[0]!.decidedByName
                    ? `（代理: ${version.rows[0]!.decidedByName}）`
                    : ''}
                  {version.rows[0]!.inputs.durationDays !== undefined &&
                    ` · 利用日数: ${version.rows[0]!.inputs.durationDays}日`}
                </p>
              )}
              {version.rows[0]!.inputs.reason !== undefined && (
                <p style={{ whiteSpace: 'pre-wrap' }}>{version.rows[0]!.inputs.reason}</p>
              )}
              <CatalogValueSummary
                fields={version.rows[0]!.item.definition.fields ?? []}
                sections={version.rows[0]!.item.definition.sections}
                values={version.rows[0]!.inputs.values ?? {}}
              />
            </details>
            {(!version.current || version.rows.some((row) => row.invalidatedByReassign)) && (
              <>
                <h3 className="visually-hidden">申請内容 {version.revision} の承認</h3>
                <ul>
                  {version.rows
                    // 現在の版の段ごとの経過は「承認の経過」が担う。ここでは
                    // 再割当で無効になったステップだけを残す(二重に並べない)。
                    .filter((row) => !version.current || row.invalidatedByReassign)
                    .map((row, index) => (
                      <li key={row.id}>
                        <p>
                          <strong>段{row.stepNo ?? index + 1}</strong>
                          {' · '}
                          {approvalStateLabels[row.state] ?? '状態を確認できません'}
                          {row.invalidatedByReassign && '（再割当により無効）'}
                          {row.decidedAt && ` · ${formatDateTime(row.decidedAt)}`}
                        </p>
                        <p>
                          承認者: {row.approverName}
                          {row.delegated && row.decidedByName
                            ? `（代理: ${row.decidedByName}）`
                            : ''}
                        </p>
                        {row.reason && <p style={{ whiteSpace: 'pre-wrap' }}>理由: {row.reason}</p>}
                      </li>
                    ))}
                </ul>
              </>
            )}
          </li>
        ))}
      </ul>
      {data.receipt && (
        <section className="form-panel">
          <h2>模擬実行の結果</h2>
          <p>{data.receipt.result.summary}</p>
          <dl>
            <dt>対象</dt>
            <dd>{data.receipt.result.targetLabel}</dd>
            <dt>外部変更</dt>
            <dd>{data.receipt.result.externalChanges}件</dd>
            <dt>完了日時</dt>
            <dd>{formatDateTime(data.receipt.finishedAt)}</dd>
            <dt>証跡 ID</dt>
            <dd style={{ overflowWrap: 'anywhere' }}>{data.receipt.id}</dd>
          </dl>
          <details>
            <summary>保存した証跡を確認する</summary>
            <p>
              申請内容のハッシュ:{' '}
              <code style={{ overflowWrap: 'anywhere' }}>{data.receipt.snapshotHash}</code>
            </p>
            <p>
              処理キー:{' '}
              <code style={{ overflowWrap: 'anywhere' }}>{data.receipt.idempotencyKey}</code>
            </p>
          </details>
        </section>
      )}
    </main>
  );
}
