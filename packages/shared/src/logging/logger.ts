import { redactLogRecord } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  service: string;
  level: LogLevel;
  env: string;
  /** テスト用の差し替え口 */
  sink?: (line: string) => void;
}

export interface LogContext {
  correlationId?: string;
  requestId?: string;
  organizationId?: string;
  actorId?: string;
  actorType?: string;
  [key: string]: unknown;
}

/**
 * 構造化ログ。出力は JSON 1行。
 * 監査の正本ではない(監査は audit_event テーブル / ADR-0009)。運用ログを監査の代わりにしない。
 */
export class Logger {
  constructor(
    private readonly options: LoggerOptions,
    private readonly context: LogContext = {},
  ) {}

  child(context: LogContext): Logger {
    return new Logger(this.options, { ...this.context, ...context });
  }

  debug(message: string, fields: LogContext = {}): void {
    this.write('debug', message, fields);
  }
  info(message: string, fields: LogContext = {}): void {
    this.write('info', message, fields);
  }
  warn(message: string, fields: LogContext = {}): void {
    this.write('warn', message, fields);
  }

  error(message: string, error?: unknown, fields: LogContext = {}): void {
    const extra: LogContext = { ...fields };
    if (error instanceof Error) {
      extra.errorName = error.name;
      extra.errorMessage = error.message;
      if (this.options.env !== 'production') extra.stack = error.stack;
    } else if (error !== undefined) {
      extra.errorName = 'UnknownError';
      extra.errorMessage = String(error);
    }
    this.write('error', message, extra);
  }

  private write(level: LogLevel, message: string, fields: LogContext): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.options.level]) return;
    const record = redactLogRecord({
      timestamp: new Date().toISOString(),
      level,
      message,
      service: this.options.service,
      env: this.options.env,
      ...this.context,
      ...fields,
    });
    const line = JSON.stringify(record);
    if (this.options.sink) this.options.sink(line);
    else if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);
  }
}

export function createLogger(options: LoggerOptions): Logger {
  return new Logger(options);
}
