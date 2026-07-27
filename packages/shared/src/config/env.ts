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
  // Prometheus スクレイプ用の待受ポート。未設定だとメトリクスが
  // 一切記録されない(MeterProvider が生成されない)ため、
  // 本番相当環境では必ず設定する。→ docs/ops/slo.md
  METRICS_PORT: z.coerce.number().int().min(1).max(65535).optional(),
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

    /**
     * ローカルアカウント認証の有効化 (ADR-0019)。
     *
     * **既定は無効。** 明示的に有効化しない限り認証経路そのものが存在しない。
     * 「うっかり有効なまま」を防ぐには、既定値を安全側に置くのが最も確実である。
     */
    AUTH_LOCAL_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),

    /** Cookie に Secure を付けるか。ローカルHTTP開発では false。 */
    SESSION_COOKIE_SECURE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),

    /** ログイン失敗の許容回数。超えるとロックアウトする。 */
    AUTH_MAX_FAILED_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(5),

    /** ロックアウトの継続時間(秒)。 */
    AUTH_LOCKOUT_SECONDS: z.coerce.number().int().min(1).default(900),
  })
  .superRefine((env, ctx) => {
    // -----------------------------------------------------------------------
    // 脅威 T-25: ローカル認証の本番混入
    //
    // 警告ではなく**起動拒否**にする。警告は無視されるが、起動失敗は無視できない。
    //
    // 「本番では設定しない運用にする」は対策として弱い。設定は人が書くもので、
    // 人は間違える。間違えたときに動いてしまう設計が問題なのであって、
    // 間違えないよう気を付けることは対策ではない。
    // -----------------------------------------------------------------------
    if (env.NODE_ENV === 'production' && env.AUTH_LOCAL_ENABLED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_LOCAL_ENABLED'],
        message:
          'AUTH_LOCAL_ENABLED は本番環境で有効にできません。' +
          'ローカルアカウント認証は検証段階限定です(ADR-0019 / 脅威 T-25)。' +
          '本番の認証は外部IdPのOIDCに限定されます(ADR-0004)。',
      });
    }

    // HTTPS でない経路に Secure なしでセッションCookieを流すのは、
    // 本番では盗聴によるセッション窃取に直結する。
    if (env.NODE_ENV === 'production' && !env.SESSION_COOKIE_SECURE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SESSION_COOKIE_SECURE'],
        message:
          'SESSION_COOKIE_SECURE は本番環境で false にできません。' +
          'HTTPS以外の経路にセッションCookieが流れます。',
      });
    }
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
