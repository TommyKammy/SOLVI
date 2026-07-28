import type pg from 'pg';
import { Problems, recordDomainEvent } from '@solvi/shared';
import {
  RelationService,
  type RelatedTicketSummary,
  type RelationType,
} from './relation.service.js';
import type { PoolDenialRecorder } from '../../common/audit/denial-recorder.js';
import type { AuthenticatedRequest } from '../auth/auth.routes.js';

/**
 * 関連付けと統合のHTTP面 (WP-P2-RELUI-012)。
 *
 * `RelationService` は WP-P2-REL-009 で完成していたが、**呼び出す経路が無かった。**
 * サービス層もスキーマも1階層制約の3層防御も揃っていながら、
 * 利用者はチケットを関連付けることも統合することもできない状態が続いていた
 * (経緯は `docs/planning/04_Development/04.23_Wiring_Verification.md`)。
 *
 * この層の要点は2つ。
 *
 * 1. **担当者は受付番号でチケットを指す。** UUID を手で入力させない。
 *    番号からの解決はサービス層の閲覧権限判定を通す。
 *
 * 2. **統合は取り消せない。** 1回のPOSTで確定させない作りにする
 *    (§ `resolveTarget` と画面側の2段確認)。
 */

export interface RelationRouteDeps {
  pool: pg.Pool;
  denialRecorder: PoolDenialRecorder;
}

const RELATION_TYPES = new Set<RelationType>(['related', 'parent_of']);

function toRelationView(item: RelatedTicketSummary & { relationId: string }) {
  return {
    relationId: item.relationId,
    ticketId: item.ticketId,
    number: item.number,
    subject: item.subject,
    state: item.state,
    role: item.role,
  };
}

export class RelationController {
  constructor(private readonly deps: RelationRouteDeps) {}

  private async run<T>(
    auth: AuthenticatedRequest,
    fn: (service: RelationService, client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.deps.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', [
        'app.current_org',
        auth.authz.organizationId,
      ]);
      const out = await fn(new RelationService(client, this.deps.denialRecorder), client);
      await client.query('COMMIT');
      return out;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 関連の一覧。
   *
   * **未解決の子も一緒に返す。** 親を解決してよいかの判断材料であり、
   * 別の呼び出しにすると画面が取りに行くのを忘れる
   * (`unresolvedChildren` は WP-P2-REL-009 で実装されながら
   * どこからも呼ばれていなかった)。
   */
  async list(auth: AuthenticatedRequest, ticketId: string) {
    const result = await this.run(auth, async (service, client) => {
      const items = await listWithRelationIds(client, service, auth, ticketId);
      const unresolved = await service.unresolvedChildren(auth.authz, ticketId);
      return { items, unresolved };
    });

    return {
      status: 200,
      body: {
        items: result.items.map(toRelationView),
        // 解決を止めるのではなく、判断材料として渡す(WP-P2-REL-009 §6)。
        unresolvedChildren: result.unresolved.map((c) => ({
          ticketId: c.ticketId,
          number: c.number,
          subject: c.subject,
          state: c.state,
        })),
      },
    };
  }

  /**
   * 受付番号でチケットを引く。
   *
   * 関連付け・統合の相手を確認するために使う。閲覧できないチケットは
   * 「見つかりません」で返す — 存在しないのか権限外なのかを区別させない。
   */
  async lookup(auth: AuthenticatedRequest, number: string) {
    const summary = await this.run(auth, (service) => service.findByNumber(auth.authz, number));
    return {
      status: 200,
      body: {
        ticketId: summary.ticketId,
        number: summary.number,
        subject: summary.subject,
        state: summary.state,
      },
    };
  }

  async link(auth: AuthenticatedRequest, ticketId: string, body: unknown) {
    const input = parseLinkBody(body);

    const relation = await this.run(auth, async (service) => {
      const target = await this.resolveTarget(service, auth, input);
      return service.link(auth.authz, ticketId, target, input.relationType);
    });

    recordDomainEvent('ticket.linked', 'success');
    return {
      status: 201,
      body: {
        relationId: relation.id,
        relationType: relation.relationType,
        targetTicketId: relation.targetTicketId,
      },
    };
  }

  /**
   * 関連の解除。
   *
   * POST で受ける。DELETE や GET をリンクに置くと、
   * ページを開いただけで解除される経路ができる。
   */
  async unlink(auth: AuthenticatedRequest, relationId: string) {
    await this.run(auth, (service) => service.unlink(auth.authz, relationId));
    recordDomainEvent('ticket.unlinked', 'success');
    return { status: 204, body: null };
  }

  /**
   * 統合。
   *
   * **理由を必須にするのはサービス層である。** ここで先に弾いてもよいが、
   * API を直接叩く経路でも同じ制約がかかることを1か所で保証したい。
   */
  async merge(auth: AuthenticatedRequest, ticketId: string, body: unknown) {
    const input = parseMergeBody(body);

    const result = await this.run(auth, async (service) => {
      const target = await this.resolveTarget(service, auth, input);
      if (target === ticketId) {
        throw Problems.validation([
          { field: 'targetTicketNumber', message: '同じチケットへは統合できません' },
        ]);
      }
      return service.merge(auth.authz, ticketId, target, input.reason);
    });

    recordDomainEvent('ticket.merged', 'success');
    return {
      status: 200,
      body: {
        sourceTicketId: result.sourceTicketId,
        targetTicketId: result.targetTicketId,
        // 「コメント・添付は移動しない」という決定が守られたことを応答でも示す。
        // 画面が「元のチケットに履歴が残っています」と伝えられるようにする。
        retained: result.retained,
      },
    };
  }

  /** 相手の指定を1つのIDへ解決する。番号とIDのどちらでも受ける。 */
  private async resolveTarget(
    service: RelationService,
    auth: AuthenticatedRequest,
    input: { targetTicketId?: string; targetTicketNumber?: string },
  ): Promise<string> {
    if (input.targetTicketId) return input.targetTicketId;
    const summary = await service.findByNumber(auth.authz, input.targetTicketNumber ?? '');
    return summary.ticketId;
  }
}

/**
 * 一覧に `relationId` を添える。
 *
 * 解除には関連そのもののIDが要る。`listRelations` は表示用の要約しか返さないため、
 * ここで突き合わせる。サービス層の戻り値を変えると
 * WP-P2-REL-009 のテストが指す契約が動くので、この層で足す。
 */
async function listWithRelationIds(
  client: pg.PoolClient,
  service: RelationService,
  auth: AuthenticatedRequest,
  ticketId: string,
): Promise<Array<RelatedTicketSummary & { relationId: string }>> {
  // 権限判定は listRelations が行う。ここでの追加クエリは
  // その判定を通ったあとにしか実行されない。
  const summaries = await service.listRelations(auth.authz, ticketId);

  const { rows } = await client.query<{ id: string; other_id: string }>(
    `SELECT r.id,
            CASE WHEN r.source_ticket_id = $1 THEN r.target_ticket_id ELSE r.source_ticket_id END AS other_id
       FROM ticket_relation r
      WHERE r.source_ticket_id = $1 OR r.target_ticket_id = $1
      ORDER BY r.created_at`,
    [ticketId],
  );

  const byOther = new Map(rows.map((r) => [r.other_id, r.id]));
  return summaries.map((s) => ({ ...s, relationId: byOther.get(s.ticketId) ?? '' }));
}

function parseLinkBody(body: unknown): {
  relationType: RelationType;
  targetTicketId?: string;
  targetTicketNumber?: string;
} {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const errors: Array<{ field: string; message: string }> = [];

  const relationType = String(record.relationType ?? 'related');
  if (!RELATION_TYPES.has(relationType as RelationType)) {
    errors.push({ field: 'relationType', message: '関連の種類を選んでください' });
  }

  const target = parseTargetRef(record, errors);
  if (errors.length > 0) throw Problems.validation(errors);
  return { relationType: relationType as RelationType, ...target };
}

function parseMergeBody(body: unknown): {
  reason: string;
  targetTicketId?: string;
  targetTicketNumber?: string;
} {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const errors: Array<{ field: string; message: string }> = [];

  const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
  if (reason.length === 0) {
    errors.push({ field: 'reason', message: '統合の理由を入力してください' });
  } else if (reason.length > 500) {
    errors.push({ field: 'reason', message: '理由は500文字以内で入力してください' });
  }

  const target = parseTargetRef(record, errors);
  if (errors.length > 0) throw Problems.validation(errors);
  return { reason, ...target };
}

/**
 * 相手の指定。受付番号かIDのどちらか一方。
 *
 * 画面からは番号で来る。担当者が見ているのは番号であり、
 * UUID を手で写させる作りにすると、写し間違いで**別のチケットを統合しうる**。
 */
function parseTargetRef(
  record: Record<string, unknown>,
  errors: Array<{ field: string; message: string }>,
): { targetTicketId?: string; targetTicketNumber?: string } {
  const id = typeof record.targetTicketId === 'string' ? record.targetTicketId.trim() : '';
  const number =
    typeof record.targetTicketNumber === 'string' ? record.targetTicketNumber.trim() : '';

  if (id.length === 0 && number.length === 0) {
    errors.push({ field: 'targetTicketNumber', message: '相手の受付番号を入力してください' });
    return {};
  }
  if (number.length > 64) {
    errors.push({ field: 'targetTicketNumber', message: '受付番号の形式が正しくありません' });
    return {};
  }
  return id.length > 0 ? { targetTicketId: id } : { targetTicketNumber: number };
}
