'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Actor, Detail, Ticket } from '../lib/glpi/client';
const statusLabel: Record<number, string> = {
  1: '新規',
  2: '対応中（割当済み）',
  3: '対応中（計画済み）',
  4: '保留',
  5: '解決済み',
  6: '終了',
};
type Listing = { actor: Actor; tickets: Ticket[]; more: boolean };
export function GLPIPortal() {
  const [actor, setActor] = useState<Actor | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [view, setView] = useState<'list' | 'new' | 'detail'>('list');
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [reply, setReply] = useState('');
  const [internal, setInternal] = useState(false);
  const locked = useRef(false);
  const scope = useRef('');
  function clear() {
    scope.current = '';
    setActor(null);
    setListing(null);
    setDetail(null);
    setTitle('');
    setContent('');
    setReply('');
    setInternal(false);
    setView('list');
    setNotice('');
  }
  async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const result = await fetch(`/api/glpi/${path}`, {
      method,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...(scope.current ? { 'X-SOLVI-GLPI-Actor': scope.current } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await result.json();
    if (!result.ok) {
      if ([401, 403, 409].includes(result.status)) clear();
      throw new Error(
        data.error || '接続できませんでした。入力を保ったまま、もう一度お試しください。',
      );
    }
    return data as T;
  }
  async function load(target = 0) {
    const result = await api<Listing>(`tickets?page=${target}`);
    const nextScope = `${result.actor.id}:${result.actor.entityId}:${result.actor.role}`;
    if (scope.current && scope.current !== nextScope) clear();
    scope.current = nextScope;
    setActor(result.actor);
    setListing(result);
    setPage(target);
  }
  async function run(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '接続できませんでした。');
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    void run(() => load());
  }, []); // Initial authentication check; no stored draft or credentials.
  async function open(id: number) {
    await run(async () => {
      const result = await api<Detail>(`tickets/${id}`);
      setDetail(result);
      setReply('');
      setInternal(false);
      setView('detail');
    });
  }
  const submit = (event: FormEvent, action: () => Promise<void>) => {
    event.preventDefault();
    void run(action);
  };
  return (
    <>
      <header className="page-heading">
        <h1>{actor?.role === 'agent' ? 'サポート対応' : '社内サポート'}</h1>
        <p className="lead">
          {actor ? '依頼とやりとりを、一か所で。' : 'GLPI の個人アカウントでログインしてください。'}
        </p>
        {actor && (
          <p>
            組織 {actor.entityId} · 利用者 {actor.id} ·{' '}
            {actor.role === 'agent' ? '担当者' : '申請者'}
          </p>
        )}
      </header>
      {error && (
        <div className="error-summary" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <p className="muted" role="status" aria-live="polite">
        {busy ? '確認しています…' : ''}
      </p>
      {!actor ? (
        <form
          className="stack"
          onSubmit={(event) => {
            const form = event.currentTarget;
            const values = new FormData(form);
            const username = String(values.get('username') ?? '');
            const password = String(values.get('password') ?? '');
            form.reset();
            submit(event, async () => {
              await api('session', 'POST', { username, password });
              await load();
            });
          }}
        >
          <div className="field">
            <label htmlFor="glpi-login">ユーザー名</label>
            <input
              id="glpi-login"
              name="username"
              autoComplete="username"
              required
              maxLength={200}
              disabled={busy}
            />
          </div>
          <div className="field">
            <label htmlFor="glpi-password">パスワード</label>
            <input
              id="glpi-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={1000}
              disabled={busy}
            />
          </div>
          <button disabled={busy}>ログインする</button>
        </form>
      ) : (
        <>
          <nav className="form-actions" aria-label="サポートメニュー">
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await load(page);
                  setView('list');
                  setDetail(null);
                  setReply('');
                  setInternal(false);
                })
              }
            >
              一覧を更新する
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setView('new');
                setError('');
                setNotice('');
              }}
            >
              依頼を送る
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api('session', 'DELETE');
                  clear();
                })
              }
            >
              ログアウトする
            </button>
          </nav>
          {view === 'list' && (
            <section aria-labelledby="glpi-list-heading">
              <h2 id="glpi-list-heading">
                {actor.role === 'agent' ? '対応できる依頼' : 'あなたの依頼'}
              </h2>
              {listing?.tickets.length === 0 && (
                <p>このページに表示できる依頼はありません。「依頼を送る」から相談できます。</p>
              )}
              <ul style={{ listStyle: 'none', padding: 0 }}>
                {listing?.tickets.map((ticket) => (
                  <li
                    key={ticket.id}
                    style={{ borderBottom: '1px solid var(--border)', padding: '1rem 0' }}
                  >
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => void open(ticket.id)}
                      style={{ textAlign: 'left', maxWidth: '100%', overflowWrap: 'anywhere' }}
                    >
                      #{ticket.id} {ticket.title}
                    </button>
                    <p className="muted">{statusLabel[ticket.status]}</p>
                  </li>
                ))}
              </ul>
              <div className="form-actions">
                <button
                  className="secondary"
                  disabled={busy || page === 0}
                  onClick={() => void run(() => load(page - 1))}
                >
                  前のページ
                </button>
                <span>{page + 1} ページ</span>
                <button
                  className="secondary"
                  disabled={busy || !listing?.more}
                  onClick={() => void run(() => load(page + 1))}
                >
                  次のページ
                </button>
              </div>
            </section>
          )}
          {view === 'new' && (
            <section aria-labelledby="glpi-new-heading">
              <h2 id="glpi-new-heading">新しい依頼</h2>
              <form
                className="stack"
                onSubmit={(event) =>
                  submit(event, async () => {
                    const saved = await api<{ id: number }>('tickets', 'POST', { title, content });
                    setTitle('');
                    setContent('');
                    setDetail(await api<Detail>(`tickets/${saved.id}`));
                    setReply('');
                    setInternal(false);
                    setView('detail');
                    setNotice(`依頼 #${saved.id} を保存しました。`);
                  })
                }
              >
                <div className="field">
                  <label htmlFor="glpi-title">件名</label>
                  <input
                    id="glpi-title"
                    required
                    maxLength={200}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    disabled={busy}
                  />
                </div>
                <div className="field">
                  <label htmlFor="glpi-content">相談したいこと</label>
                  <textarea
                    id="glpi-content"
                    required
                    maxLength={10000}
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    disabled={busy}
                  />
                </div>
                <p className="hint">添付ファイルは、この画面ではまだ利用できません。</p>
                <button disabled={busy}>依頼を送信する</button>
              </form>
            </section>
          )}
          {view === 'detail' && detail && (
            <section aria-labelledby="glpi-detail-heading">
              <h2 id="glpi-detail-heading" style={{ overflowWrap: 'anywhere' }}>
                #{detail.id} {detail.title}
              </h2>
              <p>{statusLabel[detail.status]}</p>
              <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxWidth: '70ch' }}>
                {detail.content}
              </p>
              {actor.role === 'agent' && detail.status < 5 && (
                <div className="form-actions">
                  {(['claim', 'pending', 'resume'] as const).map((action) => (
                    <button
                      className="secondary"
                      key={action}
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await api(`tickets/${detail.id}/process`, 'POST', { action });
                          setDetail(await api<Detail>(`tickets/${detail.id}`));
                          setNotice('対応状況を保存しました。');
                        })
                      }
                    >
                      {action === 'claim'
                        ? '自分が引き受ける'
                        : action === 'pending'
                          ? '保留にする'
                          : '対応を再開する'}
                    </button>
                  ))}
                </div>
              )}
              <h3>やりとり</h3>
              {detail.moreFollowups && (
                <p className="notice">
                  最新の100件までを確認しています。古い会話は GLPI 標準画面で確認してください。
                </p>
              )}
              {!detail.followups.length && <p className="muted">まだ返信はありません。</p>}
              <ol style={{ listStyle: 'none', padding: 0 }}>
                {detail.followups.map((item) => (
                  <li
                    key={item.id}
                    style={{ borderBottom: '1px solid var(--border)', padding: '1rem 0' }}
                  >
                    <strong>
                      {item.private ? '内部メモ（担当者のみ）' : '公開返信'} ·{' '}
                      {item.authorId === actor.id ? 'あなた' : `利用者 ${item.authorId}`}
                    </strong>
                    <p
                      style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxWidth: '70ch' }}
                    >
                      {item.content}
                    </p>
                  </li>
                ))}
              </ol>
              <form
                className="stack"
                onSubmit={(event) =>
                  submit(event, async () => {
                    await api(`tickets/${detail.id}/reply`, 'POST', {
                      content: reply,
                      private: internal,
                    });
                    setReply('');
                    setDetail(await api<Detail>(`tickets/${detail.id}`));
                    setNotice('返信を保存しました。');
                  })
                }
              >
                {actor.role === 'agent' && (
                  <div className="field">
                    <label htmlFor="glpi-visibility">返信の公開範囲</label>
                    <select
                      id="glpi-visibility"
                      disabled={busy}
                      value={internal ? 'private' : 'public'}
                      onChange={(e) => {
                        setInternal(e.target.value === 'private');
                        setReply('');
                      }}
                    >
                      <option value="public">申請者に公開する</option>
                      <option value="private">担当者の内部メモ</option>
                    </select>
                    <span className="hint">公開範囲を変えると未送信の本文を消去します。</span>
                  </div>
                )}
                <div className="field">
                  <label htmlFor="glpi-reply">{internal ? '内部メモ' : '返信内容'}</label>
                  <textarea
                    id="glpi-reply"
                    required
                    maxLength={10000}
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    disabled={busy}
                  />
                </div>
                <button disabled={busy}>
                  {internal ? '内部メモを保存する' : '公開返信を送る'}
                </button>
              </form>
              {actor.role === 'agent' && (
                <p className="muted">
                  解決の登録・承認や添付の管理は、GLPI 標準画面で行ってください。
                </p>
              )}
            </section>
          )}
        </>
      )}
    </>
  );
}
