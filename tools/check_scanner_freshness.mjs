#!/usr/bin/env node
/**
 * ウイルス定義の鮮度確認 (WP-P2-SCAN-011)
 *
 * **スキャナが実際に読み込んでいる定義**と、**ディスク上の定義**を比べる。
 *
 * この2つは食い違うことがある。freshclam が新しい定義を落としても、
 * clamd が読み直さなければ古い定義のまま動き続ける。
 * そのとき `clamdcheck.sh` も SelfCheck も「OK」と言い、
 * スキャンは成功して `clean` が返る。**見逃していることに気付けない。**
 *
 * 実測で確認した挙動:
 *   - daily.cvd が version 28074(当日ビルド)に更新されていても
 *   - clamd は version 27927(5か月前)を報告し続けた
 *   - `RELOAD` コマンドでは直らず、再起動で解消した
 */

import net from 'node:net';

const HOST = process.env.CLAMAV_HOST ?? '127.0.0.1';
const PORT = Number(process.env.CLAMAV_PORT ?? 3310);
/** 何日を超えたら警告するか。ClamAV の定義は日次更新される。 */
const MAX_AGE_DAYS = Number(process.env.SCANNER_MAX_AGE_DAYS ?? 7);

function ask(command) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: HOST, port: PORT });
    let response = '';
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(10_000, () => done(null));
    socket.on('connect', () => socket.write(`z${command}\0`));
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
    });
    socket.on('end', () => done(response));
    socket.on('error', () => done(null));
  });
}

const raw = await ask('VERSION');
if (raw === null) {
  process.stdout.write(`NG   スキャナへ接続できません (${HOST}:${PORT})\n`);
  process.exit(1);
}

const parts = raw.trim().replace(/\0+$/, '').split('/');
if (parts.length < 3) {
  process.stdout.write(`NG   応答を解釈できません: ${raw.trim()}\n`);
  process.exit(1);
}

const signatureVersion = parts[1];
const builtAt = new Date(parts[2].trim());
if (Number.isNaN(builtAt.getTime())) {
  process.stdout.write(`NG   定義の日時を解釈できません: ${parts[2]}\n`);
  process.exit(1);
}

const ageDays = (Date.now() - builtAt.getTime()) / 86_400_000;

process.stdout.write(`  エンジン   ${parts[0].replace(/^ClamAV\s+/, '')}\n`);
process.stdout.write(`  定義       version ${signatureVersion}\n`);
process.stdout.write(`  ビルド日時 ${builtAt.toISOString()}\n`);
process.stdout.write(`  経過       ${ageDays.toFixed(1)} 日\n\n`);

if (ageDays > MAX_AGE_DAYS) {
  process.stdout.write(
    `NG   ウイルス定義が ${MAX_AGE_DAYS} 日以上古くなっています。\n` +
      '     **スキャンは成功し続けるため、見逃していることに気付けません。**\n' +
      '     docs/ops/slo.md#ウイルス定義が古い の手順で確認してください。\n' +
      '     ディスク上の定義が新しくても、clamd が読み直していなければ古いままです。\n',
  );
  process.exit(1);
}

process.stdout.write('OK: ウイルス定義は最新です\n');
