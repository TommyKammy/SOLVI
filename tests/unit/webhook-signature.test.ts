/**
 * Webhook署名(TL-11 / NFR-SEC-007 / 脅威 T-17)。
 *
 * 署名の検証は「正しい要求が通ること」より
 * **「不正な要求が通らないこと」**の網羅が重要。
 */
import { describe, it, expect } from 'vitest';
import {
  signWebhook,
  verifyWebhook,
  InMemoryNonceStore,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  NONCE_HEADER,
  TIMESTAMP_TOLERANCE_SECONDS,
} from '../../packages/shared/src/notification/webhook-signature.js';

const SECRET = 'test-webhook-secret-value';
const NOW = new Date('2026-07-01T12:00:00Z');
const body = JSON.stringify({ event: 'ticket.created', ticketId: 'abc' });

const sign = (overrides: { now?: Date; nonce?: string; secret?: string } = {}) =>
  signWebhook({ body, secret: overrides.secret ?? SECRET, ...overrides });

describe('正当な要求', () => {
  it('署名した要求が検証を通る', async () => {
    const signed = sign();
    const result = await verifyWebhook({
      headers: signed.headers,
      body: signed.body,
      secret: SECRET,
      now: new Date(),
    });
    expect(result.valid).toBe(true);
  });

  it('必要なヘッダがすべて付く', () => {
    const signed = sign();
    expect(signed.headers[SIGNATURE_HEADER]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signed.headers[TIMESTAMP_HEADER]).toMatch(/^\d+$/);
    expect(signed.headers[NONCE_HEADER]).toBeTruthy();
  });
});

describe('改ざんの検知', () => {
  it('ペイロードを書き換えると拒否される', async () => {
    const signed = sign();
    const result = await verifyWebhook({
      headers: signed.headers,
      body: JSON.stringify({ event: 'ticket.created', ticketId: 'HACKED' }),
      secret: SECRET,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('signature_mismatch');
  });

  it('署名を書き換えると拒否される', async () => {
    const signed = sign();
    const tampered = { ...signed.headers, [SIGNATURE_HEADER]: `sha256=${'0'.repeat(64)}` };
    const result = await verifyWebhook({ headers: tampered, body, secret: SECRET });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('signature_mismatch');
  });

  it('**timestampだけ書き換えても通らない**(署名対象に含まれる)', async () => {
    // timestamp を署名対象に含めていないと、ヘッダを書き換えるだけで
    // 期限切れの要求を有効化できてしまう
    const old = sign({ now: new Date(NOW.getTime() - 3600_000) });
    const forged = { ...old.headers, [TIMESTAMP_HEADER]: String(Math.floor(Date.now() / 1000)) };
    const result = await verifyWebhook({ headers: forged, body, secret: SECRET });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('signature_mismatch');
  });

  it('**nonceだけ書き換えても通らない**(署名対象に含まれる)', async () => {
    const signed = sign();
    const forged = { ...signed.headers, [NONCE_HEADER]: 'different-nonce' };
    const result = await verifyWebhook({ headers: forged, body, secret: SECRET });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('signature_mismatch');
  });

  it('鍵が違うと拒否される', async () => {
    const signed = sign({ secret: 'attacker-secret' });
    const result = await verifyWebhook({ headers: signed.headers, body, secret: SECRET });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('signature_mismatch');
  });
});

describe('timestampの範囲', () => {
  it('許容範囲内なら通る', async () => {
    const signed = sign({ now: NOW });
    const result = await verifyWebhook({
      headers: signed.headers,
      body,
      secret: SECRET,
      now: new Date(NOW.getTime() + (TIMESTAMP_TOLERANCE_SECONDS - 10) * 1000),
    });
    expect(result.valid).toBe(true);
  });

  it('古すぎる要求は拒否される', async () => {
    const signed = sign({ now: NOW });
    const result = await verifyWebhook({
      headers: signed.headers,
      body,
      secret: SECRET,
      now: new Date(NOW.getTime() + (TIMESTAMP_TOLERANCE_SECONDS + 10) * 1000),
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('timestamp_out_of_range');
  });

  it('**未来方向のずれも拒否される**(時計を進めて期限を延ばせない)', async () => {
    const future = sign({ now: new Date(NOW.getTime() + 3600_000) });
    const result = await verifyWebhook({ headers: future.headers, body, secret: SECRET, now: NOW });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('timestamp_out_of_range');
  });

  it('数値でないtimestampを拒否する', async () => {
    const signed = sign();
    const bad = { ...signed.headers, [TIMESTAMP_HEADER]: 'not-a-number' };
    const result = await verifyWebhook({ headers: bad, body, secret: SECRET });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('timestamp_out_of_range');
  });
});

describe('リプレイ防止 (脅威 T-17)', () => {
  it('同じ要求を2回送ると2回目が拒否される', async () => {
    const store = new InMemoryNonceStore();
    const signed = sign();

    const first = await verifyWebhook({
      headers: signed.headers,
      body,
      secret: SECRET,
      nonceStore: store,
    });
    expect(first.valid).toBe(true);

    // まったく同じ要求を再送(盗聴した攻撃者が再生する状況)
    const second = await verifyWebhook({
      headers: signed.headers,
      body,
      secret: SECRET,
      nonceStore: store,
    });
    expect(second.valid).toBe(false);
    expect(second.reason).toBe('nonce_replayed');
  });

  it('**署名が不正な要求では nonce を消費しない**', async () => {
    const store = new InMemoryNonceStore();
    const signed = sign({ nonce: 'shared-nonce' });

    // 攻撃者が正当な nonce を使って不正な署名を送る
    await verifyWebhook({
      headers: { ...signed.headers, [SIGNATURE_HEADER]: `sha256=${'f'.repeat(64)}` },
      body,
      secret: SECRET,
      nonceStore: store,
    });

    // 正当な要求はまだ通るはず。先に消費していると、
    // 攻撃者が任意の nonce を潰して正当な通知を妨害できてしまう。
    const legit = await verifyWebhook({
      headers: signed.headers,
      body,
      secret: SECRET,
      nonceStore: store,
    });
    expect(legit.valid).toBe(true);
  });

  it('異なる nonce なら通る', async () => {
    const store = new InMemoryNonceStore();
    for (const nonce of ['n1', 'n2', 'n3']) {
      const signed = sign({ nonce });
      const result = await verifyWebhook({
        headers: signed.headers,
        body,
        secret: SECRET,
        nonceStore: store,
      });
      expect(result.valid).toBe(true);
    }
  });
});

describe('ヘッダの欠落', () => {
  it.each([SIGNATURE_HEADER, TIMESTAMP_HEADER, NONCE_HEADER])(
    '%s がないと拒否される',
    async (missing) => {
      const signed = sign();
      const headers = { ...signed.headers };
      delete headers[missing];
      const result = await verifyWebhook({ headers, body, secret: SECRET });
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('missing_headers');
    },
  );

  it('署名の形式が違うと拒否される', async () => {
    const signed = sign();
    const result = await verifyWebhook({
      headers: { ...signed.headers, [SIGNATURE_HEADER]: 'md5=abcdef' },
      body,
      secret: SECRET,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('malformed_signature');
  });

  it('署名の長さが違っても例外にならない', async () => {
    const signed = sign();
    const result = await verifyWebhook({
      headers: { ...signed.headers, [SIGNATURE_HEADER]: 'sha256=abc' },
      body,
      secret: SECRET,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('signature_mismatch');
  });
});
