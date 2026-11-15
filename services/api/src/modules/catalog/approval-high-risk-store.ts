import type pg from 'pg';
import { ProblemError } from '@solvi/shared';
import { readHighRiskAttribute } from './approval-high-risk.js';

/**
 * 高リスク申請の条件を崩す変更のためのDB補助 (WP-P4-APR-021 §6.3 / ADR-0026 §2)。
 *
 * ## ロックの順序
 *
 * 組織の設定の行(`org_approval_setting`)→ ルールの行(`approval_rule`)の順でだけ
 * ロックを取る。公開の側(`catalog-admin.routes.ts`)も同じ順であり、
 * 逆順に取る経路を作らない。これにより、公開とルール・設定の変更が同時に通って
 * 条件が崩れることを防ぎ、デッドロックも生じない。
 *
 * 設定の行が無い組織は「ルールの使用が無効」と同じに扱う(行を作らない。
 * 行を作れるのは `setRouting` だけである)。
 */

export type LockedRuleRevision = {
  ruleId: string;
  active: boolean;
  currentRevision: number;
  steps: unknown;
};

/**
 * 組織の設定の行をロックし、ルールの使用が有効かを返す。
 * 行が無ければロックする対象は無く、`false`(無効)を返す。
 */
export async function lockApprovalSetting(
  client: pg.PoolClient,
  organizationId: string,
  mode: 'share' | 'update',
): Promise<{ exists: boolean; enabled: boolean }> {
  const { rows } = await client.query<{ rule_routing_enabled: boolean }>(
    `SELECT rule_routing_enabled FROM org_approval_setting
      WHERE organization_id = $1
      ${mode === 'update' ? 'FOR UPDATE' : 'FOR SHARE'}`,
    [organizationId],
  );
  const row = rows[0];
  return { exists: row !== undefined, enabled: row?.rule_routing_enabled === true };
}

/**
 * ルールの現在の版を `FOR SHARE` で固定して読む(公開の側)。
 * 無効化・版の追加は `FOR UPDATE` を使うため、公開と直列化する。
 */
export async function lockRuleRevisionForShare(
  client: pg.PoolClient,
  organizationId: string,
  ruleId: string,
): Promise<LockedRuleRevision | null> {
  const { rows } = await client.query<{
    id: string;
    active: boolean;
    current_revision: number;
    steps: unknown;
  }>(
    `SELECT r.id, r.active, r.current_revision, rev.steps
       FROM approval_rule r
       LEFT JOIN approval_rule_revision rev
         ON rev.rule_id = r.id AND rev.organization_id = r.organization_id
        AND rev.revision = r.current_revision
      WHERE r.id = $1 AND r.organization_id = $2
      FOR SHARE OF r`,
    [ruleId, organizationId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    ruleId: row.id,
    active: row.active === true,
    currentRevision: row.current_revision,
    steps: row.steps,
  };
}

/** ルールの行を ID の昇順で `FOR UPDATE` する(ルールの使用の停止)。 */
export async function lockRulesForUpdate(
  client: pg.PoolClient,
  organizationId: string,
  ruleIds: readonly string[],
): Promise<void> {
  if (ruleIds.length === 0) return;
  await client.query(
    `SELECT id FROM approval_rule
      WHERE organization_id = $1 AND id = ANY($2::uuid[])
      ORDER BY id
      FOR UPDATE`,
    [organizationId, [...new Set(ruleIds)].sort()],
  );
}

export type PublishedHighRiskItem = {
  id: string;
  code: string;
  title: string;
  /** 公開中の版の定義の `approval`(判定に使う生の JSON)。 */
  approval: unknown;
  ruleId: string | null;
};

/**
 * 公開中の高リスクの定義(有効な項目の `published_revision` の版)を読む。
 *
 * 属性が `true` の行と、存在して真偽値でない行を返す(後者は fail closed で
 * 高リスクとして扱う)。`undefined` / `false` の行は返さない。
 * **ロックはしない。** 呼び出し側が設定の行(とルールの行)をロックしてから呼ぶ。
 */
export async function loadPublishedHighRiskItems(
  client: pg.PoolClient,
  organizationId: string,
  options: { ruleId?: string } = {},
): Promise<PublishedHighRiskItem[]> {
  const params: unknown[] = [organizationId];
  let ruleFilter = '';
  if (options.ruleId !== undefined) {
    params.push(options.ruleId);
    ruleFilter = ` AND r.definition->'approval'->>'ruleId' = $${params.length}`;
  }
  const { rows } = await client.query<{
    id: string;
    code: string;
    title: string;
    approval: unknown;
  }>(
    `SELECT i.id, i.code, i.title, r.definition->'approval' AS approval
       FROM local_catalog_item i
       JOIN local_catalog_revision r
         ON r.item_id = i.id AND r.organization_id = i.organization_id
        AND r.revision = i.published_revision
      WHERE i.organization_id = $1 AND i.active AND i.published_revision IS NOT NULL
        AND (r.definition->'approval'->>'highRisk' = 'true'
             OR (r.definition->'approval' ? 'highRisk'
                 AND jsonb_typeof(r.definition->'approval'->'highRisk') <> 'boolean'))
        ${ruleFilter}
      ORDER BY i.code, i.id`,
    params,
  );
  const items: PublishedHighRiskItem[] = [];
  for (const row of rows) {
    const attribute = readHighRiskAttribute(row.approval);
    if (attribute !== 'true' && attribute !== 'invalid') continue;
    const rawRuleId = (row.approval as Record<string, unknown>).ruleId;
    items.push({
      id: row.id,
      code: row.code,
      title: row.title,
      approval: row.approval,
      ruleId: typeof rawRuleId === 'string' && rawRuleId.length > 0 ? rawRuleId : null,
    });
  }
  return items;
}

/**
 * 条件を崩す変更を 409 で拒否する。影響する項目のコードと名前を返す。
 *
 * `errors` の先頭は理由のコード(`high_risk_definition_blocked`)、続いて
 * 影響する項目ごとに `コード: 名前` を返す(既存の Problem の `errors` の流儀)。
 * 個人データ・入力値は含めない。
 */
export function highRiskDefinitionBlockedProblem(
  items: ReadonlyArray<{ code: string; title: string }>,
): ProblemError {
  return new ProblemError({
    status: 409,
    type: 'https://solvi.internal/problems/high-risk-approval-constraint',
    title: '高リスクの申請の承認条件が崩れるため変更できません',
    detail:
      '公開中の高リスクのカタログ項目が、この変更の後で承認条件を満たさなくなります。先に対象の項目の高リスクの指定を外すか、別の承認ルールへ切り替えて公開し直してください。',
    errors: [
      { field: 'approval', message: 'high_risk_definition_blocked' },
      ...items.map((item) => ({ field: 'affectedItems', message: `${item.code}: ${item.title}` })),
    ],
  });
}
