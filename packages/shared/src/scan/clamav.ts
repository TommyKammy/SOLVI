import net from 'node:net';

/**
 * ClamAV クライアント (WP-P2-SCAN-011 / OQ-011)。
 *
 * clamd の `INSTREAM` を使い、**ファイルを一時ディスクへ置かずに**ストリームで送る。
 * ディスクへ置くと、スキャン前の検体がファイルシステム上に存在する時間が生まれ、
 * 他のプロセス(バックアップ、同期、ウイルス対策ソフト自身)が拾いうる。
 *
 * 判定は3値である。**「感染していない」と「判定できなかった」を区別する。**
 * 混同すると、スキャナが落ちている間のアップロードがすべて `clean` になり、
 * 検疫を素通りする。判定できなかったものは `pending` のまま残し、再試行する。
 */

export type ScanVerdict =
  | { status: 'clean' }
  | { status: 'infected'; signature: string }
  /** スキャナへ到達できない、応答が解釈できない等。**cleanではない。** */
  | { status: 'error'; reason: string };

export interface ClamAvOptions {
  host: string;
  port: number;
  /** 応答を待つ上限。長すぎると滞留し、短すぎると大きなファイルで誤って error になる。 */
  timeoutMs?: number;
  /** clamd の StreamMaxLength を超えると接続が切られるため、送信前に弾く。 */
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/** INSTREAM のチャンク長ヘッダ(4バイト・ビッグエンディアン) */
function chunkHeader(length: number): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(length);
  return header;
}

/**
 * clamd の応答を判定へ変換する。
 *
 * 応答例:
 *   `stream: OK`
 *   `stream: Eicar-Test-Signature FOUND`
 *   `stream: <reason> ERROR`
 *
 * **知らない形式は error にする。** 「OK が含まれていないから感染」と決めつけると
 * 誤検知で正当なファイルを止め、逆に「FOUND が無いから clean」と決めつけると
 * 応答形式が変わった日に検疫が素通りする。
 */
export function parseClamResponse(raw: string): ScanVerdict {
  const line = raw.trim().replace(/\0+$/, '');

  if (/\bERROR\b/.test(line)) {
    return { status: 'error', reason: line };
  }
  const found = /:\s*(.+?)\s+FOUND$/.exec(line);
  if (found) {
    return { status: 'infected', signature: found[1] ?? 'unknown' };
  }
  if (/:\s*OK$/.test(line)) {
    return { status: 'clean' };
  }
  return { status: 'error', reason: `解釈できない応答: ${line}` };
}

export class ClamAvScanner {
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(private readonly options: ClamAvOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  async scan(content: Buffer): Promise<ScanVerdict> {
    if (content.length > this.maxBytes) {
      // 上限を超えるものを clean にしない。**スキャンしていないのだから clean ではない。**
      // 大きなファイルを検疫の抜け道にさせない。
      return {
        status: 'error',
        reason: `スキャン可能な上限(${this.maxBytes} bytes)を超えています`,
      };
    }

    return new Promise<ScanVerdict>((resolve) => {
      const socket = net.createConnection({
        host: this.options.host,
        port: this.options.port,
      });
      let response = '';
      let settled = false;

      const finish = (verdict: ScanVerdict): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(verdict);
      };

      socket.setTimeout(this.timeoutMs, () => {
        finish({ status: 'error', reason: 'スキャナの応答がタイムアウトしました' });
      });

      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        socket.write(chunkHeader(content.length));
        socket.write(content);
        // 長さ0のチャンクが終端を表す
        socket.write(chunkHeader(0));
      });

      socket.on('data', (chunk) => {
        response += chunk.toString('utf8');
      });

      socket.on('end', () => finish(parseClamResponse(response)));

      // 接続できない場合も **clean にしない**。
      // スキャナが落ちている間のアップロードが素通りする。
      socket.on('error', (error) =>
        finish({ status: 'error', reason: `スキャナへ接続できません: ${error.message}` }),
      );
    });
  }

  /** 疎通確認。起動直後は署名DBの読み込みで応答しないため、待機に使う。 */
  async ping(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host: this.options.host, port: this.options.port });
      let response = '';
      const done = (ok: boolean): void => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(5000, () => done(false));
      socket.on('connect', () => socket.write('zPING\0'));
      socket.on('data', (chunk) => {
        response += chunk.toString('utf8');
      });
      socket.on('end', () => done(response.includes('PONG')));
      socket.on('error', () => done(false));
    });
  }
}
