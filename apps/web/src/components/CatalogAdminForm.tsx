'use client';
import { useActionState, useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { FeedbackForm, FormField } from './FeedbackForm';
import { ContextLink } from './ContextLink';
import type { CatalogAdminDetail, CatalogField, CatalogItem } from '../lib/api';
import type { FormFeedback } from '../lib/form-state';
import { saveCatalog, publishCatalog } from '../app/catalog/manage/actions';
import { CatalogFieldInputs } from './CatalogFieldInputs';
import { catalogTemplates } from '../lib/catalog-templates';
import styles from './CatalogAdminForm.module.css';
import { CatalogLivePreview } from './CatalogLivePreview';

type EditorValues = {
  code: string;
  title: string;
  description: string;
  target: string;
  days: string;
  maxReason: number;
  approver: string;
  fields: CatalogField[];
};

function editorValues(item?: CatalogAdminDetail): EditorValues {
  const d = item?.draft;
  return {
    code: item?.code ?? '',
    title: d?.title ?? '',
    description: (d?.description ?? '').replace(/\r\n?/g, '\n'),
    target: d?.definition.targetLabel ?? '検証用アクセス',
    days: d?.definition.allowedDurations.join(', ') ?? '1, 7, 30',
    maxReason: d?.definition.maxReasonLength ?? 2000,
    approver: d?.definition.approval?.approverId ?? '',
    fields: d?.definition.fields ?? [],
  };
}

// Compare displayed edit values, retaining field and option array boundaries and order.
function editProjection(values: EditorValues) {
  return JSON.stringify({
    title: values.title,
    description: values.description.replace(/\r\n?/g, '\n'),
    target: values.target,
    days: values.days,
    maxReason: values.maxReason,
    approver: values.approver,
    fields: values.fields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      required: f.required,
      ...(f.type === 'select'
        ? { options: f.options }
        : f.type === 'checkbox'
          ? {}
          : { maxLength: f.maxLength }),
    })),
  });
}

async function exclusiveAction(
  busy: RefObject<boolean> | undefined,
  previous: FormFeedback,
  execute: () => Promise<FormFeedback>,
) {
  if (busy?.current) {
    return {
      message: '別の処理が進行中です。完了してから、もう一度操作してください。',
      attempt: (previous.attempt ?? 0) + 1,
    };
  }
  // FeedbackForm has already captured the complete FormData before dispatch reaches here.
  if (busy) busy.current = true;
  try {
    return await execute();
  } finally {
    if (busy) busy.current = false;
  }
}

function blockSubmission(blocked: () => boolean) {
  return (event: FormEvent<HTMLFormElement>) => {
    if (blocked()) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
}

function useEditor(item?: CatalogAdminDetail, busy?: RefObject<boolean>) {
  const [feedback, action, pending] = useActionState(
    (previous: FormFeedback, form: FormData) =>
      exclusiveAction(busy, previous, () => saveCatalog(item?.id ?? null, previous, form)),
    { message: '' } as FormFeedback,
  );
  const [values, setState] = useState<EditorValues>(editorValues(item));
  const current = useRef(values);
  function update<K extends keyof EditorValues>(
    key: K,
    value: EditorValues[K] | ((old: EditorValues[K]) => EditorValues[K]),
  ) {
    if (busy?.current || pending) return;
    const next = typeof value === 'function' ? value(current.current[key]) : value;
    current.current = { ...current.current, [key]: next };
    setState(current.current);
  }
  return { feedback, action, pending, values, current, update };
}

export function CatalogAdminForm({
  item,
  approvers,
}: {
  item?: CatalogAdminDetail;
  approvers: Array<{ id: string; name: string }>;
}) {
  const editor = useEditor(item);
  return <EditorForm item={item} approvers={approvers} editor={editor} busy={editor.pending} />;
}

function EditorForm({
  item,
  approvers,
  editor,
  busy,
  isBusy = () => busy,
}: {
  item?: CatalogAdminDetail;
  approvers: Array<{ id: string; name: string }>;
  editor: ReturnType<typeof useEditor>;
  busy: boolean;
  isBusy?: () => boolean;
}) {
  const { feedback, action, pending, values, update } = editor;
  const { code, title, description, target, days, maxReason, approver, fields } = values;
  function edit<K extends keyof EditorValues>(
    key: K,
    value: EditorValues[K] | ((old: EditorValues[K]) => EditorValues[K]),
  ) {
    if (!isBusy()) update(key, value);
  }
  const setCode = (value: string) => edit('code', value);
  const setTitle = (value: string) => edit('title', value);
  const setDescription = (value: string) => edit('description', value);
  const setTarget = (value: string) => edit('target', value);
  const setDays = (value: string) => edit('days', value);
  const setMaxReason = (value: number) => edit('maxReason', value);
  const setApprover = (value: string) => edit('approver', value);
  const setFields = (value: CatalogField[] | ((old: CatalogField[]) => CatalogField[])) =>
    edit('fields', value);
  const [creationKey, setCreationKey] = useState('');
  const [templateCode, setTemplateCode] = useState('');
  useEffect(() => {
    const key = crypto.randomUUID();
    setCreationKey(key);
    if (!item) setCode('service-' + key);
    // One creation intent and management code per mounted editor, including retries.
  }, []);
  const replace = (index: number, value: CatalogField) =>
    setFields((old) => old.map((f, i) => (i === index ? value : f)));
  const changeType = (index: number, type: CatalogField['type']) => {
    const f = fields[index]!;
    replace(index, {
      key: f.key,
      label: f.label,
      required: f.required,
      ...(type === 'select'
        ? { type, options: ['候補1', '候補2'] }
        : type === 'checkbox'
          ? { type }
          : { type, maxLength: type === 'text' ? 200 : 2000 }),
    });
  };
  function example() {
    setTitle('合成アクセス利用申請');
    setDescription('項目定義と独立承認を確認するための合成申請です。外部変更はありません。');
    setTarget('検証用アクセス');
    setApprover(approvers[0]?.id ?? '');
    setFields([
      { key: 'team', label: '利用部署', type: 'text', required: true, maxLength: 80 },
      {
        key: 'purpose',
        label: '利用目的',
        type: 'select',
        required: true,
        options: ['障害検証', '運用改善'],
      },
      { key: 'notes', label: '補足事項', type: 'textarea', required: false, maxLength: 500 },
      {
        key: 'confirm',
        label: '合成申請であることを確認しました',
        type: 'checkbox',
        required: true,
      },
    ]);
  }
  function applyTemplate() {
    const template = catalogTemplates.find((t) => t.code === templateCode);
    if (!template) return;
    setTitle(template.title);
    setDescription(template.description);
    setTarget(template.targetLabel);
    setDays(template.allowedDurations.join(', '));
    setMaxReason(2000);
    setFields(template.fields.map((f) => ({ ...f })));
  }
  const steps = [
    ['catalog-basic-settings', '基本情報'],
    ['catalog-question-settings', '申請フォーム'],
    ['catalog-approval-settings', '承認と検証設定'],
    ['catalog-save-review', '確認・保存'],
  ];
  return (
    <div className={styles.authoring}>
      <nav className={styles.steps} aria-label="サービス作成の手順">
        <p>サービスを整える</p>
        <ol>
          {steps.map(([id, label], index) => (
            <li key={id}>
              <a
                href={'#' + id}
                onClick={(event) => {
                  event.preventDefault();
                  if (!isBusy()) document.getElementById(id!)?.focus();
                }}
              >
                <span aria-hidden="true">{index + 1}</span>
                {label}
              </a>
            </li>
          ))}
        </ol>
        <a className={styles.previewJump} href="#catalog-live-preview">
          利用者フォームを試す
        </a>
      </nav>
      <div className={styles.workspace}>
        <FeedbackForm
          feedback={feedback}
          pending={pending}
          action={action}
          onSubmitCapture={blockSubmission(isBusy)}
          onClickCapture={(event) => {
            if ((event.target as HTMLElement).closest('.error-link')) {
              event.currentTarget.querySelectorAll('details').forEach((details) => {
                details.open = true;
              });
            }
          }}
          className={`stack form-panel ${styles.editor}`}
        >
          <input type="hidden" name="creationKey" value={creationKey} />
          <input type="hidden" name="expectedVersion" value={item?.editVersion ?? 1} />
          <input type="hidden" name="fields" value={JSON.stringify(fields)} />
          <fieldset disabled={busy} className={styles.controls}>
            <legend>カタログの下書き入力</legend>
            <section className={styles.section} aria-labelledby="catalog-basic-settings">
              <h2 id="catalog-basic-settings" tabIndex={-1}>
                基本情報
              </h2>
              <p className="hint">利用者が、このサービスで何を依頼できるかを伝えます。</p>
              {!item && (
                <fieldset className="stack">
                  <legend>種類別のテンプレートから始める</legend>
                  <label htmlFor="catalog-template">申請の種類</label>
                  <select
                    id="catalog-template"
                    value={templateCode}
                    onChange={(e) => {
                      if (!isBusy()) setTemplateCode(e.target.value);
                    }}
                  >
                    <option value="">テンプレートを選ぶ</option>
                    {catalogTemplates.map((t) => (
                      <option key={t.code} value={t.code}>
                        {t.title}
                      </option>
                    ))}
                  </select>
                  <p className="hint">
                    この新規フォームに必要項目を入力します。固定承認者を選び、保存・プレビューしてから公開してください。既存項目は変更しません。
                  </p>
                  <button
                    type="button"
                    className="secondary"
                    onClick={applyTemplate}
                    disabled={!templateCode || pending}
                  >
                    選んだテンプレートを入力する
                  </button>
                  <button type="button" className="secondary" onClick={example}>
                    汎用の合成例を入力する
                  </button>
                </fieldset>
              )}
              <FormField name="code" className="field">
                <input type="hidden" name="code" value={code} />
                <details className={styles.details}>
                  <summary>管理コードを確認する</summary>
                  <p>
                    <code>{code || '作成の準備中…'}</code>
                  </p>
                  <p className="hint">
                    自動で割り当てる識別子です。サービス名の編集では変更しません。
                  </p>
                </details>
              </FormField>
              <FormField className="field">
                <label htmlFor="catalog-title">サービス名</label>
                <input
                  type="text"
                  id="catalog-title"
                  name="title"
                  value={title}
                  maxLength={200}
                  required
                  onChange={(e) => setTitle(e.target.value)}
                />
              </FormField>
              <FormField className="field">
                <label htmlFor="catalog-description">利用者への説明</label>
                <textarea
                  id="catalog-description"
                  name="description"
                  value={description}
                  maxLength={2000}
                  required
                  placeholder="例：業務用PCの貸与を依頼します。利用部署・端末の希望・受取方法をご用意ください。"
                  aria-describedby="catalog-description-help"
                  onChange={(e) => setDescription(e.target.value)}
                />
                <p className="hint" id="catalog-description-help">
                  対象者、依頼できる内容、用意する情報、承認後の流れを記載してください。確約できない納期や費用は記載しないでください。
                </p>
              </FormField>
            </section>
            <section className={styles.section} aria-labelledby="catalog-question-settings">
              <h2 id="catalog-question-settings" tabIndex={-1}>
                申請フォーム
              </h2>
              <p className="hint">
                理由と利用日数に加え、必要な質問を作ります。編集中のプレビューで入力を試せます。
              </p>
              <FormField className="field">
                <label htmlFor="catalog-days">利用日数の候補</label>
                <input
                  type="text"
                  id="catalog-days"
                  name="allowedDurations"
                  value={days}
                  required
                  onChange={(e) => setDays(e.target.value)}
                />
                <p className="hint">1〜365の日数をカンマ区切りで最大10候補。</p>
              </FormField>
              <FormField className="field">
                <label htmlFor="catalog-reason-limit">理由の文字数上限</label>
                <input
                  type="number"
                  id="catalog-reason-limit"
                  name="maxReasonLength"
                  min={1}
                  max={2000}
                  value={maxReason}
                  required
                  onChange={(e) => setMaxReason(Number(e.target.value))}
                />
              </FormField>
              <FormField name="fields">
                <h3>追加の申請項目</h3>
              </FormField>
              <p className="hint">
                上の理由・利用日数に加える項目です。最大10件。利用者へこの順番で表示します。
              </p>
              {fields.map((f, i) => (
                <fieldset key={f.key} className="catalog-editor-field">
                  <legend>項目{i + 1}</legend>
                  <FormField name={`fields.${i}.key`} className="field">
                    <input type="hidden" name={`fields.${i}.key`} value={f.key} />
                    <details className={styles.details}>
                      <summary>項目{i + 1}の保存キーを確認する</summary>
                      <code>{f.key}</code>
                      <p className="hint">
                        この質問の識別子です。表示名や順番を変えても同じキーを保持します。
                      </p>
                    </details>
                  </FormField>
                  <FormField className="field">
                    <label htmlFor={'field-label-' + i}>表示名 {i + 1}</label>
                    <input
                      type="text"
                      id={'field-label-' + i}
                      name={`fields.${i}.label`}
                      value={f.label}
                      maxLength={100}
                      required
                      onChange={(e) => replace(i, { ...f, label: e.target.value })}
                    />
                  </FormField>
                  <FormField className="field">
                    <label htmlFor={'field-type-' + i}>種類 {i + 1}</label>
                    <select
                      id={'field-type-' + i}
                      name={`fields.${i}.type`}
                      value={f.type}
                      onChange={(e) => changeType(i, e.target.value as CatalogField['type'])}
                    >
                      <option value="text">短文</option>
                      <option value="textarea">長文</option>
                      <option value="select">選択</option>
                      <option value="checkbox">確認チェック</option>
                    </select>
                  </FormField>
                  <label>
                    <input
                      type="checkbox"
                      checked={f.required}
                      onChange={(e) => replace(i, { ...f, required: e.target.checked })}
                    />{' '}
                    必須にする{f.type === 'checkbox' ? '（チェックが必要）' : ''}
                  </label>
                  {f.type === 'select' ? (
                    <FormField className="field">
                      <label htmlFor={'field-options-' + i}>選択肢 {i + 1}（1行1候補）</label>
                      <textarea
                        id={'field-options-' + i}
                        name={`fields.${i}.options`}
                        value={f.options.join('\n')}
                        onChange={(e) => replace(i, { ...f, options: e.target.value.split('\n') })}
                      />
                      <p className="hint">空行なし、重複なしで2〜10候補。各100文字以内。</p>
                    </FormField>
                  ) : (
                    f.type !== 'checkbox' && (
                      <FormField className="field">
                        <label htmlFor={'field-limit-' + i}>文字数上限 {i + 1}</label>
                        <input
                          type="number"
                          id={'field-limit-' + i}
                          name={`fields.${i}.maxLength`}
                          value={f.maxLength}
                          min={1}
                          max={f.type === 'text' ? 1000 : 2000}
                          required
                          onChange={(e) => replace(i, { ...f, maxLength: Number(e.target.value) })}
                        />
                      </FormField>
                    )
                  )}
                  <div className={styles.fieldOrder}>
                    <button
                      type="button"
                      className="secondary"
                      disabled={i === 0}
                      onClick={() =>
                        setFields((old) => {
                          const next = [...old];
                          [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
                          return next;
                        })
                      }
                    >
                      項目{i + 1}を上へ
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={i === fields.length - 1}
                      onClick={() =>
                        setFields((old) => {
                          const next = [...old];
                          [next[i], next[i + 1]] = [next[i + 1]!, next[i]!];
                          return next;
                        })
                      }
                    >
                      項目{i + 1}を下へ
                    </button>
                  </div>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setFields((old) => old.filter((_, j) => j !== i))}
                  >
                    項目{i + 1}を下書きから外す
                  </button>
                </fieldset>
              ))}
              <button
                type="button"
                className="secondary"
                disabled={fields.length >= 10}
                onClick={() =>
                  setFields((old) => [
                    ...old,
                    {
                      key: 'field_' + crypto.randomUUID().replaceAll('-', '').slice(0, 24),
                      label: '',
                      type: 'text',
                      required: false,
                      maxLength: 200,
                    },
                  ])
                }
              >
                申請項目を追加する
              </button>
            </section>
            <section className={styles.section} aria-labelledby="catalog-approval-settings">
              <h2 id="catalog-approval-settings" tabIndex={-1}>
                承認と検証設定
              </h2>
              <details className={styles.details}>
                <summary>模擬結果の表示名を設定する</summary>
                <FormField className="field">
                  <label htmlFor="catalog-target">模擬対象の表示名</label>
                  <input
                    type="text"
                    id="catalog-target"
                    name="targetLabel"
                    value={target}
                    maxLength={100}
                    required
                    onChange={(e) => setTarget(e.target.value)}
                  />
                  <p className="hint">
                    模擬結果に表示する名前です。実際のグループや権限のIDは設定しません。
                  </p>
                </FormField>
              </details>
              <FormField className="field">
                <label htmlFor="catalog-approver">固定の承認者</label>
                <select
                  id="catalog-approver"
                  name="approverId"
                  value={approver}
                  required
                  onChange={(e) => setApprover(e.target.value)}
                >
                  <option value="">同じ組織の承認者を選ぶ</option>
                  {approvers.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <p className="hint">
                  この版での申請先です。申請者本人が承認者になる申請は受け付けません。
                </p>
              </FormField>
            </section>
            <section className={styles.section} aria-labelledby="catalog-save-review">
              <h2 id="catalog-save-review" tabIndex={-1}>
                確認・保存
              </h2>
              <p className="hint">
                利用者フォームで入力を試し、名前・説明・質問・承認者を確認してください。保存しても公開はされません。
              </p>
              <p className="notice">
                保存は下書きだけに反映します。保存後に利用者のフォームをプレビューし、公開を確定してください。既存申請の定義・入力・承認は変更しません。
              </p>
              {!approvers.length && (
                <p role="alert">
                  有効な承認者がいません。現在の組織の承認者設定を確認してください。
                </p>
              )}
              <div className="form-actions">
                <button disabled={pending || !creationKey || !approvers.length}>
                  {pending ? '保存しています…' : '下書きを保存してプレビューする'}
                </button>
                <ContextLink back href={item ? `/catalog/manage/${item.id}` : '/catalog/manage'}>
                  キャンセルして戻る
                </ContextLink>
              </div>
            </section>
          </fieldset>
        </FeedbackForm>
        <aside
          id="catalog-live-preview"
          className={styles.livePreview}
          aria-label="利用者フォームの入力試験"
          tabIndex={0}
        >
          <CatalogLivePreview
            title={title}
            description={description}
            target={target}
            days={days}
            maxReason={maxReason}
            approver={approver}
            fields={fields}
            approvers={approvers}
            disabled={busy}
          />
        </aside>
      </div>
    </div>
  );
}
export function CatalogPublicationForm({
  item,
  feedback,
  action,
  pending,
  blocked,
}: {
  item: CatalogAdminDetail;
  feedback: FormFeedback;
  action: (form: FormData) => void;
  pending: boolean;
  blocked: () => boolean;
}) {
  const valid = Boolean(
    item.draft.definition.approval &&
    item.approvers.some((a) => a.id === item.draft.definition.approval?.approverId),
  );
  return (
    <FeedbackForm
      feedback={feedback}
      pending={pending}
      action={action}
      onSubmitCapture={blockSubmission(blocked)}
      className="stack form-panel"
    >
      <input type="hidden" name="expectedVersion" value={item.editVersion} />

      <p>
        公開すると保存済みの下書き版{item.draft.revision}
        を新しい申請に使用します。既存申請は元の版で継続します。
      </p>
      <div className="actions-row">
        <button
          name="state"
          value="published"
          disabled={
            blocked() || !valid || (item.active && item.publishedRevision === item.draft.revision)
          }
        >
          保存済みの下書き版{item.draft.revision}を公開する
        </button>
        {item.active && (
          <button name="state" value="unpublished" className="secondary" disabled={blocked()}>
            公開版{item.publishedRevision}の新規受付を停止する
          </button>
        )}
      </div>
      {!valid && <p role="alert">公開する前に下書きへ有効な固定承認者を設定してください。</p>}
    </FeedbackForm>
  );
}

export function CatalogManagement({ item }: { item: CatalogAdminDetail }) {
  const busyLatch = useRef(false);
  const editor = useEditor(item, busyLatch);
  const [feedback, action, pending] = useActionState(
    (previous: FormFeedback, form: FormData) =>
      exclusiveAction(busyLatch, previous, () => publishCatalog(item.id, previous, form)),
    { message: '' } as FormFeedback,
  );
  const baseline = editProjection(editorValues(item));
  const isDirty = () => editProjection(editor.current.current) !== baseline;
  const busy = editor.pending || pending;
  const isBusy = () => busy || busyLatch.current;
  const dirty = isDirty();
  return (
    <section aria-label="カタログの編集と公開" className={styles.management}>
      <p role="status" className={`notice ${styles.status}`}>
        {editor.pending
          ? '下書きを保存しています。完了するまで編集・公開操作をお待ちください。'
          : pending
            ? '公開設定を変更しています。完了するまで編集・保存をお待ちください。'
            : dirty
              ? '未保存の入力があります。下書きを保存してから、公開・受付停止を操作してください。'
              : `入力は保存済みの下書き版${item.draft.revision}と同じです。`}
      </p>
      <h2>保存済みの下書き版{item.draft.revision}</h2>
      <p className="hint">以下は保存済みの内容です。編集中の入力は、保存するまで反映されません。</p>
      <CatalogPreview
        title={item.draft.title}
        description={item.draft.description}
        definition={item.draft.definition}
        approvers={item.approvers}
      />
      <CatalogPublicationForm
        item={item}
        feedback={feedback}
        action={action}
        pending={pending}
        blocked={() => isDirty() || isBusy()}
      />
      <details>
        <summary>下書きの項目と承認者を編集する</summary>
        <EditorForm
          item={item}
          approvers={item.approvers}
          editor={editor}
          busy={busy}
          isBusy={isBusy}
        />
      </details>
    </section>
  );
}
export function CatalogPreview({
  title,
  description,
  definition,
  approvers,
}: {
  title: string;
  description: string;
  definition: CatalogItem['definition'];
  approvers: Array<{ id: string; name: string }>;
}) {
  return (
    <section id="preview" className="form-panel">
      <h2>保存した下書きのプレビュー</h2>
      <p className="hint">利用者に表示するフォームです。このプレビューから申請は送信されません。</p>
      <h3>{title}</h3>
      <p>{description}</p>
      <fieldset disabled className="stack">
        <FormField className="field">
          <label htmlFor="preview-reason">利用する理由</label>
          <textarea id="preview-reason" maxLength={definition.maxReasonLength} />
        </FormField>
        <FormField className="field">
          <label htmlFor="preview-days">希望する利用日数</label>
          <select id="preview-days">
            {definition.allowedDurations.map((d) => (
              <option key={d}>{d}日</option>
            ))}
          </select>
        </FormField>
        <CatalogFieldInputs fields={definition.fields ?? []} values={{}} disabled />
      </fieldset>
      <p>
        固定の承認者:{' '}
        {approvers.find((a) => a.id === definition.approval?.approverId)?.name ??
          '未設定・現在無効'}
      </p>
    </section>
  );
}
