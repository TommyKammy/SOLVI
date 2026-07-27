/**
 * 認証の基礎部品 (WP-P1-IDM-009 / TL-08)。
 *
 * 検証の重点は「正しい入力が通ること」ではなく
 * **「間違った入力が通らないこと」と「情報が漏れないこと」**。
 */
import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  parseHash,
  validatePasswordStrength,
  MIN_PASSWORD_LENGTH,
} from '../../packages/shared/src/auth/password.js';
import {
  issueToken,
  hashToken,
  computeExpiry,
  extendIdle,
  buildSessionCookie,
  buildClearedSessionCookie,
  parseSessionCookie,
  SESSION_COOKIE_NAME,
  DEFAULT_LIFETIME,
} from '../../packages/shared/src/auth/session-token.js';

const PASSWORD = 'correct horse battery staple';

describe('パスワードのハッシュ化', () => {
  it('正しいパスワードで照合できる', async () => {
    const stored = await hashPassword(PASSWORD);
    expect(await verifyPassword(PASSWORD, stored)).toBe(true);
  });

  it('誤ったパスワードは照合できない', async () => {
    const stored = await hashPassword(PASSWORD);
    expect(await verifyPassword(PASSWORD + 'x', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('**保存値にパスワードが含まれない**', async () => {
    const stored = await hashPassword(PASSWORD);
    expect(stored).not.toContain(PASSWORD);
    // 部分文字列としても現れない
    for (const word of PASSWORD.split(' ')) {
      expect(stored).not.toContain(word);
    }
  });

  it('**同じパスワードでも毎回異なるハッシュになる**(ソルト)', async () => {
    const a = await hashPassword(PASSWORD);
    const b = await hashPassword(PASSWORD);
    expect(a).not.toBe(b);
    // それでも両方とも照合できる
    expect(await verifyPassword(PASSWORD, a)).toBe(true);
    expect(await verifyPassword(PASSWORD, b)).toBe(true);
  });

  it('パラメータがハッシュ文字列に含まれる(後でコストを上げても既存を読める)', async () => {
    const stored = await hashPassword(PASSWORD, { N: 1024, r: 8, p: 1 });
    const parsed = parseHash(stored);
    expect(parsed?.params).toEqual({ N: 1024, r: 8, p: 1 });
    // 別のコストで作られた値も照合できる
    expect(await verifyPassword(PASSWORD, stored)).toBe(true);
  });

  it.each(['', 'not-scrypt$x', 'scrypt$a$b$c$d$e', 'scrypt$16384$8$1$onlyfive'])(
    '壊れた保存値 %s で例外を投げず false を返す',
    async (broken) => {
      expect(await verifyPassword(PASSWORD, broken)).toBe(false);
    },
  );
});

describe('パスワードの最低要件', () => {
  it(`${MIN_PASSWORD_LENGTH}文字未満を拒否する`, () => {
    expect(validatePasswordStrength('a'.repeat(MIN_PASSWORD_LENGTH - 1)).ok).toBe(false);
    expect(validatePasswordStrength('a'.repeat(MIN_PASSWORD_LENGTH)).ok).toBe(true);
  });

  it('極端に長い入力を拒否する(計算資源の枯渇を防ぐ)', () => {
    expect(validatePasswordStrength('a'.repeat(2000)).ok).toBe(false);
  });
});

describe('セッショントークン', () => {
  it('毎回異なるトークンが発行される', () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => issueToken().token));
    expect(tokens.size).toBe(1000);
  });

  it('**保存するのはハッシュであり、トークンそのものではない**', () => {
    const { token, tokenHash } = issueToken();
    expect(tokenHash).not.toBe(token);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    // ハッシュからトークンは復元できない(同じ入力なら同じハッシュになることだけ確認)
    expect(hashToken(token)).toBe(tokenHash);
  });

  it('URL・Cookieに安全な文字だけを使う', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(issueToken().token).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});

describe('セッションの期限', () => {
  const issuedAt = new Date('2026-07-27T09:00:00Z');

  it('絶対期限とアイドル期限の両方が設定される', () => {
    const expiry = computeExpiry(issuedAt);
    expect(expiry.absoluteExpiresAt.getTime()).toBe(
      issuedAt.getTime() + DEFAULT_LIFETIME.absoluteSeconds * 1000,
    );
    expect(expiry.idleExpiresAt.getTime()).toBe(
      issuedAt.getTime() + DEFAULT_LIFETIME.idleSeconds * 1000,
    );
  });

  it('**アイドル期限が絶対期限を越えない**', () => {
    const expiry = computeExpiry(issuedAt, { absoluteSeconds: 60, idleSeconds: 3600 });
    expect(expiry.idleExpiresAt.getTime()).toBe(expiry.absoluteExpiresAt.getTime());
  });

  it('アクセスでアイドル期限が延びる', () => {
    const expiry = computeExpiry(issuedAt);
    const later = new Date(issuedAt.getTime() + 30 * 60 * 1000);
    const extended = extendIdle(later, expiry.absoluteExpiresAt);
    expect(extended.getTime()).toBeGreaterThan(expiry.idleExpiresAt.getTime());
  });

  it('**延長しても絶対期限は超えない**(窃取されたセッションの寿命に上限)', () => {
    const expiry = computeExpiry(issuedAt);
    // 絶対期限の直前までアクセスし続けた場合
    const nearEnd = new Date(expiry.absoluteExpiresAt.getTime() - 1000);
    const extended = extendIdle(nearEnd, expiry.absoluteExpiresAt);
    expect(extended.getTime()).toBe(expiry.absoluteExpiresAt.getTime());
  });
});

describe('セッションCookie', () => {
  const expiresAt = new Date('2026-07-27T21:00:00Z');

  it('HttpOnly と SameSite が付く', () => {
    const cookie = buildSessionCookie({ token: 'abc', expiresAt, secure: true });
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
  });

  it('secure=true で Secure が付き、false で付かない', () => {
    expect(buildSessionCookie({ token: 'abc', expiresAt, secure: true })).toContain('Secure');
    expect(buildSessionCookie({ token: 'abc', expiresAt, secure: false })).not.toContain('Secure');
  });

  it('ログアウト用Cookieは値が空で期限が過去', () => {
    const cleared = buildClearedSessionCookie(false);
    expect(cleared).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(cleared).toContain('1970');
  });

  it('Cookieヘッダからトークンを取り出せる', () => {
    expect(parseSessionCookie(`${SESSION_COOKIE_NAME}=tok123`)).toBe('tok123');
    expect(parseSessionCookie(`other=1; ${SESSION_COOKIE_NAME}=tok123; more=2`)).toBe('tok123');
    expect(parseSessionCookie(`  ${SESSION_COOKIE_NAME}=tok123  `)).toBe('tok123');
  });

  it.each([
    ['ヘッダが無い', undefined],
    ['別のCookieだけ', 'other=1; another=2'],
    ['値が空', `${SESSION_COOKIE_NAME}=`],
    ['名前が部分一致する別Cookie', `x_${SESSION_COOKIE_NAME}=tok123`],
  ])('%s ときは undefined', (_label, header) => {
    expect(parseSessionCookie(header)).toBeUndefined();
  });
});
