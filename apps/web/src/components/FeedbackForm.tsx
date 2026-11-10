'use client';
import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  startTransition,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type FormHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { FormFeedback } from '../lib/form-state';
import { ReturnToField } from './ContextLink';

const FeedbackContext = createContext<FormFeedback>({ message: '' });
type ControlProps = {
  name?: string;
  children?: ReactNode;
  type?: string;
  'aria-describedby'?: string;
};

export function validationMessage(message: string): string {
  let match = message.match(
    /(?:String must contain at least\s*|Too small: expected string to have >=)(\d+)/,
  );
  if (match) return `${match[1]}文字以上で入力してください。`;
  match = message.match(
    /(?:String must contain at most\s*|Too big: expected string to have <=)(\d+)/,
  );
  if (match) return `${match[1]}文字以内に短くしてください。`;
  if (/Array must contain at least/i.test(message))
    return '必要な数の項目を選択・追加してください。';
  if (/Array must contain at most/i.test(message)) return '項目数を上限以内に減らしてください。';
  if (/Expected number|expected number|Invalid.*number|greater than|less than/i.test(message))
    return '指定された範囲の数値を入力してください。';
  if (/Invalid.*uuid|Invalid.*UUID/i.test(message)) return '一覧から選び直してください。';
  if (/Invalid enum|Invalid option/i.test(message))
    return '表示されている選択肢から選んでください。';
  if (/Required|expected string|expected boolean/i.test(message))
    return 'この項目を入力・選択してください。';
  if (/^Invalid/i.test(message)) return '形式が条件に合いません。項目のヒントを確認してください。';
  return message;
}
function inputName(field: string): string {
  if (field.startsWith('values.')) return 'value:' + field.slice(7);
  return field
    .replace(/^definition\./, '')
    .replace(/^approval\./, '')
    .replace(/^metadata\./, '');
}
function fieldLabel(field: string): string {
  const names: Record<string, string> = {
    subject: '件名',
    title: 'タイトル',
    body: '内容',
    reason: '理由',
    assetTag: '資産タグ',
    name: '資産名',
    serialNumber: 'シリアル番号',
    model: 'モデル',
    hostname: 'ホスト名',
    kind: '種別',
    state: '状態',
    assignedUserId: '利用者',
    ownerId: '実施担当者',
    approverId: '承認者',
    ticketId: '元のチケット',
    assetIds: '対象資産',
    plannedStart: '開始予定',
    plannedEnd: '終了予定',
    code: '管理コード',
    description: '利用者への説明',
    targetLabel: '模擬対象の表示名',
    allowedDurations: '利用日数の候補',
    maxReasonLength: '理由の文字数上限',
    durationDays: '希望する利用日数',
    tags: '検索のためのタグ',
    audience: '閲覧範囲',
    purpose: '目的',
    impact: '影響',
    urgency: '急ぎ具合',
    groupId: '担当グループ',
    targetTicketNumber: '相手の受付番号',
    relationType: '関係',
    assetId: '対象資産',
    sourceKey: '取込元',
    csv: 'CSVテキスト',
    confirmed: '差分の確認',
    implementationPlan: '実施手順',
    testPlan: '確認手順',
    backoutPlan: '切り戻し手順',
  };
  const name = inputName(field);
  const added = name.match(/^fields\.(\d+)/);
  if (added) return `追加の申請項目${Number(added[1]) + 1}`;
  return names[name.split('.')[0]] ?? '入力項目';
}
function controls(children: ReactNode): string[] {
  const names: string[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement<ControlProps>(child)) return;
    if (child.props.name) names.push(child.props.name);
    names.push(...controls(child.props.children));
  });
  return names;
}

/** 既存の.field構造のまま、入力と直近エラーを関連付ける。 */
export function FormField({
  children,
  className = 'field',
  name,
}: {
  children: ReactNode;
  className?: string;
  name?: string;
}) {
  const feedback = useContext(FeedbackContext),
    id = useId();
  const names = name ? [name] : controls(children);
  const errors =
    feedback.errors?.filter((e) =>
      names.some((n) => inputName(e.field) === n || inputName(e.field).startsWith(n + '.')),
    ) ?? [];
  const decorate = (nodes: ReactNode): ReactNode =>
    Children.map(nodes, (child) => {
      if (!isValidElement<ControlProps>(child)) return child;
      const element = child as ReactElement<ControlProps>;
      const invalid =
        element.props.name &&
        errors.some(
          (e) =>
            inputName(e.field) === element.props.name ||
            inputName(e.field).startsWith(element.props.name + '.'),
        );
      const props =
        invalid && element.props.type !== 'hidden'
          ? {
              'aria-invalid': true,
              'aria-describedby': [element.props['aria-describedby'], id].filter(Boolean).join(' '),
            }
          : {};
      return cloneElement(
        element,
        props,
        element.props.children ? decorate(element.props.children) : undefined,
      );
    });
  return (
    <div className={className} data-error-field={name} tabIndex={name ? -1 : undefined}>
      {decorate(children)}
      {errors.length > 0 && (
        <p id={id} className="field-error">
          {errors.map((e) => validationMessage(e.message)).join(' ')}
        </p>
      )}
    </div>
  );
}

export function FeedbackSummary({ feedback }: { feedback: FormFeedback }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (feedback.message) ref.current?.focus();
  }, [feedback.message, feedback.attempt]);
  if (!feedback.message) return null;
  return (
    <div className="error-summary" role="alert" tabIndex={-1} ref={ref}>
      <h2>保存・送信できませんでした</h2>
      <p>{validationMessage(feedback.message)}</p>
      {feedback.errors?.length ? (
        <ul>
          {feedback.errors.map((e, i) => (
            <li key={i}>
              <button
                type="button"
                className="error-link"
                onClick={() => {
                  const form = ref.current?.closest('form');
                  const target = Array.from(
                    form?.querySelectorAll<
                      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
                    >('input, select, textarea') ?? [],
                  ).find((c) => c.type !== 'hidden' && c.name === inputName(e.field));
                  if (target) target.focus();
                  else
                    Array.from(form?.querySelectorAll<HTMLElement>('[data-error-field]') ?? [])
                      .find(
                        (c) =>
                          inputName(e.field) === c.dataset.errorField ||
                          inputName(e.field).startsWith(c.dataset.errorField + '.'),
                      )
                      ?.focus();
                }}
              >
                {e.label ?? fieldLabel(e.field)}: {validationMessage(e.message)}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="hint">
        この画面の入力は保持しています。
        {feedback.message.includes('送信結果')
          ? '一覧や詳細で保存済みか確認してから、必要な場合だけ再送してください。'
          : '内容を確認して、もう一度送信してください。'}
      </p>
      {/ログイン/.test(feedback.message) && (
        <p>
          <a href="/login" target="_blank" rel="noopener">
            別のタブでログインする
          </a>
        </p>
      )}
      {/古|競合|変更され|最新では/.test(feedback.message) && (
        <p>
          <a href="" target="_blank" rel="noopener">
            最新の状態を別タブで確認する
          </a>
          。入力を一時保存してから
          <a href="">この画面を再読込する</a>
          と、最新の内容へ保存済みの下書きを比較して復元できます（対応フォームのみ）。
        </p>
      )}
    </div>
  );
}

export function FeedbackForm({
  feedback,
  pending,
  children,
  onSubmit,
  onSuccess,
  returnToCurrent = false,
  ...props
}: FormHTMLAttributes<HTMLFormElement> & {
  feedback: FormFeedback;
  pending: boolean;
  returnToCurrent?: boolean;
  onSuccess?: () => void;
}) {
  const submitting = useRef(false);
  useEffect(() => {
    if (feedback.redirectTo) {
      onSuccess?.();
      window.location.assign(feedback.redirectTo);
    }
  }, [feedback.redirectTo, onSuccess]);
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const [localFeedback, setLocalFeedback] = useState<FormFeedback | null>(null);
  useEffect(() => {
    if (!pending) submitting.current = false;
  }, [pending, feedback.attempt, feedback.message]);
  return (
    <FeedbackContext.Provider value={localFeedback ?? feedback}>
      <form
        {...props}
        noValidate
        aria-busy={pending || !ready}
        inert={!ready}
        onReset={(event) => event.preventDefault()}
        onSubmit={(event) => {
          if (submitting.current || pending) {
            event.preventDefault();
            return;
          }
          const submitter = (event.nativeEvent as SubmitEvent)
            .submitter as HTMLButtonElement | null;
          const errors = submitter?.formNoValidate
            ? []
            : Array.from(
                event.currentTarget.querySelectorAll<
                  HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
                >('input, select, textarea'),
              )
                .filter((control) => control.willValidate && !control.validity.valid)
                .map((control) => ({
                  field: control.name,
                  label: control.labels?.[0]?.textContent?.trim(),
                  message: control.validity.valueMissing
                    ? control.type === 'checkbox'
                      ? '内容を確認してチェックしてください。'
                      : control.tagName === 'SELECT'
                        ? '選択肢から選んでください。'
                        : 'この項目を入力してください。'
                    : control.validity.patternMismatch
                      ? '項目のヒントに示した形式で入力してください。'
                      : control.validity.rangeUnderflow || control.validity.rangeOverflow
                        ? `${control.getAttribute('min')}〜${control.getAttribute('max')}の範囲で入力してください。`
                        : control.validity.tooLong
                          ? `${control.getAttribute('maxlength')}文字以内に短くしてください。`
                          : '入力の形式を確認してください。',
                }));
          if (errors.length) {
            event.preventDefault();
            setLocalFeedback((previous) => ({
              message: '入力が必要な項目・形式を確認してください。',
              errors,
              attempt: (previous?.attempt ?? 0) + 1,
            }));
            return;
          }
          setLocalFeedback(null);
          submitting.current = true;
          if (onSubmit) onSubmit(event);
          else if (typeof props.action === 'function') {
            // Reactの自動resetはエラー時にもselectを初期値へ戻す。
            // 明示的にdispatchし、押された判断ボタンもFormDataに残す。
            event.preventDefault();
            const data = new FormData(
              event.currentTarget,
              (event.nativeEvent as SubmitEvent).submitter,
            );
            const action = props.action;
            startTransition(() => {
              void action(data);
            });
          }
        }}
      >
        {!ready && (
          <p role="status" className="hint">
            入力画面を準備しています…
          </p>
        )}
        <ReturnToField current={returnToCurrent} />
        <FeedbackSummary feedback={localFeedback ?? feedback} />
        {children}
      </form>
    </FeedbackContext.Provider>
  );
}
