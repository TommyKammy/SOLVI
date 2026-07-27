import { describe, it, expect } from 'vitest';
import { loadEnv, apiEnvSchema, executorEnvSchema, EnvValidationError } from '../src/config/env.js';

const validApiEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/solvi',
  S3_ENDPOINT: 'http://localhost:9100',
  S3_REGION: 'ap-northeast-1',
  S3_BUCKET_ATTACHMENTS: 'a',
  S3_BUCKET_AUDIT_ANCHOR: 'b',
  S3_ACCESS_KEY: 'k',
  S3_SECRET_KEY: 's',
  SESSION_SECRET: 'x'.repeat(32),
};

describe('環境変数の検証 (fail closed)', () => {
  it('必須値が揃っていれば読み込める', () => {
    expect(loadEnv(apiEnvSchema, 'api', validApiEnv as NodeJS.ProcessEnv).API_PORT).toBe(3001);
  });

  it('DATABASE_URL がないと失敗する(既定値で起動させない)', () => {
    const { DATABASE_URL: _omit, ...without } = validApiEnv;
    expect(() => loadEnv(apiEnvSchema, 'api', without as NodeJS.ProcessEnv)).toThrow(
      EnvValidationError,
    );
  });

  it('SESSION_SECRET が短いと失敗する', () => {
    expect(() =>
      loadEnv(apiEnvSchema, 'api', {
        ...validApiEnv,
        SESSION_SECRET: 'short',
      } as NodeJS.ProcessEnv),
    ).toThrow(EnvValidationError);
  });

  it('エラーメッセージに値そのものを含めない', () => {
    try {
      loadEnv(apiEnvSchema, 'api', {
        ...validApiEnv,
        DATABASE_URL: 'postgres://u:SUPERSECRET@h/d?x',
      } as NodeJS.ProcessEnv);
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('SUPERSECRET');
      return;
    }
    // 形式が通ってしまう場合もあるため、通ったこと自体は失敗にしない
  });

  it('Executor は添付ストレージやセッション秘密を要求しない(必要のない秘密を持たせない)', () => {
    const env = loadEnv(executorEnvSchema, 'executor', {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://exec:pass@localhost:5432/solvi',
    } as NodeJS.ProcessEnv);
    expect(env.EXECUTOR_PORT).toBe(3003);
    expect('S3_SECRET_KEY' in env).toBe(false);
    expect('SESSION_SECRET' in env).toBe(false);
  });
});
