import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

/**
 * Webhookの署名(NFR-SEC-007 / 脅威 T-17)。
 *
 * 守るべきは3つ。
 *   1. 改ざん検知 — ペイロードが途中で書き換えられていないこと
 *   2. なりすまし防止 — 鍵を持つ者だけが送れること
 *   3. **リプレイ防止** — 過去の正当な要求をそのまま再送されないこと
 *
 * 3が抜けている実装をよく見かける。署名が正しくても、
 * 一度盗まれた要求を何度でも再生できるなら、状態を変える操作は繰り返し実行されてしまう。
 * timestamp の許容幅と nonce の一回性で防ぐ。
 */

export const SIGNATURE_HEADER = 'x-solvi-signature';
export const TIMESTAMP_HEADER = 'x-solvi-timestamp';
export const NONCE_HEADER = 'x-solvi-nonce';

/** timestamp の許容ずれ。時計のずれを吸収しつつ、再生の窓を短く保つ。 */
export const TIMESTAMP_TOLERANCE_SECONDS = 300;

export interface SignedRequest {
  headers: Record<string, string>;
  body: string;
}

/**
 * 署名対象の文字列を組み立てる。
 *
 * timestamp と nonce を**署名対象に含める**ことが要点。
 * 含めずにヘッダとして送るだけだと、攻撃者がヘッダだけ書き換えて
 * 有効期限を延ばせてしまう。
 */
function signingPayload(timestamp: string, nonce: string, body: string): string {
  return `${timestamp}.${nonce}.${body}`;
}

export function signWebhook(params: {
  body: string;
  secret: string;
  now?: Date;
  nonce?: string;
}): SignedRequest {
  const timestamp = String(Math.floor((params.now ?? new Date()).getTime() / 1000));
  const nonce = params.nonce ?? randomUUID();
  const signature = createHmac('sha256', params.secret)
    .update(signingPayload(timestamp, nonce, params.body))
    .digest('hex');

  return {
    headers: {
      [SIGNATURE_HEADER]: `sha256=${signature}`,
      [TIMESTAMP_HEADER]: timestamp,
      [NONCE_HEADER]: nonce,
      'content-type': 'application/json',
    },
    body: params.body,
  };
}

export type VerificationFailure =
  | 'missing_headers'
  | 'malformed_signature'
  | 'signature_mismatch'
  | 'timestamp_out_of_range'
  | 'nonce_replayed';

export interface VerificationResult {
  valid: boolean;
  reason?: VerificationFailure;
}

/** nonce の一回性を判定する。実装は呼び出し側(DBやキャッシュ)。 */
export interface NonceStore {
  /** @returns 初めて見た nonce なら true。既出なら false。 */
  consume(nonce: string): Promise<boolean>;
}

/**
 * 受信側の検証。
 *
 * 失敗の理由は呼び出し側のログ用であり、**送信元へ返さない**。
 * 「署名が違う」と「timestampが古い」を返し分けると、
 * 攻撃者に総当たりの手がかりを与える。
 */
export async function verifyWebhook(params: {
  headers: Record<string, string | string[] | undefined>;
  body: string;
  secret: string;
  nonceStore?: NonceStore;
  now?: Date;
}): Promise<VerificationResult> {
  const header = (name: string): string | undefined => {
    const value = params.headers[name] ?? params.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  };

  const signature = header(SIGNATURE_HEADER);
  const timestamp = header(TIMESTAMP_HEADER);
  const nonce = header(NONCE_HEADER);

  if (!signature || !timestamp || !nonce) {
    return { valid: false, reason: 'missing_headers' };
  }
  if (!signature.startsWith('sha256=')) {
    return { valid: false, reason: 'malformed_signature' };
  }

  // timestamp を先に見る。署名計算はHMACのコストがかかるため、
  // 明らかに古い要求は計算前に落とす。
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return { valid: false, reason: 'timestamp_out_of_range' };
  }
  const nowSeconds = Math.floor((params.now ?? new Date()).getTime() / 1000);
  // 未来方向も制限する。時計を進めた要求で有効期限を延ばされないようにする。
  if (Math.abs(nowSeconds - ts) > TIMESTAMP_TOLERANCE_SECONDS) {
    return { valid: false, reason: 'timestamp_out_of_range' };
  }

  const expected = createHmac('sha256', params.secret)
    .update(signingPayload(timestamp, nonce, params.body))
    .digest('hex');
  const provided = signature.slice('sha256='.length);

  // 長さが違うと timingSafeEqual が例外を投げるため先に確認する。
  // 長さの比較自体は情報量が小さく、タイミング攻撃の助けにならない。
  if (provided.length !== expected.length) {
    return { valid: false, reason: 'signature_mismatch' };
  }
  if (!timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'))) {
    return { valid: false, reason: 'signature_mismatch' };
  }

  // 署名が正しいことを確認してから nonce を消費する。
  // 先に消費すると、不正な署名で正当な nonce を潰せてしまう。
  if (params.nonceStore) {
    const fresh = await params.nonceStore.consume(nonce);
    if (!fresh) return { valid: false, reason: 'nonce_replayed' };
  }

  return { valid: true };
}

/** メモリ上の nonce ストア。単一プロセス・テスト用。本番はDBかRedisを使う。 */
export class InMemoryNonceStore implements NonceStore {
  private readonly seen = new Map<string, number>();

  constructor(private readonly ttlSeconds = TIMESTAMP_TOLERANCE_SECONDS * 2) {}

  async consume(nonce: string): Promise<boolean> {
    const now = Date.now();
    // timestampの許容幅を過ぎた nonce は保持する意味がない(その要求はもう通らない)
    for (const [key, at] of this.seen) {
      if (now - at > this.ttlSeconds * 1000) this.seen.delete(key);
    }
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, now);
    return true;
  }
}
