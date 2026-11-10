import type pg from 'pg';
import { z } from 'zod';
import { Problems } from '@solvi/shared';
import { hasRole, requireRole } from '../../common/authz/authz.js';
import { recordAuditEvent, uuidv7 } from '../../common/audit/audit.js';
import type { AuthenticatedRequest } from '../auth/auth.routes.js';
import {
  buildKnowledgeCountQuery,
  buildKnowledgePageQuery,
  buildKnowledgeNeighborsQuery,
  encodeKnowledgeCursor,
  knowledgeArticleSelect,
  knowledgeArticleFrom,
  parseKnowledgeListQuery,
  type KnowledgeAnchor,
} from './knowledge-query.js';

const contentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20000),
  tags: z.string().trim().max(500).default(''),
  audience: z.enum(['organization', 'staff']),
});
const updateSchema = contentSchema.extend({ expectedVersion: z.number().int().positive() });
const actionSchema = z.object({
  action: z.enum(['review', 'publish', 'retire', 'restore']),
  expectedVersion: z.number().int().positive(),
  restoreVersion: z.number().int().positive().optional(),
});
const idSchema = z.string().uuid();
type Article = {
  id: string;
  organization_id: string;
  state: string;
  version: number;
  published_version: number | null;
};
function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const r = schema.safeParse(input);
  if (!r.success)
    throw Problems.validation(
      r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    );
  return r.data;
}
function canEdit(auth: AuthenticatedRequest): boolean {
  return hasRole(auth.authz, 'agent', 'org_admin', 'platform_admin');
}
const select = (manage: boolean) => `${knowledgeArticleSelect(manage)} ${knowledgeArticleFrom}`;

export class KnowledgeController {
  constructor(private readonly pool: pg.Pool) {}
  private async run<T>(
    auth: AuthenticatedRequest,
    fn: (client: pg.PoolClient) => Promise<T>,
    readOnly = false,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
      await client.query("SELECT set_config('app.current_org', $1, true)", [
        auth.authz.organizationId,
      ]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
  private async lock(client: pg.PoolClient, id: string, organizationId: string): Promise<Article> {
    parse(idSchema, id);
    const r = await client.query<Article>(
      'SELECT * FROM knowledge_article WHERE id=$1 AND organization_id=$2 FOR UPDATE',
      [id, organizationId],
    );
    if (!r.rows[0]) throw Problems.notFound('記事');
    return r.rows[0];
  }
  private async audit(
    client: pg.PoolClient,
    auth: AuthenticatedRequest,
    id: string,
    action: 'created' | 'saved' | 'review' | 'restore' | 'published' | 'retired',
    version: number,
  ): Promise<void> {
    await recordAuditEvent(client, {
      eventType: `article.${action}`,
      organizationId: auth.authz.organizationId,
      actorType: 'user',
      actorId: auth.userId,
      targetType: 'knowledge_article',
      targetId: id,
      action: `article.${action}`,
      outcome: 'success',
      afterState: { version },
    });
  }
  async list(auth: AuthenticatedRequest, query: URLSearchParams) {
    const manage = query.get('manage') === '1';
    if (manage) requireRole(auth.authz, 'agent', 'org_admin', 'platform_admin');
    const scope = { organizationId: auth.authz.organizationId, staffVisible: canEdit(auth) };
    const options = parseKnowledgeListQuery(query, scope);
    return this.run(
      auth,
      async (client) => {
        const countQuery = buildKnowledgeCountQuery(options, scope);
        const count = (await client.query(countQuery.sql, countQuery.params)).rows[0]?.total;
        const total = Number(count);
        if (typeof count !== 'string' || !/^\d+$/.test(count) || !Number.isSafeInteger(total))
          throw new Error('KNOWLEDGE_COUNT_INVALID');
        const pageQuery = buildKnowledgePageQuery(options, scope);
        const rows = (await client.query(pageQuery.sql, pageQuery.params)).rows;
        if (options.cursor?.direction === 'previous') rows.reverse();
        let previousCursor: string | null = null,
          nextCursor: string | null = null;
        if (rows.length) {
          const anchor = (row: Record<string, unknown>): KnowledgeAnchor => ({
            titleMatch: row.__titleMatch as boolean,
            updatedAt: row.__updatedAt as string,
            id: row.id as string,
          });
          const first = anchor(rows[0]),
            last = anchor(rows[rows.length - 1]);
          const neighbors = buildKnowledgeNeighborsQuery(options, scope, first, last);
          const adjacent = (await client.query(neighbors.sql, neighbors.params)).rows[0];
          if (typeof adjacent?.previous !== 'boolean' || typeof adjacent?.next !== 'boolean')
            throw new Error('KNOWLEDGE_NEIGHBORS_INVALID');
          if (adjacent.previous) previousCursor = encodeKnowledgeCursor(options, first, 'previous');
          if (adjacent.next) nextCursor = encodeKnowledgeCursor(options, last, 'next');
        }
        const items = rows.map((row) => {
          const item = { ...row };
          delete item.__titleMatch;
          delete item.__updatedAt;
          return item;
        });
        return { items, total, previousCursor, nextCursor };
      },
      true,
    );
  }
  async detail(auth: AuthenticatedRequest, id: string, manage: boolean) {
    parse(idSchema, id);
    if (manage) requireRole(auth.authz, 'agent', 'org_admin', 'platform_admin');
    return this.run(auth, async (client) => {
      const visible = manage
        ? 'v.number=a.version'
        : `v.number=a.published_version AND a.state <> 'retired' AND (v.audience='organization' OR $3)`;
      const r = await client.query(
        `${select(manage)} WHERE a.id=$1 AND a.organization_id=$2 AND ${visible}`,
        manage ? [id, auth.authz.organizationId] : [id, auth.authz.organizationId, canEdit(auth)],
      );
      if (!r.rows[0]) throw Problems.notFound('記事');
      const versions = manage
        ? (
            await client.query(
              'SELECT number, title, created_at AS "createdAt" FROM knowledge_version WHERE article_id=$1 ORDER BY number DESC',
              [id],
            )
          ).rows
        : [];
      return { article: r.rows[0], versions };
    });
  }
  async create(auth: AuthenticatedRequest, input: unknown) {
    requireRole(auth.authz, 'agent', 'org_admin', 'platform_admin');
    const c = parse(contentSchema, input);
    return this.run(auth, async (client) => {
      const id = uuidv7();
      await client.query(
        "INSERT INTO knowledge_article(id,organization_id,state,version,created_by) VALUES($1,$2,'draft',1,$3)",
        [id, auth.authz.organizationId, auth.userId],
      );
      await this.insertVersion(client, auth, id, 1, c);
      await this.audit(client, auth, id, 'created', 1);
      return { id, version: 1 };
    });
  }
  private async insertVersion(
    client: pg.PoolClient,
    auth: AuthenticatedRequest,
    id: string,
    version: number,
    c: z.infer<typeof contentSchema>,
  ): Promise<void> {
    await client.query(
      'INSERT INTO knowledge_version(article_id,organization_id,number,title,body,tags,audience,author_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, auth.authz.organizationId, version, c.title, c.body, c.tags, c.audience, auth.userId],
    );
  }
  async save(auth: AuthenticatedRequest, id: string, input: unknown) {
    requireRole(auth.authz, 'agent', 'org_admin', 'platform_admin');
    const c = parse(updateSchema, input);
    return this.run(auth, async (client) => {
      const a = await this.lock(client, id, auth.authz.organizationId);
      if (a.version !== c.expectedVersion) throw Problems.stale('記事');
      if (a.state === 'retired')
        throw Problems.conflict('取り下げ済みの記事は過去版から下書きに戻してください');
      const version = a.version + 1;
      await this.insertVersion(client, auth, id, version, c);
      await client.query(
        "UPDATE knowledge_article SET version=$2,state='draft',updated_at=now() WHERE id=$1",
        [id, version],
      );
      await this.audit(client, auth, id, 'saved', version);
      return { id, version };
    });
  }
  async action(auth: AuthenticatedRequest, id: string, input: unknown) {
    requireRole(auth.authz, 'agent', 'org_admin', 'platform_admin');
    const c = parse(actionSchema, input);
    return this.run(auth, async (client) => {
      const a = await this.lock(client, id, auth.authz.organizationId);
      if (a.version !== c.expectedVersion) throw Problems.stale('記事');
      if (c.action === 'publish' || c.action === 'retire')
        requireRole(auth.authz, 'org_admin', 'platform_admin');
      let version = a.version;
      if (c.action === 'restore') {
        if (!c.restoreVersion)
          throw Problems.validation([
            { field: 'restoreVersion', message: '復元する版を指定してください' },
          ]);
        const old = await client.query(
          'SELECT title,body,tags,audience FROM knowledge_version WHERE article_id=$1 AND number=$2',
          [id, c.restoreVersion],
        );
        if (!old.rows[0]) throw Problems.notFound('記事の版');
        version += 1;
        await this.insertVersion(client, auth, id, version, old.rows[0]);
      } else if (
        (c.action === 'review' && a.state !== 'draft') ||
        (c.action === 'publish' && a.state !== 'review') ||
        (c.action === 'retire' && !a.published_version)
      ) {
        throw Problems.conflict('現在の状態ではこの操作を行えません');
      }
      const state = { review: 'review', publish: 'published', retire: 'retired', restore: 'draft' }[
        c.action
      ];
      // A lifecycle change invalidates optimistic versions too: create a new immutable
      // snapshot to prevent a stale editor saving through a concurrent publication.
      if (c.action !== 'restore') {
        const current = await client.query(
          'SELECT title,body,tags,audience FROM knowledge_version WHERE article_id=$1 AND number=$2',
          [id, a.version],
        );
        version += 1;
        await this.insertVersion(client, auth, id, version, current.rows[0]);
      }
      await client.query(
        'UPDATE knowledge_article SET version=$2,state=$3,published_version=$4,updated_at=now() WHERE id=$1',
        [
          id,
          version,
          state,
          c.action === 'publish'
            ? version
            : a.state === 'retired' && c.action === 'restore'
              ? null
              : a.published_version,
        ],
      );
      await this.audit(
        client,
        auth,
        id,
        c.action === 'publish' ? 'published' : c.action === 'retire' ? 'retired' : c.action,
        version,
      );
      return { id, version, state };
    });
  }
}
