/**
 * ブラウザ向けセキュリティヘッダーを付ける(ADR-0027 / WP-P2-SEC-025)。
 *
 * - リクエストごとにnonceを作り、CSPを**リクエストとレスポンスの両方**に載せる。
 *   Next.js はリクエスト側のCSPヘッダー(`Content-Security-Policy` または
 *   `-Report-Only`)から `'nonce-…'` を読み、自分のスクリプトタグに付ける。
 * - 固定値のヘッダーもここで付ける。付与場所を1か所にする(ADR-0027 §1)。
 * - nonceはログに出さない。
 */
import { NextResponse, type NextRequest } from 'next/server';
import {
  CSP_MODE,
  attachmentUploadSource,
  buildContentSecurityPolicy,
  buildSecurityHeaders,
  cspHeaderName,
  generateNonce,
  isHttpsRequest,
} from './lib/security-headers';

let uploadSource: string | null | undefined;

/**
 * 添付のアップロード先(ADR-0029)。API と同じストレージ設定から一度だけ組み立てる。
 * 不正・未設定なら何も加えない(アップロードは失敗するが、CSPは緩めない)。
 */
function resolveUploadSource(): string | null {
  if (uploadSource !== undefined) return uploadSource;
  uploadSource = attachmentUploadSource(
    {
      publicEndpoint: process.env.S3_PUBLIC_ENDPOINT,
      endpoint: process.env.S3_ENDPOINT,
      bucket: process.env.S3_BUCKET_ATTACHMENTS,
    },
    { production: process.env.NODE_ENV === 'production' },
  );
  if (uploadSource === null) {
    console.error(
      JSON.stringify({
        level: 'error',
        service: 'web',
        message:
          'attachment upload source not added to CSP connect-src: S3_PUBLIC_ENDPOINT/S3_ENDPOINT or S3_BUCKET_ATTACHMENTS is missing or invalid (ADR-0029)',
      }),
    );
  }
  return uploadSource;
}

export function middleware(request: NextRequest) {
  const https = isHttpsRequest(request.nextUrl.protocol, request.headers.get('x-forwarded-proto'));
  const nonce = generateNonce();
  const csp = buildContentSecurityPolicy(nonce, {
    development: process.env.NODE_ENV === 'development',
    https,
    uploadSource: resolveUploadSource(),
  });
  const headerName = cspHeaderName(CSP_MODE);

  const requestHeaders = new Headers(request.headers);
  // 外部から送られたCSPヘッダーを信用しない。必ずここで作った値で上書きする。
  requestHeaders.delete('content-security-policy');
  requestHeaders.delete('content-security-policy-report-only');
  requestHeaders.set(headerName, csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(headerName, csp);
  for (const [name, value] of Object.entries(buildSecurityHeaders({ https }))) {
    response.headers.set(name, value);
  }
  return response;
}

export const config = {
  // 静的ファイルと画像最適化には付けない(文書ではなく、nonceも不要)。
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
