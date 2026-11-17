/**
 * ブラウザ向けセキュリティヘッダー(ADR-0027 / NFR-SEC-011 / WP-P2-SEC-025)。
 *
 * 値はすべてこのファイルの定数から組み立てる。**利用者由来の値(チケット本文、
 * クエリ等)からは組み立てない**(ADR-0027 §6)。CSPを無効化・緩和する環境変数や
 * 機能フラグも置かない。展開の段階(Report-Only か強制か、HSTSのmax-age)は、
 * 下の定数を変えるデプロイで進める。
 */

/**
 * CSPの展開段階(ADR-0027 §4)。
 *
 * `report-only` で違反を観察し、主要導線の違反が0件であることを確認してから
 * `enforce` へ切り替える。強制で障害が起きたときは `report-only` へ戻す
 * デプロイで切り戻す(CSPそのものは外さない。08.1 Deployment Runbook)。
 */
export type CspMode = 'report-only' | 'enforce';
export const CSP_MODE: CspMode = 'enforce';

/**
 * HSTSのmax-age(秒)。300 → 604800 → 31536000 の順に延ばす(ADR-0027 §3)。
 * 延ばした値は、その期間中は利用者のブラウザから取り消せない。
 */
export const HSTS_MAX_AGE_SECONDS = 300;

/** nonceとして受け付ける形式。ヘッダー値を壊す文字(`'` `;` 空白)を通さない。 */
const NONCE_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** 暗号論的乱数16バイトのbase64。リクエストごとに作り、ログに出さない。 */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** S3 のバケット命名規則(連続するピリオドは別に拒否する)。 */
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
/** `connect-src` に加えてよいソースの形: `<http(s)://ホスト[:ポート]>/<バケット>/`。 */
const UPLOAD_SOURCE_PATTERN =
  /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/$|^http:\/\/\[::1\](?::\d{1,5})?\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * 添付のアップロード先として `connect-src` に加えるソース(ADR-0029)。
 *
 * ブラウザは API が発行した署名付きURL(`<endpoint>/<bucket>/<key>`、パス形式)へ
 * 直接 PUT する。本番の S3 のホスト名は全利用者のバケットで共有されるため、
 * オリジンだけでなく**添付用バケットのパス**に限る。値は API と同じストレージ設定から
 * 組み立て、1つでも条件を満たさなければ `null`(何も加えない = fail closed)を返す。
 */
export function attachmentUploadSource(
  settings: { publicEndpoint?: string; endpoint?: string; bucket?: string },
  options: { production: boolean },
): string | null {
  const raw = settings.publicEndpoint || settings.endpoint;
  const bucket = settings.bucket;
  if (!raw || !bucket || !BUCKET_PATTERN.test(bucket) || bucket.includes('..')) return null;
  if (raw.includes('*')) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (raw.includes('?') || raw.includes('#')) return null;
  if (url.protocol === 'https:') {
    // 本番・開発とも可。
  } else if (url.protocol === 'http:') {
    if (options.production || !LOOPBACK_HOSTS.has(url.hostname)) return null;
  } else {
    return null;
  }
  const source = `${url.origin}/${bucket}/`;
  return UPLOAD_SOURCE_PATTERN.test(source) ? source : null;
}

export function buildContentSecurityPolicy(
  nonce: string,
  options: { development: boolean; https: boolean; uploadSource?: string | null },
): string {
  if (!NONCE_PATTERN.test(nonce)) throw new Error('invalid CSP nonce');
  if (
    options.uploadSource !== undefined &&
    options.uploadSource !== null &&
    !UPLOAD_SOURCE_PATTERN.test(options.uploadSource)
  ) {
    throw new Error('invalid attachment upload source');
  }

  const scriptSrc = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
  // next dev(React の開発用デバッグ情報)だけが eval を使う。本番には入れない。
  if (options.development) scriptSrc.push("'unsafe-eval'");

  const policy: Array<[string, string[]]> = [
    ['default-src', ["'self'"]],
    ['script-src', scriptSrc],
    // インラインstyle(約136箇所)の解消までは許す。ADR-0027 Follow-up。
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:']],
    ['font-src', ["'self'"]],
    // 添付のアップロード先(添付用バケットのパスだけ)。ADR-0029。
    ['connect-src', options.uploadSource ? ["'self'", options.uploadSource] : ["'self'"]],
    // 本番IdPのオリジンは、IdP接続時の後継ADRで加える(2026-11-16 利用者決定)。
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['object-src', ["'none'"]],
  ];
  // HTTPSの応答にだけ付ける(HSTSと同じ扱い)。HTTPのページでは守るものが無く、
  // WebKit は localhost でも https へ書き換えるため、ローカルの画面遷移が壊れる
  // (2026-11-17 の実画面検査で確認)。
  if (options.https) policy.push(['upgrade-insecure-requests', []]);
  return policy.map(([name, values]) => [name, ...values].join(' ')).join('; ');
}

export function cspHeaderName(mode: CspMode): string {
  return mode === 'enforce' ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only';
}

/** 固定値のヘッダー(ADR-0027 §3)。HSTSはHTTPSの応答にだけ付ける。 */
export function buildSecurityHeaders(options: { https: boolean }): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  };
  // includeSubDomains / preload は付けない(ドメイン管理方針の確定後に後継ADR)。
  if (options.https) headers['Strict-Transport-Security'] = `max-age=${HSTS_MAX_AGE_SECONDS}`;
  return headers;
}

/**
 * HTTPSで提供されている応答か。
 *
 * 本番はALBでTLSを終端し、ALBが `X-Forwarded-Proto` を上書きする(ADR-0018)。
 * 直接HTTPで偽った値を送られても、HTTPの応答のHSTSはブラウザが無視するため害はない。
 */
export function isHttpsRequest(urlProtocol: string, forwardedProto: string | null): boolean {
  const forwarded = forwardedProto?.split(',')[0]?.trim().toLowerCase();
  if (forwarded) return forwarded === 'https';
  return urlProtocol === 'https:';
}
