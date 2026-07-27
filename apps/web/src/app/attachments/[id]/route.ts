import { NextResponse } from 'next/server';
import { api } from '../../../lib/api';

/**
 * 添付のダウンロード (WP-P2-SCAN-011)。
 *
 * **署名付きURLを画面に埋め込まない。** 埋め込むと、ページを共有したり
 * スクリーンショットを撮ったりしただけで、有効期限まで誰でも取得できてしまう。
 *
 * 毎回サーバへ問い合わせ、その時点の権限とスキャン状態で判断してから
 * 署名を発行し、リダイレクトする。`scan_status` が `clean` でなければ
 * サービス層がURLを出さない。
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const result = await api.downloadUrl(id);

  if (!result.ok) {
    if (result.problem.status === 401) {
      return NextResponse.redirect(
        new URL('/login', process.env.WEB_BASE_URL ?? 'http://localhost:3000'),
      );
    }
    // 権限が無い場合もスキャン未完了の場合も、詳細は画面側で説明済み。
    // ここでは素っ気なく返す。
    return NextResponse.json(result.problem, { status: result.problem.status });
  }

  // 一時的なリダイレクト。恒久リダイレクトにすると、ブラウザが
  // 期限切れのURLをキャッシュして次回開けなくなる。
  return NextResponse.redirect(result.data.url, { status: 302 });
}
