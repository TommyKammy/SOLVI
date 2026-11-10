/** 開発用 API / Web を同時に起動する。データや外部接続の設定は変更しない。 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

if (process.env.NODE_ENV === 'production') throw new Error('dev:local は開発環境専用です');
const root = fileURLToPath(new URL('..', import.meta.url));
const apiPort = process.env.API_PORT ?? '3001';
const webPort = process.env.WEB_PORT ?? '3000';
const storageEndpoint = `http://127.0.0.1:${process.env.S3_PORT ?? '9100'}`;
const env = {
  ...process.env,
  NODE_ENV: 'development',
  OTEL_EXPORTER_OTLP_ENDPOINT: '',
  S3_ENDPOINT: storageEndpoint,
  S3_PUBLIC_ENDPOINT: storageEndpoint,
};
const children = [
  spawn(process.execPath, ['tools/dev_object_storage.mjs'], { cwd: root, env, stdio: 'inherit' }),
  spawn(
    process.execPath,
    [join(root, 'node_modules/tsx/dist/cli.mjs'), 'tools/dev_scan_attachments.ts'],
    { cwd: root, env, stdio: 'inherit' },
  ),
  spawn(
    process.execPath,
    [join(root, 'node_modules/tsx/dist/cli.mjs'), 'watch', 'services/api/src/main.ts'],
    { cwd: root, env, stdio: 'inherit' },
  ),
  spawn(
    process.execPath,
    [
      join(root, 'node_modules/next/dist/bin/next'),
      'dev',
      '--hostname',
      '127.0.0.1',
      '--port',
      webPort,
    ],
    {
      cwd: join(root, 'apps/web'),
      env: {
        ...env,
        API_BASE_URL: `http://127.0.0.1:${apiPort}`,
        WEB_BASE_URL: `http://127.0.0.1:${webPort}`,
      },
      stdio: 'inherit',
    },
  ),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
}
for (const child of children) {
  child.on('error', () => {
    console.error('開発サーバーを起動できませんでした。');
    stop(1);
  });
  child.on('exit', (code) => stop(code ?? 0));
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
console.log(`SOLVI 開発ポータル: http://127.0.0.1:${webPort}`);
