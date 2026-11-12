import { createHash } from 'node:crypto';

/**
 * 申請スナップショットの正規化とハッシュ(WP-P4-APR-011)。
 *
 * `catalog.routes.ts` から**出力を変えずに**抽出した。承認行・申請・版に保存済みの
 * `snapshot_hash` はこの出力と一致している必要があるため、実装を変えてはならない
 * (固定ベクトルは tests/unit/approval-assertion.test.ts)。
 */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}

export const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
