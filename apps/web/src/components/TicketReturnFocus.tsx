'use client';

import { useEffect } from 'react';
import { ticketEntryPrefix, ticketListHeadingId } from '../lib/navigation';

/** Returning from a ticket can leave the row outside an unread or status filter. */
export function TicketReturnFocus({ headingId }: { headingId?: string } = {}) {
  useEffect(() => {
    const restore = () => {
      const id = window.location.hash.slice(1);
      const isHeading = id === headingId;
      if (!isHeading && !id.startsWith(ticketEntryPrefix)) return;
      const target =
        document.getElementById(id) ?? document.getElementById(headingId ?? ticketListHeadingId);
      if (!target) return;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: isHeading ? 'start' : 'center', inline: 'nearest' });
    };
    const frame = window.requestAnimationFrame(restore);
    window.addEventListener('hashchange', restore);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('hashchange', restore);
    };
  }, [headingId]);

  return null;
}
