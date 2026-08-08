import type pg from 'pg';
import { Problems } from '@solvi/shared';
import { recordAuditEvent } from '../../common/audit/audit.js';
import { hasRole, requireRole, type AuthzContext } from '../../common/authz/authz.js';

/**
 * 監査の書き出し (AUD-002 / AUD-003 / WP-P1-AUD-018)。
 *
 * ADR-0009 で追記専用・ハッシュ連鎖の監査を作り、日次アンカーで固定した。
 * **取り出す手段が無かった。**
 *
 * **読めない記録は、記録していないことに近い。**
 * 監査人が確かめられなければ、追記専用であることに意味が無い。
 *
 * ## 正準形を書き写さない
 *
 * 連鎖の入力(正準形)は `anchor.ts` の SQL が持つ。ここでも同じ式を使う。
 * **書き写すと、片方だけ直したときにアンカーと書き出しが食い違い、
 * 「改ざんされた」ように見える。** それは最悪の誤報である。
 *
 * ## 何が照合できて、何ができないか
 *
 * 連鎖は**組織をまたいで1本**である。したがって:
 *
 * | 書き出し | アンカー照合 |
 * |---|---|
 * | `platform_auditor` の全体書き出し | **できる** |
 * | `auditor` の自組織書き出し | **できない**(連鎖の一部しか無い) |
 *
 * 後者を「照合できる」ように見せない。先頭の manifest に明記する。
 */

/**
 * 正準形。`services/worker/src/jobs/audit-anchor/anchor.ts` と**同じ式**。
 *
 * 二か所にある。**同じ列を同じ順で連ねるという契約**であり、
 * 片方だけ変えるとアンカーと書き出しが一致しなくなる。
 * `check_unwired` のセクションF がこの重複を見張っている。
 */
export const AUDIT_CANONICAL_SQL = `
  concat_ws('|',
    event_id::text,
    event_type,
    to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    coalesce(organization_id::text, ''),
    actor_type,
    coalesce(actor_id::text, ''),
    coalesce(subject_user_id::text, ''),
    coalesce(target_type, ''),
    coalesce(target_id, ''),
    action,
    outcome,
    coalesce(before_state::jsonb::text, ''),
    coalesce(after_state::jsonb::text, ''),
    coalesce(correlation_id, ''),
    coalesce(policy_decision::jsonb::text, '')
  )
`;

/** 1回の書き出しの上限。**無制限にしない** — 監査は増え続ける。 */
const MAX_ROWS = 50_000;

export interface ExportManifest {
  /** 書き出した日(UTC)。連鎖は日単位で固定される。 */
  date: string;
  scope: 'platform' | 'organization';
  organizationId: string | null;
  eventCount: number;
  /**
   * アンカーと照合できるか。
   *
   * **組織で絞った書き出しはできない。** 連鎖が組織をまたぐためであり、
   * 「できない」と書いておかないと、照合が合わないことを
   * 改ざんと読み違える。
   */
  anchorVerifiable: boolean;
  /** 打ち切ったか。**黙って切らない。** */
  truncated: boolean;
  exportedAt: string;
  exportedBy: string;
}

export interface ExportedEvent {
  eventId: string;
  eventType: string;
  occurredAt: string;
  organizationId: string | null;
  actorType: string;
  actorId: string | null;
  subjectUserId: string | null;
  targetType: string | null;
  targetId: string | null;
  action: string;
  outcome: string;
  beforeState: unknown;
  afterState: unknown;
  correlationId: string | null;
  /** 連鎖の入力。**これを使ってルートを再計算する。** */
  canonical: string;
}

export class AuditExportService {
  constructor(private readonly client: pg.PoolClient | pg.Client) {}

  /**
   * 1日分を書き出す。
   *
   * **日単位に固定する。** 任意の期間を許すと、アンカー(日次)と
   * 突き合わせられない範囲が生まれる。
   */
  async exportDay(
    ctx: AuthzContext,
    date: string,
  ): Promise<{ manifest: ExportManifest; events: ExportedEvent[] }> {
    // AUD-002: auditor / platform_auditor のみ。**管理者にも見せない。**
    requireRole(ctx, 'auditor', 'platform_auditor');

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw Problems.validation([
        { field: 'date', message: '日付は YYYY-MM-DD で指定してください' },
      ]);
    }

    const platformWide = hasRole(ctx, 'platform_auditor');

    if (platformWide) {
      // 横断の読み取り例外を立てる(migration 0023)。
      await this.client.query("SELECT set_config('app.auditexport', 'on', true)");
    }

    const { rows } = await this.client.query(
      `SELECT event_id, event_type,
              to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at,
              organization_id, actor_type, actor_id, subject_user_id,
              target_type, target_id, action, outcome,
              before_state, after_state, correlation_id,
              ${AUDIT_CANONICAL_SQL} AS canonical
         FROM audit_event
        WHERE occurred_at >= $1::date
          AND occurred_at <  ($1::date + interval '1 day')
        ORDER BY event_id
        LIMIT ${MAX_ROWS + 1}`,
      [date],
    );

    const truncated = rows.length > MAX_ROWS;
    const kept = truncated ? rows.slice(0, MAX_ROWS) : rows;

    // **当日は照合できない。**
    //
    // 書き出しそのものが `audit.export.executed` を記録する。
    // つまり当日を書き出すと、**書き出した記録は書き出しに含まれない**。
    // あとから同じ日を再計算すれば、その1件の差で必ず食い違う。
    //
    // アンカーは前日分を固定する(`runDailyAnchor`)。
    // 照合できるのは**固定が済んだ日**だけである。
    const today = new Date().toISOString().slice(0, 10);
    const settled = date < today;

    const manifest: ExportManifest = {
      date,
      scope: platformWide ? 'platform' : 'organization',
      organizationId: platformWide ? null : ctx.organizationId,
      eventCount: kept.length,
      // **打ち切ったら照合できない。** 連鎖の一部しか無いためである。
      anchorVerifiable: platformWide && !truncated && settled,
      truncated,
      exportedAt: new Date().toISOString(),
      exportedBy: ctx.principal.userId,
    };

    // AUD-002:「閲覧・export 自体も監査記録」。
    // **取り出したことが残らなければ、持ち出しに気付けない。**
    await recordAuditEvent(this.client, {
      eventType: 'audit.export.executed',
      organizationId: ctx.organizationId,
      actorType: 'user',
      actorId: ctx.principal.userId,
      subjectUserId: ctx.principal.userId,
      targetType: 'audit_event',
      targetId: date,
      action: 'export',
      outcome: 'success',
      // **中身は残さない。** 何件をどの範囲で取り出したかだけを残す。
      afterState: {
        date,
        scope: manifest.scope,
        eventCount: manifest.eventCount,
        truncated,
      },
    });

    return {
      manifest,
      events: kept.map((r) => ({
        eventId: r.event_id as string,
        eventType: r.event_type as string,
        occurredAt: r.occurred_at as string,
        organizationId: (r.organization_id as string | null) ?? null,
        actorType: r.actor_type as string,
        actorId: (r.actor_id as string | null) ?? null,
        subjectUserId: (r.subject_user_id as string | null) ?? null,
        targetType: (r.target_type as string | null) ?? null,
        targetId: (r.target_id as string | null) ?? null,
        action: r.action as string,
        outcome: r.outcome as string,
        beforeState: r.before_state ?? null,
        afterState: r.after_state ?? null,
        correlationId: (r.correlation_id as string | null) ?? null,
        canonical: r.canonical as string,
      })),
    };
  }
}

/** JSONL に組み立てる。**1行目は manifest** で、以降が1件ずつ。 */
export function toJsonl(result: { manifest: ExportManifest; events: ExportedEvent[] }): string {
  return [
    JSON.stringify({ kind: 'manifest', ...result.manifest }),
    ...result.events.map((e) => JSON.stringify({ kind: 'event', ...e })),
  ].join('\n');
}
