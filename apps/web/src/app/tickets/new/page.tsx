import { redirect } from 'next/navigation';
import { api } from '../../../lib/api';

/**
 * 起票フォーム (WP-P2-PORTAL-002 / FR-TKT-001)。
 *
 * 設計の要点は「入力させる項目を増やさない」こと。
 *
 * 分類・カテゴリ・サブカテゴリを選ばせる作りにすると、利用者は
 * 「どれを選べばいいか分からない」で止まる。結果として電話に戻る。
 * 件名と内容、そして影響と緊急度の2つだけにする。
 * 優先度はその2つから機械的に導く(FR-TKT-002)ため、利用者に選ばせない。
 */

export const dynamic = 'force-dynamic';

const KINDS = { incident: '障害の報告', request: '依頼' } as const;

async function submit(formData: FormData): Promise<void> {
  'use server';

  const kind = String(formData.get('kind') ?? 'request');
  const result = await api.createTicket({
    kind,
    subject: String(formData.get('subject') ?? ''),
    body: String(formData.get('body') ?? ''),
    impact: String(formData.get('impact') ?? 'medium'),
    urgency: String(formData.get('urgency') ?? 'medium'),
  });

  if (!result.ok) {
    if (result.problem.status === 401) redirect('/login');
    // 検証エラーはクエリで持ち回す。**入力値は載せない** —
    // 件名や内容がURLに乗ると、ブラウザ履歴と参照元ヘッダに業務情報が残る。
    const params = new URLSearchParams({ kind, error: '1' });
    for (const error of result.problem.errors ?? []) {
      params.append('field', `${error.field}:${error.message}`);
    }
    redirect(`/tickets/new?${params.toString()}`);
  }

  redirect(`/tickets/${result.data.id}?created=1`);
}

export default async function NewTicketPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const kindParam = String(params.kind ?? 'request');
  const kind = kindParam in KINDS ? (kindParam as keyof typeof KINDS) : 'request';
  const isIncident = kind === 'incident';

  const rawFields = params.field;
  const fieldList = Array.isArray(rawFields) ? rawFields : rawFields ? [rawFields] : [];
  const errors: Record<string, string> = {};
  for (const entry of fieldList) {
    const index = entry.indexOf(':');
    if (index > 0) errors[entry.slice(0, index)] = entry.slice(index + 1);
  }
  const hasErrors = Object.keys(errors).length > 0 || params.error !== undefined;

  return (
    <main id="main" className="shell">
      <h1>{KINDS[kind]}</h1>
      <p className="lead">
        {isIncident
          ? '発生している事象をお知らせください。分かる範囲で構いません。'
          : 'ご希望の内容をお知らせください。'}
      </p>

      {hasErrors && (
        // エラー要約。送信直後にここへフォーカスを移す。
        // 各項目のエラーだけだと、画面下部の項目で失敗したときに気付けない。
        <div className="error-summary" role="alert" tabIndex={-1} autoFocus>
          <h2>入力内容を確認してください</h2>
          <ul>
            {Object.entries(errors).map(([field, message]) => (
              <li key={field}>
                {/* 該当項目へ飛べるようにする。「どこが違うのか」を
                    探させないことが、やり直しの負担を減らす */}
                <a href={`#${field}`}>{message}</a>
              </li>
            ))}
            {Object.keys(errors).length === 0 && <li>送信できませんでした。</li>}
          </ul>
        </div>
      )}

      <form className="stack" action={submit} style={{ marginTop: '1.5rem' }}>
        <input type="hidden" name="kind" value={kind} />

        <div className="field">
          <label htmlFor="subject">件名</label>
          <span className="hint" id="subject-hint">
            {isIncident ? '例: 経費精算システムにログインできない' : '例: 新入社員のアカウント作成'}
          </span>
          <input
            id="subject"
            name="subject"
            type="text"
            maxLength={200}
            required
            aria-describedby={errors.subject ? 'subject-hint subject-error' : 'subject-hint'}
            aria-invalid={errors.subject ? true : undefined}
          />
          {errors.subject && (
            <span className="field-error" id="subject-error">
              {errors.subject}
            </span>
          )}
        </div>

        <div className="field">
          <label htmlFor="body">内容</label>
          <span className="hint" id="body-hint">
            {isIncident
              ? 'いつから、何をしたときに、どうなるかをお書きください。エラーメッセージがあれば貼り付けてください。'
              : '必要な理由と希望する時期をお書きください。'}
          </span>
          <textarea
            id="body"
            name="body"
            maxLength={10000}
            required
            aria-describedby={errors.body ? 'body-hint body-error' : 'body-hint'}
            aria-invalid={errors.body ? true : undefined}
          />
          {errors.body && (
            <span className="field-error" id="body-error">
              {errors.body}
            </span>
          )}
        </div>

        <div className="field">
          <label htmlFor="impact">影響の範囲</label>
          <span className="hint" id="impact-hint">
            困っているのはご自身だけか、部署全体かを選んでください。
          </span>
          <select id="impact" name="impact" defaultValue="medium" aria-describedby="impact-hint">
            <option value="low">自分だけ困っている</option>
            <option value="medium">同じ部署の何人かが困っている</option>
            <option value="high">部署全体・全社が困っている</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="urgency">急ぎ具合</label>
          <span className="hint" id="urgency-hint">
            いつまでに解決が必要かを選んでください。
          </span>
          <select
            id="urgency"
            name="urgency"
            defaultValue={isIncident ? 'high' : 'medium'}
            aria-describedby="urgency-hint"
          >
            <option value="low">数日待てる</option>
            <option value="medium">今日中に解決したい</option>
            <option value="high">いま業務が止まっている</option>
          </select>
        </div>

        <button type="submit">送信する</button>
      </form>
    </main>
  );
}
