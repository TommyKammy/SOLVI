/**
 * 署名付きURLの実地検証 (WP-P2-SCAN-011 / FR-TKT-005)。
 *
 * **実際に取得できることを確かめる。** URLの形だけを検査していたため、
 * 署名が食い違って 403 になる欠陥が長く残っていた。
 *
 * 壊れ方が厄介だった: `PUT` は通るが `GET` だけが失敗する。
 * 追加のクエリパラメータが `Content-Type` だけの PUT では
 * エンコードの差異が現れず、`Content-Disposition` に
 * `filename*=UTF-8''<name>` が入る GET でだけ現れたためである。
 *
 * 「URLが生成できる」と「そのURLで取得できる」は別の主張である。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { S3CompatibleStorage } from '@solvi/shared';
import { randomBytes } from 'node:crypto';

let storage: S3CompatibleStorage;

beforeAll(() => {
  storage = new S3CompatibleStorage({
    endpoint: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9100',
    bucket: process.env.S3_BUCKET_ATTACHMENTS ?? 'solvi-attachments',
    accessKey: process.env.S3_ACCESS_KEY ?? '',
    secretKey: process.env.S3_SECRET_KEY ?? '',
    region: process.env.S3_REGION ?? 'ap-northeast-1',
  });
});

const newKey = (): string => `attachments/test/${randomBytes(16).toString('hex')}`;

async function put(key: string, body: string, contentType = 'text/plain'): Promise<number> {
  const signed = storage.presignPut(key, 300, contentType);
  const res = await fetch(signed.url, {
    method: 'PUT',
    body,
    headers: { 'content-type': contentType },
  });
  return res.status;
}

describe('署名付きURLで実際にやり取りできる', () => {
  it('PUT で保存できる', async () => {
    expect(await put(newKey(), 'hello')).toBe(200);
  });

  it('**GET で取得できる**(署名が実際に通る)', async () => {
    const key = newKey();
    await put(key, '添付の中身');

    const signed = storage.presignGet(key, 300, 'report.txt');
    const res = await fetch(signed.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('添付の中身');
  });

  it.each([
    ['空白を含む', '月次 報告書.txt'],
    ['日本語', '2026年度_評価.xlsx'],
    ['アポストロフィ', "O'Brien's file.txt"],
    ['アスタリスク', 'draft*final.txt'],
    ['括弧', 'screenshot (1).png'],
  ])('**ファイル名に %s 場合も取得できる**', async (_label, fileName) => {
    // これらの文字が encodeURIComponent で変換されないことが、
    // 署名の食い違いを生んでいた。
    const key = newKey();
    await put(key, 'content');

    const signed = storage.presignGet(key, 300, fileName);
    const res = await fetch(signed.url);
    expect(res.status).toBe(200);
  });

  it('**常に添付としてダウンロードさせる**(ブラウザで実行させない)', async () => {
    const key = newKey();
    await put(key, '<script>alert(1)</script>', 'text/html');

    const signed = storage.presignGet(key, 300, 'evil.html');
    const res = await fetch(signed.url);

    // HTMLやSVGがインライン表示されると、同一オリジンでのスクリプト実行につながる
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('getObject でサーバ側から実体を読める(スキャン用)', async () => {
    const key = newKey();
    await put(key, 'スキャン対象');
    const content = await storage.getObject(key);
    expect(content.toString('utf8')).toBe('スキャン対象');
  });

  it('存在しないオブジェクトは取得できない', async () => {
    await expect(storage.getObject(newKey())).rejects.toThrow();
  });

  it('**期限切れの署名では取得できない**', async () => {
    const key = newKey();
    await put(key, 'content');

    const signed = storage.presignGet(key, 1, 'file.txt');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const res = await fetch(signed.url);
    expect(res.status).toBe(403);
  });
});
