'use client';
import { useActionState, useState } from 'react';
import {
  searchLinkAssets,
  linkTicketAsset,
  unlinkTicketAsset,
  type AssetSearchFeedback,
} from '../app/assets/actions';
import { FeedbackForm, FormField } from './FeedbackForm';
import { ContextLink } from './ContextLink';
import type { FormFeedback } from '../lib/form-state';
import { assetKindLabel, assetStateLabel } from '../lib/asset-labels';
export function TicketAssetLinkForm({ ticketId }: { ticketId: string }) {
  const [search, searchAction, searching] = useActionState(searchLinkAssets, {
    message: '',
    items: [],
    query: '',
    searched: false,
  } as AssetSearchFeedback);
  const [feedback, linkAction, pending] = useActionState(linkTicketAsset.bind(null, ticketId), {
    message: '',
  } as FormFeedback);
  const [query, setQuery] = useState(''),
    [reason, setReason] = useState('');
  return (
    <details>
      <summary>資産を検索して関連付ける</summary>
      <FeedbackForm
        action={searchAction}
        feedback={{ message: search.items.length ? '' : search.message }}
        pending={searching}
        className="filters"
      >
        <FormField>
          <label htmlFor="ticket-asset-query">資産タグ・名前・シリアル・ホスト名で検索</label>
          <input
            id="ticket-asset-query"
            name="q"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            maxLength={200}
          />
        </FormField>
        <button disabled={searching}>{searching ? '検索しています…' : '資産を検索する'}</button>
      </FeedbackForm>
      {search.message && <p role="status">{search.message}</p>}
      {search.searched && !search.items.length && (
        <p role="status">
          追加できる資産はありません。検索語を変えるか、
          <ContextLink href="/assets/new">資産を登録</ContextLink>
          してください。
        </p>
      )}
      {!!search.items.length && (
        <FeedbackForm action={linkAction} feedback={feedback} pending={pending} className="stack">
          <FormField>
            <label htmlFor="ticket-asset-select">対象資産</label>
            <select
              key={`${search.query}-${search.items.map((a) => a.id).join(',')}-${feedback.attempt ?? 0}`}
              id="ticket-asset-select"
              name="assetId"
              defaultValue={feedback.values?.assetId ?? ''}
              required
            >
              <option value="">対象を選んでください</option>
              {search.items.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.assetTag} · {a.name} · {assetKindLabel(a.kind)} · {assetStateLabel(a.state)}
                </option>
              ))}
            </select>
          </FormField>
          <FormField>
            <label htmlFor="ticket-asset-reason">関連付ける理由</label>
            <textarea
              id="ticket-asset-reason"
              name="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={1000}
              required
            />
          </FormField>
          <button disabled={pending}>{pending ? '保存しています…' : '資産を関連付ける'}</button>
        </FeedbackForm>
      )}
    </details>
  );
}
export function TicketAssetUnlinkForm({
  ticketId,
  assetId,
  version,
}: {
  ticketId: string;
  assetId: string;
  version: number;
}) {
  const [feedback, action, pending] = useActionState(
    unlinkTicketAsset.bind(null, ticketId, assetId),
    { message: '' } as FormFeedback,
  );
  const [reason, setReason] = useState('');
  return (
    <details>
      <summary>この資産の関連を解除する</summary>
      <FeedbackForm action={action} feedback={feedback} pending={pending} className="stack">
        <input type="hidden" name="expectedVersion" value={version} />
        <FormField>
          <label htmlFor={`asset-unlink-${assetId}`}>解除する理由</label>
          <textarea
            id={`asset-unlink-${assetId}`}
            name="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={1000}
            required
          />
        </FormField>
        <p className="hint">資産とこれまでの関連履歴は残ります。</p>
        <button disabled={pending} className="secondary">
          {pending ? '保存しています…' : '理由を残して関連を解除する'}
        </button>
      </FeedbackForm>
    </details>
  );
}
