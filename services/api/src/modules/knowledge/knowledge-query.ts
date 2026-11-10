import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Problems } from '@solvi/shared';

export interface KnowledgeListScope {
  organizationId: string;
  staffVisible: boolean;
}
export interface KnowledgeAnchor {
  titleMatch: boolean;
  updatedAt: string;
  id: string;
}
export interface KnowledgeListOptions {
  q: string;
  manage: boolean;
  limit: number;
  digest: string;
  cursor: (KnowledgeAnchor & { direction: 'next' | 'previous' }) | null;
}
export interface KnowledgeSql {
  sql: string;
  params: unknown[];
}

// A fixed tuple fits the existing returnTo bound even with 200 Japanese characters.
// Its digest binds conditions; it never authorizes access.
export const KNOWLEDGE_CURSOR_MAX_LENGTH = 168;
function validTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{6}Z$/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    year > 0 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1]! &&
    hour < 24 &&
    minute < 60 &&
    second < 60
  );
}
const cursorSchema = z.tuple([
  z.literal(1),
  z.union([z.literal(0), z.literal(1)]),
  z.boolean(),
  z.string().refine(validTimestamp),
  z.string().uuid(),
  z.string().regex(/^[A-Za-z0-9_-]{43}$/),
]);
function invalid(field: string): never {
  throw Problems.validation([
    { field, message: '検索条件が不正です。先頭から検索し直してください' },
  ]);
}

export function parseKnowledgeListQuery(
  query: URLSearchParams,
  scope: KnowledgeListScope,
): KnowledgeListOptions {
  for (const key of ['limit', 'cursor']) if (query.getAll(key).length > 1) invalid(key);
  const rawLimit = query.get('limit');
  if (rawLimit !== null && !/^(?:[1-9]\d?|100)$/.test(rawLimit)) invalid('limit');
  const limit = rawLimit === null ? 100 : Number(rawLimit);
  const q = (query.get('q') ?? '').trim().slice(0, 200);
  const manage = query.get('manage') === '1';
  const digest = createHash('sha256')
    .update(JSON.stringify([q, manage, scope.organizationId, scope.staffVisible, limit]))
    .digest('base64url');
  const options: KnowledgeListOptions = { q, manage, limit, digest, cursor: null };
  const raw = query.get('cursor');
  if (raw === null) return options;
  if (!raw || raw.length > KNOWLEDGE_CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(raw))
    invalid('cursor');
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    invalid('cursor');
  }
  const parsed = cursorSchema.safeParse(decoded);
  if (!parsed.success) invalid('cursor');
  const tuple = parsed.data;
  if (Buffer.from(JSON.stringify(tuple)).toString('base64url') !== raw || tuple[5] !== digest)
    invalid('cursor');
  options.cursor = {
    direction: tuple[1] === 0 ? 'next' : 'previous',
    titleMatch: tuple[2],
    updatedAt: tuple[3],
    id: tuple[4],
  };
  return options;
}

export function encodeKnowledgeCursor(
  options: KnowledgeListOptions,
  anchor: KnowledgeAnchor,
  direction: 'next' | 'previous',
): string {
  const tuple = cursorSchema.parse([
    1,
    direction === 'next' ? 0 : 1,
    anchor.titleMatch,
    anchor.updatedAt,
    anchor.id,
    options.digest,
  ]);
  return Buffer.from(JSON.stringify(tuple)).toString('base64url');
}

export const knowledgeArticleSelect = (
  manage: boolean,
) => `SELECT a.id, ${manage ? 'a.state, a.version' : "'published' AS state, v.number AS version"}, a.published_version AS "publishedVersion",
  v.number AS "contentVersion", v.title, v.body, v.tags, v.audience, v.created_at AS "versionCreatedAt"`;
export const knowledgeArticleFrom =
  'FROM knowledge_article a JOIN knowledge_version v ON v.article_id=a.id AND v.organization_id=a.organization_id';

function base(options: KnowledgeListOptions, scope: KnowledgeListScope): KnowledgeSql {
  const pattern = `%${options.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const params: unknown[] = [pattern, scope.organizationId];
  const visible = options.manage
    ? 'v.number=a.version'
    : `v.number=a.published_version AND a.state <> 'retired' AND (v.audience='organization' OR $3)`;
  if (!options.manage) params.push(scope.staffVisible);
  return {
    sql: `${knowledgeArticleFrom} WHERE a.organization_id=$2 AND ${visible} AND (v.title ILIKE $1 OR v.body ILIKE $1 OR v.tags ILIKE $1)`,
    params,
  };
}
const orderKey = '(v.title ILIKE $1, a.updated_at, a.id)';
function boundary(params: unknown[], anchor: KnowledgeAnchor): string {
  const offset = params.length;
  params.push(anchor.titleMatch, anchor.updatedAt, anchor.id);
  return `($${offset + 1}::boolean, $${offset + 2}::timestamptz, $${offset + 3}::uuid)`;
}
export function buildKnowledgeCountQuery(
  options: KnowledgeListOptions,
  scope: KnowledgeListScope,
): KnowledgeSql {
  const query = base(options, scope);
  return { sql: `SELECT count(*)::text AS total ${query.sql}`, params: query.params };
}
export function buildKnowledgePageQuery(
  options: KnowledgeListOptions,
  scope: KnowledgeListScope,
): KnowledgeSql {
  const query = base(options, scope);
  let filter = '';
  if (options.cursor)
    filter = ` AND ${orderKey} ${options.cursor.direction === 'next' ? '<' : '>'} ${boundary(query.params, options.cursor)}`;
  const direction = options.cursor?.direction === 'previous' ? 'ASC' : 'DESC';
  query.params.push(options.limit);
  return {
    sql: `${knowledgeArticleSelect(options.manage)}, (v.title ILIKE $1) AS "__titleMatch", to_char(a.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "__updatedAt" ${query.sql}${filter} ORDER BY (v.title ILIKE $1) ${direction}, a.updated_at ${direction}, a.id ${direction} LIMIT $${query.params.length}`,
    params: query.params,
  };
}
export function buildKnowledgeNeighborsQuery(
  options: KnowledgeListOptions,
  scope: KnowledgeListScope,
  first: KnowledgeAnchor,
  last: KnowledgeAnchor,
): KnowledgeSql {
  const query = base(options, scope);
  const before = boundary(query.params, first),
    after = boundary(query.params, last);
  return {
    sql: `SELECT EXISTS(SELECT 1 ${query.sql} AND ${orderKey} > ${before}) AS previous, EXISTS(SELECT 1 ${query.sql} AND ${orderKey} < ${after}) AS next`,
    params: query.params,
  };
}
