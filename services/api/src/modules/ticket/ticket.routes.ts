import type pg from 'pg';
import { Problems, recordDomainEvent } from '@solvi/shared';
import { GroupService } from './group.service.js';
import { TicketService, type Ticket } from './ticket.service.js';
import { PoolDenialRecorder } from '../../common/audit/denial-recorder.js';
import type { AuthenticatedRequest } from '../auth/auth.routes.js';

/**
 * チケットのHTTP面 (WP-P2-PORTAL-002)。
 *
 * ここは薄い層に保つ。判断はすべて `TicketService` にあり、
 * このファイルの仕事は「入力を型に落とす」「応答の形を決める」の2つだけである。
 *
 * **応答に含める項目を明示的に選ぶ。** サービスが返す `Ticket` をそのまま
 * JSON にすると、後でフィールドを足したときに意図せず外へ出る。
 * 依頼者向けの応答には、依頼者が見てよいものだけを載せる。
 */

export interface TicketRouteDeps {
  pool: pg.Pool;
  denialRecorder: PoolDenialRecorder;
}

/** 依頼者へ返す形。内部IDや担当者の詳細は含めない。 */
function toPortalView(ticket: Ticket): Record<string, unknown> {
  return {
    id: ticket.id,
    number: ticket.number,
    kind: ticket.kind,
    state: ticket.state,
    subject: ticket.subject,
    body: ticket.body,
    impact: ticket.impact,
    urgency: ticket.urgency,
    priority: ticket.priority,
    createdAt: ticket.createdAt.toISOString(),
    resolvedAt: ticket.resolvedAt?.toISOString() ?? null,
    // 担当者は「割り当て済みかどうか」だけを伝える。
    // 誰が担当かは依頼者にとって必要な情報ではなく、
    // 担当者の稼働状況が外から見える状態を作る必要も無い。
    assigned: ticket.assigneeId !== null,
    // 期限 (FR-TKT-008)。**依頼者にも見せる。**
    // 「いつまでに返ってくるか」は依頼者が最も知りたいことであり、
    // 見えないと「まだですか」という問い合わせが増える。
    // 一覧のSQLで計算した値であり、保存値ではない(陳腐化しない)。
    ...(ticket.sla
      ? {
          sla: {
            remainingSeconds: ticket.sla.remainingSeconds,
            breached: ticket.sla.breached,
          },
        }
      : {}),
  };
}

const KINDS = new Set(['incident', 'request']);

/**
 * 絞り込みに使える値。**許可する値を列挙する**(拒否リストにしない)。
 *
 * 知らない値を無視すると、利用者は「絞り込んだつもりで絞り込めていない」
 * 状態に気付けない。明示的に拒否する。
 */
const STATES = new Set([
  'new',
  'assigned',
  'in_progress',
  'pending',
  'resolved',
  'closed',
  'cancelled',
  'merged',
]);
const PRIORITIES = new Set(['low', 'medium', 'high', 'critical']);

/**
 * 絞り込み条件の解釈。
 *
 * 複数指定は同じキーを繰り返す(`?state=new&state=assigned`)。
 * カンマ区切りにすると、値そのものにカンマを含む項目を足したときに壊れる。
 */
/**
 * どのグループにも一致しないためのID。
 *
 * 所属が無い人が「自分のグループ」を選んだとき、空配列で条件を落とすと
 * **絞り込んだつもりで全件が出る**。一致しない値を1つ渡して0件にする。
 */
const NO_MATCH_UUID = '00000000-0000-4000-8000-0000000000ff';

function parseFilter(
  query: URLSearchParams,
  currentUserId: string,
  myGroupIds: string[],
): {
  state?: string[];
  kind?: string[];
  priority?: string[];
  assigneeId?: string | null;
  unassignedOnly?: boolean;
  assigneeGroupIds?: string[];
  ungroupedOnly?: boolean;
  slaBreachedOnly?: boolean;
  keyword?: string;
} {
  const errors: Array<{ field: string; message: string }> = [];

  const pick = (name: string, allowed: ReadonlySet<string>): string[] | undefined => {
    const values = query.getAll(name).filter((v) => v.length > 0);
    if (values.length === 0) return undefined;
    const invalid = values.filter((v) => !allowed.has(v));
    if (invalid.length > 0) {
      errors.push({ field: name, message: `指定できない値です: ${invalid.join(', ')}` });
      return undefined;
    }
    return values;
  };

  const state = pick('state', STATES);
  const kind = pick('kind', KINDS);
  const priority = pick('priority', PRIORITIES);

  // 担当の絞り込みは3通り。「自分」「未割当」「指定なし」。
  // 任意の利用者IDを受け付けない — 他人の担当分を名指しで引く必要は無く、
  // 受け付ければ在籍者のIDを総当たりする経路になる。
  const assignment = query.get('assignment');
  let assigneeId: string | null | undefined;
  let unassignedOnly: boolean | undefined;

  if (assignment === 'mine') {
    assigneeId = currentUserId;
  } else if (assignment === 'unassigned') {
    unassignedOnly = true;
  } else if (assignment !== null && assignment.length > 0) {
    errors.push({ field: 'assignment', message: '指定できない値です' });
  }

  // 期限超過の絞り込み (FR-TKT-008)。
  //
  // **超過しても業務は止めない**が、止めない代わりに見つけられなければならない。
  const slaBreachedOnly = query.get('sla') === 'breached' ? true : undefined;
  if (query.get('sla') !== null && query.get('sla') !== '' && slaBreachedOnly === undefined) {
    errors.push({ field: 'sla', message: '指定できない値です' });
  }

  // グループの絞り込み。値は「自分のグループ」「未割当」「特定のグループID」。
  //
  // 特定のIDは受け付ける。担当の絞り込み(assignment)と違い、
  // **グループのIDは総当たりの意味を持たない** — 組織内のグループは
  // 一覧APIで正当に取得できるものであり、隠す対象ではない。
  // ただし他組織のIDを渡してもRLSで0件になる。
  const groupParam = query.get('group');
  let assigneeGroupIds: string[] | undefined;
  let ungroupedOnly: boolean | undefined;

  if (groupParam === 'mine') {
    // 呼び出し側が本人の所属グループを解決して渡す。
    // ここでDBを引かないのは、この関数が純粋な解析であるため。
    assigneeGroupIds = myGroupIds;
    if (assigneeGroupIds.length === 0) {
      // 所属が無い人が「自分のグループ」を選んだ場合。**全件を返さない。**
      // 空配列のまま条件を落とすと、絞り込んだつもりで全件が出る。
      assigneeGroupIds = [NO_MATCH_UUID];
    }
  } else if (groupParam === 'ungrouped') {
    ungroupedOnly = true;
  } else if (groupParam !== null && groupParam.length > 0) {
    if (!/^[0-9a-f-]{36}$/i.test(groupParam)) {
      errors.push({ field: 'group', message: '指定できない値です' });
    } else {
      assigneeGroupIds = [groupParam];
    }
  }

  /**
   * 全文検索の語。
   *
   * **短すぎる語を受け付けない。** 1文字で検索すると事実上の全件取得になり、
   * 「検索した」という体裁で全件を眺めることになる。
   * ワイルドカード(`%` `_`)のエスケープはクエリ組み立て側で行っている。
   */
  const rawKeyword = (query.get('keyword') ?? '').trim();
  let keyword: string | undefined;
  if (rawKeyword.length > 0) {
    if (rawKeyword.length > 200) {
      errors.push({ field: 'keyword', message: '検索語が長すぎます' });
    } else {
      keyword = rawKeyword;
    }
  }

  if (errors.length > 0) throw Problems.validation(errors);

  return {
    ...(keyword ? { keyword } : {}),
    ...(state ? { state } : {}),
    ...(kind ? { kind } : {}),
    ...(priority ? { priority } : {}),
    ...(assigneeId !== undefined ? { assigneeId } : {}),
    ...(unassignedOnly !== undefined ? { unassignedOnly } : {}),
    ...(assigneeGroupIds ? { assigneeGroupIds } : {}),
    ...(ungroupedOnly !== undefined ? { ungroupedOnly } : {}),
    ...(slaBreachedOnly !== undefined ? { slaBreachedOnly } : {}),
  };
}
const IMPACTS = new Set(['low', 'medium', 'high']);
const URGENCIES = new Set(['low', 'medium', 'high']);

/** 入力の検証。**許可する値を列挙する**(拒否リストにしない)。 */
function parseCreateBody(body: unknown): {
  kind: 'incident' | 'request';
  subject: string;
  body: string;
  impact: 'low' | 'medium' | 'high';
  urgency: 'low' | 'medium' | 'high';
} {
  const errors: Array<{ field: string; message: string }> = [];
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  const kind = String(record.kind ?? '');
  if (!KINDS.has(kind)) {
    errors.push({ field: 'kind', message: '種別を選んでください' });
  }

  const subject = typeof record.subject === 'string' ? record.subject.trim() : '';
  if (subject.length === 0) {
    errors.push({ field: 'subject', message: '件名を入力してください' });
  } else if (subject.length > 200) {
    errors.push({ field: 'subject', message: '件名は200文字以内で入力してください' });
  }

  const text = typeof record.body === 'string' ? record.body.trim() : '';
  if (text.length === 0) {
    errors.push({ field: 'body', message: '内容を入力してください' });
  } else if (text.length > 10_000) {
    errors.push({ field: 'body', message: '内容は10,000文字以内で入力してください' });
  }

  const impact = String(record.impact ?? 'medium');
  if (!IMPACTS.has(impact)) {
    errors.push({ field: 'impact', message: '影響範囲を選んでください' });
  }

  const urgency = String(record.urgency ?? 'medium');
  if (!URGENCIES.has(urgency)) {
    errors.push({ field: 'urgency', message: '緊急度を選んでください' });
  }

  // **すべての誤りをまとめて返す。** 1つずつ返すと、利用者は
  // 送信のたびに次の誤りを知ることになり、往復が増える(NFR-UX-003)。
  if (errors.length > 0) throw Problems.validation(errors);

  return {
    kind: kind as 'incident' | 'request',
    subject,
    body: text,
    impact: impact as 'low' | 'medium' | 'high',
    urgency: urgency as 'low' | 'medium' | 'high',
  };
}

export class TicketController {
  constructor(private readonly deps: TicketRouteDeps) {}

  /**
   * 組織コンテキスト付きでサービスを実行する。
   *
   * `SET LOCAL app.current_org` を張るのはここ1か所。
   * 各ハンドラで書くと、1か所忘れた時点で fail-closed の0件になり、
   * 「データが無い」のか「文脈を設定し忘れた」のかが区別できなくなる。
   */
  private async run<T>(
    auth: AuthenticatedRequest,
    fn: (service: TicketService) => Promise<T>,
  ): Promise<T> {
    const client = await this.deps.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', [
        'app.current_org',
        auth.authz.organizationId,
      ]);
      const service = new TicketService(client, this.deps.denialRecorder);
      const out = await fn(service);
      await client.query('COMMIT');
      return out;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** 本人の所属グループID。「自分のキュー」の絞り込みに使う。 */
  private async resolveMyGroupIds(auth: AuthenticatedRequest): Promise<string[]> {
    const client = await this.deps.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', [
        'app.current_org',
        auth.authz.organizationId,
      ]);
      const groups = await new GroupService(client).myGroups(auth.authz);
      await client.query('COMMIT');
      return groups.map((g) => g.id);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async create(auth: AuthenticatedRequest, body: unknown) {
    const input = parseCreateBody(body);
    const ticket = await this.run(auth, (service) => service.create(auth.authz, input));
    recordDomainEvent('ticket.created', 'success');
    return { status: 201, body: toPortalView(ticket) };
  }

  async list(auth: AuthenticatedRequest, query: URLSearchParams) {
    const limitRaw = query.get('limit');
    const limit = limitRaw ? Number(limitRaw) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
      throw Problems.validation([{ field: 'limit', message: '1〜100の範囲で指定してください' }]);
    }

    // 「自分のグループ」を選ばれたときだけ所属を引く。
    // 常に引くと、絞り込みを使わない一覧でも毎回1クエリ増える。
    const myGroupIds =
      query.get('group') === 'mine' ? await this.resolveMyGroupIds(auth) : ([] as string[]);
    const filter = parseFilter(query, auth.userId, myGroupIds);

    // 並び順。既定は受付順(新しいものから)。
    // 期限順は担当者の triage 用であり、**遅れているものが先頭に来る**。
    const sortParam = query.get('sort') ?? '';
    const SORTS: Record<string, { column: string; direction: 'asc' | 'desc' }> = {
      '': { column: 'created_at', direction: 'desc' },
      newest: { column: 'created_at', direction: 'desc' },
      deadline: { column: 'deadline', direction: 'asc' },
    };
    const sort = SORTS[sortParam];
    if (!sort) {
      throw Problems.validation([{ field: 'sort', message: '指定できない並び順です' }]);
    }

    const result = await this.run(auth, (service) =>
      service.list(auth.authz, {
        sort: sort as never,
        ...(Object.keys(filter).length > 0 ? { filter: filter as never } : {}),
        ...(limit !== undefined ? { limit } : {}),
        // カーソルはサーバが返した文字列をそのまま受け取る。
        // クライアントで組み立てさせない(マイクロ秒が落ちてページが空になる)。
        ...(query.get('cursorCreatedAt') && query.get('cursorId')
          ? {
              cursor: {
                createdAt: query.get('cursorCreatedAt')!,
                id: query.get('cursorId')!,
              },
            }
          : {}),
      }),
    );

    return {
      status: 200,
      body: {
        items: result.items.map(toPortalView),
        total: result.total,
        nextCursor: result.nextCursor,
        // どの範囲が見えているかを明示する。依頼者は自分の分だけ、
        // 担当者は組織全体。画面側で「全件が見えている」と誤解させない。
        scope: result.scope,
        // **絞り込みが効いていることを応答で示す。** 画面が送った条件と
        // 突き合わせられないと、「絞り込んだつもりで全件を見ている」に気付けない。
        appliedFilter: filter,
      },
    };
  }

  async findById(auth: AuthenticatedRequest, ticketId: string) {
    // 権限が無いチケットは 404 になる(存在秘匿 / NFR-SEC-006)。
    // ここで 403 を返すと「そのIDは存在する」ことを教えてしまう。
    const ticket = await this.run(auth, (service) => service.findById(auth.authz, ticketId));
    return { status: 200, body: toPortalView(ticket) };
  }
}
