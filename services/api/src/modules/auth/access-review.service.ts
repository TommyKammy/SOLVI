import type pg from 'pg';
import { Problems } from '@solvi/shared';
import { recordAuditEvent, uuidv7 } from '../../common/audit/audit.js';
import { requireRole, type AuthzContext } from '../../common/authz/authz.js';
import { UserAdminService } from './user-admin.service.js';

/**
 * アクセスレビュー (NFR-SEC-002 / WP-P1-SEC-024)。
 *
 * 誰が何を持つかは見えていた([[WP-P1-IDM-015]] の一覧)。
 * 配ることも取り消すことも動いていた。**見直す手続きが無かった。**
 *
 * 一覧が在っても、見る機会が定義されていなければ誰も見ない。
 * 権限は増える方向にしか動かない。減るのは、減らす日を決めたときだけである。
 *
 * ## 設計の要点
 *
 * 1. **開いた時点で対象を固定する。** 毎回「いま有効な役割」を引き直すと
 *    レビュー中に対象が動き、何を見たのかが後から言えなくなる。
 *
 * 2. **決定は実際に効かせる。** `revoke` はその場で役割を失効させる。
 *    記録だけを作る実装は、**記録が嘘になる**。
 *
 * 3. **失効は既存の経路を通す。** [[WP-P1-IDM-015]] の `revokeRole` を呼ぶ。
 *    別に失効の実装を持つと、片方だけ直したときに食い違う(DL-046)。
 *    最後の管理者を守る判定も、そちら側に既に在る。
 *
 * 4. **未決を残したまま完了できない。** 「実施した」という記録は、
 *    全部を見たときにだけ真である。
 *
 * 5. **自分で自分を承認できる。** SoD を強制すると管理者1人の組織で
 *    実施不能になる。**禁じる代わりに、そうしたことを記録に残す。**
 */

const MANAGE_ROLES = ['org_admin', 'platform_admin'] as const;

export type ReviewDecision = 'keep' | 'revoke';

export interface AccessReviewItem {
  id: string;
  userId: string;
  displayName: string;
  email: string;
  roleCode: string;
  validUntilAtOpen: string | null;
  decision: 'pending' | ReviewDecision;
  decidedAt: string | null;
  decidedBy: string | null;
  reason: string | null;
  /**
   * 開いた後に別経路(取り消し・期限到来)で失効したか。
   *
   * **既に無効なものへ決定を求めない。** 求めると、
   * 「取り消した」という決定が何も変えないまま記録される。
   */
  alreadyInactive: boolean;
  /** レビュー者自身の役割か。SoD を強制しない代わりに見えるようにする。 */
  selfReviewed: boolean;
}

export interface AccessReviewSummary {
  id: string;
  periodLabel: string;
  openedAt: string;
  openedBy: string;
  source: 'manual' | 'scheduled';
  completedAt: string | null;
  completedBy: string | null;
  totalItems: number;
  pendingItems: number;
}

export class AccessReviewService {
  constructor(private readonly client: pg.PoolClient | pg.Client) {}

  /**
   * 期を開く。
   *
   * その時点で有効な **org スコープの** 役割を項目として写し取る。
   *
   * ## platform スコープは対象にできない — 件数も出せない
   *
   * [[WP-P1-IDM-014]] は対象外にしたものの**件数を返す**ことにした
   * (黙って飛ばすと「守った」と「欠けた」の区別が消えるため)。
   * ここでも同じにしようとして、**実際に測ったら数えられなかった。**
   *
   * `role_binding_isolation` は `organization_id = app_current_org()` であり、
   * platform 束縛は `organization_id` が NULL なので条件が NULL になる。
   * 所有者から 3 件見える状態で、アプリからは 0 件だった。
   *
   * **0 を返す実装は、「無い」と読ませる。実際は「見えない」である。**
   * 表示のために越境読み取りの例外を増やすこともしない(DL-062)。
   * 画面には「この組織からは件数も見えない」と書く。
   */
  async open(ctx: AuthzContext, periodLabel: string): Promise<{ reviewId: string; items: number }> {
    requireRole(ctx, ...MANAGE_ROLES);

    const label = periodLabel.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/.test(label)) {
      throw Problems.validation([
        { field: 'periodLabel', message: '期の名前は英数字・ハイフン・下線で32文字以内です' },
      ]);
    }

    // 開いているものがあれば、それを先に終わらせる。
    // DB にも一意索引があるが、**利用者に読める理由を返す**のはここである。
    const { rows: open } = await this.client.query(
      'SELECT period_label FROM access_review WHERE organization_id = $1 AND completed_at IS NULL LIMIT 1',
      [ctx.organizationId],
    );
    if (open.length > 0) {
      throw Problems.conflict(
        `レビュー「${open[0]!.period_label as string}」が進行中です。先に完了させてください。`,
      );
    }

    const { rows: dup } = await this.client.query(
      'SELECT 1 FROM access_review WHERE organization_id = $1 AND period_label = $2 LIMIT 1',
      [ctx.organizationId, label],
    );
    if (dup.length > 0) {
      throw Problems.conflict('その期のレビューは既にあります');
    }

    const reviewId = uuidv7();
    await this.client.query(
      `INSERT INTO access_review (id, organization_id, period_label, opened_by, source)
       VALUES ($1, $2, $3, $4, 'manual')`,
      [reviewId, ctx.organizationId, label, ctx.principal.userId],
    );

    // 開いた時点の姿を写し取る。**停止された利用者の役割も対象にする** —
    // 止まっていることと、権限を持ち続けていることは別である。
    const { rows: bindings } = await this.client.query(
      `SELECT rb.id, rb.user_id, rb.valid_until, r.code
         FROM role_binding rb
         JOIN role r ON r.id = rb.role_id
        WHERE rb.organization_id = $1
          AND rb.role_scope = 'org'
          AND rb.valid_from <= now()
          AND (rb.valid_until IS NULL OR rb.valid_until > now())`,
      [ctx.organizationId],
    );

    for (const b of bindings) {
      await this.client.query(
        `INSERT INTO access_review_item
           (id, review_id, organization_id, user_id, role_binding_id, role_code, valid_until_at_open)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          uuidv7(),
          reviewId,
          ctx.organizationId,
          b.user_id,
          b.id,
          b.code,
          b.valid_until as Date | null,
        ],
      );
    }

    await recordAuditEvent(this.client, {
      eventType: 'access.review.opened',
      organizationId: ctx.organizationId,
      actorType: 'user',
      actorId: ctx.principal.userId,
      targetType: 'access_review',
      targetId: reviewId,
      action: 'open',
      outcome: 'success',
      afterState: { periodLabel: label, items: bindings.length },
    });

    return { reviewId, items: bindings.length };
  }

  /** 期の一覧。新しいものから。 */
  async list(ctx: AuthzContext): Promise<AccessReviewSummary[]> {
    requireRole(ctx, ...MANAGE_ROLES, 'auditor');

    const { rows } = await this.client.query(
      `SELECT ar.*,
              (SELECT count(*)::int FROM access_review_item i WHERE i.review_id = ar.id) AS total,
              (SELECT count(*)::int FROM access_review_item i
                WHERE i.review_id = ar.id AND i.decision = 'pending') AS pending
         FROM access_review ar
        WHERE ar.organization_id = $1
        ORDER BY ar.opened_at DESC`,
      [ctx.organizationId],
    );
    return rows.map((r) => this.toSummary(r));
  }

  private toSummary(r: Record<string, unknown>): AccessReviewSummary {
    return {
      id: r.id as string,
      periodLabel: r.period_label as string,
      openedAt: (r.opened_at as Date).toISOString(),
      openedBy: r.opened_by as string,
      source: r.source as 'manual' | 'scheduled',
      completedAt: (r.completed_at as Date | null)?.toISOString() ?? null,
      completedBy: (r.completed_by as string | null) ?? null,
      totalItems: Number(r.total ?? 0),
      pendingItems: Number(r.pending ?? 0),
    };
  }

  /**
   * 期の中身。
   *
   * **他組織のレビューは 404 にする。** RLS でも見えないが、
   * 認可を RLS に任せない(ADR-0015)。存在も教えない(NFR-SEC-006)。
   */
  async detail(
    ctx: AuthzContext,
    reviewId: string,
  ): Promise<{ review: AccessReviewSummary; items: AccessReviewItem[] }> {
    requireRole(ctx, ...MANAGE_ROLES, 'auditor');

    const { rows } = await this.client.query(
      `SELECT ar.*,
              (SELECT count(*)::int FROM access_review_item i WHERE i.review_id = ar.id) AS total,
              (SELECT count(*)::int FROM access_review_item i
                WHERE i.review_id = ar.id AND i.decision = 'pending') AS pending
         FROM access_review ar
        WHERE ar.id = $1 AND ar.organization_id = $2`,
      [reviewId, ctx.organizationId],
    );
    if (rows.length === 0) throw Problems.notFound('アクセスレビュー');

    const { rows: items } = await this.client.query(
      `SELECT i.*, u.display_name, u.primary_email,
              -- **いま効力があるか**を束縛の側から見る。
              -- 開いた後に取り消されたものへ決定を求めない。
              (rb.valid_from <= now() AND (rb.valid_until IS NULL OR rb.valid_until > now()))
                AS still_active
         FROM access_review_item i
         JOIN app_user u ON u.id = i.user_id
         JOIN role_binding rb ON rb.id = i.role_binding_id
        WHERE i.review_id = $1 AND i.organization_id = $2
        ORDER BY u.display_name, i.role_code`,
      [reviewId, ctx.organizationId],
    );

    return {
      review: this.toSummary(rows[0]!),
      items: items.map((r) => ({
        id: r.id as string,
        userId: r.user_id as string,
        displayName: r.display_name as string,
        email: r.primary_email as string,
        roleCode: r.role_code as string,
        validUntilAtOpen: (r.valid_until_at_open as Date | null)?.toISOString() ?? null,
        decision: r.decision as 'pending' | ReviewDecision,
        decidedAt: (r.decided_at as Date | null)?.toISOString() ?? null,
        decidedBy: (r.decided_by as string | null) ?? null,
        reason: (r.reason as string | null) ?? null,
        alreadyInactive: r.still_active === false,
        selfReviewed: r.decided_by === r.user_id,
      })),
    };
  }

  /**
   * 1件を決める。
   *
   * `revoke` は**その場で失効させる**。失効は [[WP-P1-IDM-015]] の
   * `revokeRole` を通す — 最後の管理者を守る判定も、監査の書き方も、
   * そちらに既に在る。**判定する側を1つにする**(DL-050)。
   */
  async decide(
    ctx: AuthzContext,
    reviewId: string,
    itemId: string,
    decision: ReviewDecision,
    reason: string,
  ): Promise<void> {
    requireRole(ctx, ...MANAGE_ROLES);

    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      // **「残す」も判断である。** 判断には理由がある。
      throw Problems.validation([{ field: 'reason', message: '判断の理由を入力してください' }]);
    }
    if (trimmed.length > 500) {
      throw Problems.validation([
        { field: 'reason', message: '理由は500文字以内で入力してください' },
      ]);
    }

    const { rows } = await this.client.query(
      `SELECT i.id, i.user_id, i.role_code, i.decision, ar.completed_at,
              (rb.valid_from <= now() AND (rb.valid_until IS NULL OR rb.valid_until > now()))
                AS still_active
         FROM access_review_item i
         JOIN access_review ar ON ar.id = i.review_id
         JOIN role_binding rb ON rb.id = i.role_binding_id
        WHERE i.id = $1 AND i.review_id = $2 AND i.organization_id = $3`,
      [itemId, reviewId, ctx.organizationId],
    );
    if (rows.length === 0) throw Problems.notFound('レビュー項目');
    const item = rows[0]!;

    if (item.completed_at !== null) {
      // 完了した記録を後から書き換えられるようにしない。
      throw Problems.conflict('完了したレビューは変更できません');
    }

    if (decision === 'revoke' && item.still_active === false) {
      // 既に無効なものを「取り消した」と記録すると、
      // **何も変えていない操作が、変えた記録として残る。**
      throw Problems.conflict('この役割は既に失効しています');
    }

    if (decision === 'revoke') {
      // **同じ経路を通す。** ここで UPDATE を書くと失効の実装が2つになる。
      await new UserAdminService(this.client).revokeRole(
        ctx,
        item.user_id as string,
        item.role_code as string,
        `アクセスレビュー: ${trimmed}`,
      );
    }

    await this.client.query(
      `UPDATE access_review_item
          SET decision = $1, decided_at = now(), decided_by = $2, reason = $3
        WHERE id = $4`,
      [decision, ctx.principal.userId, trimmed, itemId],
    );

    await recordAuditEvent(this.client, {
      eventType: 'access.review.item.decided',
      organizationId: ctx.organizationId,
      actorType: 'user',
      actorId: ctx.principal.userId,
      subjectUserId: item.user_id as string,
      targetType: 'access_review_item',
      targetId: itemId,
      action: decision,
      outcome: 'success',
      afterState: {
        roleCode: item.role_code as string,
        reason: trimmed,
        // **自分で自分を承認したことを残す。** 禁じない代わりに見えるようにする。
        selfReviewed: item.user_id === ctx.principal.userId,
      },
    });
  }

  /**
   * 完了させる。
   *
   * **未決が1件でも残っていれば完了させない。**
   * 「実施した」という記録は、全部を見たときにだけ真である。
   */
  async complete(ctx: AuthzContext, reviewId: string): Promise<{ decided: number }> {
    requireRole(ctx, ...MANAGE_ROLES);

    const { rows } = await this.client.query(
      `SELECT ar.completed_at,
              (SELECT count(*)::int FROM access_review_item i
                WHERE i.review_id = ar.id AND i.decision = 'pending') AS pending,
              (SELECT count(*)::int FROM access_review_item i WHERE i.review_id = ar.id) AS total
         FROM access_review ar
        WHERE ar.id = $1 AND ar.organization_id = $2`,
      [reviewId, ctx.organizationId],
    );
    if (rows.length === 0) throw Problems.notFound('アクセスレビュー');
    if (rows[0]!.completed_at !== null) {
      throw Problems.conflict('このレビューは既に完了しています');
    }

    const pending = Number(rows[0]!.pending ?? 0);
    if (pending > 0) {
      throw Problems.conflict(`未判断が ${pending} 件あります。すべて判断してから完了してください。`);
    }

    await this.client.query(
      'UPDATE access_review SET completed_at = now(), completed_by = $1 WHERE id = $2',
      [ctx.principal.userId, reviewId],
    );

    const total = Number(rows[0]!.total ?? 0);
    await recordAuditEvent(this.client, {
      eventType: 'access.review.completed',
      organizationId: ctx.organizationId,
      actorType: 'user',
      actorId: ctx.principal.userId,
      targetType: 'access_review',
      targetId: reviewId,
      action: 'complete',
      outcome: 'success',
      afterState: { decided: total },
    });

    return { decided: total };
  }
}
