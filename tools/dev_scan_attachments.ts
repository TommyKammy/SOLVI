/** Local attachment scanning only: no notifications, SLA jobs, or external actions. */
import pg from 'pg';
import {
  ClamAvScanner,
  S3CompatibleStorage,
  createLogger,
  workerEnvSchema,
  loadEnv,
} from '@solvi/shared';
import { AttachmentScanner } from '../services/worker/src/jobs/scan/attachment-scanner.js';

if (process.env.NODE_ENV !== 'development') throw new Error('development only');
const env = loadEnv(workerEnvSchema, 'local-attachment-scanner');
if (!['localhost', '127.0.0.1'].includes(new URL(env.DATABASE_URL).hostname))
  throw new Error('ローカル DB 専用です');
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2 });
const logger = createLogger({
  service: 'local-attachment-scanner',
  level: env.LOG_LEVEL,
  env: env.NODE_ENV,
});
const scanner = new ClamAvScanner({
  host: '127.0.0.1',
  port: env.CLAMAV_PORT,
  maxBytes: env.CLAMAV_MAX_BYTES,
});
const job = new AttachmentScanner(
  pool,
  new S3CompatibleStorage({
    endpoint: env.S3_ENDPOINT,
    bucket: env.S3_BUCKET_ATTACHMENTS,
    accessKey: env.S3_ACCESS_KEY,
    secretKey: env.S3_SECRET_KEY,
    region: env.S3_REGION,
  }),
  scanner,
  logger,
);
let busy = false;
async function tick(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    // Do not spend pending upload attempts while clamd is starting or unavailable.
    if (!(await scanner.signatureInfo())) return;
    const result = await job.scanPending();
    if (result.scanned) console.log('添付検査:', result);
  } catch {
    console.error('添付検査を実行できません。次回再試行します。');
  } finally {
    busy = false;
  }
}
const timer = setInterval(() => void tick(), 5000);
void tick();
function stop(): void {
  clearInterval(timer);
  void pool.end();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
