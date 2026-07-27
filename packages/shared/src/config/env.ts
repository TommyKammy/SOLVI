import { z } from 'zod';

/**
 * 環境変数の検証。
 *
 * 既定値は与えない。未設定・不正な値のときはプロセスを起動させない(fail closed)。
 * 本番の資格情報がローカルへ紛れ込んでも既定値で動いてしまう事故を防ぐため、
 * 「動くが設定が抜けている」状態を作らない。
 */

const nonEmpty = (label: string) => z.string().min(1, `${label} が未設定です`);

const postgresUrl = z.string().refine((v) => /^postgres(ql)?:\/\/[^:]+:[^@]+@[^/]+\/.+/.test(v), {
  message: 'DATABASE_URL の形式が不正です (postgres://user:password@host:port/db)',
});

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  OTEL_SERVICE_NAMESPACE: z.string().default('solvi'),
});

const databaseSchema = z.object({
  DATABASE_URL: postgresUrl,
});

const storageSchema = z.object({
  S3_ENDPOINT: nonEmpty('S3_ENDPOINT'),
  S3_REGION: nonEmpty('S3_REGION'),
  S3_BUCKET_ATTACHMENTS: nonEmpty('S3_BUCKET_ATTACHMENTS'),
  S3_BUCKET_AUDIT_ANCHOR: nonEmpty('S3_BUCKET_AUDIT_ANCHOR'),
  S3_ACCESS_KEY: nonEmpty('S3_ACCESS_KEY'),
  S3_SECRET_KEY: nonEmpty('S3_SECRET_KEY'),
});

export const apiEnvSchema = baseSchema
  .merge(databaseSchema)
  .merge(storageSchema)
  .extend({
    API_PORT: z.coerce.number().int().positive().default(3001),
    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET は32文字以上にしてください'),
  });

export const workerEnvSchema = baseSchema
  .merge(databaseSchema)
  .merge(storageSchema)
  .extend({
    WORKER_PORT: z.coerce.number().int().positive().default(3002),
  });

/**
 * Executor は Core とは別の資格情報で動く(ADR-0006)。
 * Core のセッション秘密や添付ストレージの資格情報を要求しない ―
 * 必要のない秘密を持たせないことが分離の実態である。
 */
export const executorEnvSchema = baseSchema.merge(databaseSchema).extend({
  EXECUTOR_PORT: z.coerce.number().int().positive().default(3003),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;
export type WorkerEnv = z.infer<typeof workerEnvSchema>;
export type ExecutorEnv = z.infer<typeof executorEnvSchema>;

export class EnvValidationError extends Error {
  constructor(
    readonly service: string,
    readonly issues: string[],
  ) {
    super(
      `${service}: 環境変数の検証に失敗しました。起動を中止します。\n` +
        issues.map((i) => `  - ${i}`).join('\n'),
    );
    this.name = 'EnvValidationError';
  }
}

/**
 * 検証に失敗したら EnvValidationError を投げる。
 * エラーメッセージに値そのものを含めない(Secret がログへ出るのを防ぐ / AGENTS.md §1.8)。
 */
export function loadEnv<T extends z.ZodTypeAny>(
  schema: T,
  service: string,
  source: NodeJS.ProcessEnv = process.env,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new EnvValidationError(service, issues);
  }
  return result.data;
}
