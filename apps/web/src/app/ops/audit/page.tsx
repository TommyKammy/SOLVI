import React from 'react';
import Link from 'next/link';
import { AdminDenied } from '../../../components/AdminWorkspace';
import { api, requireSession } from '../../../lib/api';
import { formatDateTime } from '../../../lib/labels';
import { navigationRoles } from '../../../lib/navigation';
import {
  auditCategories,
  auditHref,
  auditParams,
  type AuditEventSummary,
} from '../../../lib/ops-insights';
import { DIRECTORY_ROLE_LABELS } from '../../../lib/user-directory';

export const dynamic = 'force-dynamic';

const labels: Record<string, string> = {
  'approval.requested': '承認依頼',
  'approval.approved': '申請を承認',
  'approval.rejected': '申請を却下',
  'approval.invalidated': '承認を無効化',
  'approval.cancelled': '承認依頼を取り消し',
  'approval.expired': '承認期限切れ',
  'approval.reassigned': '承認者の再割当',
  'approval.delegated': '代理承認の委任',
  'approval.delegation_revoked': '代理承認の委任を終了',
  'request.approved': '申請を承認（旧方式）',
  'request.rejected': '申請を却下（旧方式）',
  'request.revoked': '承認取消（旧方式）',
  'change.approved': '変更計画を承認',
  'change.rejected': '変更計画を却下',
  'role.binding.created': '役割を付与',
  'role.binding.deleted': '役割を取り消し',
  'access.review.opened': 'アクセスレビューを開始',
  'access.review.item.decided': 'アクセスレビューの判断を記録',
  'access.review.completed': 'アクセスレビューを完了',
};

function EventDetail({ item, params }: { item: AuditEventSummary; params: URLSearchParams }) {
  return (
    <section className="insights-panel" aria-labelledby="audit-detail-title">
      <h2 id="audit-detail-title">{labels[item.type] ?? item.type}</h2>
      <dl className="audit-fields">
        <dt>イベント</dt>
        <dd>
          <code>{item.type}</code>
        </dd>
        <dt>記録日時（JST）</dt>
        <dd>{formatDateTime(item.occurredAt)}</dd>
        <dt>記録ID</dt>
        <dd>
          <code>{item.id}</code>
        </dd>
        <dt>操作者</dt>
        <dd>
          {item.actorId ? (
            <code>{item.actorId}</code>
          ) : item.actorType === 'system' ? (
            'システム'
          ) : (
            '記録なし'
          )}
        </dd>
        {item.subjectId && (
          <>
            <dt>対象利用者</dt>
            <dd>
              <code>{item.subjectId}</code>
            </dd>
          </>
        )}
        {item.targetId && (
          <>
            <dt>対象</dt>
            <dd>
              <code>{item.targetId}</code>
            </dd>
          </>
        )}
        {item.step !== null && (
          <>
            <dt>承認の段</dt>
            <dd>段{item.step}</dd>
          </>
        )}
        {item.roleBefore && (
          <>
            <dt>変更前の役割</dt>
            <dd>{DIRECTORY_ROLE_LABELS[item.roleBefore] ?? item.roleBefore}</dd>
          </>
        )}
        {item.roleAfter && (
          <>
            <dt>付与した役割</dt>
            <dd>{DIRECTORY_ROLE_LABELS[item.roleAfter] ?? item.roleAfter}</dd>
          </>
        )}
      </dl>
      {item.targetId && (
        <Link
          className="support-action"
          prefetch={false}
          href={auditHref(params, { target: item.targetId, event: null, page: null })}
        >
          この対象の履歴に絞る
        </Link>
      )}
    </section>
  );
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const role = navigationRoles(session);
  if (!role.auditLog) return <AdminDenied title="監査ログ" canOpenHome={role.admin} />;

  const params = auditParams(await searchParams);
  const event = params.get('event');
  const target = params.get('target');
  const page = Number(params.get('page') ?? '1');
  const result = await api.auditEvents(params);

  return (
    <main id="main" className="shell insights-workspace">
      <header className="support-page-heading">
        <div>
          {event && (
            <Link
              className="support-back"
              prefetch={false}
              href={auditHref(params, { event: null })}
            >
              監査ログ一覧へ戻る
            </Link>
          )}
          <h1>監査ログ</h1>
          <p className="lead">選択中の組織の承認、権限変更、アクセスレビューを確認します。</p>
        </div>
        {role.auditor && (
          <Link href="/ops/approvals/changes" className="support-action">
            上長・部署長の変更履歴
          </Link>
        )}
      </header>
      <form
        key={params.toString()}
        method="get"
        className="insights-filters"
        aria-label="監査ログの絞り込み"
      >
        <div className="field">
          <label htmlFor="audit-from">開始日（UTC）</label>
          <input
            id="audit-from"
            type="date"
            name="from"
            defaultValue={params.get('from') ?? ''}
            aria-describedby="audit-period-help"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="audit-to">終了日（UTC）</label>
          <input
            id="audit-to"
            type="date"
            name="to"
            defaultValue={params.get('to') ?? ''}
            aria-describedby="audit-period-help"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="audit-category">種別</label>
          <select
            id="audit-category"
            name="category"
            defaultValue={params.get('category') ?? 'all'}
          >
            {Object.entries(auditCategories).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {target && <input type="hidden" name="target" value={target} />}
        <div className="form-actions">
          <button type="submit">絞り込む</button>
          <Link href="/ops/audit" prefetch={false}>
            条件を解除する
          </Link>
        </div>
        <p id="audit-period-help" className="hint insights-filter-hint">
          期間は31日以内で指定できます。
        </p>
      </form>
      {target && (
        <p className="hint">
          同じ対象の履歴を表示中 · <code>{target}</code>{' '}
          <Link
            href={auditHref(params, { target: null, event: null, page: null })}
            prefetch={false}
          >
            対象の絞り込みを解除する
          </Link>
        </p>
      )}
      {!result.ok ? (
        <section className="insights-panel" role="alert">
          <h2>
            {result.problem.status === 400
              ? '絞り込み条件を確認してください'
              : '監査ログを取得できませんでした'}
          </h2>
          <p>
            {result.problem.status === 400
              ? '開始日・終了日や種別を確認し、設定し直してください。'
              : '時間をおいて、同じ条件で再読み込みしてください。'}
          </p>
          {result.problem.status !== 400 && <a href={auditHref(params, {})}>再読み込みする</a>}
        </section>
      ) : event && result.data.items[0] ? (
        <EventDetail item={result.data.items[0]} params={params} />
      ) : (
        <section className="insights-panel" aria-labelledby="audit-results">
          <h2 id="audit-results">監査イベント</h2>
          <p role="status">このページに{result.data.items.length}件を表示</p>
          {result.data.items.length ? (
            <ul className="insights-list" role="list">
              {result.data.items.map((item) => (
                <li key={item.id}>
                  <div>
                    <Link href={auditHref(params, { event: item.id })} prefetch={false}>
                      {labels[item.type] ?? item.type}
                    </Link>
                    <p className="hint">{item.targetId && <code>{item.targetId}</code>}</p>
                  </div>
                  <time dateTime={item.occurredAt}>{formatDateTime(item.occurredAt)}</time>
                </li>
              ))}
            </ul>
          ) : (
            <p>
              {event
                ? 'この条件で記録を表示できません。'
                : 'この条件に一致する監査イベントはありません。'}
            </p>
          )}
          {!event && (page > 1 || result.data.hasMore) && (
            <nav className="form-actions" aria-label="監査イベントのページ">
              {page > 1 && (
                <Link href={auditHref(params, { page: String(page - 1) })} prefetch={false}>
                  前のページ
                </Link>
              )}
              <span>{page}ページ</span>
              {result.data.hasMore && (
                <Link href={auditHref(params, { page: String(page + 1) })} prefetch={false}>
                  次のページ
                </Link>
              )}
            </nav>
          )}
        </section>
      )}
    </main>
  );
}
