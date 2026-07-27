import { randomBytes, createHash } from 'node:crypto';

/**
 * セッショントークン (WP-P1-IDM-009)。
 *
 * **不透明なランダム値**を使う。JWT のような自己記述トークンにしない。
 *
 * 理由は失効である。JWT は署名だけで検証できるのが利点だが、
 * その利点はそのまま「発行後に取り消せない」という欠点になる。
 * `FR-IDM-008` は無効化から15分以内の失効を要求しており、
 * 取り消せないトークンではこれを満たせない。
 *
 * 毎リクエストのDB参照は増えるが、セッション1行の主キー引きであり、
 * すでに行っている認可判定のためのDB参照と同じ経路に乗る。
 *
 * **保存するのはハッシュである。** DBが流出しても、そこから
 * 有効なトークンを組み立てることはできない。
 * バックアップやログにトークンが残る事故も同時に防げる。
 */

/**
 * 32バイト = 256ビット。総当たりは現実的でない。
 * base64url にして URL・Cookie のどちらでも安全に運べる形にする。
 */
const TOKEN_BYTES = 32;

export const SESSION_COOKIE_NAME = 'solvi_session';

export interface IssuedToken {
  /** 利用者へ渡す値。**これはこの瞬間しか手に入らない。** */
  token: string;
  /** DBへ保存する値 */
  tokenHash: string;
}

export function issueToken(): IssuedToken {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

/**
 * トークンのハッシュ。
 *
 * パスワードと違い、ストレッチング(scrypt等)は不要。
 * トークンは256ビットの完全なランダム値であり、辞書攻撃の対象にならない。
 * 総当たりが不可能な入力に対してコストの高いハッシュを使うのは、
 * 検証のたびに自分の首を絞めるだけである。
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * セッションの期限設定。
 *
 * 2種類を併用する。
 *   絶対期限   使い続けていても必ず切れる。窃取されたセッションの寿命に上限を与える
 *   アイドル期限 使われなくなったら切れる。放置された端末からの乗っ取りを防ぐ
 *
 * 片方だけだと、どちらかの攻撃が通る。絶対期限だけなら、盗んだ側が
 * 使い続ける限り期限まで有効。アイドル期限だけなら、使い続ければ永遠に有効。
 */
export interface SessionLifetime {
  absoluteSeconds: number;
  idleSeconds: number;
}

export const DEFAULT_LIFETIME: SessionLifetime = {
  // 業務日1日を通しで使えて、翌日は必ず再認証させる長さ
  absoluteSeconds: 12 * 60 * 60,
  // 離席して戻る程度の長さ。短すぎると業務の邪魔になり、
  // 利用者は「ログインしっぱなしにする」回避策を探し始める
  idleSeconds: 60 * 60,
};

export interface SessionExpiry {
  absoluteExpiresAt: Date;
  idleExpiresAt: Date;
}

export function computeExpiry(
  issuedAt: Date,
  lifetime: SessionLifetime = DEFAULT_LIFETIME,
): SessionExpiry {
  const absoluteExpiresAt = new Date(issuedAt.getTime() + lifetime.absoluteSeconds * 1000);
  const idleCandidate = new Date(issuedAt.getTime() + lifetime.idleSeconds * 1000);
  return {
    absoluteExpiresAt,
    // アイドル期限が絶対期限を越えても意味が無い(絶対期限が先に効く)。
    // DB制約でも縛っているが、ここで丸めておかないと制約違反で落ちる。
    idleExpiresAt: idleCandidate > absoluteExpiresAt ? absoluteExpiresAt : idleCandidate,
  };
}

/** アクセスのたびにアイドル期限を延長する。絶対期限は動かさない。 */
export function extendIdle(
  now: Date,
  absoluteExpiresAt: Date,
  lifetime: SessionLifetime = DEFAULT_LIFETIME,
): Date {
  const candidate = new Date(now.getTime() + lifetime.idleSeconds * 1000);
  return candidate > absoluteExpiresAt ? absoluteExpiresAt : candidate;
}

/**
 * Cookie 属性。
 *
 * `HttpOnly`  JavaScript から読めない。XSS でトークンを持ち出されない
 * `SameSite`  別サイトからの遷移でCookieを送らない。CSRF の主要経路を塞ぐ
 * `Secure`    HTTPS でのみ送る。ローカルHTTP開発では付けられないため設定で切る
 * `Path=/`    アプリ全体で有効
 *
 * `SameSite=Lax` にしているのは、`Strict` だと外部リンク(通知メールの
 * チケットURL)から遷移したときにログイン状態が切れて見えるため。
 * 通知からの導線は本製品の主要経路であり、そこで毎回ログインを求めるのは
 * 利用者に「ログインしっぱなしにする」回避策を促す。
 */
export function buildSessionCookie(params: {
  token: string;
  expiresAt: Date;
  secure: boolean;
}): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${params.token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Expires=${params.expiresAt.toUTCString()}`,
  ];
  if (params.secure) attributes.push('Secure');
  return attributes.join('; ');
}

/** ログアウト時に即座に無効化するCookie。値を空にし、過去の日付を与える。 */
export function buildClearedSessionCookie(secure: boolean): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

/** Cookie ヘッダからセッショントークンを取り出す。 */
export function parseSessionCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(index + 1).trim();
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}
