/** Development-only subset of S3 presigned requests emitted by S3CompatibleStorage.
 * Never use this server for production, public hosting, or audit retention guarantees.
 */
import { createServer } from 'node:http';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, readFile, link, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';

if (process.env.NODE_ENV !== 'development') throw new Error('development only');
const endpoint = new URL(process.env.S3_ENDPOINT ?? '');
if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/')
  throw new Error('開発ストレージは http://127.0.0.1:<port> 専用です');
const accessKey = process.env.S3_ACCESS_KEY;
const secretKey = process.env.S3_SECRET_KEY;
const region = process.env.S3_REGION;
if (!accessKey || !secretKey || !region) throw new Error('S3 設定が不足しています');
const buckets = new Set([process.env.S3_BUCKET_ATTACHMENTS, process.env.S3_BUCKET_AUDIT_ANCHOR]);
if (buckets.has(undefined) || buckets.has('')) throw new Error('bucket 設定が不足しています');
const root = resolve('.local/object-storage');
await mkdir(root, { recursive: true, mode: 0o700 });
const origin = `http://127.0.0.1:${process.env.WEB_PORT ?? '3000'}`;
const maxBytes = 25 * 1024 * 1024;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const encode = (value) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

function authorize(req, url) {
  if (req.headers.host !== endpoint.host) return false;
  const pairs = [...url.searchParams];
  if (new Set(pairs.map(([key]) => key)).size !== pairs.length) return false;
  const p = Object.fromEntries(pairs);
  if (p['X-Amz-Algorithm'] !== 'AWS4-HMAC-SHA256' || p['X-Amz-SignedHeaders'] !== 'host')
    return false;
  if (
    !/^\d{8}T\d{6}Z$/.test(p['X-Amz-Date'] ?? '') ||
    !/^[a-f0-9]{64}$/.test(p['X-Amz-Signature'] ?? '')
  )
    return false;
  const stamp = p['X-Amz-Date'];
  const issued = Date.parse(
    `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`,
  );
  const ttl = Number(p['X-Amz-Expires']);
  if (
    !Number.isInteger(ttl) ||
    ttl < 1 ||
    ttl > 600 ||
    Date.now() < issued - 30000 ||
    Date.now() > issued + ttl * 1000
  )
    return false;
  const scope = `${stamp.slice(0, 8)}/${region}/s3/aws4_request`;
  if (p['X-Amz-Credential'] !== `${accessKey}/${scope}`) return false;
  if (req.method === 'PUT' && p['Content-Type'] !== req.headers['content-type']) return false;
  const query = pairs
    .filter(([key]) => key !== 'X-Amz-Signature')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encode(k)}=${encode(v)}`)
    .join('&');
  const path = url.pathname
    .split('/')
    .map((segment) => encode(decodeURIComponent(segment)))
    .join('/');
  const canonical = [
    req.method,
    path,
    query,
    `host:${endpoint.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${secretKey}`, stamp.slice(0, 8)), region), 's3'),
    'aws4_request',
  );
  const expected = hmac(signingKey, ['AWS4-HMAC-SHA256', stamp, scope, hash(canonical)].join('\n'));
  return timingSafeEqual(expected, Buffer.from(p['X-Amz-Signature'], 'hex'));
}

const server = createServer(async (req, res) => {
  // No access logging: signed URLs contain short-lived bearer credentials.
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  try {
    const url = new URL(req.url, endpoint);
    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.end('ok');
      return;
    }
    if (req.headers.origin && req.headers.origin !== origin) {
      res.writeHead(403).end();
      return;
    }
    if (req.headers.origin) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('access-control-allow-methods', 'GET, PUT, DELETE');
      res.setHeader('access-control-allow-headers', 'content-type');
      res.writeHead(204).end();
      return;
    }
    if (!['GET', 'PUT', 'DELETE'].includes(req.method) || !authorize(req, url)) {
      res.writeHead(403).end();
      return;
    }
    const parts = url.pathname.slice(1).split('/').map(decodeURIComponent);
    const bucket = parts.shift();
    const key = parts.join('/');
    if (!buckets.has(bucket) || !key || key.length > 1024) {
      res.writeHead(404).end();
      return;
    }
    // Hash both identifiers; user-controlled names can never become filesystem paths.
    const file = join(root, hash(`${bucket}\0${key}`));
    if (req.method === 'GET') {
      const bytes = await readFile(file);
      res.setHeader('content-type', 'application/octet-stream');
      const disposition = url.searchParams.get('response-content-disposition');
      if (disposition && /^attachment; filename\*=UTF-8''[^\r\n]+$/.test(disposition))
        res.setHeader('content-disposition', disposition);
      res.end(bytes);
      return;
    }
    if (req.method === 'DELETE') {
      await unlink(file).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      res.writeHead(204).end();
      return;
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    if (size === 0) {
      res.writeHead(400).end();
      return;
    }
    const temp = join(root, `.upload-${randomUUID()}`);
    try {
      await writeFile(temp, Buffer.concat(chunks), { flag: 'wx', mode: 0o600 });
      // Publish complete bytes atomically, once only. A reused upload URL cannot
      // overwrite bytes which have already been scanned and marked clean.
      await link(temp, file);
    } finally {
      await unlink(temp).catch(() => undefined);
    }
    res.writeHead(200).end();
  } catch (error) {
    res.writeHead(error.code === 'ENOENT' ? 404 : error.code === 'EEXIST' ? 409 : 500).end();
  }
});
server.requestTimeout = 60000;
server.listen(Number(endpoint.port), '127.0.0.1', () =>
  console.log(`開発ストレージ: ${endpoint.origin} (.local/object-storage に保存)`),
);
process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
