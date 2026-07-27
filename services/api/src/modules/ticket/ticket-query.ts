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
} as const;

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
      // 番号は前方一致、件名は部分一致。値はパラメータとして渡す。
      params.push(`${keyword}%`);
      const numberParam = params.length;
      params.push(`%${keyword}%`);
      clauses.push(`(t.number ILIKE $${numberParam} OR t.subject ILIKE $${params.length})`);
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
  const sql = `
    SELECT t.*, t.created_at::text AS cursor_created_at
      FROM ticket t
     WHERE ${where}
     ORDER BY t.${column} ${direction}, t.id ${direction}
     LIMIT $${params.length}
  `;

  return {
    sql,
    params,
    countSql: `SELECT count(*)::int AS total FROM ticket t WHERE ${countWhere}`,
    countParams,
    limit,
  };
}

/** 一覧の可視範囲。UIが「全件」か「自分の分」かを示すために使う。 */
export function visibilityScope(ctx: AuthzContext): 'organization' | 'own' {
  return hasRole(ctx, ...ORGANIZATION_WIDE_ROLES) ? 'organization' : 'own';
}

export { SORTABLE_COLUMNS, MAX_LIMIT, DEFAULT_LIMIT };
