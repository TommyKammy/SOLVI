import { describe, expect, it } from 'vitest';
import {
  adminReturnTo,
  adminViewPath,
  withAdminReturnTo,
} from '../../apps/web/src/lib/admin-recovery';

describe('management login recovery', () => {
  it.each([
    null,
    ['//example.test'],
    'https://example.test/ops/users',
    '//example.test/ops/users',
    '/\\example.test/ops/users',
    '/ops/users\n',
    '/ops/users/edit',
    '/ops/groups/not-a-group',
    '/ops/audit',
    '/login',
  ])('declines destinations outside the allowed management views: %s', (value) => {
    expect(adminReturnTo(value)).toBeNull();
  });

  it('retains the selected record and valid view inputs without transient actions', () => {
    const id = '08300000-0000-4000-8000-000000000001';
    const target = adminViewPath('/ops/users', {
      q: '業務 担当',
      selected: id,
      status: ['active', 'deactivated'],
      create: 'agent',
      error: 'synthetic',
      confirm: 'revoke',
    });
    const url = new URL(target!, 'https://solvi.local');
    expect([...url.searchParams]).toEqual([
      ['q', '業務 担当'],
      ['selected', id],
    ]);
    expect(adminReturnTo('/ops/approvals?rule=' + id + '&confirm=disable-routing#detail')).toBe(
      '/ops/approvals?rule=' + id,
    );
    expect(adminReturnTo('/ops/groups/' + id + '?filter=available&q=a&q=b')).toBe(
      '/ops/groups/' + id + '?filter=available',
    );
    const login = new URL(withAdminReturnTo('/login?expired=1', target), 'https://solvi.local');
    expect(login.searchParams.get('returnTo')).toBe(target);
  });
});
