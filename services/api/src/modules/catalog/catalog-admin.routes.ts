import type pg from 'pg';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { Problems } from '@solvi/shared';
import { requireRole } from '../../common/authz/authz.js';
import { recordAuditEvent, uuidv7 } from '../../common/audit/audit.js';
import type { AuthenticatedRequest } from '../auth/auth.routes.js';
import { definitionSchema } from './catalog-definition.js';
const content = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(2000),
    definition: definitionSchema.refine((d) => Boolean(d.approval), '固定承認者を設定してください'),
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
function parse<T extends z.ZodTypeAny>(s: T, v: unknown): z.output<T> {
  const r = s.safeParse(v);
  if (!r.success)
    throw Problems.validation(
      r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    );
  return r.data;
}
const approversSql = `SELECT DISTINCT u.id,u.display_name AS name FROM app_user u JOIN role_binding rb ON rb.user_id=u.id JOIN role r ON r.id=rb.role_id WHERE rb.organization_id=$1 AND r.code='approver' AND u.status='active' AND rb.valid_from<=clock_timestamp() AND (rb.valid_until IS NULL OR rb.valid_until>clock_timestamp()) ORDER BY name,u.id`;
export class CatalogAdminController {
  constructor(
    private readonly pool: pg.Pool,
    private readonly enabled: boolean,
  ) {}
  private async run<T>(auth: AuthenticatedRequest, fn: (c: pg.PoolClient) => Promise<T>) {
    if (!this.enabled) throw Problems.notFound('ローカルカタログ管理');
    requireRole(auth.authz, 'org_admin', 'platform_admin');
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
  private async approver(c: pg.PoolClient, org: string, id: string) {
    if (!(await c.query(approversSql, [org])).rows.some((a) => a.id === id))
      throw Problems.validation([
        {
          field: 'definition.approval.approverId',
          message: '現在有効な同じ組織の承認者を設定してください',
        },
      ]);
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
    return this.run(auth, async (c) => ({
      items: (
        await c.query(
          `SELECT i.id,i.code,i.edit_version AS "editVersion",i.draft_revision AS "draftRevision",i.published_revision AS "publishedRevision",i.active,r.title,r.description FROM local_catalog_item i JOIN local_catalog_revision r ON r.item_id=i.id AND r.organization_id=i.organization_id AND r.revision=i.draft_revision WHERE i.organization_id=$1 ORDER BY i.code`,
          [auth.authz.organizationId],
        )
      ).rows,
      approvers: (await c.query(approversSql, [auth.authz.organizationId])).rows,
    }));
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
      return {
        id: i.id,
        code: i.code,
        editVersion: i.edit_version,
        active: i.active,
        publishedRevision: i.published_revision,
        draft: revisions.find((r) => r.revision === i.draft_revision),
        published: revisions.find((r) => r.revision === i.published_revision) ?? null,
        history: revisions.map(({ revision, title, createdAt }) => ({
          revision,
          title,
          createdAt,
        })),
        approvers: (await c.query(approversSql, [auth.authz.organizationId])).rows,
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
      await this.approver(c, auth.authz.organizationId, v.definition.approval!.approverId);
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
      if (i.edit_version !== v.expectedVersion) throw Problems.stale('カタログ');
      await this.approver(c, auth.authz.organizationId, v.definition.approval!.approverId);
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
            { field: 'approval', message: '下書きを編集して固定承認者を設定してください' },
          ]);
        await this.approver(c, auth.authz.organizationId, d.approval.approverId);
        await c.query(
          'UPDATE local_catalog_item SET version=$2,title=$3,description=$4,definition=$5,published_revision=$2,active=true,edit_version=edit_version+1 WHERE id=$1',
          [id, r.revision, r.title, r.description, d],
        );
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
}
