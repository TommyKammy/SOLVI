import { scrypt, randomBytes, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * パスワードのハッシュ化 (WP-P1-IDM-009 / ADR-0019)。
 *
 * scrypt を使う。Node の標準に含まれており、ネイティブ依存を増やさない。
 * argon2id のほうが新しいが、追加の依存とビルド環境の差異を持ち込むだけの
 * 利得は、検証段階限りの用途では無い。
 *
 * **保存するのは派生鍵であり、パスワードそのものではない。**
 * DBを読めた者が、そこからパスワードを復元することはできない。
 *
 * パラメータをハッシュ文字列に含めるのは、後でコストを上げたときに
 * 既存の資格情報を読めなくしないため。コストだけ変えて再デプロイすると、
 * 全員がログインできなくなる — という事故を構造的に防ぐ。
 */

/**
 * `promisify(scrypt)` は options 付きのオーバーロードを拾えないため、自前で包む。
 * options を渡せないと maxmem を上げられず、N=16384 で既定の32MB上限に当たる。
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

/**
 * scrypt のパラメータ。
 *
 * N=16384 は OWASP の推奨下限(2^14)。検証環境の応答性とのバランスで選んだ。
 * 本番でローカル認証は使わないため、本番向けの強度検討は不要である
 * (使おうとすると起動が拒否される)。
 */
const DEFAULT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/** メモリ上限。既定(32MB)だと N=16384, r=8 で足りない。 */
const MAX_MEMORY = 128 * 1024 * 1024;

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** `scrypt$N$r$p$salt$hash` */
export function formatHash(params: ScryptParams, salt: Buffer, derived: Buffer): string {
  return [
    'scrypt',
    params.N,
    params.r,
    params.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export function parseHash(
  stored: string,
): { params: ScryptParams; salt: Buffer; derived: Buffer } | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;

  const n = parts[1];
  const r = parts[2];
  const p = parts[3];
  const salt = parts[4];
  const derived = parts[5];
  if (
    n === undefined ||
    r === undefined ||
    p === undefined ||
    salt === undefined ||
    derived === undefined
  ) {
    return null;
  }

  const params = { N: Number(n), r: Number(r), p: Number(p) };
  if (!Number.isInteger(params.N) || !Number.isInteger(params.r) || !Number.isInteger(params.p)) {
    return null;
  }
  return {
    params,
    salt: Buffer.from(salt, 'base64'),
    derived: Buffer.from(derived, 'base64'),
  };
}

export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_PARAMS,
): Promise<string> {
  // ソルトは資格情報ごとに新しく生成する。使い回すと、
  // 同じパスワードの利用者が同じハッシュになり、まとめて狙われる。
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scryptAsync(password, salt, KEY_LENGTH, {
    ...params,
    maxmem: MAX_MEMORY,
  });
  return formatHash(params, salt, derived);
}

/**
 * パスワードの照合。
 *
 * 比較は `timingSafeEqual` で行う。通常の `===` は最初に違うバイトで打ち切るため、
 * 一致した先頭バイト数が処理時間に現れる。1バイトずつ総当たりできてしまう。
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;

  const derived = await scryptAsync(password, parsed.salt, parsed.derived.length, {
    ...parsed.params,
    maxmem: MAX_MEMORY,
  });

  if (derived.length !== parsed.derived.length) return false;
  return timingSafeEqual(derived, parsed.derived);
}

/**
 * 資格情報が存在しない場合でも、存在する場合と同じだけ時間をかけるためのダミー照合。
 *
 * これが無いと、存在しないユーザには即座に返るため、**応答時間だけで
 * ユーザ名の存在有無が分かる**。総当たりの前段としてユーザ名を洗い出せてしまう。
 *
 * 「同じエラーメッセージを返す」だけでは足りない。時間も揃える必要がある。
 */
let dummyHashPromise: Promise<string> | undefined;

export async function consumeTimingBudget(password: string): Promise<void> {
  // ダミーのハッシュは一度だけ作って使い回す。毎回作ると
  // ハッシュ化とソルト生成の2回分になり、かえって時間がずれる。
  dummyHashPromise ??= hashPassword('solvi-timing-equalizer-not-a-real-password');
  await verifyPassword(password, await dummyHashPromise);
}

/**
 * パスワードの最低要件。
 *
 * 複雑さの規則(記号を含めろ、等)は課さない。利用者は規則を満たす最短の
 * 文字列を選び、結果として弱くなることが知られている。長さのほうが効く。
 */
export const MIN_PASSWORD_LENGTH = 12;

export function validatePasswordStrength(password: string): { ok: boolean; reason?: string } {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: `パスワードは${MIN_PASSWORD_LENGTH}文字以上にしてください` };
  }
  // 極端に長い入力は、scrypt の計算時間を通じた資源枯渇に使える。
  if (password.length > 1024) {
    return { ok: false, reason: 'パスワードが長すぎます' };
  }
  return { ok: true };
}
