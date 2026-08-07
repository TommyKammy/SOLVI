/**
 * 画面へ入る前の判定 (NFR-UX-004 / WP-P2-UISTATE-018)。
 *
 * `requireSession()` は「この画面を出してよいか」を決める1か所である。
 * ここが理由を取り違えると、**利用者は直しようのない行き止まりに入る。**
 *
 * 以前は `api.me()` が失敗すれば理由を問わずログイン画面へ送っていた。
 * APIが落ちているとき、利用者は黙ってログアウトさせられ、
 * **そのログイン画面でも同じ理由で失敗する。**
 * 画面上は「パスワードが違う」ようにしか見えない。
 *
 * 判別できる情報(`problem.status`)は最初からあった。呼ぶ側が捨てていた。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

/** `redirect()` は例外で制御を移す。行き先を取り出せる形で模す。 */
class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}

const jar = { entries: [] as Array<{ name: string; value: string }> };

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ getAll: () => jar.entries }),
}));

const { requireSession } = await import('../../apps/web/src/lib/api.js');

/** `api.me()` の応答を差し替える。 */
function respond(status: number, body: unknown): void {
  vi.stubGlobal('fetch', () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

/** 行き先を取り出す。redirect しなければ null。 */
async function destinationOf(): Promise<string | null> {
  try {
    await requireSession();
    return null;
  } catch (error) {
    if (error instanceof RedirectSignal) return error.to;
    throw error;
  }
}

beforeEach(() => {
  jar.entries = [];
  vi.unstubAllGlobals();
});

describe('入れるとき', () => {
  it('セッションが有効ならそのまま返す', async () => {
    respond(200, { userId: 'u1', organizationId: 'o1', roles: [] });
    const session = await requireSession();
    expect(session.userId).toBe('u1');
  });
});

describe('認証が要るとき', () => {
  it('一度も入っていない人はログイン画面へ', async () => {
    respond(401, { title: '認証が必要です', status: 401 });
    expect(await destinationOf()).toBe('/login');
  });

  it('**セッションを持っていたのに 401 なら、期限切れと伝える**', async () => {
    // 何も言わずにログイン画面へ戻すと、利用者は自分の操作を疑う。
    jar.entries = [{ name: 'solvi_session', value: 'stale' }];
    respond(401, { title: '認証が必要です', status: 401 });
    expect(await destinationOf()).toBe('/login?expired=1');
  });

  it('組織が未選択なら選択画面へ(ログイン画面へ戻さない)', async () => {
    // 兼務者を401としてログイン画面へ送り返すと、正しい資格情報で
    // 何度ログインしても同じ画面に戻ってくる。
    jar.entries = [{ name: 'solvi_session', value: 'live' }];
    respond(403, {
      type: 'https://solvi.example/problems/organization-not-selected',
      title: '組織が未選択です',
      status: 403,
    });
    expect(await destinationOf()).toBe('/select-organization');
  });

  it('組織未選択の判定は 403 の中身で行う(単なる 403 はログイン画面へ)', async () => {
    respond(403, { title: '権限がありません', status: 403 });
    expect(await destinationOf()).toBe('/login');
  });
});

describe('基盤へ届かないとき', () => {
  it('**ログイン画面へ送らない**(送ると、そこでも同じ理由で失敗する)', async () => {
    jar.entries = [{ name: 'solvi_session', value: 'live' }];
    vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')));

    expect(await destinationOf()).toBe('/unavailable');
  });

  it('APIが 500 を返したときも同じ扱い', async () => {
    respond(500, { title: '内部エラー', status: 500 });
    expect(await destinationOf()).toBe('/unavailable');
  });

  it('APIが 503 を返したときも同じ扱い', async () => {
    respond(503, { title: '一時的に利用できません', status: 503 });
    expect(await destinationOf()).toBe('/unavailable');
  });

  it('**基盤の詳細を持ち出さない**(ホスト名やポートが画面に出ると偵察の材料になる)', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:3001')));
    try {
      await requireSession();
      expect.unreachable('例外になるはず');
    } catch (error) {
      const text = `${(error as Error).name} ${(error as Error).message}`;
      expect(text).not.toContain('10.0.0.5');
      expect(text).not.toContain('3001');
    }
  });
});
