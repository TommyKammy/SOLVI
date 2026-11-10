'use client';
import { useActionState, useState, type FormEvent } from 'react';
import { FeedbackForm, FormField } from './FeedbackForm';
import { ContextLink } from './ContextLink';
import { saveArticle, changeArticle } from '../app/knowledge/actions';
import type { KnowledgeArticle } from '../lib/api';
import type { FormFeedback } from '../lib/form-state';
import { formatDateTime } from '../lib/labels';
import styles from './KnowledgeEditor.module.css';

type EditorValues = Pick<KnowledgeArticle, 'title' | 'body' | 'tags' | 'audience'>;
type Versions = Array<{ number: number; title: string; createdAt: string }>;

// A textarea exposes LF even when the saved HTTP form value contains CRLF/CR.
function displayedBody(body: string) {
  return body.replace(/\r\n?/g, '\n');
}

function useEditor(article?: KnowledgeArticle) {
  const [feedback, action, pending] = useActionState(saveArticle.bind(null, article?.id ?? null), {
    message: '',
  } as FormFeedback);
  const [values, setValues] = useState<EditorValues>({
    title: article?.title ?? '',
    body: displayedBody(article?.body ?? ''),
    tags: article?.tags ?? '',
    audience: article?.audience ?? 'organization',
  });
  return { feedback, action, pending, values, setValues };
}

function preventBlockedSubmission(blocked: boolean) {
  return (event: FormEvent<HTMLFormElement>) => {
    if (blocked) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
}

function preventActionSubmission(blocked: boolean) {
  return (event: FormEvent<HTMLFormElement>) => {
    const selector = event.currentTarget.querySelector('#restore-version');
    const selectingVersion =
      selector !== null && event.currentTarget.ownerDocument.activeElement === selector;
    preventBlockedSubmission(blocked || selectingVersion)(event);
  };
}

function EditorForm({
  article,
  editor,
  busy,
}: {
  article?: KnowledgeArticle;
  editor: ReturnType<typeof useEditor>;
  busy: boolean;
}) {
  const { feedback, action, pending, values, setValues } = editor;
  return (
    <FeedbackForm
      feedback={feedback}
      pending={pending}
      action={action}
      onSubmitCapture={preventBlockedSubmission(busy)}
      className={`stack form-panel ${styles.form}`}
    >
      <input type="hidden" name="expectedVersion" value={article?.version ?? 1} />
      <FormField className="field">
        <label htmlFor="article-title">記事のタイトル</label>
        <input
          id="article-title"
          name="title"
          value={values.title}
          onChange={(e) => setValues({ ...values, title: e.target.value })}
          disabled={busy}
          required
          maxLength={200}
        />
      </FormField>
      <FormField className="field">
        <label htmlFor="article-body">内容・手順</label>
        <textarea
          id="article-body"
          name="body"
          value={values.body}
          onChange={(e) => setValues({ ...values, body: e.target.value })}
          disabled={busy}
          rows={12}
          required
          maxLength={20000}
        />
        <span className="hint">
          見出しや手順は文章で記載してください。HTML は表示用の文章として扱います。
        </span>
      </FormField>
      <FormField className="field">
        <label htmlFor="article-tags">検索のためのタグ</label>
        <input
          id="article-tags"
          name="tags"
          value={values.tags}
          onChange={(e) => setValues({ ...values, tags: e.target.value })}
          disabled={busy}
          maxLength={500}
        />
      </FormField>
      <FormField className="field">
        <label htmlFor="article-audience">公開後の閲覧範囲</label>
        <select
          id="article-audience"
          name="audience"
          value={values.audience}
          onChange={(e) =>
            setValues({ ...values, audience: e.target.value as EditorValues['audience'] })
          }
          disabled={busy}
        >
          <option value="organization">組織内の利用者</option>
          <option value="staff">担当者限定</option>
        </select>
      </FormField>
      <p className="hint">
        保存すると下書きになります。公開済みの版は、再公開するまで利用者に表示されます。
      </p>
      <div className="form-actions">
        <button disabled={busy}>{pending ? '保存しています…' : '下書きを保存する'}</button>
        <ContextLink
          back
          href={article ? `/knowledge/${article.id}?manage=1` : '/knowledge?manage=1'}
        >
          キャンセルして戻る
        </ContextLink>
      </div>
    </FeedbackForm>
  );
}

export function KnowledgeEditor({ article }: { article?: KnowledgeArticle }) {
  const editor = useEditor(article);
  return <EditorForm article={article} editor={editor} busy={editor.pending} />;
}

function KnowledgeActions({
  article,
  canPublish,
  versions,
  feedback,
  action,
  pending,
  blocked,
}: {
  article: KnowledgeArticle;
  canPublish: boolean;
  versions: Versions;
  feedback: FormFeedback;
  action: (form: FormData) => void;
  pending: boolean;
  blocked: boolean;
}) {
  return (
    <FeedbackForm
      feedback={feedback}
      pending={pending}
      action={action}
      onSubmitCapture={preventActionSubmission(blocked)}
      className={`stack form-panel ${styles.form}`}
    >
      <input type="hidden" name="expectedVersion" value={article.version} />
      {article.state === 'draft' && (
        <button name="action" value="review" disabled={blocked}>
          レビューへ送る
        </button>
      )}
      {article.state === 'review' && (
        <p>最新の内容と閲覧範囲を確認してください。管理者が公開を確定します。</p>
      )}
      {article.state === 'review' && canPublish && (
        <button name="action" value="publish" disabled={blocked}>
          確認した内容を公開する
        </button>
      )}
      {article.publishedVersion && article.state !== 'retired' && canPublish && (
        <button name="action" value="retire" className="secondary" disabled={blocked}>
          公開を取り下げる
        </button>
      )}
      <details>
        <summary>過去の版から下書きを作る</summary>
        <label htmlFor="restore-version">復元する版（版の作成日時）</label>
        <select id="restore-version" name="restoreVersion" disabled={blocked}>
          {versions.map((v) => (
            <option value={v.number} key={v.number}>
              版 {v.number} · {formatDateTime(v.createdAt)} · {v.title}
            </option>
          ))}
        </select>
        <p className="hint">
          過去の版は変更せず、新しい下書きとして保存します。再公開にはレビューが必要です。
        </p>
        <button name="action" value="restore" disabled={blocked}>
          この版から下書きを作る
        </button>
      </details>
    </FeedbackForm>
  );
}

export function KnowledgeManagement({
  article,
  canPublish,
  versions,
}: {
  article: KnowledgeArticle;
  canPublish: boolean;
  versions: Versions;
}) {
  const editor = useEditor(article);
  const [feedback, action, pending] = useActionState(changeArticle.bind(null, article.id), {
    message: '',
  } as FormFeedback);
  const editable = article.state === 'draft' || article.state === 'published';
  const dirty =
    editable &&
    (editor.values.title !== article.title ||
      editor.values.body !== displayedBody(article.body) ||
      editor.values.tags !== article.tags ||
      editor.values.audience !== article.audience);
  const busy = editor.pending || pending;
  const states = {
    draft: '下書き',
    review: 'レビュー待ち',
    published: '公開済み',
    retired: '取り下げ済み',
  };
  return (
    <div className="stack" style={{ gap: '2rem' }}>
      {editable && (
        <section aria-labelledby="knowledge-edit-heading" className="stack">
          <h2 id="knowledge-edit-heading">記事を編集する</h2>
          <p role="status" aria-live="polite">
            {editor.pending
              ? '下書きを保存しています。完了するまでお待ちください。'
              : pending
                ? '保存済みの版を操作しています。完了するまでお待ちください。'
                : dirty
                  ? '未保存の変更があります。版の操作に進むには、先に下書きを保存してください。'
                  : '保存済みの内容と一致しています。'}
          </p>
          <EditorForm article={article} editor={editor} busy={busy} />
        </section>
      )}
      <section aria-labelledby="knowledge-actions-heading" className="stack">
        <h2 id="knowledge-actions-heading">保存済みの版を操作する</h2>
        <p>
          操作対象: 保存済みの版 {article.contentVersion} · {states[article.state]}
        </p>
        <p className="hint">
          未保存の入力は、レビュー・公開・取り下げ・復元の操作には含まれません。
        </p>
        <KnowledgeActions
          article={article}
          canPublish={canPublish}
          versions={versions}
          feedback={feedback}
          action={action}
          pending={pending}
          blocked={dirty || busy}
        />
      </section>
    </div>
  );
}
