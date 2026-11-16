import type pg from 'pg';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { Problems } from '@solvi/shared';
import { hasRole, requireRole } from '../../common/authz/authz.js';
import {
  catalogFieldSchema,
  catalogSectionSchema,
  type CatalogDefinition,
} from '@solvi/shared/catalog';
import { recordAuditEvent, uuidv7 } from '../../common/audit/audit.js';
import type { AuthenticatedRequest } from '../auth/auth.routes.js';
import { definitionSchema } from './catalog-definition.js';
import { activeRuleExists } from './approval-rule.service.js';
import { evaluateHighRiskDefinition, readHighRiskAttribute } from './approval-high-risk.js';
import { lockApprovalSetting, lockRuleRevisionForShare } from './approval-high-risk-store.js';
const content = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(2000),
    definition: definitionSchema.refine(
      (d) => Boolean(d.approval),
      '固定承認者または承認ルールを設定してください',
    ),
  })
  .strict();
const createSchema = content
  .extend({ code: z.string().regex(/^[a-z][a-z0-9-]{1,47}$/), creationKey: z.string().uuid() })
  .strict();
const editSchema = content.extend({ expectedVersion: z.number().int().positive() }).strict();
const publicationSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    state: z.enum(['published', 'unpublished']),
  })
  .strict();
const questionContent = z
  .object({
    title: z.string().trim().min(1, '質問セット名を入力してください').max(200),
    description: z.string().trim().max(2000),
    fields: z.array(catalogFieldSchema).max(10),
    sections: z.array(catalogSectionSchema).max(10).optional(),
  })
  .strict();
const questionCreate = questionContent.extend({ creationKey: z.string().uuid() }).strict();
const questionEdit = questionContent
  .extend({ expectedVersion: z.number().int().positive() })
  .strict();
const fingerprint = (value: unknown) =>
  createHash('sha256')
    .update(
      JSON.stringify(value, (_key, entry) =>
        entry && typeof entry === 'object' && !Array.isArray(entry)
          ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
          : entry,
      ),
    )
    .digest('hex');
function parse<T extends z.ZodTypeAny>(s: T, v: unknown): z.output<T> {
  const r = s.safeParse(v);
  if (!r.success)
    throw Problems.validation(
      r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    );
  return r.data;
}
const approversSql = `SELECT DISTINCT u.id,u.display_name AS name FROM app_user u JOIN role_binding rb ON rb.user_id=u.id JOIN role r ON r.id=rb.role_id WHERE rb.organization_id=$1 AND r.code='approver' AND u.status='active' AND rb.valid_from<=clock_timestamp() AND (rb.valid_until IS NULL OR rb.valid_until>clock_timestamp()) ORDER BY name,u.id`;
/** 高リスクの指定を変えられるのは org_admin だけである(ADR-0024 §4 / ADR-0026 §3)。 */
const HIGH_RISK_ADMIN_ONLY = '高リスクの指定を変更できるのは組織管理者だけです';
/** 高リスクの定義の公開を拒否するときの、条件ごとの文言(WP-P4-APR-021 §6.3-1)。 */
function highRiskPublishMessage(
  code:
    | 'attribute_invalid'
    | 'rule_missing'
    | 'rule_routing_disabled'
    | 'rule_unavailable'
    | 'fixed_approvers_insufficient'
    | 'fixed_approvers_duplicate',
): string {
  switch (code) {
    case 'rule_missing':
      return '高リスクの項目には承認ルールを設定してください';
    case 'rule_routing_disabled':
      return '組織で承認ルールの使用が有効になっていません。有効にしてから公開してください';
    case 'rule_unavailable':
      return '高リスクの項目に設定した承認ルールが有効ではありません';
    case 'fixed_approvers_insufficient':
      return '高リスクの項目には、別人の固定承認者を2段以上設定した承認ルールが必要です';
    case 'fixed_approvers_duplicate':
      return '高リスクの項目では、固定承認者を段ごとに別人にしてください';
    case 'attribute_invalid':
      return '高リスクの指定を確認してください';
  }
}
export class CatalogAdminController {
  constructor(
    private readonly pool: pg.Pool,
    private readonly enabled: boolean,
  ) {}
  private async run<T>(auth: AuthenticatedRequest, fn: (c: pg.PoolClient) => Promise<T>) {
    if (!this.enabled) throw Problems.notFound('ローカルカタログ管理');
    requireRole(auth.authz, 'org_admin', 'platform_admin', 'catalog_editor');
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.current_org',$1,true)", [auth.authz.organizationId]);
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
  private administrator(auth: AuthenticatedRequest) {
    return hasRole(auth.authz, 'org_admin', 'platform_admin');
  }
  private async questionSets(c: pg.PoolClient, organizationId: string) {
    return (
      await c.query(
        `SELECT DISTINCT ON(set_id) set_id AS id,revision,title,description,fields,sections,created_at AS "updatedAt" FROM local_catalog_question_set_revision WHERE organization_id=$1 ORDER BY set_id,revision DESC`,
        [organizationId],
      )
    ).rows;
  }
  private async options(c: pg.PoolClient, auth: AuthenticatedRequest) {
    const owners = (
      await c.query(
        `SELECT DISTINCT u.id,u.display_name AS name FROM app_user u JOIN role_binding rb ON rb.user_id=u.id WHERE rb.organization_id=$1 AND u.status='active' AND rb.valid_from<=clock_timestamp() AND (rb.valid_until IS NULL OR rb.valid_until>clock_timestamp()) AND ($2::boolean OR u.id=$3) ORDER BY name,u.id`,
        [auth.authz.organizationId, this.administrator(auth), auth.userId],
      )
    ).rows;
    const groups = (
      await c.query(
        'SELECT id,name FROM assignment_group WHERE organization_id=$1 AND active ORDER BY name,id',
        [auth.authz.organizationId],
      )
    ).rows;
    return {
      viewerId: auth.userId,
      owners,
      groups,
      questionSets: await this.questionSets(c, auth.authz.organizationId),
      approvers: (await c.query(approversSql, [auth.authz.organizationId])).rows,
      // 定義に結び付けられる有効な承認ルール(同じ組織だけ。RLS + 明示条件)。
      rules: (
        await c.query(
          'SELECT id,code,name,current_revision AS "currentRevision" FROM approval_rule WHERE organization_id=$1 AND active ORDER BY code,id',
          [auth.authz.organizationId],
        )
      ).rows,
      canCreate: true,
      canPublish: this.administrator(auth),
      canManageQuestionSets: this.administrator(auth),
    };
  }
  private readiness(
    value: unknown,
    options: {
      owners: Array<{ id: string; name: string }>;
      groups: Array<{ id: string; name: string }>;
      approvers: Array<{ id: string; name: string }>;
      rules: Array<{ id: string; code: string; name: string }>;
    },
  ) {
    const parsed = definitionSchema.safeParse(value),
      issues: string[] = [],
      warnings: string[] = [];
    if (!parsed.success) issues.push(...parsed.error.issues.map((issue) => issue.message));
    else {
      const definition = parsed.data;
      if (!definition.approval) issues.push('固定承認者または承認ルールを設定してください');
      else {
        if (
          definition.approval.approverId &&
          !options.approvers.some((person) => person.id === definition.approval!.approverId)
        )
          issues.push('現在有効な固定承認者を設定してください');
        if (
          definition.approval.ruleId &&
          !options.rules.some((rule) => rule.id === definition.approval!.ruleId)
        )
          issues.push('現在有効な承認ルールを設定してください');
      }
      if (definition.ownerId && !options.owners.some((person) => person.id === definition.ownerId))
        issues.push('責任者が現在有効な同じ組織の候補にありません');
      if (
        definition.fulfillmentGroupId &&
        !options.groups.some((group) => group.id === definition.fulfillmentGroupId)
      )
        issues.push('処理グループが現在有効な同じ組織の候補にありません');
      if (!definition.ownerId) warnings.push('責任者が未設定です');
      if (!definition.fulfillmentGroupId) warnings.push('処理グループが未設定です');
    }
    return { ready: issues.length === 0, issues, warnings };
  }
  private async references(
    c: pg.PoolClient,
    auth: AuthenticatedRequest,
    definition: CatalogDefinition,
  ) {
    // 版属性 `ruleId` は保存時点で同じ組織の有効なルールを指すこと(WP §6.1)。
    // 他組織・無効・不在は 400。組織の有効化設定が無効でも保存自体は許す(準備のため)。
    if (
      definition.approval?.ruleId &&
      !(await activeRuleExists(c, auth.authz.organizationId, definition.approval.ruleId))
    )
      throw Problems.validation([
        {
          field: 'definition.approval.ruleId',
          message: '現在有効な同じ組織の承認ルールを設定してください',
        },
      ]);
    const options = await this.options(c, auth),
      readiness = this.readiness(definition, options);
    if (!readiness.ready)
      throw Problems.validation(
        readiness.issues.map((message) => ({
          field: message.startsWith('責任者')
            ? 'definition.ownerId'
            : message.startsWith('処理グループ')
              ? 'definition.fulfillmentGroupId'
              : message.startsWith('現在有効な承認ルール')
                ? 'definition.approval.ruleId'
                : 'definition.approval.approverId',
          message,
        })),
      );
  }
  private async approver(c: pg.PoolClient, org: string, id: string) {
    if (!(await c.query(approversSql, [org])).rows.some((a) => a.id === id))
      throw Problems.validation([
        {
          field: 'definition.approval.approverId',
          message: '現在有効な同じ組織の承認者を設定してください',
        },
      ]);
  }
  /**
   * 委任された編集者が、下書きで高リスクの指定を変えられないことを確かめる
   * (WP-P4-APR-021 §6.1-2 / ADR-0026 §3)。
   *
   * 比較は「省略」と「偽」を同じ値とみなす。直前の版の値が読めない場合は、
   * 誰にも変えさせない(fail closed。直せるのは org_admin だけ)。
   */
  private async assertHighRiskChangeAllowed(
    c: pg.PoolClient,
    auth: AuthenticatedRequest,
    itemId: string,
    draftRevision: number,
    approval: unknown,
  ) {
    if (this.administrator(auth)) return;
    const row = (
      await c.query<{ definition: unknown }>(
        'SELECT definition FROM local_catalog_revision WHERE item_id=$1 AND organization_id=$2 AND revision=$3',
        [itemId, auth.authz.organizationId, draftRevision],
      )
    ).rows[0];
    if (!row) throw Problems.notFound('カタログ項目');
    const previous = readHighRiskAttribute(
      (row.definition as { approval?: unknown } | null)?.approval,
    );
    const next = readHighRiskAttribute(approval);
    if (previous === 'invalid' || next === 'invalid')
      throw Problems.forbidden(HIGH_RISK_ADMIN_ONLY);
    if ((previous === 'true') !== (next === 'true')) throw Problems.forbidden(HIGH_RISK_ADMIN_ONLY);
  }
  /**
   * 高リスクの定義を公開できる条件を確かめる(WP-P4-APR-021 §6.3-1)。
   *
   * ロックは「組織の設定の行 → ルールの行」の順で取る(公開の側。ADR-0026 §2)。
   * 高リスクでない定義では何もしない(既存の公開の挙動を変えない)。
   */
  private async assertHighRiskPublish(
    c: pg.PoolClient,
    auth: AuthenticatedRequest,
    definition: CatalogDefinition,
  ) {
    const attribute = readHighRiskAttribute(definition.approval);
    if (attribute === 'invalid')
      throw Problems.validation([
        {
          field: 'definition.approval.highRisk',
          message: highRiskPublishMessage('attribute_invalid'),
        },
      ]);
    if (attribute !== 'true') return;
    // 公開中だった版との比較(監査)より先に、条件を満たすかを確かめる。
    const setting = await lockApprovalSetting(c, auth.authz.organizationId, 'share');
    const ruleId = definition.approval?.ruleId;
    const rule =
      typeof ruleId === 'string' && ruleId.length > 0
        ? await lockRuleRevisionForShare(c, auth.authz.organizationId, ruleId)
        : null;
    const evaluation = evaluateHighRiskDefinition({
      approval: definition.approval,
      ruleRoutingEnabled: setting.enabled,
      rule: rule ? { active: rule.active, steps: rule.steps } : null,
    });
    if (evaluation.highRisk && !evaluation.ok)
      throw Problems.validation([
        {
          field: 'definition.approval.highRisk',
          message: highRiskPublishMessage(evaluation.code),
        },
      ]);
  }
  /** 公開中だった版の高リスクの属性(無ければ `missing`)。版が消えていれば 409。 */
  private async publishedHighRisk(
    c: pg.PoolClient,
    auth: AuthenticatedRequest,
    itemId: string,
    publishedRevision: number | null,
  ) {
    if (publishedRevision === null) return { attribute: 'missing' as const, revision: null };
    const row = (
      await c.query<{ definition: unknown }>(
        'SELECT definition FROM local_catalog_revision WHERE item_id=$1 AND organization_id=$2 AND revision=$3',
        [itemId, auth.authz.organizationId, publishedRevision],
      )
    ).rows[0];
    if (!row) throw Problems.conflict('公開中だったカタログの版を確認できません');
    return {
      attribute: readHighRiskAttribute((row.definition as { approval?: unknown } | null)?.approval),
      revision: publishedRevision,
    };
  }
  private async audit(
    c: pg.PoolClient,
    auth: AuthenticatedRequest,
    id: string,
    event: 'saved' | 'published' | 'unpublished',
    revision: number,
  ) {
    await recordAuditEvent(c, {
      eventType: `catalog.${event}`,
      organizationId: auth.authz.organizationId,
      actorType: 'user',
      actorId: auth.userId,
      targetType: 'catalog_item',
      targetId: id,
      action: `catalog.${event}`,
      outcome: 'success',
      afterState: { revision, simulation: true },
    });
  }
  async list(auth: AuthenticatedRequest) {
    return this.run(auth, async (c) => {
      const options = await this.options(c, auth);
      const rows = (
        await c.query(
          `SELECT i.id,i.code,i.edit_version AS "editVersion",i.draft_revision AS "draftRevision",i.published_revision AS "publishedRevision",i.active,r.title,r.description,r.definition,pr.definition AS "publishedDefinition",r.created_at AS "updatedAt" FROM local_catalog_item i JOIN local_catalog_revision r ON r.item_id=i.id AND r.organization_id=i.organization_id AND r.revision=i.draft_revision LEFT JOIN local_catalog_revision pr ON pr.item_id=i.id AND pr.organization_id=i.organization_id AND pr.revision=i.published_revision WHERE i.organization_id=$1 AND ($2::boolean OR r.definition->>'ownerId'=$3) ORDER BY i.code`,
          [auth.authz.organizationId, this.administrator(auth), auth.userId],
        )
      ).rows;
      return {
        ...options,
        items: rows.map(({ definition, publishedDefinition, ...row }) => ({
          ...row,
          ownerName: options.owners.find((person) => person.id === definition.ownerId)?.name,
          readiness: this.readiness(definition, options),
          // 一覧の目印(加算的)。画面が定義の JSON を推測せずに済むよう、
          // API が同じ判定(`=== true` のときだけ)で返す。
          highRisk: readHighRiskAttribute(definition.approval) === 'true',
          publishedHighRisk:
            readHighRiskAttribute(
              (publishedDefinition as { approval?: unknown } | null)?.approval,
            ) === 'true',
        })),
      };
    });
  }
  private async lock(c: pg.PoolClient, auth: AuthenticatedRequest, id: string) {
    parse(z.string().uuid(), id);
    const r = (
      await c.query(
        'SELECT * FROM local_catalog_item WHERE id=$1 AND organization_id=$2 FOR UPDATE',
        [id, auth.authz.organizationId],
      )
    ).rows[0];
    if (!r) throw Problems.notFound('カタログ項目');
    if (!this.administrator(auth)) {
      const draft = (
        await c.query(
          'SELECT definition FROM local_catalog_revision WHERE item_id=$1 AND organization_id=$2 AND revision=$3',
          [id, auth.authz.organizationId, r.draft_revision],
        )
      ).rows[0];
      if (draft?.definition?.ownerId !== auth.userId) throw Problems.notFound('カタログ項目');
    }
    return r;
  }
  async detail(auth: AuthenticatedRequest, id: string) {
    return this.run(auth, async (c) => {
      const i = await this.lock(c, auth, id);
      const revisions = (
        await c.query(
          'SELECT revision,title,description,definition,created_at AS "createdAt" FROM local_catalog_revision WHERE item_id=$1 AND organization_id=$2 ORDER BY revision DESC',
          [id, auth.authz.organizationId],
        )
      ).rows;
      const options = await this.options(c, auth);
      const draft = revisions.find((r) => r.revision === i.draft_revision);
      const published = revisions.find((r) => r.revision === i.published_revision) ?? null;
      return {
        id: i.id,
        code: i.code,
        editVersion: i.edit_version,
        active: i.active,
        publishedRevision: i.published_revision,
        draft,
        published,
        history: revisions.map(({ revision, title, createdAt }) => ({
          revision,
          title,
          createdAt,
        })),
        ...options,
        canEdit: true,
        // 画面の目印(加算的)。一覧と同じく、属性が真偽値の `true` のときだけ真。
        highRisk: readHighRiskAttribute(draft?.definition?.approval) === 'true',
        publishedHighRisk: readHighRiskAttribute(published?.definition?.approval) === 'true',
        readiness: this.readiness(draft?.definition, options),
      };
    });
  }
  private async revision(
    c: pg.PoolClient,
    auth: AuthenticatedRequest,
    id: string,
    revision: number,
    v: z.infer<typeof content>,
  ) {
    await c.query(
      'INSERT INTO local_catalog_revision(item_id,organization_id,revision,title,description,definition,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [id, auth.authz.organizationId, revision, v.title, v.description, v.definition, auth.userId],
    );
  }
  async create(auth: AuthenticatedRequest, value: unknown) {
    const v = parse(createSchema, value);
    if (!this.administrator(auth)) {
      if (v.definition.ownerId && v.definition.ownerId !== auth.userId)
        throw Problems.forbidden('自分を責任者とする下書きだけ作成できます');
      // 新規の項目では、委任された編集者は高リスクの指定を真にできない(ADR-0026 §3)。
      if (v.definition.approval?.highRisk === true) throw Problems.forbidden(HIGH_RISK_ADMIN_ONLY);
      v.definition.ownerId = auth.userId;
    }
    return this.run(auth, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'catalog-create:' + auth.authz.organizationId + ':' + auth.userId + ':' + v.creationKey,
      ]);
      const prior = (
        await c.query(
          'SELECT i.id,i.code,r.title,r.description,r.definition FROM local_catalog_item i JOIN local_catalog_revision r ON r.item_id=i.id AND r.organization_id=i.organization_id AND r.revision=1 WHERE i.organization_id=$1 AND i.created_by=$2 AND i.creation_key=$3',
          [auth.authz.organizationId, auth.userId, v.creationKey],
        )
      ).rows[0];
      if (prior) {
        const normalize = (o: Record<string, unknown>) =>
          createHash('sha256')
            .update(
              JSON.stringify(o, (_key, v) =>
                v && typeof v === 'object' && !Array.isArray(v)
                  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
                  : v,
              ),
            )
            .digest('hex');
        if (
          prior.code !== v.code ||
          prior.title !== v.title ||
          prior.description !== v.description ||
          normalize(prior.definition) !== normalize(v.definition)
        )
          throw Problems.conflict('同じ作成キーで別の定義は保存できません');
        return { id: prior.id, replayed: true };
      }
      await this.references(c, auth, v.definition);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'catalog-code:' + auth.authz.organizationId + ':' + v.code,
      ]);
      if (
        (
          await c.query('SELECT id FROM local_catalog_item WHERE organization_id=$1 AND code=$2', [
            auth.authz.organizationId,
            v.code,
          ])
        ).rowCount
      )
        throw Problems.conflict('このコードは既に使用されています');
      const id = uuidv7();
      await c.query(
        'INSERT INTO local_catalog_item(id,organization_id,code,version,title,description,definition,active,created_by,creation_key) VALUES($1,$2,$3,1,$4,$5,$6,false,$7,$8)',
        [
          id,
          auth.authz.organizationId,
          v.code,
          v.title,
          v.description,
          v.definition,
          auth.userId,
          v.creationKey,
        ],
      );
      await this.revision(c, auth, id, 1, v);
      await this.audit(c, auth, id, 'saved', 1);
      return { id, replayed: false };
    });
  }
  async save(auth: AuthenticatedRequest, id: string, value: unknown) {
    const v = parse(editSchema, value);
    return this.run(auth, async (c) => {
      const i = await this.lock(c, auth, id);
      if (!this.administrator(auth)) {
        if (v.definition.ownerId !== auth.userId)
          throw Problems.forbidden('責任者の変更は管理者が行えます');
        // 直前の版(下書き)と同じ値でなければ保存できない(ADR-0026 §3)。
        await this.assertHighRiskChangeAllowed(
          c,
          auth,
          id,
          i.draft_revision,
          v.definition.approval,
        );
      }
      if (i.edit_version !== v.expectedVersion) throw Problems.stale('カタログ');
      await this.references(c, auth, v.definition);
      const revision = i.draft_revision + 1;
      await this.revision(c, auth, id, revision, v);
      await c.query(
        'UPDATE local_catalog_item SET draft_revision=$2,edit_version=edit_version+1 WHERE id=$1',
        [id, revision],
      );
      await this.audit(c, auth, id, 'saved', revision);
      return { id };
    });
  }
  async publication(auth: AuthenticatedRequest, id: string, value: unknown) {
    requireRole(auth.authz, 'org_admin', 'platform_admin');
    const v = parse(publicationSchema, value);
    return this.run(auth, async (c) => {
      const i = await this.lock(c, auth, id);
      if (i.edit_version !== v.expectedVersion) throw Problems.stale('カタログ');
      if (v.state === 'published') {
        const r = (
          await c.query(
            'SELECT * FROM local_catalog_revision WHERE item_id=$1 AND organization_id=$2 AND revision=$3',
            [id, auth.authz.organizationId, i.draft_revision],
          )
        ).rows[0];
        const d = parse(definitionSchema, r.definition);
        if (!d.approval)
          throw Problems.validation([
            {
              field: 'approval',
              message: '下書きを編集して固定承認者または承認ルールを設定してください',
            },
          ]);
        await this.references(c, auth, d);
        // 高リスクの定義は、条件(ルール・別人の固定承認者が2段以上)を満たすときだけ公開できる。
        await this.assertHighRiskPublish(c, auth, d);
        const before = await this.publishedHighRisk(c, auth, id, i.published_revision);
        await c.query(
          'UPDATE local_catalog_item SET version=$2,title=$3,description=$4,definition=$5,published_revision=$2,active=true,edit_version=edit_version+1 WHERE id=$1',
          [id, r.revision, r.title, r.description, d],
        );
        // 属性の変更は**公開の時点で**、公開中だった版との差として記録する
        // (ADR-0026 §3。下書きの保存では記録しない)。前後の真偽値と版だけを残す。
        const beforeValue = before.attribute === 'true';
        const afterValue = readHighRiskAttribute(d.approval) === 'true';
        if (beforeValue !== afterValue || before.attribute === 'invalid')
          await recordAuditEvent(c, {
            eventType: 'catalog.high_risk_changed',
            organizationId: auth.authz.organizationId,
            actorType: 'user',
            actorId: auth.userId,
            targetType: 'catalog_item',
            targetId: id,
            action: 'catalog.high_risk_changed',
            outcome: 'success',
            beforeState: { code: i.code, revision: before.revision, highRisk: beforeValue },
            afterState: { code: i.code, revision: r.revision, highRisk: afterValue },
          });
      } else {
        await c.query(
          'UPDATE local_catalog_item SET active=false,edit_version=edit_version+1 WHERE id=$1',
          [id],
        );
      }
      await this.audit(
        c,
        auth,
        id,
        v.state,
        v.state === 'published' ? i.draft_revision : (i.published_revision ?? i.draft_revision),
      );
      return { id, state: v.state };
    });
  }
  async listQuestionSets(auth: AuthenticatedRequest) {
    return this.run(auth, async (c) => ({
      items: await this.questionSets(c, auth.authz.organizationId),
      canManage: this.administrator(auth),
    }));
  }
  async saveQuestionSet(auth: AuthenticatedRequest, id: string | null, value: unknown) {
    requireRole(auth.authz, 'org_admin', 'platform_admin');
    const input = id ? parse(questionEdit, value) : parse(questionCreate, value);
    const normalized = parse(definitionSchema, {
      mode: 'local_simulation',
      action: 'simulate.access_grant',
      targetLabel: '共有質問セット検証',
      allowedDurations: [1],
      maxReasonLength: 2000,
      fields: input.fields,
      ...(input.sections ? { sections: input.sections } : {}),
    });
    const stored = {
      title: input.title,
      description: input.description,
      fields: normalized.fields ?? [],
      sections: normalized.sections ?? [],
    };
    return this.run(auth, async (c) => {
      let revision = 1;
      const setId = id ?? uuidv7();
      if (id) {
        parse(z.string().uuid(), id);
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `question-set:${auth.authz.organizationId}:${id}`,
        ]);
        const latest = (
          await c.query(
            'SELECT revision FROM local_catalog_question_set_revision WHERE set_id=$1 AND organization_id=$2 ORDER BY revision DESC LIMIT 1',
            [id, auth.authz.organizationId],
          )
        ).rows[0];
        if (!latest) throw Problems.notFound('共有質問セット');
        if (latest.revision !== ('expectedVersion' in input ? input.expectedVersion : undefined))
          throw Problems.stale('共有質問セット');
        revision = latest.revision + 1;
      } else {
        const creationKey = 'creationKey' in input ? input.creationKey : undefined;
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `question-set-create:${auth.authz.organizationId}:${auth.userId}:${creationKey}`,
        ]);
        const prior = (
          await c.query(
            'SELECT set_id,title,description,fields,sections FROM local_catalog_question_set_revision WHERE organization_id=$1 AND created_by=$2 AND creation_key=$3',
            [auth.authz.organizationId, auth.userId, creationKey],
          )
        ).rows[0];
        if (prior) {
          const { set_id: priorId, ...priorContent } = prior;
          if (fingerprint(priorContent) !== fingerprint(stored))
            throw Problems.conflict('同じ作成キーで別の質問セットは保存できません');
          return { id: priorId, revision: 1 };
        }
      }
      await c.query(
        'INSERT INTO local_catalog_question_set_revision(set_id,organization_id,revision,title,description,fields,sections,created_by,creation_key) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)',
        [
          setId,
          auth.authz.organizationId,
          revision,
          stored.title,
          stored.description,
          JSON.stringify(stored.fields),
          JSON.stringify(stored.sections),
          auth.userId,
          !id && 'creationKey' in input ? input.creationKey : null,
        ],
      );
      await recordAuditEvent(c, {
        eventType: 'catalog.question_set.saved',
        organizationId: auth.authz.organizationId,
        actorType: 'user',
        actorId: auth.userId,
        targetType: 'catalog_question_set',
        targetId: setId,
        action: 'catalog.question_set.saved',
        outcome: 'success',
        ...(revision > 1 ? { beforeState: { revision: revision - 1 } } : {}),
        afterState: { revision, fieldCount: stored.fields.length },
      });
      return { id: setId, revision };
    });
  }
}
