import { randomBytes, createHmac, createHash } from 'node:crypto';

/**
 * Object Storage への署名付きURL発行(ADR-0010 / 02.18 §4)。
 *
 * 署名付きURLは、発行後に無効化する手段がない。
 * したがって守るべきは「発行時に必ず認可すること」と「短く保つこと」の2点。
 *
 * - 有効期限は10分以内(上限を実装で強制する。呼び出し側が長くできない)
 * - 単一オブジェクト限定(プレフィックスやワイルドカードの署名を作らない)
 * - キーに organization や ticket を推測させる情報を含めない(脅威 T-16)
 */

/** 02.18 §4 の上限。これを超える指定は実装側で切り詰める。 */
export const MAX_SIGNED_URL_TTL_SECONDS = 600;

export interface SignedUrl {
  url: string;
  expiresAt: Date;
  /** 実際に適用された有効期間(秒)。要求値が上限を超えた場合は切り詰められる。 */
  ttlSeconds: number;
}

export interface ObjectStorageConfig {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
}

/**
 * 推測不能なオブジェクトキーを生成する。
 *
 * ファイル名・チケット番号・連番を含めない。
 * キーが推測できると、署名の仕組みとは無関係に「存在の確認」ができてしまい、
 * 添付の有無から業務内容が漏れる。
 */
export function generateStorageKey(): string {
  const now = new Date();
  // 日付プレフィックスはライフサイクル管理(古いオブジェクトの移動)のためだけに使う。
  // 組織やチケットの情報は含めない。
  const datePrefix = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return `attachments/${datePrefix}/${randomBytes(32).toString('hex')}`;
}

export interface ObjectStorage {
  presignGet(key: string, ttlSeconds: number, downloadFileName: string): SignedUrl;
  presignPut(key: string, ttlSeconds: number, contentType: string): SignedUrl;
  /**
   * オブジェクトの実体をサーバ側で取得する。
   *
   * **利用者への配布には使わない。** 配布は署名付きURLで行い、
   * アプリを経由させない(大きなファイルでプロセスが詰まる)。
   * これはウイルススキャンのように**サーバ自身が中身を見る必要がある**場合に限る。
   */
  getObject(key: string): Promise<Buffer>;
}

/**
 * オブジェクトストレージ。
 *
 * `packages/shared` に置いているのは、**API と Worker の双方が必要とする**ため。
 * API は署名付きURLを発行し、Worker はウイルススキャンのために実体を読む。
 * どちらかのサービスに置くと、もう一方がそれを import することになり、
 * サービス間の依存が生まれる(`check_architecture.mjs` が禁止している)。
 *
 * S3互換の署名付きURL(SigV4)。
 *
 * ローカルは MinIO、本番は S3(ADR-0018)。同一の実装で両方を扱う。
 */
export class S3CompatibleStorage implements ObjectStorage {
  constructor(private readonly config: ObjectStorageConfig) {}

  presignGet(key: string, ttlSeconds: number, downloadFileName: string): SignedUrl {
    // ブラウザでの実行を避けるため、常に添付としてダウンロードさせる。
    // HTMLやSVGがインライン表示されると、同一オリジンでのスクリプト実行につながる。
    const disposition = `attachment; filename*=UTF-8''${encodeURIComponent(downloadFileName)}`;
    return this.presign('GET', key, ttlSeconds, {
      'response-content-disposition': disposition,
      'response-content-type': 'application/octet-stream',
    });
  }

  presignPut(key: string, ttlSeconds: number, contentType: string): SignedUrl {
    return this.presign('PUT', key, ttlSeconds, {}, contentType);
  }

  /**
   * サーバ側での実体取得。ウイルススキャンのみに使う。
   *
   * 自分で署名付きURLを作って自分で取りに行く。専用の資格情報経路を増やさず、
   * 署名の実装も1つに保つ。TTLは短く取る — このURLは外へ出さないため、
   * 長い有効期間に意味が無い。
   */
  async getObject(key: string): Promise<Buffer> {
    const signed = this.presignGet(key, 60, 'object');
    const response = await fetch(signed.url);
    if (!response.ok) {
      throw new Error(`オブジェクトを取得できません: ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * RFC 3986 に従ったURIエンコード。
   *
   * **`encodeURIComponent` をそのまま使ってはいけない。**
   * `! ' ( ) *` を変換しないため、SigV4 が要求する正規化と食い違う。
   *
   * この違いは普段は現れない。オブジェクトキーは16進文字列で、
   * PUT の追加パラメータは `Content-Type` だけだからである。
   * 現れるのはダウンロードのときで、`Content-Disposition` に
   * `filename*=UTF-8''<name>` が入る — ここに `*` と `'` が含まれる。
   *
   * 結果として **PUT は通るが GET だけが 403 になる**という、
   * 気付きにくい壊れ方をしていた(WP-P2-SCAN-011 で発見)。
   */
  private static uriEncode(value: string): string {
    return encodeURIComponent(value).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  }

  private presign(
    method: 'GET' | 'PUT',
    key: string,
    requestedTtl: number,
    extraQuery: Record<string, string>,
    contentType?: string,
  ): SignedUrl {
    // 呼び出し側が上限を超える値を渡しても、ここで切り詰める。
    // 「設定ミスで長い署名が出回る」経路を残さない。
    const ttlSeconds = Math.min(Math.max(1, Math.floor(requestedTtl)), MAX_SIGNED_URL_TTL_SECONDS);

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const credentialScope = `${dateStamp}/${this.config.region}/s3/aws4_request`;

    const host = new URL(this.config.endpoint).host;
    const canonicalUri = `/${this.config.bucket}/${key
      .split('/')
      .map((segment) => S3CompatibleStorage.uriEncode(segment))
      .join('/')}`;

    const query: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.config.accessKey}/${credentialScope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(ttlSeconds),
      'X-Amz-SignedHeaders': 'host',
      ...extraQuery,
    };
    if (contentType) query['Content-Type'] = contentType;

    const canonicalQuery = Object.keys(query)
      .sort()
      .map((k) => `${S3CompatibleStorage.uriEncode(k)}=${S3CompatibleStorage.uriEncode(query[k]!)}`)
      .join('&');

    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQuery,
      `host:${host}\n`,
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n');

    // SigV4 の署名鍵は日付→リージョン→サービス→終端の順に導出する
    const kDate = createHmac('sha256', `AWS4${this.config.secretKey}`).update(dateStamp).digest();
    const kRegion = createHmac('sha256', kDate).update(this.config.region).digest();
    const kService = createHmac('sha256', kRegion).update('s3').digest();
    const kSigning = createHmac('sha256', kService).update('aws4_request').digest();

    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    return {
      url: `${this.config.endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`,
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
      ttlSeconds,
    };
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
