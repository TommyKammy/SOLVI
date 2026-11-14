'use client';
import { useActionState, useEffect, useState } from 'react';
import { FeedbackForm, FormField } from './FeedbackForm';
import { FormDraftRecovery } from './FormDraftRecovery';
import { draftKey, type DraftValues } from '../lib/form-draft';
import { ContextLink } from './ContextLink';
import { saveServiceRequest, processServiceRequest } from '../app/requests/actions';
import type { CatalogItem, RequestApprovalRoute, ServiceRequestDetail } from '../lib/api';
import { CatalogFieldInputs } from './CatalogFieldInputs';
import { catalogRequestFieldVisibility, type CatalogValues } from '@solvi/shared/catalog';
import { catalogDraftValues, restoreCatalogDraftValues } from '../lib/catalog-form';
import type { FormFeedback } from '../lib/form-state';
import { authorityLabel, requestRouteDecision } from '../lib/approval-route';
export function RequestForm({
  item,
  approvers,
  request,
  scope,
  route,
}: {
  item: CatalogItem;
  scope: string;
  approvers: Array<{ id: string; name: string }>;
  request?: ServiceRequestDetail;
  /** 申請者自身の経路 (WP-P4-APR-016 §6.1)。ルール項目だけ渡す。 */
  route?: RequestApprovalRoute | null;
}) {
  const [feedback, action, pending] = useActionState(
    saveServiceRequest.bind(null, request?.request.id ?? null),
    { message: '' } as FormFeedback,
  );
  const [key, setKey] = useState('');
  useEffect(() => setKey(crypto.randomUUID()), []);
  const ruleId = item.definition.approval?.ruleId ?? null;
  const routeDecision = requestRouteDecision({
    ruleId,
    itemVersion: item.version,
    route: route ?? null,
  });
  const usingRule = routeDecision.usesRule;
  const fixedApprover = usingRule ? undefined : item.definition.approval?.approverId;
  const [approverId, setApproverId] = useState(request?.approval.approver_id ?? '');
  const available = usingRule
    ? !routeDecision.blocked
    : fixedApprover
      ? approvers.some((a) => a.id === fixedApprover)
      : approvers.length > 0;
  const routeVersionMismatch = Boolean(
    usingRule &&
    route &&
    route.ruleRoutingEnabled &&
    (route.itemVersion !== item.version || route.mode !== 'rule' || route.rule?.id !== ruleId),
  );
  const [customValues, setCustomValues] = useState<CatalogValues>(
    request?.request.snapshot.inputs.values ?? {},
  );
  const visibleRequestFields = catalogRequestFieldVisibility(item.definition);
  const [reason, setReason] = useState(request?.request.snapshot.inputs.reason ?? '');
  const [days, setDays] = useState(
    String(request?.request.snapshot.inputs.durationDays ?? item.definition.allowedDurations[0]),
  );
  const fields = (item.definition.fields ?? []).filter((f) => f.type !== 'checkbox');
  const baseline: DraftValues = {
    ...(visibleRequestFields.reason
      ? { reason: request?.request.snapshot.inputs.reason ?? '' }
      : {}),
    ...(visibleRequestFields.duration
      ? {
          durationDays: String(
            request?.request.snapshot.inputs.durationDays ?? item.definition.allowedDurations[0],
          ),
        }
      : {}),
    ...catalogDraftValues(fields, request?.request.snapshot.inputs.values ?? {}),
  };
  const values: DraftValues = {
    ...(visibleRequestFields.reason ? { reason } : {}),
    ...(visibleRequestFields.duration ? { durationDays: days } : {}),
    ...catalogDraftValues(fields, customValues),
  };
  const formKey = request ? `request:edit:${request.request.id}` : `request:new:${item.id}`;
  const restore = (v: DraftValues) => {
    if (!fixedApprover) setApproverId('');
    if (visibleRequestFields.reason && v.reason !== undefined)
      setReason(v.reason.slice(0, item.definition.maxReasonLength));
    if (
      visibleRequestFields.duration &&
      item.definition.allowedDurations.includes(Number(v.durationDays))
    )
      setDays(v.durationDays);
    setCustomValues(restoreCatalogDraftValues(item.definition.fields ?? [], v));
  };
  return (
    <FeedbackForm
      feedback={feedback}
      pending={pending}
      className="stack form-panel"
      action={action}
      onSuccess={() => {
        try {
          sessionStorage.removeItem(draftKey(scope, formKey));
        } catch {
          /* disabled */
        }
      }}
    >
      <FormDraftRecovery
        scope={scope}
        formKey={formKey}
        version={`${request?.request.version ?? 'new'}:${item.version}`}
        baseline={baseline}
        values={values}
        labels={{
          ...(visibleRequestFields.reason ? { reason: '利用する理由' } : {}),
          ...(visibleRequestFields.duration ? { durationDays: '利用日数' } : {}),
          ...Object.fromEntries(fields.map((f) => ['value:' + f.key, f.label])),
        }}
        onRestore={restore}
      />
      <input type="hidden" name="itemId" value={item.id} />
      <input type="hidden" name="itemVersion" value={item.version} />
      <input type="hidden" name="idempotencyKey" value={key} />
      <input type="hidden" name="expectedVersion" value={request?.request.version ?? 1} />
      {visibleRequestFields.reason && (
        <FormField className="field">
          <label htmlFor="request-reason">利用する理由</label>
          <textarea
            id="request-reason"
            name="reason"
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={item.definition.maxReasonLength}
          />
        </FormField>
      )}
      {visibleRequestFields.duration && (
        <FormField className="field">
          <label htmlFor="request-days">希望する利用日数</label>
          <select
            id="request-days"
            name="durationDays"
            value={days}
            onChange={(e) => setDays(e.target.value)}
          >
            {item.definition.allowedDurations.map((d) => (
              <option key={d} value={d}>
                {d}日
              </option>
            ))}
          </select>
        </FormField>
      )}
      <CatalogFieldInputs
        fields={item.definition.fields ?? []}
        sections={item.definition.sections}
        values={customValues}
        onChange={setCustomValues}
        disabled={pending}
        idPrefix="request-field"
      />
      {usingRule ? (
        <section className="field" aria-labelledby="request-approval-route-title">
          <h2 id="request-approval-route-title">承認の経路</h2>
          {routeDecision.showSteps && route ? (
            <ol>
              {route.steps.map((step) => (
                <li key={step.stepNo}>
                  <strong>
                    段{step.stepNo}（{authorityLabel(step.authorityType)}）
                  </strong>
                  : {step.approverName}
                </li>
              ))}
            </ol>
          ) : routeDecision.blocked ? (
            <div id="request-route-blocked" role="alert">
              <p>{routeDecision.reason}</p>
              <p>組織の管理者へ設定を依頼してください。</p>
            </div>
          ) : (
            <p className="hint" id="request-route-note">
              {routeVersionMismatch
                ? 'この申請の定義版と現在公開中の版が異なるため、経路の表示は省略します。'
                : '変更後の新しい版で、その時点の組織データから経路を解決し直します。'}
            </p>
          )}
          <p className="hint">
            表示は参考です。送信時にAPIが改めて経路を解決し、承認者を確認します。承認期限は各段72時間です。
          </p>
        </section>
      ) : fixedApprover ? (
        <FormField className="field">
          <p>
            <strong>設定された承認者</strong>:{' '}
            {approvers.find((a) => a.id === fixedApprover)?.name ??
              '現在依頼できる承認者がいません'}
          </p>
          <input type="hidden" name="approverId" value={fixedApprover} />
          <p className="hint">この公開版で指定された承認者へ依頼します。承認期限は72時間です。</p>
        </FormField>
      ) : (
        <FormField className="field">
          <label htmlFor="request-approver">承認を依頼する相手</label>
          <select
            id="request-approver"
            name="approverId"
            required
            value={approverId}
            onChange={(e) => setApproverId(e.target.value)}
          >
            <option value="">承認者を選んでください</option>
            {approvers.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <p className="hint">
            同じ組織の有効な承認者だけが表示されます。自分は選べません。承認期限は72時間です。
          </p>
        </FormField>
      )}
      {request && usingRule && (
        <p className="notice">
          変更すると以前の承認が無効になり、新しい版でその時点の経路を解決し直します。
        </p>
      )}
      {request && !usingRule && (
        <p className="notice">
          変更すると以前の承認が無効になります。新しい内容で再承認を依頼します。
        </p>
      )}
      {!usingRule && !available && (
        <p role="alert">現在選べる承認者がいません。管理者へご連絡ください。</p>
      )}
      <div className="form-actions">
        <button
          disabled={pending || !key || !available || routeDecision.blocked}
          aria-describedby={routeDecision.blocked ? 'request-route-blocked' : undefined}
        >
          {pending ? '保存しています…' : request ? '変更して再承認を依頼する' : '申請する（模擬）'}
        </button>
        <ContextLink back href={request ? `/requests/${request.request.id}` : '/catalog'}>
          キャンセルして戻る
        </ContextLink>
      </div>
    </FeedbackForm>
  );
}
export function RequestActions({
  request,
  canApprove,
  canRevoke,
  canSimulate,
}: {
  request: ServiceRequestDetail;
  canApprove: boolean;
  canRevoke: boolean;
  canSimulate: boolean;
}) {
  const [feedback, action, pending] = useActionState(
    processServiceRequest.bind(null, request.request.id),
    { message: '' } as FormFeedback,
  );
  const [reason, setReason] = useState('');
  if (!canApprove && !canRevoke && !canSimulate) return null;
  return (
    <FeedbackForm
      feedback={feedback}
      pending={pending}
      className="stack form-panel"
      action={action}
    >
      <input type="hidden" name="expectedVersion" value={request.request.version} />

      {(canApprove || canRevoke) && (
        <FormField className="field">
          <label htmlFor="decision-reason">判断の理由</label>
          <textarea
            id="decision-reason"
            name="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={2000}
          />
          <p className="hint">却下・承認取消には理由が必要です。</p>
        </FormField>
      )}
      <div className="actions-row">
        {canApprove && (
          <>
            <button name="decision" value="approve" disabled={pending}>
              承認する
            </button>
            <button name="decision" value="reject" className="secondary" disabled={pending}>
              理由を添えて却下する
            </button>
          </>
        )}
        {canRevoke && (
          <button name="decision" value="revoke" className="secondary" disabled={pending}>
            承認を取り消す
          </button>
        )}
        {canSimulate && (
          <button name="operation" value="simulate" disabled={pending}>
            ローカルで模擬実行する
          </button>
        )}
      </div>
      {canSimulate && (
        <p className="hint">
          承認を再確認し結果の証跡を保存します。外部変更は0件です。再送でも同じ結果を返します。
        </p>
      )}
    </FeedbackForm>
  );
}
