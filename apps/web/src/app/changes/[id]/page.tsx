import { ContextLink } from '../../../components/ContextLink';
import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { api, requireSession } from '../../../lib/api';
import { formatDateTime } from '../../../lib/labels';
import { assetStateLabel } from '../../../lib/asset-labels';
import { changeStateLabel, changeNextStep, changeActionLabel } from '../../../lib/change-labels';
import { ChangeCommandForm } from '../../../components/ChangeForms';
import { safeReturnTo } from '../../../lib/navigation';
export default async function ChangePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireSession(),
    { id } = await params,
    r = await api.changeDetail(id),
    p = await searchParams;
  if (!r.ok) {
    if ([403, 404].includes(r.problem.status)) notFound();
    const returnTo = safeReturnTo(p.returnTo);
    const retryQuery = new URLSearchParams();
    if (returnTo) retryQuery.set('returnTo', returnTo);
    const validId =
      typeof id === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const retryHref = validId
      ? `/changes/${encodeURIComponent(id)}${retryQuery.size ? '?' + retryQuery.toString() : ''}`
      : '';
    const message =
      r.problem.status === 401
        ? 'ログイン状態を確認できませんでした。ログインし直してから、もう一度お試しください。'
        : r.problem.status === 400
          ? '変更を指定する情報が正しくありません。一覧から選び直してください。'
          : '一時的に変更を読み込めませんでした。時間をおいて、もう一度お試しください。';
    return (
      <main id="main" className="shell">
        <h1>変更を読み込めませんでした</h1>
        <p role="alert">{message}</p>
        {validId && (
          <p>
            <a href={retryHref}>再取得する</a>
          </p>
        )}
        <p>
          <a href={returnTo ?? '/changes'}>{returnTo ? '元の画面へ戻る' : '変更一覧へ戻る'}</a>
        </p>
        <p>
          <a href="/portal">ポータルへ戻る</a>
        </p>
      </main>
    );
  }
  const d = r.data,
    c = d.change,
    s = c.snapshot;
  const staff = user.roles.some(
    (a) =>
      (a.organizationId === user.organizationId || a.organizationId === null) &&
      ['agent', 'org_admin', 'platform_admin'].includes(a.roleCode),
  );
  return (
    <main id="main" className="shell">
      <ContextLink back href="/changes">
        変更一覧へ戻る
      </ContextLink>
      <h1>
        {c.number} · {c.title}
      </h1>
      {p.saved === '1' && <p role="status">変更と履歴を保存しました。</p>}
      <p>
        <strong>{changeStateLabel(c.state)}</strong> · 通常変更 · 計画版{c.revision} · 更新版
        {c.version}
      </p>
      <p>
        {d.pir
          ? '実施後レビューまで保存しました。計画・承認・結果の履歴を確認できます。'
          : d.availableActions.includes('reject')
            ? 'あなたが指名された承認者です。この版の計画・対象・予定を確認して、承認または理由付きの却下を記録してください。'
            : !d.canManage && ['approved', 'scheduled', 'in_progress'].includes(c.state)
              ? '実施担当者が次の操作を進めます。ここから承認対象と操作履歴を確認できます。'
              : changeNextStep(c.state)}
      </p>
      <p className="hint">
        ローカルの合成記録です。実環境への変更・外部変更は0件です。日時は日本時間（JST）で表示しています。
      </p>
      {!!d.readiness.issues.length &&
        !['completed', 'failed', 'cancelled', 'in_progress'].includes(c.state) && (
          <div role="alert">
            <h2>申請・予定・開始前に確認してください</h2>
            <ul>
              {d.readiness.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
            <p>計画を編集して現在の対象に更新し、再申請してください。</p>
          </div>
        )}
      <h2>承認対象の計画</h2>
      <dl className="detail">
        <dt>元のチケット</dt>
        <dd>
          {d.ticketCanOpen ? (
            <a href={`/${staff ? 'ops' : 'tickets'}/${s.ticket.id}`}>
              {s.ticket.number} · {s.ticket.subject}
            </a>
          ) : (
            <>
              {s.ticket.number} · {s.ticket.subject}
            </>
          )}
        </dd>
        <dt>実施担当者</dt>
        <dd>{s.owner.name}</dd>
        <dt>承認者</dt>
        <dd>{s.approver?.name ?? '未選択'}</dd>
        <dt>予定</dt>
        <dd>
          {s.plannedStart ? formatDateTime(s.plannedStart) : '未入力'} 〜{' '}
          {s.plannedEnd ? formatDateTime(s.plannedEnd) : '未入力'}
        </dd>
        <dt>リスク</dt>
        <dd>{{ low: '低', medium: '中', high: '高' }[s.risk]}</dd>
        {(
          [
            ['purpose', '目的'],
            ['impact', '影響'],
            ['implementationPlan', '実施計画'],
            ['testPlan', 'テスト計画'],
            ['backoutPlan', '切戻し計画'],
          ] as const
        ).map(([key, label]) => (
          <div key={key} style={{ display: 'contents' }}>
            <dt>{label}</dt>
            <dd style={{ whiteSpace: 'pre-wrap' }}>{s[key] || '未入力'}</dd>
          </div>
        ))}
      </dl>
      <h3>この版で固定した対象資産</h3>
      <ul className="attachments">
        {s.assets.map((a) => (
          <li className="attachment" key={a.id}>
            {d.assetAccess.some((access) => access.id === a.id && access.canOpen) ? (
              <ContextLink href={`/assets/${a.id}`}>
                {a.assetTag} · {a.name}
              </ContextLink>
            ) : (
              <>
                {a.assetTag} · {a.name}
              </>
            )}
            <p>
              {assetStateLabel(a.state)} · 資産版{a.version}
            </p>
          </li>
        ))}
      </ul>
      <p className="hint">
        計画・対象資産・日時を変更すると旧承認は使えなくなります。承認、予定確定、開始の時点でも現在の対象を確認します。
      </p>
      {d.availableActions.includes('edit') && (
        <p>
          <ContextLink href={`/changes/${id}/edit`}>
            計画・対象・予定を編集し、再承認の準備をする
          </ContextLink>
        </p>
      )}
      {!!d.availableActions.filter((a) => a !== 'edit').length && (
        <section aria-label="現在できる操作">
          <h2>次の操作</h2>
          {d.availableActions
            .filter((a) => a !== 'edit')
            .map((kind) => (
              <details key={kind} open={!['cancel', 'reject'].includes(kind)}>
                <summary>{changeActionLabel(kind)}</summary>
                <ChangeCommandForm detail={d} kind={kind} commandKey={randomUUID()} />
              </details>
            ))}
        </section>
      )}
      {c.state === 'scheduled' && !d.readiness.withinWindow && (
        <p role="status">
          予定期間になると開始を記録できます。現在の日時: {formatDateTime(d.readiness.now)}
          。期間を変える場合は再承認が必要です。
        </p>
      )}
      {d.result && (
        <section>
          <h2>保存した実施結果</h2>
          <p>
            {d.result.outcome === 'completed' ? '成功' : '失敗'} · 合成記録 · 外部変更0件 · 計画版
            {d.result.revision}
          </p>
          <p>
            {formatDateTime(d.result.startedAt)} 〜 {formatDateTime(d.result.finishedAt)} ·{' '}
            {d.result.actorName}
          </p>
          <h3>実施結果</h3>
          <p style={{ whiteSpace: 'pre-wrap' }}>{d.result.summary}</p>
          <h3>テスト結果</h3>
          <p style={{ whiteSpace: 'pre-wrap' }}>{d.result.testResults}</p>
          <h3>切戻し {d.result.backoutPerformed ? 'あり' : 'なし'}</h3>
          <p style={{ whiteSpace: 'pre-wrap' }}>{d.result.backoutReason}</p>
        </section>
      )}
      {d.pir && (
        <section>
          <h2>実施後レビュー（PIR）</h2>
          <p>
            {formatDateTime(d.pir.createdAt)} · {d.pir.actorName}
          </p>
          {(
            [
              ['rootCause', '原因・振り返り'],
              ['lessons', '教訓'],
              ['prevention', '再発防止'],
            ] as const
          ).map(([key, label]) => (
            <div key={key}>
              <h3>{label}</h3>
              <p style={{ whiteSpace: 'pre-wrap' }}>{d.pir![key]}</p>
            </div>
          ))}
        </section>
      )}
      <h2>承認の履歴</h2>
      {!d.approvals.length ? (
        <p>まだ申請されていません。</p>
      ) : (
        <ul className="attachments">
          {d.approvals.map((a) => (
            <li key={a.id} className="attachment">
              <p>
                計画版{a.revision} · {a.approverName} ·{' '}
                {a.isCurrent ? '現在の承認対象' : '旧版の履歴'}
              </p>
              <p>
                {a.decision === 'approved'
                  ? '承認'
                  : a.decision === 'rejected'
                    ? '却下'
                    : '判断待ち'}{' '}
                · 有効期限 {formatDateTime(a.expiresAt)}
              </p>
              {a.reason && <p style={{ whiteSpace: 'pre-wrap' }}>{a.reason}</p>}
              {a.decidedAt && <p>{formatDateTime(a.decidedAt)}</p>}
            </li>
          ))}
        </ul>
      )}
      <h2>操作の履歴</h2>
      <ul className="attachments">
        {d.history.map((e) => (
          <li key={e.version} className="attachment">
            <p>
              更新版{e.version} · 計画版{e.revision} · {changeActionLabel(e.action)}
            </p>
            <p>
              {e.beforeState ? `${changeStateLabel(e.beforeState)} → ` : ''}
              {changeStateLabel(e.afterState)} · {formatDateTime(e.createdAt)} · {e.actorName}
            </p>
            <p style={{ whiteSpace: 'pre-wrap' }}>{e.reason || '記録を保存'}</p>
          </li>
        ))}
      </ul>
      <details>
        <summary>計画の版履歴</summary>
        {d.revisions.map((v) => (
          <section key={v.revision}>
            <h3>
              計画版{v.revision} · {v.snapshot.title}
            </h3>
            <p>
              {formatDateTime(v.createdAt)} · {v.actorName} · {v.reason}
            </p>
            <p>
              チケット: {v.snapshot.ticket.number} · 担当者: {v.snapshot.owner.name} · 承認者:{' '}
              {v.snapshot.approver?.name ?? '未選択'}
            </p>
            <p>
              予定: {v.snapshot.plannedStart ? formatDateTime(v.snapshot.plannedStart) : '未入力'}{' '}
              〜 {v.snapshot.plannedEnd ? formatDateTime(v.snapshot.plannedEnd) : '未入力'}
            </p>
            <ul>
              {v.snapshot.assets.map((a) => (
                <li key={a.id}>
                  {a.assetTag} · {a.name} · 資産版{a.version}
                </li>
              ))}
            </ul>
            {(
              [
                ['purpose', '目的'],
                ['impact', '影響'],
                ['implementationPlan', '実施計画'],
                ['testPlan', 'テスト計画'],
                ['backoutPlan', '切戻し計画'],
              ] as const
            ).map(([key, label]) => (
              <p key={key} style={{ whiteSpace: 'pre-wrap' }}>
                {label}: {v.snapshot[key] || '未入力'}
              </p>
            ))}
          </section>
        ))}
      </details>
    </main>
  );
}
