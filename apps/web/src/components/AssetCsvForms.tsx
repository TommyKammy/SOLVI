'use client';
import { useActionState, useState } from 'react';
import { prepareCsv, applyCsv, type CsvFeedback } from '../app/assets/imports/actions';
import { FeedbackForm, FormField } from './FeedbackForm';
import { ContextLink } from './ContextLink';
import type { FormFeedback } from '../lib/form-state';
export function AssetCsvForm() {
  const [csv, setCsv] = useState('');
  const [sourceKey, setSourceKey] = useState('synthetic-demo');
  const [reason, setReason] = useState('合成データでCSV取込を試す');
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [feedback, action, pending] = useActionState(prepareCsv, {
    message: '',
    csv: '',
  } as CsvFeedback);
  const inspection = feedback.csv === csv ? feedback.inspection : undefined;
  const example = () => {
    setMapping({});
    const marker = Date.now().toString();
    setCsv(
      'externalId,assetTag,name,kind,state,model,serialNumber,hostname,vendor,assignedUserEmail\n' +
        `demo-pc-${marker},SYN-PC-${marker},"合成ノートPC, 検証用",pc,in_use,Synthetic Notebook,SYN-SERIAL-${marker},syn-${marker},Synthetic Vendor,requester@acme.example.test\n` +
        `demo-saas-${marker},SYN-SAAS-${marker},合成サービス,saas,stocked,Synthetic Helpdesk,,,Synthetic Vendor,\n` +
        `demo-error-${marker},SYN-ERROR-${marker},不正行の例,pc,stocked,,,,,\n`,
    );
  };
  return (
    <FeedbackForm action={action} feedback={feedback} pending={pending} className="stack">
      <FormField>
        <label htmlFor="csv-source">取込元（必須・同じ元には同じ名前）</label>
        <input
          id="csv-source"
          name="sourceKey"
          value={sourceKey}
          onChange={(e) => setSourceKey(e.target.value)}
          pattern="[a-z0-9](?:[a-z0-9_]|-){0,63}"
          maxLength={64}
          required
        />
        <p className="hint">
          小文字の英数字、ハイフン、アンダースコア。外部IDと組み合わせて資産を識別します。
        </p>
      </FormField>
      <FormField>
        <label htmlFor="csv-reason">取込理由（必須）</label>
        <input
          id="csv-reason"
          name="reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={1000}
          required
        />
      </FormField>
      <FormField>
        <label htmlFor="csv-text">CSVテキスト（見出し付き・100行 / UTF-8 24KiBまで）</label>
        <textarea
          id="csv-text"
          name="csv"
          value={csv}
          onChange={(e) => {
            setCsv(e.target.value);
            setMapping({});
          }}
          rows={10}
          maxLength={24576}
          required
          spellCheck={false}
        />
        <p className="hint">
          BOM・CRLF・引用符に対応。PC/サーバー/ネットワーク機器はモデル・シリアル・ホスト名が必須です。種別:
          pc / server / vm / network / mobile / saas、状態: stocked / in_use / repair / retired。
        </p>
      </FormField>
      <div className="actions-row">
        <button type="button" onClick={example} disabled={pending}>
          合成例を入力する
        </button>
        <button name="intent" value="inspect" disabled={pending} formNoValidate>
          {pending ? '確認しています…' : '列を確認する'}
        </button>
      </div>
      {inspection && (
        <>
          <h2>列の対応付け</h2>
          <p>
            未対応の任意列は既存値を保持します。対応列の空欄は値を消します。新規の未対応状態は在庫です。利用者メールは同じ組織の有効な1名に一致する必要があります。
          </p>
          <div className="table-scroll">
            <table className="tickets">
              <caption className="visually-hidden">資産属性とCSV列</caption>
              <thead>
                <tr>
                  <th scope="col">資産属性</th>
                  <th scope="col">CSVの列</th>
                </tr>
              </thead>
              <tbody>
                {inspection.fields.map((f) => (
                  <tr key={f.key}>
                    <td>
                      <label htmlFor={`csv-map-${f.key}`}>
                        {f.label}
                        {f.required ? '（必須）' : ''}
                      </label>
                    </td>
                    <td>
                      <FormField>
                        <select
                          key={inspection.headers.join('|')}
                          id={`csv-map-${f.key}`}
                          name={`map.${f.key}`}
                          required={f.required}
                          value={
                            mapping[f.key] ??
                            (inspection.headers.includes(f.key)
                              ? f.key
                              : inspection.headers.includes(f.label)
                                ? f.label
                                : '')
                          }
                          onChange={(e) => setMapping((m) => ({ ...m, [f.key]: e.target.value }))}
                        >
                          <option value="">対応なし</option>
                          {inspection.headers.map((h) => (
                            <option key={h} value={h}>
                              {h}
                            </option>
                          ))}
                        </select>
                      </FormField>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary>先頭3行のCSV内容を確認する</summary>
            <div className="table-scroll">
              <table className="tickets">
                <thead>
                  <tr>
                    {inspection.headers.map((h) => (
                      <th key={h} scope="col">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {inspection.sample.map((r, i) => (
                    <tr key={i}>
                      {r.map((v, j) => (
                        <td key={j}>{v || '（空欄）'}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <button name="intent" value="preview" disabled={pending}>
            {pending ? '確認しています…' : '取込プレビューを作成する'}
          </button>
        </>
      )}
      <ContextLink back href="/assets/imports">
        キャンセルして戻る
      </ContextLink>
    </FeedbackForm>
  );
}
export function ApplyAssetCsvForm({
  id,
  planHash,
  count,
}: {
  id: string;
  planHash: string;
  count: number;
}) {
  const [feedback, action, pending] = useActionState(applyCsv.bind(null, id), {
    message: '',
  } as FormFeedback);
  return (
    <FeedbackForm action={action} feedback={feedback} pending={pending} className="stack">
      <input type="hidden" name="planHash" value={planHash} />
      <FormField>
        <label>
          <input type="checkbox" name="confirmed" required /> 差分と不正行を確認しました。正常
          {count}
          行を確定し、不正行とCSVにない資産を変更しません。
        </label>
      </FormField>
      <ContextLink href="/assets/imports/new">CSVを再プレビューする</ContextLink>
      <button disabled={pending}>
        {pending ? '保存しています…' : `正常${count}行の取込を確定する`}
      </button>
    </FeedbackForm>
  );
}
