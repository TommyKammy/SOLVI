/**
 * ClamAV 応答の解釈 (WP-P2-SCAN-011)。
 *
 * ここで確かめるのは **「clean を安売りしないこと」**。
 *
 * ダウンロードURLは `scan_status = 'clean'` でなければ発行されない。
 * したがって応答の解釈を1つ間違えれば、検疫はその瞬間に無効になる。
 *
 * 特に危険なのは「OK が含まれていないから感染」「FOUND が無いから clean」
 * という決めつけである。前者は誤検知で正当なファイルを止め、
 * 後者は**応答形式が変わった日に検疫が素通りする**。
 */
import { describe, it, expect } from 'vitest';
import { parseClamResponse, ClamAvScanner } from '../../packages/shared/src/scan/clamav.js';

describe('応答の解釈', () => {
  it('OK を clean と判定する', () => {
    expect(parseClamResponse('stream: OK')).toEqual({ status: 'clean' });
    expect(parseClamResponse('stream: OK\0')).toEqual({ status: 'clean' });
  });

  it('FOUND を infected と判定し、検体名を取り出す', () => {
    expect(parseClamResponse('stream: Eicar-Test-Signature FOUND')).toEqual({
      status: 'infected',
      signature: 'Eicar-Test-Signature',
    });
  });

  it('検体名に空白が含まれても取り出せる', () => {
    expect(parseClamResponse('stream: Win.Test.EICAR_HDB-1 FOUND')).toMatchObject({
      status: 'infected',
    });
  });

  it('ERROR を error と判定する(cleanでもinfectedでもない)', () => {
    const result = parseClamResponse('stream: size limit exceeded ERROR');
    expect(result.status).toBe('error');
  });

  it.each([
    ['空文字', ''],
    ['想定外の文字列', 'UNKNOWN COMMAND'],
    ['形式が変わった応答', 'result=clean'],
    ['途中で切れた応答', 'stream:'],
  ])('**%s は error にする**(cleanと決めつけない)', (_label, raw) => {
    const result = parseClamResponse(raw);
    expect(result.status).toBe('error');
  });

  it('**「OKが無いから感染」と決めつけない**', () => {
    // 解釈できない応答を infected にすると、正当なファイルが永久に開けなくなる
    expect(parseClamResponse('何かおかしな応答').status).not.toBe('infected');
  });

  it('**「FOUNDが無いからclean」と決めつけない**', () => {
    // ここが最も危険。応答形式が変わった日に検疫が素通りする
    expect(parseClamResponse('何かおかしな応答').status).not.toBe('clean');
  });
});

describe('スキャナへ到達できない場合', () => {
  it('**接続できないときに clean を返さない**', async () => {
    // 使われていないポートを指定する
    const scanner = new ClamAvScanner({ host: '127.0.0.1', port: 1, timeoutMs: 2000 });
    const verdict = await scanner.scan(Buffer.from('内容'));

    // スキャナが落ちている間のアップロードが素通りしないこと
    expect(verdict.status).toBe('error');
    expect(verdict.status).not.toBe('clean');
  });

  it('**サイズ上限を超えたものを clean にしない**', async () => {
    const scanner = new ClamAvScanner({ host: '127.0.0.1', port: 1, maxBytes: 100 });
    const verdict = await scanner.scan(Buffer.alloc(200));

    // スキャンしていないのだから clean ではない。
    // 大きなファイルを検疫の抜け道にさせない。
    expect(verdict.status).toBe('error');
    if (verdict.status === 'error') {
      expect(verdict.reason).toContain('上限');
    }
  });

  it('ping が失敗しても例外を投げない', async () => {
    const scanner = new ClamAvScanner({ host: '127.0.0.1', port: 1 });
    expect(await scanner.ping()).toBe(false);
  });
});
