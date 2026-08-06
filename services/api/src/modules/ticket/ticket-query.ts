import { Problems, type Priority, type TicketState } from '@solvi/shared';
import { hasRole, type AuthzContext, type RoleCode } from '../../common/authz/authz.js';

/**
 * 一覧クエリの組み立て(FR-TKT-006 / NFR-SEC-006)。
 *
 * 一覧は最も権限漏れが起きやすい経路である。詳細画面は1件ずつ認可すれば守れるが、
 * 一覧は「条件に合う全件」を返すため、認可が絞り込みに入っていないと一度に大量に漏れる。
 * したがって認可は WHERE 句の一部として組み立て、取得後のフィルタにしない。
 *
 * SQLは常にパラメータ化する。列名・ソート順は許可リストから引く
 * (文字列連結でSQLを組み立てない / 脅威 T-03)。
 */

/** 組織内の全チケットを見られるロール */
const ORGANIZATION_WIDE_ROLES: readonly RoleCode[] = [
  'agent',
  'org_admin',
  'auditor',
  'platform_admin',
  'platform_auditor',
];

/** ソート可能な列。ここにない値は受け付けない。 */
const SORTABLE_COLUMNS = {
  created_at: 'created_at',
  updated_at: 'updated_at',
  priority: 'priority',
  number: 'number',
  /**
   * 解決期限までの残り。**担当者が最初に見たい並び順である。**
   * 計算列なので `t.` を付けない(下の SORT_EXPRESSIONS で解決する)。
   */
  deadline: 'deadline',
} as const;

/**
 * 並び替えの式。計算列は `t.<column>` では引けない。
 *
 * 期限順は「残り時間の少ない順」。超過しているものは負値になるので、
 * 昇順に並べれば**最も遅れているものが先頭に来る**。
 */
const SORT_EXPRESSIONS: Record<string, string> = {
  deadline: 'remaining_seconds',
};

/**
 * SLAの経過・目標・超過を**その場で計算する**式 (FR-TKT-008)。
 *
 * **保存した判定値を使わない。**
 *
 * `ticket.response_sla_breached` / `resolution_sla_breached` という列が
 * 存在したが、更新するのは状態遷移のときだけだった。つまり
 * **放置されたチケットは期限を過ぎてもフラグが立たない** —
 * 一覧で最も見たいのは放置されたものであり、そこだけが更新されない。
 *
 * 計算してしまえば陳腐化しない。保存値と実際が食い違う余地が消える。
 * 件数の規模(パイロットで数千件)なら、索引が効かなくても問題にならない。
 *
 * クロックが動いていれば開始からの差分を足す
 * (`packages/shared/src/ticket/sla.ts` の `currentElapsedSeconds` と同じ規則)。
 */
export const SLA_ELAPSED_SQL = `
  (t.sla_elapsed_seconds
    + CASE WHEN t.sla_clock_started_at IS NOT NULL
           THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - t.sla_clock_started_at))))
           ELSE 0 END)`;

/**
 * 目標値。組織ごとの `sla_policy` を引き、無ければ既定値を使う。
 *
 * **既定値をSQLに書かない。** `DEFAULT_SLA_TARGETS`(TypeScript側)と
 * 二重に持つと、片方だけ直したときに一覧と詳細で違う判定になる。
 * ポリシーが無い組織では NULL になり、超過の判定を「不明」として扱う。
 */
export const SLA_JOIN_SQL = `
  LEFT JOIN sla_policy p
    ON p.organization_id = t.organization_id AND p.priority = t.priority`;

export type SortColumn = keyof typeof SORTABLE_COLUMNS;
export type SortDirection = 'asc' | 'desc';

export interface TicketFilter {
  state?: TicketState[];
  priority?: Priority[];
  kind?: Array<'incident' | 'request'>;
  assigneeId?: string | null;
  requesterId?: string;
  /** 番号または件名の部分一致 */
  keyword?: string;
  createdFrom?: Date;
  createdTo?: Date;
  /** 担当者未割当のみ */
  unassignedOnly?: boolean;
  /**
   * 担当グループ (FR-TKT-003)。
   *
   * 複数指定できるのは「自分のキュー」を引くためである。担当者は
   * 通常いくつかのグループに属しており、それらを1つの一覧で見たい。
   */
  assigneeGroupIds?: string[];
  /** グループ未割当のみ。**どこにも振られていないもの**を見つける。 */
  ungroupedOnly?: boolean;
  /**
   * 解決期限を超過しているものだけ (FR-TKT-008)。
   *
   * **超過しても業務は止めない**(SLAは計測指標であって統制ではない)。
   * 止めない代わりに、見つけられなければならない。
   */
  slaBreachedOnly?: boolean;
}

/**
 * キーセットページネーションのカーソル。
 *
 * オフセットを使わない理由: 件数が増えるほど遅くなり、
 * かつ取得中に新しいチケットが作られると重複・欠落が発生する。
 * (created_at, id) の複合カーソルなら、同時更新があっても
 * 「このレコードより前」という条件が安定する。
 *
 * `createdAt` を **文字列** で持つ理由:
 * PostgreSQL の timestamptz はマイクロ秒精度だが、JavaScript の Date はミリ秒までしか
 * 表現できない。Date を経由して値を返すと下位3桁が切り捨てられ、
 * 「カーソルの時刻 < 実際の行の時刻」となって次ページが空になる(実際に発生した)。
 * DBが返した文字列表現をそのまま持ち回り、比較時に timestamptz へキャストする。
 */
export interface Cursor {
  /** DBの `created_at::text` の値。加工しないこと。 */
  createdAt: string;
  id: string;
}

export interface ListOptions {
  filter?: TicketFilter;
  sort?: { column: SortColumn; direction: SortDirection };
  limit?: number;
  cursor?: Cursor;
}

export interface BuiltQuery {
  sql: string;
  params: unknown[];
  /** 件数取得用。認可条件を含む同一の WHERE を使う。 */
  countSql: string;
  countParams: unknown[];
  limit: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * 認可条件を生成する。
 * @returns SQL断片とパラメータ。呼び出し側で必ず WHERE に含める。
 */
function authorizationClause(
  ctx: AuthzContext,
  params: unknown[],
): { clause: string; scope: 'organization' | 'own' } {
  // 組織条件は常に付ける。RLSでも守られるが、ここでも明示する
  // (RLSを認可の代わりにしない / ADR-0015)。
  params.push(ctx.organizationId);
  const orgClause = `t.organization_id = $${params.length}`;

  if (hasRole(ctx, ...ORGANIZATION_WIDE_ROLES)) {
    return { clause: orgClause, scope: 'organization' };
  }

  // 依頼者は自分が起票した分のみ。
  params.push(ctx.principal.userId);
  return { clause: `${orgClause} AND t.requester_id = $${params.length}`, scope: 'own' };
}

function filterClauses(filter: TicketFilter | undefined, params: unknown[]): string[] {
  if (!filter) return [];
  const clauses: string[] = [];

  if (filter.state?.length) {
    params.push(filter.state);
    clauses.push(`t.state = ANY($${params.length}::text[])`);
  }
  if (filter.priority?.length) {
    params.push(filter.priority);
    clauses.push(`t.priority = ANY($${params.length}::text[])`);
  }
  if (filter.kind?.length) {
    params.push(filter.kind);
    clauses.push(`t.kind = ANY($${params.length}::text[])`);
  }
  if (filter.unassignedOnly) {
    clauses.push('t.assignee_id IS NULL');
  } else if (filter.assigneeId !== undefined) {
    if (filter.assigneeId === null) {
      clauses.push('t.assignee_id IS NULL');
    } else {
      params.push(filter.assigneeId);
      clauses.push(`t.assignee_id = $${params.length}`);
    }
  }
  if (filter.requesterId) {
    params.push(filter.requesterId);
    clauses.push(`t.requester_id = $${params.length}`);
  }
  if (filter.assigneeGroupIds && filter.assigneeGroupIds.length > 0) {
    params.push(filter.assigneeGroupIds);
    clauses.push(`t.assignee_group_id = ANY($${params.length})`);
  }

  if (filter.ungroupedOnly) {
    // 振り先が決まっていないものは、誰も見ていない可能性が高い。
    // 一覧から探せないと**放置されたことに気付けない**。
    clauses.push('t.assignee_group_id IS NULL');
  }

  if (filter.slaBreachedOnly) {
    // 目標が設定されていない組織では判定できない。**超過扱いにしない** —
    // 設定漏れを「超過」として並べると、本当に遅れているものが埋もれる。
    clauses.push(
      `(p.resolution_target_minutes IS NOT NULL
        AND ${SLA_ELAPSED_SQL} > p.resolution_target_minutes * 60)`,
    );
  }

  if (filter.createdFrom) {
    params.push(filter.createdFrom);
    clauses.push(`t.created_at >= $${params.length}`);
  }
  if (filter.createdTo) {
    params.push(filter.createdTo);
    clauses.push(`t.created_at <= $${params.length}`);
  }
  if (filter.keyword) {
    const keyword = filter.keyword.trim();
    if (keyword.length > 0) {
      // 番号・件名・本文をまとめた生成列(search_text)に対する部分一致。
      // 値は常にパラメータとして渡す。ILIKE のワイルドカードとして解釈される
      // % と _ はエスケープし、利用者の入力が検索範囲を広げないようにする。
      const escaped = keyword.replace(/([%_\\])/g, '\\$1');
      params.push(`%${escaped}%`);
      clauses.push(`t.search_text ILIKE $${params.length}`);
    }
  }
  return clauses;
}

export function buildListQuery(ctx: AuthzContext, options: ListOptions = {}): BuiltQuery {
  const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const params: unknown[] = [];

  const auth = authorizationClause(ctx, params);
  const clauses = [auth.clause, ...filterClauses(options.filter, params)];

  // ソート列は許可リストからのみ引く。未知の値は拒否する(注入経路を作らない)。
  const sortColumn = options.sort?.column ?? 'created_at';
  const column = SORTABLE_COLUMNS[sortColumn];
  if (!column) {
    throw Problems.validation([
      { field: 'sort.column', message: '指定された並び順は使用できません' },
    ]);
  }
  const direction = options.sort?.direction === 'asc' ? 'ASC' : 'DESC';

  // カーソル条件を足す前の状態を保持する(件数クエリで使う)
  const clausesWithoutCursor = [...clauses];
  const paramCountBeforeCursor = params.length;

  // カーソルは常に (created_at, id) で判定する。
  // ソート列が created_at 以外でも、一意性を担保するため id を第2キーに使う。
  if (options.cursor) {
    // **期限順のときはカーソルを受け付けない。**
    // カーソルは (created_at, id) で判定するため、別の列で並べた一覧に
    // 適用すると「進んだつもりで飛ばされる／重複する」が起きる。
    // 期限順は「いま遅れているものから見る」ための並びであり、
    // 先頭から数十件を見れば足りる。黙って壊れた頁を返さない。
    if (sortColumn !== 'created_at') {
      throw Problems.validation([
        {
          field: 'cursorCreatedAt',
          message: 'この並び順では続きの取得に対応していません',
        },
      ]);
    }
    params.push(options.cursor.createdAt);
    const createdAtParam = params.length;
    params.push(options.cursor.id);
    const comparison = direction === 'DESC' ? '<' : '>';
    // 明示的にキャストする。文字列のまま比較すると型推論に依存して結果が変わる。
    clauses.push(
      `(t.created_at, t.id) ${comparison} ($${createdAtParam}::timestamptz, $${params.length}::uuid)`,
    );
  }

  // 件数は認可条件とフィルタを含む WHERE で数える。
  // 全体件数を返すと、権限外のチケットが何件あるかを漏らすことになる。
  // ただし **カーソル条件は含めない**。含めると残り件数になり、
  // ページを進めるたびに total が減っていく。
  const countWhere = clausesWithoutCursor.join(' AND ');
  const countParams = params.slice(0, paramCountBeforeCursor);

  const where = clauses.join(' AND ');
  params.push(limit);
  const orderBy = SORT_EXPRESSIONS[column] ?? `t.${column}`;
  const sql = `
    SELECT t.*, t.created_at::text AS cursor_created_at,
           ${SLA_SELECT_SQL},
           p.response_target_minutes,
           p.resolution_target_minutes
      FROM ticket t
      ${SLA_JOIN_SQL}
     WHERE ${where}
     ORDER BY ${orderBy} ${direction} NULLS LAST, t.id ${direction}
     LIMIT $${params.length}
  `;

  return {
    sql,
    params,
    countSql: `SELECT count(*)::int AS total FROM ticket t ${SLA_JOIN_SQL} WHERE ${countWhere}`,
    countParams,
    limit,
  };
}

/** 一覧の可視範囲。UIが「全件」か「自分の分」かを示すために使う。 */
export function visibilityScope(ctx: AuthzContext): 'organization' | 'own' {
  return hasRole(ctx, ...ORGANIZATION_WIDE_ROLES) ? 'organization' : 'own';
}

/**
 * 一覧と詳細で同じ式を使うための SELECT 句。
 *
 * **二か所に書かない。** 片方だけ直すと、一覧と詳細で違う期限が出る。
 */
export const SLA_SELECT_SQL = `
  ${SLA_ELAPSED_SQL} AS sla_elapsed_now,
  CASE WHEN p.resolution_target_minutes IS NULL THEN NULL
       ELSE p.resolution_target_minutes * 60 - ${SLA_ELAPSED_SQL}
  END AS remaining_seconds`;

export { SORTABLE_COLUMNS, MAX_LIMIT, DEFAULT_LIMIT };
