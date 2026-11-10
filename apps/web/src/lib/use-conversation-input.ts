'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ReplyContext } from './api';
import type { FormFeedback } from './form-state';
import { clearFormDrafts, draftKey, type DraftValues } from './form-draft';

type Mode = 'public' | 'internal';
const empty = (context: ReplyContext) => ({ body: '', citation: '', context });
export const conversationVersion = (context: ReplyContext) =>
  `${context.ticketVersion}/${context.latestCommentId ?? 'none'}`;

/** Keep input separate from refreshed server state until the person acknowledges it. */
export function useConversationInput(
  scope: string,
  formKey: string,
  current: ReplyContext,
  feedback: FormFeedback,
) {
  const router = useRouter();
  const [visibility, setVisibility] = useState<Mode>('public');
  const [drafts, setDrafts] = useState({ public: empty(current), internal: empty(current) });
  const handled = useRef('');
  const draft = drafts[visibility];
  const update = (values: Partial<DraftValues>) =>
    setDrafts((all) => {
      const previous = all[visibility];
      return {
        ...all,
        [visibility]: {
          ...previous,
          context: previous.body || previous.citation ? previous.context : current,
          ...values,
        },
      };
    });
  const restore = (values: DraftValues) =>
    setDrafts((all) => ({
      ...all,
      [visibility]: { ...all[visibility], ...values, context: current },
    }));
  const changed =
    conversationVersion(draft.context) !== conversationVersion(current) &&
    !!(draft.body || draft.citation);
  useEffect(() => {
    if (!feedback.scopeChanged) return;
    setDrafts({ public: empty(current), internal: empty(current) });
    try {
      clearFormDrafts();
    } catch {
      /* disabled */
    }
    window.dispatchEvent(new Event('solvi:drafts-cleared'));
    window.location.reload();
  }, [feedback.scopeChanged]);
  useEffect(() => {
    const clear = () => setDrafts({ public: empty(current), internal: empty(current) });
    window.addEventListener('solvi:drafts-cleared', clear);
    return () => window.removeEventListener('solvi:drafts-cleared', clear);
  }, [scope, formKey, current.ticketVersion, current.latestCommentId]);
  useEffect(() => {
    if (!feedback.postedCommentId || handled.current === feedback.postedCommentId) return;
    handled.current = feedback.postedCommentId;
    const sent = feedback.postedVisibility ?? 'public';
    setDrafts((all) => ({ ...all, [sent]: empty(current) }));
    try {
      sessionStorage.removeItem(draftKey(scope, `${formKey}:${sent}`));
    } catch {
      /* disabled */
    }
    router.refresh();
  }, [feedback.postedCommentId, feedback.postedVisibility, scope, formKey, router]);
  return {
    visibility,
    setVisibility,
    draft,
    update,
    restore,
    changed,
    reload: () => router.refresh(),
    acknowledge: () =>
      setDrafts((all) => ({ ...all, [visibility]: { ...all[visibility], context: current } })),
  };
}
