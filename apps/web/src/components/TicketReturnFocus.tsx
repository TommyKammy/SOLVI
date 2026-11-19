'use client';

import { useEffect } from 'react';
import { ticketEntryPrefix, ticketListHeadingId } from '../lib/navigation';

/** Returning from a ticket can leave the row outside an unread or status filter. */
export function TicketReturnFocus() {
  useEffect(() => {
    const restore = () => {
      const id = window.location.hash.slice(1);
      if (!id.startsWith(ticketEntryPrefix)) return;
      const target = document.getElementById(id) ?? document.getElementById(ticketListHeadingId);
      if (!target) return;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'center', inline: 'nearest' });
    };
    const frame = window.requestAnimationFrame(restore);
    window.addEventListener('hashchange', restore);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('hashchange', restore);
    };
  }, []);

  return null;
}
