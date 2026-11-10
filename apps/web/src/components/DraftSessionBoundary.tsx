'use client';
import { useEffect } from 'react';
import { bindDraftScope, clearFormDrafts, currentDraftScope } from '../lib/form-draft';

export function DraftSessionBoundary({ scope }: { scope: string | null }) {
  useEffect(() => {
    try {
      if (scope) bindDraftScope(scope);
    } catch {
      /* Storage can be disabled. */
    }
    const invalidate = () => {
      try {
        clearFormDrafts();
      } catch {
        /* Nothing can be persisted. */
      }
      window.dispatchEvent(new Event('solvi:drafts-cleared'));
    };
    const channel =
      typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('solvi:draft-session');
    if (channel) channel.onmessage = invalidate;
    const check = async () => {
      if (document.visibilityState !== 'visible' || !scope) return;
      try {
        const current = await currentDraftScope();
        if (current && current !== scope) {
          invalidate();
          window.location.reload();
        }
      } catch {
        /* Form recovery itself reports read failures. */
      }
    };
    window.addEventListener('pageshow', check);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      channel?.close();
      window.removeEventListener('pageshow', check);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [scope]);
  return null;
}

export function LogoutForm() {
  return (
    <form
      action="/logout"
      method="post"
      onSubmit={() => {
        try {
          clearFormDrafts();
        } catch {
          /* Server response also requests clearing. */
        }
        window.dispatchEvent(new Event('solvi:drafts-cleared'));
        if (typeof BroadcastChannel !== 'undefined') {
          const channel = new BroadcastChannel('solvi:draft-session');
          channel.postMessage('logout');
          channel.close();
        }
      }}
    >
      <button className="secondary" type="submit">
        ログアウト
      </button>
    </form>
  );
}
