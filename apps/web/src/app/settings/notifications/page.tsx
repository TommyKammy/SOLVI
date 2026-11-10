import { Suspense } from 'react';
import { api } from '../../../lib/api';
import { formScope } from '../../../lib/form-scope';
import { NotificationPreferenceForm } from '../../../components/NotificationPreferenceForm';
import { saveNotificationPreference } from './actions';

function Failure({
  status,
  organizationMissing = false,
}: {
  status: number;
  organizationMissing?: boolean;
}) {
  return (
    <section className="notice error-summary" role="alert">
      <h2>
        {status === 401
          ? 'ログイン状態を確認してください'
          : status === 403
            ? '通知設定を表示できません'
            : '通知設定を取得できませんでした'}
      </h2>
      <p>保存済みの設定を確認できないため、設定の変更はできません。</p>
      {status === 401 ? (
        <p>
          <a href="/login" target="_blank" rel="noopener">
            別のタブでログインする
          </a>
        </p>
      ) : status === 403 ? (
        <p>
          {organizationMissing
            ? '操作する組織を選んでください。'
            : '所属と操作中の組織を確認してください。'}{' '}
          <a href="/select-organization">組織を選ぶ</a>
        </p>
      ) : (
        <p>接続を確認し、時間をおいてもう一度お試しください。</p>
      )}
      <p>
        <a href="/settings/notifications">通知設定を再読み込み</a>
      </p>
    </section>
  );
}

async function Settings() {
  try {
    const session = await api.me();
    if (!session.ok)
      return (
        <Failure
          status={session.problem.status}
          organizationMissing={session.problem.type?.endsWith('/organization-not-selected')}
        />
      );
    const result = await api.notificationPreference();
    if (!result.ok) return <Failure status={result.problem.status} />;
    const scope = formScope(session.data);
    return (
      <NotificationPreferenceForm
        key={scope}
        initialEnabled={result.data.ticketEmailEnabled}
        action={saveNotificationPreference.bind(null, scope)}
      />
    );
  } catch {
    return <Failure status={503} />;
  }
}

export default function NotificationPreferencesPage() {
  return (
    <main className="shell notification-preferences">
      <header className="notification-preference-heading">
        <p className="eyebrow">自分の設定</p>
        <h1>メール通知の設定</h1>
        <p>操作中の組織で、自分が受け取る任意のチケット通知を設定します。</p>
      </header>
      <Suspense
        fallback={
          <p className="notice" role="status" aria-busy="true">
            保存済みの設定を読み込んでいます…
          </p>
        }
      >
        <Settings />
      </Suspense>
      <section
        className="notification-preference-notes"
        aria-labelledby="notification-preference-notes-title"
      >
        <h2 id="notification-preference-notes-title">この設定が適用される範囲</h2>
        <ul>
          <li>
            新しく作成される任意の通知に適用します。すでに開始された処理や再試行は取り消せません。
          </li>
          <li>役割の有効期限など、必須の通知は停止しません。</li>
          <li>受け取る設定に戻しても、停止中に処理を終えた通知は送られません。</li>
        </ul>
        <p className="hint">開発環境では送信処理の記録のみ。実際のメール配達は確認できません。</p>
      </section>
    </main>
  );
}
