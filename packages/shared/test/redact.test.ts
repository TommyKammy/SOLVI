import { describe, it, expect } from 'vitest';
import { redactLogRecord, scrubFreeText, REDACTED } from '../src/logging/redact.js';
import { Logger } from '../src/logging/logger.js';

describe('ログのredaction (NFR-SEC-004 / 脅威 T-22)', () => {
  it('許可リストにないキーを落とす', () => {
    const out = redactLogRecord({
      message: 'ok',
      correlationId: 'abc',
      password: 'hunter2',
      accessToken: 'secret-token',
      requestBody: { ticketTitle: '内部の議事録' },
    });
    expect(out).toEqual({ message: 'ok', correlationId: 'abc' });
    expect(Object.keys(out)).not.toContain('password');
    expect(Object.keys(out)).not.toContain('requestBody');
  });

  it('許可キーの値であっても秘密らしい文字列は落とす', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123';
    expect(redactLogRecord({ errorMessage: jwt }).errorMessage).toBe(REDACTED);
  });

  it('接続文字列に含まれる資格情報を落とす', () => {
    const url = 'postgres://solvi_app:s3cr3t@db:5432/solvi';
    expect(redactLogRecord({ errorMessage: `connect failed: ${url}` }).errorMessage).toBe(REDACTED);
  });

  it('AWSアクセスキーIDを落とす', () => {
    expect(redactLogRecord({ message: 'key AKIAIOSFODNN7EXAMPLE leaked' }).message).toBe(REDACTED);
  });

  it('秘密鍵のPEMヘッダを落とす', () => {
    expect(
      scrubFreeText('-----BEGIN RSA PRIVATE KEY-----\nMIIEow...'),
    ).toBe(REDACTED);
  });

  it('深いネストは打ち切る(構造ごとログへ流し込むのを防ぐ)', () => {
    const out = redactLogRecord({ policyDecision: { a: { b: { c: 'deep' } } } }, 2);
    expect(JSON.stringify(out)).toContain(REDACTED);
  });

  it('通常の値はそのまま残る', () => {
    const out = redactLogRecord({ statusCode: 200, durationMs: 12.5, path: '/healthz' });
    expect(out).toEqual({ statusCode: 200, durationMs: 12.5, path: '/healthz' });
  });
});

describe('Logger', () => {
  const capture = () => {
    const lines: string[] = [];
    const logger = new Logger({ service: 'test', level: 'info', env: 'test', sink: (l) => lines.push(l) });
    return { lines, logger };
  };

  it('レベル未満のログを出さない', () => {
    const { lines, logger } = capture();
    logger.debug('should not appear');
    logger.info('should appear');
    expect(lines).toHaveLength(1);
  });

  it('childで付けた文脈が各行に載る', () => {
    const { lines, logger } = capture();
    logger.child({ correlationId: 'corr-1' }).info('hello');
    expect(JSON.parse(lines[0]!)).toMatchObject({ correlationId: 'corr-1', message: 'hello' });
  });

  it('本番ではスタックトレースを出さない', () => {
    const lines: string[] = [];
    const logger = new Logger({ service: 'test', level: 'info', env: 'production', sink: (l) => lines.push(l) });
    logger.error('failed', new Error('boom'));
    expect(JSON.parse(lines[0]!).stack).toBeUndefined();
  });

  it('エラーメッセージ内の秘密も落とす', () => {
    const { lines, logger } = capture();
    logger.error('db down', new Error('postgres://u:p@h:5432/d unreachable'));
    expect(JSON.parse(lines[0]!).errorMessage).toBe(REDACTED);
  });
});
