#!/usr/bin/env node
/**
 * オブジェクトストレージのバケット作成 (WP-P2-SCAN-011)
 *
 * `docker compose up` だけでは MinIO にバケットが存在しない。
 * 添付のアップロードは 404 で失敗するが、**エラーの原因が
 * 「バケットが無い」であることは応答から分からない**。
 *
 * `migrate.mjs` がスキーマを用意するのと同じ位置づけで、
 * ストレージ側の初期化をここに置く。冪等なので何度実行してもよい。
 *
 * 監査アンカー用のバケットは、本番では Object Lock を有効にする必要がある
 * (ADR-0009)。ローカルの MinIO では有効化しないため、
 * **ローカルで改ざん防止が効いていると誤解しないこと。**
 */

import { createHash, createHmac } from 'node:crypto';

const ENDPOINT = process.env.S3_ENDPOINT;
const REGION = process.env.S3_REGION;
const ACCESS_KEY = process.env.S3_ACCESS_KEY;
const SECRET_KEY = process.env.S3_SECRET_KEY;

const BUCKETS = [process.env.S3_BUCKET_ATTACHMENTS, process.env.S3_BUCKET_AUDIT_ANCHOR].filter(
  Boolean,
);

if (!ENDPOINT || !REGION || !ACCESS_KEY || !SECRET_KEY || BUCKETS.length === 0) {
  process.stderr.write('S3_* 環境変数が不足しています\n');
  process.exit(78);
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/** SigV4 署名。バケット操作は署名付きURLではなくヘッダ署名で行う。 */
function signedHeaders(method, bucket) {
  const url = new URL(`${ENDPOINT}/${bucket}`);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256('');

  const canonicalHeaders =
    `host:${url.host}\n` + `x-amz-content-sha256:${payloadHash}\n` + `x-amz-date:${amzDate}\n`;
  const signedHeaderList = 'host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = [
    method,
    url.pathname,
    '',
    canonicalHeaders,
    signedHeaderList,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${REGION}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');

  let key = hmac(`AWS4${SECRET_KEY}`, dateStamp);
  key = hmac(key, REGION);
  key = hmac(key, 's3');
  key = hmac(key, 'aws4_request');
  const signature = hmac(key, stringToSign).toString('hex');

  return {
    url: url.toString(),
    headers: {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${scope}, ` +
        `SignedHeaders=${signedHeaderList}, Signature=${signature}`,
    },
  };
}

let failed = 0;

for (const bucket of BUCKETS) {
  const head = signedHeaders('HEAD', bucket);
  const exists = await fetch(head.url, { method: 'HEAD', headers: head.headers }).catch(() => null);

  if (exists?.ok) {
    process.stdout.write(`  既存 ${bucket}\n`);
    continue;
  }

  const put = signedHeaders('PUT', bucket);
  const created = await fetch(put.url, { method: 'PUT', headers: put.headers }).catch((error) => ({
    ok: false,
    status: 0,
    statusText: error.message,
  }));

  if (created.ok) {
    process.stdout.write(`  作成 ${bucket}\n`);
  } else {
    process.stdout.write(`  失敗 ${bucket} — ${created.status} ${created.statusText ?? ''}\n`);
    failed += 1;
  }
}

if (failed > 0) {
  process.stdout.write(`\n${failed} 件のバケットを用意できませんでした\n`);
  process.exit(1);
}
process.stdout.write('\nOK: バケットは利用可能です\n');
