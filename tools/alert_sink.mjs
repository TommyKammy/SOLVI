#!/usr/bin/env node
/**
 * アラート受信シンク (WP-P2-SLO-008)
 *
 * 目的は1つ。**アラートが実際に人のところまで届いたことを機械的に確かめる。**
 *
 * アラートが「定義されている」ことと「届く」ことは別問題で、
 * 経路の設定ミス・認証切れ・宛先の退職で、静かに届かなくなる。
 * 届かないアラートは、無いのと同じどころか「鳴らない=正常」という
 * 誤った安心を与えるぶん有害である。
 *
 * ローカル/パイロットでは本物のチャットやメールの代わりにこれで受ける。
 * 疑似アラートの演習(§7 受入基準)はこのシンクの記録を証跡にする。
 * 本番の通知先は Gate A までに決める(OQ-012)。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.ALERT_SINK_PORT ?? 9466);
const LOG_PATH = process.env.ALERT_SINK_LOG ?? '/var/log/solvi/alerts.jsonl';

fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });

/** @type {object[]} 直近の受信内容。演習の確認に使う。 */
const received = [];
const MAX_KEPT = 200;

function record(entry) {
  received.push(entry);
  if (received.length > MAX_KEPT) received.shift();
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
}

http
  .createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/alerts') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        // 受信側で上限を持たないと、壊れた送信元にメモリを食い潰される。
        if (body.length > 1_000_000) req.destroy();
      });
      req.on('end', () => {
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          res.writeHead(400);
          res.end();
          return;
        }
        for (const alert of payload.alerts ?? []) {
          record({
            receivedAt: new Date().toISOString(),
            status: alert.status,
            alertname: alert.labels?.alertname,
            severity: alert.labels?.severity,
            slo: alert.labels?.slo,
            job: alert.labels?.job,
            summary: alert.annotations?.summary,
            startsAt: alert.startsAt,
          });
          process.stdout.write(
            JSON.stringify({
              level: 'info',
              message: 'alert received',
              alertname: alert.labels?.alertname,
              severity: alert.labels?.severity,
              status: alert.status,
              timestamp: new Date().toISOString(),
            }) + '\n',
          );
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"received":true}');
      });
      return;
    }

    // 演習の確認用。到達したアラートの一覧を返す。
    if (req.method === 'GET' && req.url === '/alerts') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(received));
      return;
    }

    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }

    res.writeHead(404);
    res.end();
  })
  .listen(PORT, () => {
    process.stdout.write(
      JSON.stringify({
        level: 'info',
        message: 'alert sink started',
        port: PORT,
        logPath: LOG_PATH,
        timestamp: new Date().toISOString(),
      }) + '\n',
    );
  });
