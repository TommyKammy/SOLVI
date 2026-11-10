'use client';
import { TableRegion } from './TableRegion';
import { useEffect, useId, useRef, useState } from 'react';
import {
  bindDraftScope,
  clearFormDrafts,
  currentDraftScope,
  draftKey,
  DRAFT_TTL,
  readFormDraft,
  type DraftValues,
  type FormDraft,
} from '../lib/form-draft';

export function FormDraftRecovery({
  scope,
  formKey,
  version,
  baseline,
  values,
  labels,
  onRestore,
  successful = false,
  conservativeRestore = false,
  copy,
}: {
  scope: string;
  formKey: string;
  version: string;
  baseline: DraftValues;
  values: DraftValues;
  labels: Record<string, string>;
  onRestore: (values: DraftValues) => void;
  successful?: boolean;
  conservativeRestore?: boolean;
  copy?: { title: string; notice: string; restored: string };
}) {
  const key = draftKey(scope, formKey),
    id = useId();
  const [draft, setDraft] = useState<FormDraft | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState(false);
  const liveValues = useRef(values);
  liveValues.current = values;
  const valuesSignature = JSON.stringify(values);
  useEffect(() => {
    if (!conservativeRestore) return;
    setSelected((fields) =>
      fields.filter((field) => !values[field] || values[field] === draft?.values[field]),
    );
  }, [conservativeRestore, valuesSignature]);
  const changed = draft
    ? Object.keys(labels).filter(
        (field) =>
          typeof draft.values[field] === 'string' &&
          draft.values[field] !== draft.baseline[field] &&
          draft.values[field] !== values[field],
      )
    : [];
  const conflict = (field: string) => draft?.baseline[field] !== baseline[field];
  async function verify() {
    const current = await currentDraftScope();
    if (!current) {
      setMessage(
        'ログインの期限が切れています。同じアカウントでログイン後、この画面を開き直してください。保存済みの下書きは期限まで保持します。',
      );
      setReview(false);
      return false;
    }
    if (current !== scope) {
      try {
        clearFormDrafts();
      } catch {
        /* Still invalidate the visible form. */
      }
      setDraft(null);
      setReview(false);
      onRestore(baseline);
      window.location.reload();
      return false;
    }
    bindDraftScope(scope);
    return true;
  }
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const current = await currentDraftScope();
        if (!live || current !== scope) return;
        bindDraftScope(scope);
        const saved = readFormDraft(key, scope);
        setDraft(saved);
        // Only fields untouched on the server are initially selected.
        setSelected(
          saved
            ? Object.keys(labels)
                .filter(
                  (field) =>
                    saved.values[field] !== undefined && saved.baseline[field] === baseline[field],
                )
                .filter(
                  (field) =>
                    !conservativeRestore ||
                    (saved.version === version && !liveValues.current[field]),
                )
            : [],
        );
        setReview(!!saved);
      } catch {
        if (live)
          setMessage('このタブでは下書きを読み込めません。画面内の入力はそのまま使えます。');
      }
    })();
    const clear = () => {
      setDraft(null);
      setReview(false);
      setSelected([]);
      onRestore(baseline);
    };
    window.addEventListener('solvi:drafts-cleared', clear);
    return () => {
      live = false;
      window.removeEventListener('solvi:drafts-cleared', clear);
    };
    // Snapshot values at this rendered server revision, never on each keystroke.
  }, [key, scope, version]);
  useEffect(() => {
    if (!successful) return;
    setDraft(null);
    setReview(false);
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* no persisted copy */
    }
  }, [successful, key]);
  useEffect(() => {
    if (!draft) return;
    const timer = window.setTimeout(
      () => {
        try {
          sessionStorage.removeItem(key);
        } catch {
          /* disabled */
        }
        setDraft(null);
        setReview(false);
        setMessage('一時保存の2時間の期限が切れました。画面内の入力は保持しています。');
      },
      Math.max(0, draft.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [draft, key]);
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    try {
      await operation();
    } catch {
      setMessage('一時保存を利用できません。入力はこの画面に保持しています。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="draft-recovery" aria-labelledby={id}>
      <h2 id={id}>{copy?.title ?? 'このタブの下書き'}</h2>
      <p className="hint">
        一時保存は任意です。本文をこのタブに2時間保存します。共有PC・機微情報には使わないでください。自動保存はしません。
      </p>
      <input type="hidden" name="formScope" value={scope} />
      <div className="form-actions">
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              if (!(await verify())) return;
              const now = Date.now();
              const next: FormDraft = {
                schema: 1,
                scope,
                version,
                savedAt: now,
                expiresAt: now + DRAFT_TTL,
                baseline,
                values,
              };
              const raw = JSON.stringify(next);
              if (new TextEncoder().encode(raw).byteLength > 100000) {
                setMessage('入力が大きいため一時保存できません。');
                return;
              }
              sessionStorage.setItem(key, raw);
              setDraft(next);
              setReview(false);
              setMessage('このタブに一時保存しました。以後の変更はもう一度保存してください。');
            })
          }
        >
          このタブに一時保存する
        </button>
        {draft && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              try {
                sessionStorage.removeItem(key);
                setDraft(null);
                setReview(false);
                setMessage('一時保存を削除しました。画面の入力は残っています。');
              } catch {
                setMessage('一時保存を削除できませんでした。');
              }
            }}
          >
            一時保存を削除する
          </button>
        )}
      </div>
      {message && <p role="status">{message}</p>}
      {draft && (
        <p className="hint">
          保存: {new Date(draft.savedAt).toLocaleTimeString('ja-JP')} · 期限:{' '}
          {new Date(draft.expiresAt).toLocaleTimeString('ja-JP')}
          {!review && changed.length > 0 && ' · 保存後に変更があります。'}
        </p>
      )}
      {draft && review && (
        <div className="stack">
          <p className="notice">
            {copy?.notice ??
              '一時保存した入力があります。差を確認して復元する項目を選んでください。承認者の現在の設定を確認し、確認チェックは入れ直してください。送信は自動では行いません。'}
          </p>
          {draft.version !== version && (
            <p role="alert">
              保存時からサーバーの版が変わっています。現在の内容を変更する項目は、確認してから選んでください。
            </p>
          )}
          {changed.length ? (
            <TableRegion label="復元する入力の比較">
              <table>
                <caption>復元前の入力の比較</caption>
                <thead>
                  <tr>
                    <th scope="col">復元</th>
                    <th scope="col">項目</th>
                    <th scope="col">現在の内容</th>
                    <th scope="col">保存した下書き</th>
                  </tr>
                </thead>
                <tbody>
                  {changed.map((field) => (
                    <tr key={field}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`${labels[field]}を復元する`}
                          checked={selected.includes(field)}
                          onChange={(e) =>
                            setSelected((previous) =>
                              e.target.checked
                                ? [...previous, field]
                                : previous.filter((f) => f !== field),
                            )
                          }
                        />
                      </td>
                      <th scope="row">
                        {labels[field]}
                        {conflict(field) && <span className="hint">（サーバーで変更あり）</span>}
                      </th>
                      <td className="draft-value">{values[field] || '（未入力）'}</td>
                      <td className="draft-value">{draft.values[field] || '（未入力）'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableRegion>
          ) : (
            <p>現在の内容と同じです。復元は不要です。</p>
          )}
          <button
            type="button"
            disabled={busy || !changed.some((f) => selected.includes(f))}
            onClick={() =>
              void run(async () => {
                const reviewedValues = liveValues.current;
                if (!(await verify())) return;
                const saved = readFormDraft(key, scope);
                if (!saved) {
                  setDraft(null);
                  setReview(false);
                  setMessage('一時保存の期限が切れたか削除されました。');
                  return;
                }
                if (
                  conservativeRestore &&
                  changed.some(
                    (field) =>
                      selected.includes(field) &&
                      (liveValues.current[field] !== reviewedValues[field] ||
                        saved.values[field] !== draft.values[field]),
                  )
                ) {
                  setDraft(saved);
                  setSelected([]);
                  setMessage(
                    '復元の確認中に入力または下書きが変わりました。差を確認して、もう一度選んでください。',
                  );
                  return;
                }
                onRestore(
                  Object.fromEntries(
                    changed.filter((f) => selected.includes(f)).map((f) => [f, saved.values[f]]),
                  ),
                );
                setReview(false);
                setMessage(
                  copy?.restored ??
                    '選んだ項目を復元しました。現在の版へ送信する前に入力と承認者を確認してください。',
                );
              })
            }
          >
            選んだ項目を復元する
          </button>
        </div>
      )}
    </section>
  );
}
