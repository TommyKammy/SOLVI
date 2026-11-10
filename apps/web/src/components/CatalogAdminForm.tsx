'use client';
import { useActionState, useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { FeedbackForm, FormField } from './FeedbackForm';
import { ContextLink } from './ContextLink';
import type {
  CatalogAdminDetail,
  CatalogAuthoringOptions,
  CatalogField,
  CatalogItem,
} from '../lib/api';
import type { FormFeedback } from '../lib/form-state';
import { saveCatalog, publishCatalog } from '../app/catalog/manage/actions';
import { CatalogFieldInputs } from './CatalogFieldInputs';
import { catalogTemplates } from '../lib/catalog-templates';
import styles from './CatalogAdminForm.module.css';
import { CatalogLivePreview } from './CatalogLivePreview';
import { catalogRequestFieldVisibility, type CatalogSection } from '@solvi/shared/catalog';
import {
  appendCatalogQuestionSet,
  cloneCatalogContent,
  type CatalogInitialContent,
} from '../lib/catalog-reuse';

type EditorValues = {
  code: string;
  title: string;
  description: string;
  target: string;
  days: string;
  maxReason: number;
  requestFields: CatalogItem['definition']['requestFields'];
  approver: string;
  fields: CatalogField[];
  category: string;
  sections: CatalogSection[];
  ownerId: string;
  fulfillmentGroupId: string;
  checklist: NonNullable<CatalogItem['definition']['checklist']>;
};

function editorValues(
  item?: CatalogAdminDetail,
  initialContent?: CatalogInitialContent,
  viewerId = '',
): EditorValues {
  const d =
    item?.draft ?? (initialContent ? cloneCatalogContent(initialContent, viewerId) : undefined);
  return {
    code: item?.code ?? '',
    title: d?.title ?? '',
    description: (d?.description ?? '').replace(/\r\n?/g, '\n'),
    target: d?.definition.targetLabel ?? '検証用アクセス',
    days: d?.definition.allowedDurations.join(', ') ?? '1, 7, 30',
    maxReason: d?.definition.maxReasonLength ?? 2000,
    requestFields: d?.definition.requestFields,
    approver: d?.definition.approval?.approverId ?? '',
    fields: d?.definition.fields ?? [],
    category: d?.definition.category ?? '',
    sections: d?.definition.sections ?? [],
    ownerId: item ? (d?.definition.ownerId ?? '') : viewerId,
    fulfillmentGroupId: d?.definition.fulfillmentGroupId ?? '',
    checklist: d?.definition.checklist ?? [],
  };
}

// Compare displayed edit values, retaining field and option array boundaries and order.
function editProjection(values: EditorValues) {
  return JSON.stringify(
    {
      title: values.title,
      description: values.description.replace(/\r\n?/g, '\n'),
      target: values.target,
      days: values.days,
      maxReason: values.maxReason,
      requestFields: catalogRequestFieldVisibility({ requestFields: values.requestFields }),
      approver: values.approver,
      category: values.category,
      ownerId: values.ownerId,
      fulfillmentGroupId: values.fulfillmentGroupId,
      checklist: values.checklist,
      sections: values.sections.map((section) => ({
        ...section,
        description: section.description || undefined,
      })),
      fields: values.fields.map((field) => ({ ...field, helpText: field.helpText || undefined })),
    },
    (_key, value: unknown) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
        : value,
  );
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

function useEditor(
  item?: CatalogAdminDetail,
  busy?: RefObject<boolean>,
  initialContent?: CatalogInitialContent,
  options?: CatalogAuthoringOptions,
) {
  const [feedback, action, pending] = useActionState(
    (previous: FormFeedback, form: FormData) =>
      exclusiveAction(busy, previous, () => saveCatalog(item?.id ?? null, previous, form)),
    { message: '' } as FormFeedback,
  );
  const [values, setState] = useState<EditorValues>(
    editorValues(item, initialContent, options?.viewerId),
  );
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
  initialContent,
  options,
}: {
  item?: CatalogAdminDetail;
  approvers: Array<{ id: string; name: string }>;
  initialContent?: CatalogInitialContent;
  options?: CatalogAuthoringOptions;
}) {
  const editor = useEditor(item, undefined, initialContent, options);
  if (item ? item.canEdit !== true : options?.canCreate !== true)
    return <p className="notice">現在、このサービスの下書きを編集する権限がありません。</p>;
  return (
    <EditorForm
      item={item}
      approvers={approvers}
      editor={editor}
      busy={editor.pending}
      options={options ?? item}
    />
  );
}

function EditorForm({
  item,
  approvers,
  editor,
  busy,
  options = {},
  isBusy = () => busy,
}: {
  item?: CatalogAdminDetail;
  approvers: Array<{ id: string; name: string }>;
  editor: ReturnType<typeof useEditor>;
  busy: boolean;
  options?: CatalogAuthoringOptions;
  isBusy?: () => boolean;
}) {
  const { feedback, action, pending, values, update } = editor;
  const {
    code,
    title,
    description,
    target,
    days,
    maxReason,
    requestFields,
    approver,
    fields,
    category,
    sections,
    ownerId,
    fulfillmentGroupId,
    checklist,
  } = values;
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
  const visibleRequestFields = catalogRequestFieldVisibility({ requestFields });
  const setRequestField = (field: 'reason' | 'duration', visible: boolean) =>
    edit('requestFields', (old) => ({ ...old, [field]: visible }));
  const setApprover = (value: string) => edit('approver', value);
  const setFields = (value: CatalogField[] | ((old: CatalogField[]) => CatalogField[])) =>
    edit('fields', value);
  const setCategory = (value: string) => edit('category', value);
  const setSections = (value: CatalogSection[]) => edit('sections', value);
  const setOwnerId = (value: string) => edit('ownerId', value);
  const setFulfillmentGroupId = (value: string) => edit('fulfillmentGroupId', value);
  const setChecklist = (
    value:
      EditorValues['checklist'] | ((old: EditorValues['checklist']) => EditorValues['checklist']),
  ) => edit('checklist', value);
  const [creationKey, setCreationKey] = useState('');
  const [templateCode, setTemplateCode] = useState('');
  const [questionSetId, setQuestionSetId] = useState('');
  const [reuseFeedback, setReuseFeedback] = useState<{ error: boolean; message: string } | null>(
    null,
  );
  useEffect(() => {
    const key = crypto.randomUUID();
    setCreationKey(key);
    if (!item) setCode('service-' + key);
    // One creation intent and management code per mounted editor, including retries.
  }, []);
  const replace = (index: number, value: CatalogField) =>
    setFields((old) => old.map((f, i) => (i === index ? value : f)));
  const neighbor = (index: number, direction: number, source = fields) => {
    for (
      let candidate = index + direction;
      candidate >= 0 && candidate < source.length;
      candidate += direction
    )
      if ((source[candidate]?.section ?? '') === (source[index]?.section ?? '')) return candidate;
    return -1;
  };
  const moveField = (index: number, direction: number) =>
    setFields((old) => {
      const targetIndex = neighbor(index, direction, old);
      if (targetIndex < 0) return old;
      const next = [...old];
      [next[index], next[targetIndex]] = [next[targetIndex]!, next[index]!];
      return next;
    });
  const changeType = (index: number, type: CatalogField['type']) => {
    const f = fields[index]!;
    replace(index, {
      key: f.key,
      label: f.label,
      required: f.required,
      ...(f.helpText !== undefined ? { helpText: f.helpText } : {}),
      ...(f.section !== undefined ? { section: f.section } : {}),
      ...(f.visibleWhen !== undefined ? { visibleWhen: f.visibleWhen } : {}),
      ...(type === 'select' || type === 'multiselect'
        ? { type, options: ['候補1', '候補2'] }
        : type === 'checkbox' || type === 'date' || type === 'number'
          ? { type }
          : { type, maxLength: type === 'text' ? 200 : 2000 }),
    });
  };
  function insertQuestionSet() {
    if (isBusy()) return;
    const selected = options.questionSets?.find((set) => set.id === questionSetId);
    if (!selected) {
      setReuseFeedback({ error: true, message: '追加する共有質問セットを選んでください。' });
      return;
    }
    const current = editor.current.current;
    const result = appendCatalogQuestionSet(
      { fields: current.fields, sections: current.sections },
      selected,
    );
    if (!result.ok) {
      setReuseFeedback({ error: true, message: result.message });
      return;
    }
    setFields(result.fields);
    setSections(result.sections);
    setReuseFeedback({
      error: false,
      message: `${selected.title}（版${selected.revision}）の質問を追加しました。`,
    });
  }
  function example() {
    setReuseFeedback(null);
    setQuestionSetId('');
    setCategory('アカウント・アクセス');
    setSections([]);
    setTitle('合成アクセス利用申請');
    setDescription('項目定義と独立承認を確認するための合成申請です。外部変更はありません。');
    setTarget('検証用アクセス');
    setApprover(approvers[0]?.id ?? '');
    edit('requestFields', undefined);
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
    setReuseFeedback(null);
    setQuestionSetId('');
    setTitle(template.title);
    setDescription(template.description);
    setTarget(template.targetLabel);
    setDays(template.allowedDurations.join(', '));
    setMaxReason(2000);
    edit('requestFields', template.requestFields ? { ...template.requestFields } : undefined);
    setFields(structuredClone(template.fields));
    setCategory(template.category ?? '');
    setSections(template.sections?.map((section) => ({ ...section })) ?? []);
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
          <input type="hidden" name="sections" value={JSON.stringify(sections)} />
          <input type="hidden" name="checklist" value={JSON.stringify(checklist)} />
          {requestFields !== undefined && (
            <input type="hidden" name="requestFields" value={JSON.stringify(requestFields)} />
          )}
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
                <label htmlFor="catalog-category">業務カテゴリ</label>
                <input
                  id="catalog-category"
                  name="category"
                  value={category}
                  maxLength={80}
                  placeholder="例：PC・周辺機器"
                  onChange={(e) => setCategory(e.target.value)}
                />
                <p className="hint">
                  利用者がサービスを探す分類です。未設定の場合は「未分類」に表示します。
                </p>
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
                このサービスで必要な項目だけを表示します。質問の種類や表示条件を設定し、プレビューで入力を試せます。
              </p>
              <div className={styles.commonFields}>
                <h3>共通の申請項目</h3>
                <label className={styles.visibilityToggle}>
                  <input
                    type="checkbox"
                    id="catalog-show-reason"
                    checked={visibleRequestFields.reason}
                    onChange={(event) => setRequestField('reason', event.target.checked)}
                  />
                  利用する理由を表示する
                </label>
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
                    disabled={!visibleRequestFields.reason}
                    onChange={(e) => setMaxReason(Number(e.target.value))}
                  />
                </FormField>
                {!visibleRequestFields.reason && (
                  <input type="hidden" name="maxReasonLength" value={maxReason} />
                )}
                <label className={styles.visibilityToggle}>
                  <input
                    type="checkbox"
                    id="catalog-show-duration"
                    checked={visibleRequestFields.duration}
                    onChange={(event) => setRequestField('duration', event.target.checked)}
                  />
                  希望する利用日数を表示する
                </label>
                <FormField className="field">
                  <label htmlFor="catalog-days">利用日数の候補</label>
                  <input
                    type="text"
                    id="catalog-days"
                    name="allowedDurations"
                    value={days}
                    required
                    disabled={!visibleRequestFields.duration}
                    onChange={(e) => setDays(e.target.value)}
                  />
                  <p className="hint">1〜365の日数をカンマ区切りで最大10候補。</p>
                </FormField>
                {!visibleRequestFields.duration && (
                  <input type="hidden" name="allowedDurations" value={days} />
                )}
                <p className="hint">非表示にした項目は申請時に入力・保存されません。</p>
              </div>
              <FormField name="fields">
                {!!options.questionSets?.length && (
                  <div className={styles.reuse}>
                    <FormField>
                      <label htmlFor="catalog-question-set">追加する共有質問セット</label>
                      <select
                        id="catalog-question-set"
                        value={questionSetId}
                        onChange={(event) => {
                          setQuestionSetId(event.target.value);
                          setReuseFeedback(null);
                        }}
                      >
                        <option value="">質問セットを選ぶ</option>
                        {options.questionSets.map((set) => (
                          <option key={set.id} value={set.id}>
                            {set.title}（版{set.revision}・{set.fields.length}問）
                          </option>
                        ))}
                      </select>
                    </FormField>
                    <button
                      type="button"
                      className="secondary"
                      disabled={!questionSetId || busy}
                      onClick={insertQuestionSet}
                    >
                      質問セットを追加する
                    </button>
                    <p className="hint">
                      この下書きへ質問をコピーします。元の質問セットの更新は反映されません。
                    </p>
                    {reuseFeedback && (
                      <p
                        role={reuseFeedback.error ? 'alert' : 'status'}
                        className={reuseFeedback.error ? 'field-error' : 'hint'}
                      >
                        {reuseFeedback.message}
                      </p>
                    )}
                  </div>
                )}
                <h3>追加の申請項目</h3>
              </FormField>
              <p className="hint">
                サービスに合わせた質問を最大10件作れます。複数選択では必要なアイテムをチェックでき、表示条件では回答に応じて質問を切り替えられます。
              </p>
              <div className={styles.sectionSettings}>
                <h3>フォームのセクション</h3>
                <p className="hint">
                  質問を用途ごとにまとめます。セクションを外しても質問は残ります。
                </p>
                {sections.map((section, index) => (
                  <fieldset key={section.key} className="stack">
                    <legend>セクション{index + 1}</legend>
                    <FormField className="field">
                      <label htmlFor={`catalog-section-title-${index}`}>
                        セクション名 {index + 1}
                      </label>
                      <input
                        id={`catalog-section-title-${index}`}
                        name={`sections.${index}.title`}
                        value={section.title}
                        maxLength={100}
                        required
                        onChange={(e) =>
                          setSections(
                            sections.map((s, n) =>
                              n === index ? { ...s, title: e.target.value } : s,
                            ),
                          )
                        }
                      />
                    </FormField>
                    <FormField className="field">
                      <label htmlFor={`catalog-section-description-${index}`}>
                        セクションの説明 {index + 1}
                      </label>
                      <textarea
                        id={`catalog-section-description-${index}`}
                        name={`sections.${index}.description`}
                        value={section.description ?? ''}
                        maxLength={500}
                        onChange={(e) =>
                          setSections(
                            sections.map((s, n) =>
                              n === index ? { ...s, description: e.target.value || undefined } : s,
                            ),
                          )
                        }
                      />
                    </FormField>
                    <div className={styles.fieldOrder}>
                      <button
                        type="button"
                        className="secondary"
                        disabled={index === 0}
                        onClick={() => {
                          const next = [...sections];
                          [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                          setSections(next);
                        }}
                      >
                        セクション{index + 1}を上へ
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={index === sections.length - 1}
                        onClick={() => {
                          const next = [...sections];
                          [next[index + 1], next[index]] = [next[index]!, next[index + 1]!];
                          setSections(next);
                        }}
                      >
                        セクション{index + 1}を下へ
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          setSections(sections.filter((s) => s.key !== section.key));
                          setFields(
                            fields.map((field) =>
                              field.section === section.key
                                ? { ...field, section: undefined }
                                : field,
                            ),
                          );
                        }}
                      >
                        セクション{index + 1}を外す
                      </button>
                    </div>
                  </fieldset>
                ))}
                <button
                  type="button"
                  className="secondary"
                  disabled={sections.length >= 10}
                  onClick={() =>
                    setSections([
                      ...sections,
                      {
                        key: 'section_' + crypto.randomUUID().replaceAll('-', '').slice(0, 24),
                        title: '',
                      },
                    ])
                  }
                >
                  セクションを追加する
                </button>
              </div>
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
                      <option value="date">日付</option>
                      <option value="number">数値</option>
                      <option value="multiselect">複数選択（チェックボックス）</option>
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
                  <FormField className="field">
                    <label htmlFor={`field-help-${i}`}>補足説明 {i + 1}</label>
                    <textarea
                      id={`field-help-${i}`}
                      name={`fields.${i}.helpText`}
                      value={f.helpText ?? ''}
                      maxLength={500}
                      placeholder="例：配送先の部署・受取人をご記入ください。"
                      onChange={(e) => replace(i, { ...f, helpText: e.target.value || undefined })}
                    />
                  </FormField>
                  <FormField className="field">
                    <label htmlFor={`field-section-${i}`}>セクション {i + 1}</label>
                    <select
                      id={`field-section-${i}`}
                      name={`fields.${i}.section`}
                      value={f.section ?? ''}
                      onChange={(e) => replace(i, { ...f, section: e.target.value || undefined })}
                    >
                      <option value="">セクションなし</option>
                      {sections.map((section) => (
                        <option key={section.key} value={section.key}>
                          {section.title || '名前を入力してください'}
                        </option>
                      ))}
                    </select>
                  </FormField>
                  <details className={styles.details} open={f.visibleWhen ? true : undefined}>
                    <summary>項目{i + 1}の表示条件</summary>
                    <div className="stack">
                      <FormField className="field">
                        <label htmlFor={`field-condition-${i}`}>表示条件 {i + 1}</label>
                        <select
                          id={`field-condition-${i}`}
                          name={`fields.${i}.visibleWhen.field`}
                          value={f.visibleWhen?.field ?? ''}
                          onChange={(e) => {
                            const source = fields.find((field) => field.key === e.target.value);
                            replace(i, {
                              ...f,
                              visibleWhen: source
                                ? source.type === 'multiselect'
                                  ? { field: source.key, contains: source.options[0] ?? '' }
                                  : {
                                      field: source.key,
                                      equals:
                                        source.type === 'checkbox'
                                          ? true
                                          : source.type === 'select'
                                            ? (source.options[0] ?? '')
                                            : '',
                                    }
                                : undefined,
                            });
                          }}
                        >
                          <option value="">常に表示する</option>
                          {f.visibleWhen &&
                            !fields.some(
                              (field) =>
                                field.key !== f.key &&
                                field.key === f.visibleWhen?.field &&
                                (field.type === 'select' ||
                                  field.type === 'checkbox' ||
                                  field.type === 'multiselect'),
                            ) && (
                              <option value={f.visibleWhen.field}>
                                利用できなくなった質問（条件を選び直してください）
                              </option>
                            )}
                          {fields
                            .filter(
                              (field) =>
                                field.key !== f.key &&
                                (field.type === 'select' ||
                                  field.type === 'checkbox' ||
                                  field.type === 'multiselect'),
                            )
                            .map((field) => (
                              <option key={field.key} value={field.key}>
                                {field.label || '名前が未設定の質問'}
                              </option>
                            ))}
                        </select>
                      </FormField>
                      {f.visibleWhen &&
                        (() => {
                          const source = fields.find((field) => field.key === f.visibleWhen?.field);
                          const options =
                            source?.type === 'checkbox'
                              ? ['true', 'false']
                              : source?.type === 'select' || source?.type === 'multiselect'
                                ? source.options.map((option) => option.trim())
                                : [];
                          const current = String(
                            'contains' in f.visibleWhen
                              ? f.visibleWhen.contains
                              : f.visibleWhen.equals,
                          ).trim();
                          const contains = source?.type === 'multiselect';
                          const validConditionShape =
                            source?.type === 'multiselect'
                              ? 'contains' in f.visibleWhen &&
                                typeof f.visibleWhen.contains === 'string'
                              : source?.type === 'checkbox'
                                ? 'equals' in f.visibleWhen &&
                                  typeof f.visibleWhen.equals === 'boolean'
                                : source?.type === 'select'
                                  ? 'equals' in f.visibleWhen &&
                                    typeof f.visibleWhen.equals === 'string'
                                  : false;
                          const validAnswer = validConditionShape && options.includes(current);
                          return (
                            <FormField className="field">
                              <label htmlFor={`field-condition-value-${i}`}>
                                {contains ? '含む回答' : '一致する回答'} {i + 1}
                              </label>
                              <select
                                id={`field-condition-value-${i}`}
                                name={`fields.${i}.visibleWhen.${contains ? 'contains' : 'equals'}`}
                                value={validAnswer ? current : ''}
                                onChange={(e) =>
                                  replace(i, {
                                    ...f,
                                    visibleWhen: contains
                                      ? { field: f.visibleWhen!.field, contains: e.target.value }
                                      : {
                                          field: f.visibleWhen!.field,
                                          equals:
                                            source?.type === 'checkbox'
                                              ? e.target.value === 'true'
                                              : e.target.value,
                                        },
                                  })
                                }
                              >
                                {!validAnswer && (
                                  <option value="">
                                    {validConditionShape
                                      ? '現在の候補にない回答'
                                      : '回答の型が一致しません（選び直してください）'}
                                  </option>
                                )}
                                {options.map((option) => (
                                  <option key={option} value={option}>
                                    {source?.type === 'checkbox'
                                      ? option === 'true'
                                        ? 'チェックあり'
                                        : 'チェックなし'
                                      : option}
                                  </option>
                                ))}
                              </select>
                              <p className="hint">
                                {contains
                                  ? '選んだ回答が含まれる場合だけ表示します。'
                                  : '選んだ質問の回答が一致した場合だけ表示します。'}
                                非表示の質問への回答は保存しません。
                              </p>
                              {!validConditionShape && (
                                <p role="alert" className="field-error">
                                  質問の種類が変わりました。表示条件と回答を選び直してください。
                                </p>
                              )}
                            </FormField>
                          );
                        })()}
                    </div>
                  </details>
                  {f.type === 'select' || f.type === 'multiselect' ? (
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
                    (f.type === 'text' || f.type === 'textarea') && (
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
                  {f.type === 'date' && (
                    <div className={styles.rangeSettings}>
                      <FormField className="field">
                        <label htmlFor={`field-min-date-${i}`}>最も早い日付 {i + 1}</label>
                        <input
                          type="date"
                          id={`field-min-date-${i}`}
                          name={`fields.${i}.minDate`}
                          value={f.minDate ?? ''}
                          onChange={(e) =>
                            replace(i, { ...f, minDate: e.target.value || undefined })
                          }
                        />
                      </FormField>
                      <FormField className="field">
                        <label htmlFor={`field-max-date-${i}`}>最も遅い日付 {i + 1}</label>
                        <input
                          type="date"
                          id={`field-max-date-${i}`}
                          name={`fields.${i}.maxDate`}
                          value={f.maxDate ?? ''}
                          onChange={(e) =>
                            replace(i, { ...f, maxDate: e.target.value || undefined })
                          }
                        />
                      </FormField>
                    </div>
                  )}
                  {f.type === 'number' && (
                    <div className={styles.rangeSettings}>
                      <FormField className="field">
                        <label htmlFor={`field-min-number-${i}`}>数値の下限 {i + 1}</label>
                        <input
                          type="number"
                          step="any"
                          id={`field-min-number-${i}`}
                          name={`fields.${i}.min`}
                          value={f.min ?? ''}
                          onChange={(e) =>
                            replace(i, {
                              ...f,
                              min: e.target.value === '' ? undefined : Number(e.target.value),
                            })
                          }
                        />
                      </FormField>
                      <FormField className="field">
                        <label htmlFor={`field-max-number-${i}`}>数値の上限 {i + 1}</label>
                        <input
                          type="number"
                          step="any"
                          id={`field-max-number-${i}`}
                          name={`fields.${i}.max`}
                          value={f.max ?? ''}
                          onChange={(e) =>
                            replace(i, {
                              ...f,
                              max: e.target.value === '' ? undefined : Number(e.target.value),
                            })
                          }
                        />
                      </FormField>
                    </div>
                  )}
                  <div className={styles.fieldOrder}>
                    <button
                      type="button"
                      className="secondary"
                      disabled={neighbor(i, -1) < 0}
                      onClick={() => moveField(i, -1)}
                    >
                      項目{i + 1}を上へ
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={neighbor(i, 1) < 0}
                      onClick={() => moveField(i, 1)}
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
              <h3>責任者と処理担当</h3>
              <FormField name="ownerId">
                {options.canPublish === true ? (
                  <>
                    <label htmlFor="catalog-owner">サービスの責任者</label>
                    <select
                      id="catalog-owner"
                      name="ownerId"
                      value={ownerId}
                      onChange={(event) => setOwnerId(event.target.value)}
                    >
                      <option value="">責任者を選ぶ</option>
                      {ownerId && !options.owners?.some((owner) => owner.id === ownerId) && (
                        <option value={ownerId}>現在選べない責任者（選び直してください）</option>
                      )}
                      {options.owners?.map((owner) => (
                        <option key={owner.id} value={owner.id}>
                          {owner.name}
                        </option>
                      ))}
                    </select>
                  </>
                ) : (
                  <>
                    <input type="hidden" name="ownerId" value={ownerId} />
                    <p>
                      <strong>サービスの責任者：</strong>
                      {options.owners?.find((owner) => owner.id === ownerId)?.name ?? '自分'}
                    </p>
                    <p className="hint">責任者の変更と公開は管理者が行います。</p>
                  </>
                )}
              </FormField>
              <FormField name="fulfillmentGroupId">
                <label htmlFor="catalog-fulfillment-group">受付後の担当グループ</label>
                <select
                  id="catalog-fulfillment-group"
                  name="fulfillmentGroupId"
                  value={fulfillmentGroupId}
                  onChange={(event) => setFulfillmentGroupId(event.target.value)}
                >
                  <option value="">担当グループを指定しない</option>
                  {fulfillmentGroupId &&
                    !options.groups?.some((group) => group.id === fulfillmentGroupId) && (
                      <option value={fulfillmentGroupId}>
                        現在選べないグループ（選び直してください）
                      </option>
                    )}
                  {options.groups?.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
                <p className="hint">
                  新しい申請のチケットをこのグループへ振り分けます。個人の担当者は変更しません。
                </p>
              </FormField>
              <h3>作業チェックリスト</h3>
              <p className="hint">
                受付後に担当者が確認する作業です。完了必須の作業が残っている間は、模擬完了できません。最大20件。
              </p>
              {checklist.map((check, index) => (
                <fieldset className={styles.checklistItem} key={check.key}>
                  <legend>作業 {index + 1}</legend>
                  <input type="hidden" name={`checklist.${index}.key`} value={check.key} />
                  <FormField name={`checklist.${index}.label`}>
                    <label htmlFor={`catalog-check-label-${index}`}>作業項目 {index + 1}</label>
                    <input
                      type="text"
                      id={`catalog-check-label-${index}`}
                      name={`checklist.${index}.label`}
                      value={check.label}
                      maxLength={200}
                      required
                      onChange={(event) =>
                        setChecklist((old) =>
                          old.map((entry, position) =>
                            position === index ? { ...entry, label: event.target.value } : entry,
                          ),
                        )
                      }
                    />
                  </FormField>
                  <label>
                    <input
                      type="checkbox"
                      name={`checklist.${index}.required`}
                      checked={check.required}
                      onChange={(event) =>
                        setChecklist((old) =>
                          old.map((entry, position) =>
                            position === index
                              ? { ...entry, required: event.target.checked }
                              : entry,
                          ),
                        )
                      }
                    />{' '}
                    完了を必須にする
                  </label>
                  <div className={styles.fieldOrder}>
                    {([-1, 1] as const).map((direction) => (
                      <button
                        key={direction}
                        type="button"
                        className="secondary"
                        disabled={direction === -1 ? index === 0 : index === checklist.length - 1}
                        onClick={() =>
                          setChecklist((old) => {
                            const next = [...old];
                            const targetIndex = index + direction;
                            if (targetIndex < 0 || targetIndex >= old.length) return old;
                            [next[index], next[targetIndex]] = [next[targetIndex]!, next[index]!];
                            return next;
                          })
                        }
                      >
                        作業項目{index + 1}を{direction === -1 ? '上へ' : '下へ'}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        setChecklist((old) => old.filter((_, position) => position !== index))
                      }
                    >
                      作業項目{index + 1}を外す
                    </button>
                  </div>
                </fieldset>
              ))}
              <button
                type="button"
                className="secondary"
                disabled={checklist.length >= 20}
                onClick={() =>
                  setChecklist((old) => [
                    ...old,
                    {
                      key: 'check_' + crypto.randomUUID().replaceAll('-', '').slice(0, 24),
                      label: '',
                      required: true,
                    },
                  ])
                }
              >
                作業項目を追加する
              </button>
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
            requestFields={requestFields}
            approver={approver}
            fields={fields}
            category={category}
            sections={sections}
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
  if (item.canPublish !== true) return null;
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
      {item.canPublish === true && (
        <CatalogPublicationForm
          item={item}
          feedback={feedback}
          action={action}
          pending={pending}
          blocked={() => isDirty() || isBusy()}
        />
      )}
      {item.canEdit === true ? (
        <details>
          <summary>下書きの項目と承認者を編集する</summary>
          <EditorForm
            item={item}
            approvers={item.approvers}
            editor={editor}
            busy={busy}
            isBusy={isBusy}
            options={item}
          />
        </details>
      ) : (
        <p className="hint">保存済みの内容を表示しています。下書きの編集権限はありません。</p>
      )}
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
  const visibleRequestFields = catalogRequestFieldVisibility(definition);
  return (
    <section id="preview" className="form-panel">
      <h2>保存した下書きのプレビュー</h2>
      <p className="hint">利用者に表示するフォームです。このプレビューから申請は送信されません。</p>
      <h3>{title}</h3>
      <p>{description}</p>
      <p className="hint">業務カテゴリ: {definition.category?.trim() || '未分類'}</p>
      <fieldset disabled className="stack">
        {visibleRequestFields.reason && (
          <FormField className="field">
            <label htmlFor="preview-reason">利用する理由</label>
            <textarea id="preview-reason" maxLength={definition.maxReasonLength} />
          </FormField>
        )}
        {visibleRequestFields.duration && (
          <FormField className="field">
            <label htmlFor="preview-days">希望する利用日数</label>
            <select id="preview-days">
              {definition.allowedDurations.map((d) => (
                <option key={d}>{d}日</option>
              ))}
            </select>
          </FormField>
        )}
        <CatalogFieldInputs
          fields={definition.fields ?? []}
          sections={definition.sections}
          values={{}}
          disabled
        />
      </fieldset>
      <p>
        固定の承認者:{' '}
        {approvers.find((a) => a.id === definition.approval?.approverId)?.name ??
          '未設定・現在無効'}
      </p>
    </section>
  );
}
