import { ContextLink } from '../../../components/ContextLink';
import { notFound } from 'next/navigation';
import { api, requireSession, type CatalogItem } from '../../../lib/api';
import { formatDateTime } from '../../../lib/labels';
import { CatalogValueSummary } from '../../../components/CatalogValueSummary';
import { CatalogChecklistForm } from '../../../components/CatalogChecklistForm';
import { formScope } from '../../../lib/form-scope';
import { RequestForm, RequestActions } from '../../../components/RequestForms';
import { safeReturnTo } from '../../../lib/navigation';
const labels: Record<string, string> = {
  pending: '承認待ち',
  approved: '承認済み・模擬実行待ち',
  rejected: '却下',
  invalidated: '無効・再承認が必要',
  completed: '模擬実行完了',
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
  const assigned =
      data.approval.approver_id === session.userId &&
      !own &&
      session.roles.some((r) => r.roleCode === 'approver'),
    expired = new Date(data.approval.expires_at).getTime() <= Date.now();
  const item: CatalogItem = { ...s.item, description: '', definition: s.item.definition };
  const { saved } = await searchParams;
  return (
    <main id="main" className="shell">
      <ContextLink back href="/requests">
        申請一覧へ戻る
      </ContextLink>
      <h1>{s.item.title}</h1>
      <p className="notice">ローカル模擬実行の検証用。実際の権限付与・外部変更は行いません。</p>
      {saved === '1' && (
        <p role="status" className="success">
          申請の状態を保存しました。
        </p>
      )}
      <h2>{labels[q.state] ?? q.state}</h2>
      <dl>
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
      <p>
        カタログ定義版: {s.item.version} · 申請内容版: {q.revision}
      </p>
      <CatalogValueSummary
        fields={s.item.definition.fields ?? []}
        sections={s.item.definition.sections}
        values={s.inputs.values ?? {}}
      />
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
      {own && q.state !== 'completed' && q.state !== 'cancelled' && (
        <details>
          <summary>申請内容を変更して再承認を依頼する</summary>
          <RequestForm
            scope={formScope(session)}
            key={q.version}
            item={item}
            approvers={data.approvers}
            request={data}
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
      <RequestActions
        key={`actions-${q.version}`}
        request={data}
        canApprove={assigned && q.state === 'pending' && !expired}
        canRevoke={!own && (assigned || admin) && q.state === 'approved'}
        canSimulate={
          staff &&
          q.state === 'approved' &&
          !expired &&
          !data.fulfillment?.checks.some((check) => check.required && !check.completed)
        }
      />
      <h2>承認の記録</h2>
      <ul className="attachments">
        {data.history.map((a) => (
          <li key={a.id} className="attachment">
            <p>
              申請内容 {a.revision} ·{' '}
              {a.state === 'approved' ? '承認済み' : (labels[a.state] ?? a.state)}
              {a.decidedAt && ` · ${formatDateTime(a.decidedAt)}`}
            </p>
            {a.reason && <p style={{ whiteSpace: 'pre-wrap' }}>{a.reason}</p>}
            <details>
              <summary>この版の申請内容を見る</summary>
              <p>
                承認者: {a.approverName}
                {a.inputs.durationDays !== undefined && ` · 利用日数: ${a.inputs.durationDays}日`}
              </p>
              {a.inputs.reason !== undefined && (
                <p style={{ whiteSpace: 'pre-wrap' }}>{a.inputs.reason}</p>
              )}
              <CatalogValueSummary
                fields={a.item.definition.fields ?? []}
                sections={a.item.definition.sections}
                values={a.inputs.values ?? {}}
              />
            </details>
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
