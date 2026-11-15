// NFR-UX-002: user-facing times are always Japan Standard Time, not the server zone.
import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, jstToday } from '../../apps/web/src/lib/labels';
import { parseRelationshipHistoryQuery } from '../../apps/web/src/lib/approval-route';

describe('Japan Standard Time formatters', () => {
  it('formats a UTC instant on the next JST day', () => {
    expect(formatDate('2026-11-15T16:30:00.000Z')).toBe('2026/11/16');
    expect(formatDateTime('2026-11-15T16:30:00.000Z')).toContain('11月16日');
    expect(formatDateTime('2026-11-15T16:30:00.000Z')).toContain('01:30');
  });

  it('returns the JST calendar day regardless of the server timezone', () => {
    expect(jstToday(new Date('2026-11-15T14:59:59.000Z'))).toBe('2026-11-15');
    expect(jstToday(new Date('2026-11-15T15:00:00.000Z'))).toBe('2026-11-16');
  });

  it('uses the JST day as the relationship history default', () => {
    const query = parseRelationshipHistoryQuery({}, '2026-11-16');
    expect(query.to).toBe('2026-11-16');
    expect(query.from).toBe('2026-10-18');
  });
});
