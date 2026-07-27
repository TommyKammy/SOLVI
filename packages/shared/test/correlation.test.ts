import { describe, it, expect } from 'vitest';
import { correlationIdFromHeader, runWithContext, getContext, newContext } from '../src/correlation/context.js';

describe('相関ID (NFR-OPS-003)', () => {
  it('妥当な形式のヘッダはそのまま使う', () => {
    expect(correlationIdFromHeader('abc-12345678')).toBe('abc-12345678');
  });

  it('形式が不正なヘッダは採番し直す(ログへの任意文字列注入を防ぐ)', () => {
    for (const bad of ['../../etc/passwd', 'a', '"; DROP TABLE x; --', 'x'.repeat(100)]) {
      const issued = correlationIdFromHeader(bad);
      expect(issued).not.toBe(bad);
      expect(issued).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    }
  });

  it('ヘッダがなければ採番する', () => {
    expect(correlationIdFromHeader(undefined)).toMatch(/^[A-Za-z0-9-]{8,64}$/);
  });

  it('非同期処理をまたいで文脈が保たれる', async () => {
    const ctx = newContext({ organizationId: 'org-1' });
    await runWithContext(ctx, async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(getContext()?.organizationId).toBe('org-1');
      expect(getContext()?.correlationId).toBe(ctx.correlationId);
    });
  });
});
