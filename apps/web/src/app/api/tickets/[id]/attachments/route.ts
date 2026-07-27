import { NextResponse } from 'next/server';
import { api } from '../../../../../lib/api';

/**
 * アップロードURL発行のプロキシ (WP-P2-SCAN-011)。
 *
 * ブラウザから直接 SOLVI API を叩かせない。セッションCookieが `HttpOnly` で
 * JSから読めず、また API のオリジンを露出させると CORS の設定が必要になり、
 * 緩めた分だけ攻撃面が広がる。
 *
 * **ここは署名付きURLを返すだけで、ファイルの実体は通らない。**
 * 実体はブラウザからオブジェクトストレージへ直接送られる。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));

  const result = await api.requestUpload(id, {
    fileName: String(body.fileName ?? ''),
    contentType: String(body.contentType ?? ''),
    sizeBytes: Number(body.sizeBytes ?? 0),
    visibility: String(body.visibility ?? 'public'),
  });

  if (!result.ok) {
    // Problem Details をそのまま返す。項目ごとの文言を画面が使う。
    return NextResponse.json(result.problem, { status: result.problem.status });
  }
  return NextResponse.json(result.data, { status: 201 });
}
