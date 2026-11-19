import { describe, expect, it } from 'vitest';
import {
  ticketBackLabel,
  ticketListOrigin,
  ticketReturnTo,
  withReturnTo,
} from '../../apps/web/src/lib/navigation';

describe('staff ticket return context', () => {
  it.each([
    ['/ops/overview?group=mine', '運営状況に戻る'],
    ['/inbox?kind=ticket&q=VPN&page=2&unread=1', '業務受信箱に戻る'],
    [
      '/ops?keyword=VPN&state=new&state=assigned&cursorCreatedAt=2026-11-19T09%3A00%3A00.000Z&cursorId=00000000-0000-4000-9000-000000000001&page=2',
      'チケット一覧に戻る',
    ],
  ])('restores the exact list and focused ticket from %s', (source, label) => {
    const from = ticketReturnTo(source, '123');
    const href = withReturnTo('/ops/123', from);
    const detail = new URL(href, 'https://solvi.local');
    expect(detail.pathname).toBe('/ops/123');
    expect(detail.searchParams.get('returnTo')).toBe(source + '#ticket-entry-123');
    expect(ticketBackLabel(ticketListOrigin(from), true)).toBe(label);
  });

  it.each(['https://other.invalid/ops', '//other.invalid/inbox', '/auth/login', '/ops\\bad'])(
    'rejects an unsupported return path %s',
    (from) => {
      expect(ticketReturnTo(from, '123')).toBeNull();
      expect(withReturnTo('/ops/123', from)).toBe('/ops/123');
      expect(ticketBackLabel(ticketListOrigin(from), false)).toBe('チケット一覧に戻る');
    },
  );

  it('keeps valid context from another workflow', () => {
    const from = '/changes/123?returnTo=%2Fchanges%3Fstate%3Dreview';
    expect(ticketReturnTo(from, '123')).toBe(from);
    expect(ticketBackLabel(ticketListOrigin(from), true)).toBe('元の画面に戻る');
  });
});
