/**
 * ログ・トレース・AIプロンプトへ出してよいものを**許可リスト**で決める。
 *
 * 禁止リスト方式にしない理由: 新しいフィールドが追加されたとき、禁止リストは
 * 「気付かれないまま漏れる」側に倒れる。許可リストは「気付かれないまま落ちる」側に倒れる。
 * 秘密の露出(NFR-SEC-004 / 脅威 T-22)より、ログの欠落のほうが安全である。
 */

/** 構造化ログに出してよいトップレベルのキー */
export const LOG_ALLOWED_KEYS = new Set([
  'timestamp',
  'level',
  'message',
  'service',
  'env',
  'correlationId',
  'requestId',
  'workflowRunId',
  'commandId',
  'receiptId',
  'organizationId',
  'actorId',
  'actorType',
  'method',
  'path',
  'route',
  'statusCode',
  'durationMs',
  'errorName',
  'errorMessage',
  'stack',
  'outcome',
  'eventType',
  'targetType',
  'targetId',
  'policyDecision',
  'attempt',
  'count',
]);

export const REDACTED = '[REDACTED]';

/** 値そのものが秘密らしい形をしているかの最終防衛線 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9]{16,}\b/, // APIキー風
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, // AWS access key id
  /postgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/, // 資格情報つき接続文字列
];

function scrubString(value: string): string {
  return SECRET_VALUE_PATTERNS.some((re) => re.test(value)) ? REDACTED : value;
}

/**
 * 許可キー以外を落とし、残った文字列値も秘密パターンで最終チェックする。
 * @param maxDepth ネストの上限。深い構造をログへ流し込むこと自体を抑止する。
 */
export function redactLogRecord(
  record: Record<string, unknown>,
  maxDepth = 2,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!LOG_ALLOWED_KEYS.has(key)) continue;
    out[key] = scrubValue(value, maxDepth);
  }
  return out;
}

function scrubValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth <= 0) return REDACTED;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrubValue(v, depth - 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = scrubValue(v, depth - 1);
  }
  return out;
}

/**
 * 外部APIの応答要約など、許可リストを適用できない自由文字列に使う。
 * 秘密パターンに一致した場合は全体を落とす(部分マスクにしない ―
 * 部分的に残った文字列から復元される余地を作らない)。
 */
export function scrubFreeText(text: string, maxLength = 500): string {
  const scrubbed = scrubString(text);
  return scrubbed.length > maxLength ? `${scrubbed.slice(0, maxLength)}…[truncated]` : scrubbed;
}
