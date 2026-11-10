import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { sanitizeExplain, sanitizeReadOnlyProof } from './list-query-analysis.mjs';
import { normalizeSearchCombinedRows } from './search-cost-analysis.mjs';
import { compareSearchResults } from './search-analysis.mjs';

const check = (value, code) => {
  if (!value) throw new Error(code);
};
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ACTORS = [
  'agent',
  'requester',
  'other-requester',
  'foreign',
  'deactivated',
  'expired',
  'revoked',
];
const CONTEXTS = [...ACTORS, 'actor-missing'];
const FAILURES = new Set([
  'STATIC_ABORTED',
  'STATIC_TIME_LIMIT',
  'STATIC_RUNTIME_REQUIRED',
  'STATIC_FIXTURE_INVALID',
  'STATIC_CORPUS_INVALID',
  'STATIC_CATALOG_INVALID',
  'STATIC_PATTERN_INVALID',
  'STATIC_TOKEN_INVALID',
  'STATIC_QUERY_INVALID',
  'STATIC_RESULT_INVALID',
  'STATIC_EQUIVALENCE_FAILED',
  'STATIC_PLAN_INVALID',
  'STATIC_INDEX_NOT_PROVEN',
  'STATIC_RLS_FAILED',
  'STATIC_PROTOCOL_FAILED',
  'QUERY_PLAN_INVALID',
  'QUERY_READ_ONLY_PROOF_INVALID',
  'SEARCH_COST_RESULT_INVALID',
  'DEADLINE_RESULT_INVALID',
]);

/** Match the existing builder's JS trim and literal ILIKE escaping exactly. */
export function escapeStaticKeyword(keyword) {
  check(typeof keyword === 'string', 'STATIC_PATTERN_INVALID');
  const trimmed = keyword.trim();
  return trimmed ? `%${trimmed.replace(/([%_\\])/g, '\\$1')}%` : null;
}

/** Input is the complete pattern already folded by PostgreSQL, never by JavaScript. */
export function parseStaticPattern(pattern) {
  if (pattern === null) return { eligible: false, literal: null, reason: 'empty' };
  if (
    typeof pattern !== 'string' ||
    pattern.length < 2 ||
    !pattern.startsWith('%') ||
    !pattern.endsWith('%')
  )
    return { eligible: false, literal: null, reason: 'grammar' };
  const characters = Array.from(pattern);
  let literal = '';
  for (let i = 1; i < characters.length - 1; i++) {
    const character = characters[i];
    if (character === '\\') {
      const escaped = characters[++i];
      if (i >= characters.length - 1 || !['%', '_', '\\'].includes(escaped))
        return { eligible: false, literal: null, reason: 'grammar' };
      literal += escaped;
    } else {
      if (
        character === '%' ||
        character === '_' ||
        character === '\u0000' ||
        /^[\ud800-\udfff]$/.test(character)
      )
        return { eligible: false, literal: null, reason: 'grammar' };
      literal += character;
    }
  }
  // PostgreSQL decides length and substring positions; no JS slicing or case folding.
  return { eligible: true, literal, reason: 'literal' };
}

const TOKEN_SQL = `SELECT DISTINCT convert_to(substr($1::text,
  CASE WHEN selection.k=1 THEN 1
       ELSE floor(position.i::numeric*(selection.n-1)/(selection.k-1))::int+1 END,3),'UTF8') AS token
  FROM (SELECT char_length($1::text)-2 AS n, least(8,char_length($1::text)-2) AS k) selection
  CROSS JOIN LATERAL generate_series(0,selection.k-1) position(i)
  WHERE selection.n>0 ORDER BY token`;

async function preprocess(client, keyword) {
  const started = performance.now();
  const pattern = escapeStaticKeyword(keyword);
  if (pattern === null)
    return {
      pattern,
      tokens: [],
      eligible: false,
      reason: 'empty',
      durationMs: performance.now() - started,
    };
  const folded = await client.query('SELECT lower($1::text) AS pattern', [pattern]);
  check(
    folded.rows.length === 1 && typeof folded.rows[0].pattern === 'string',
    'STATIC_PATTERN_INVALID',
  );
  const parsed = parseStaticPattern(folded.rows[0].pattern);
  if (!parsed.eligible)
    return {
      pattern,
      tokens: [],
      eligible: false,
      reason: parsed.reason,
      durationMs: performance.now() - started,
    };
  const result = await client.query(TOKEN_SQL, [parsed.literal]);
  const tokens = result.rows.map((row) => row.token);
  check(
    tokens.length <= 8 && tokens.every((token) => Buffer.isBuffer(token) && token.length > 0),
    'STATIC_TOKEN_INVALID',
  );
  check(
    new Set(tokens.map((token) => token.toString('hex'))).size === tokens.length,
    'STATIC_TOKEN_INVALID',
  );
  return {
    pattern,
    tokens,
    eligible: tokens.length > 0,
    reason: tokens.length ? 'literal' : 'short',
    durationMs: performance.now() - started,
  };
}

const CATALOG_SQL = `SELECT current_setting('server_version_num')::int AS version,
  pg_encoding_to_char(d.encoding)='UTF8' AS utf8,
  d.datlocprovider='i' AS icu, d.daticulocale='ja-JP' AS locale,
  d.datcollversion IS NOT NULL AND pg_database_collation_actual_version(d.oid) IS NOT NULL
    AND d.datcollversion=pg_database_collation_actual_version(d.oid) AS version_matches,
  md5(d.datcollversion) AS version_hash, c.collisdeterministic AS deterministic,
  a.attcollation='pg_catalog."default"'::regcollation AS default_collation,
  a.attgenerated='s' AS generated, b.atttypid='bytea'::regtype AND b.attcollation=0 AS bytea_token,
  p.relrowsecurity AS posting_rls, p.relforcerowsecurity AS posting_force_rls,
  row_security_active(p.oid) AS posting_rls_active,
  p.relowner<>(SELECT oid FROM pg_roles WHERE rolname=current_user) AS posting_nonowner,
  has_table_privilege(current_user,p.oid,'SELECT') AS posting_select,
  NOT has_table_privilege(current_user,p.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS posting_select_only,
  i.indisvalid AND i.indisready AND i.indislive AND i.indisunique AND i.indnkeyatts=4
    AND i.indexprs IS NULL AND i.indpred IS NULL AND am.amname='btree'
    AND i.indkey[0]=(SELECT attnum FROM pg_attribute WHERE attrelid=p.oid AND attname='organization_id')
    AND i.indkey[1]=(SELECT attnum FROM pg_attribute WHERE attrelid=p.oid AND attname='generation')
    AND i.indkey[2]=b.attnum
    AND i.indkey[3]=(SELECT attnum FROM pg_attribute WHERE attrelid=p.oid AND attname='ticket_id') AS posting_index,
  coalesce(current_setting('app.autoclose',true),'')<>'on' AS autoclose_disabled,
  current_setting('enable_seqscan')='on' AS seqscan_enabled
  FROM pg_database d
  JOIN pg_collation c ON c.oid='pg_catalog."default"'::regcollation
  JOIN pg_attribute a ON a.attrelid='public.ticket'::regclass AND a.attname='search_text' AND NOT a.attisdropped
  JOIN pg_class p ON p.oid='perf053.search_posting'::regclass
  JOIN pg_attribute b ON b.attrelid=p.oid AND b.attname='token' AND NOT b.attisdropped
  JOIN pg_index i ON i.indexrelid='perf053.search_posting_token_idx'::regclass AND i.indrelid=p.oid
  JOIN pg_class x ON x.oid=i.indexrelid JOIN pg_am am ON am.oid=x.relam
  WHERE d.datname=current_database()`;
const CATALOG_BOOLS = [
  'utf8',
  'icu',
  'locale',
  'version_matches',
  'deterministic',
  'default_collation',
  'generated',
  'bytea_token',
  'posting_rls',
  'posting_force_rls',
  'posting_rls_active',
  'posting_nonowner',
  'posting_select',
  'posting_select_only',
  'posting_index',
  'autoclose_disabled',
  'seqscan_enabled',
];

export function sanitizeStaticCatalog(rows) {
  check(Array.isArray(rows) && rows.length === 1, 'STATIC_CATALOG_INVALID');
  const row = rows[0];
  check(
    row && row.version === 160006 && /^[a-f0-9]{32}$/.test(row.version_hash),
    'STATIC_CATALOG_INVALID',
  );
  check(
    CATALOG_BOOLS.every((name) => row[name] === true),
    'STATIC_CATALOG_INVALID',
  );
  return {
    version: 160006,
    collationVersionHash: row.version_hash,
    ...Object.fromEntries(CATALOG_BOOLS.map((name) => [name, true])),
  };
}

/** Wrap the unchanged compiled statement; the original auth/filter/count remain inside. */
export function buildStaticStatement(built, options, organizationId, tokens = []) {
  check(
    built &&
      typeof built.sql === 'string' &&
      typeof built.countSql === 'string' &&
      Array.isArray(built.params) &&
      Array.isArray(built.countParams) &&
      integer(built.limit) &&
      built.limit >= 1 &&
      built.limit <= 200 &&
      UUID.test(organizationId) &&
      Array.isArray(tokens) &&
      tokens.length <= 8 &&
      tokens.every((token) => Buffer.isBuffer(token) && token.length > 0) &&
      new Set(tokens.map((token) => token.toString('hex'))).size === tokens.length,
    'STATIC_QUERY_INVALID',
  );
  check(
    isDeepStrictEqual(built.params.slice(0, built.countParams.length), built.countParams),
    'STATIC_QUERY_INVALID',
  );
  const column = options.sort?.column ?? 'created_at';
  const direction = options.sort?.direction ?? 'desc';
  check(
    ['created_at', 'deadline'].includes(column) && ['asc', 'desc'].includes(direction),
    'STATIC_QUERY_INVALID',
  );
  const order = `${column === 'deadline' ? 'remaining_seconds' : 'created_at'} ${direction.toUpperCase()}${column === 'deadline' ? ' NULLS LAST' : ''}, id ${direction.toUpperCase()}`;
  const base =
    built.combinedSql ??
    `SELECT static_page.*, static_count.total AS __solvi_total
    FROM (${built.countSql}) static_count LEFT JOIN LATERAL (${built.sql}) static_page ON true
    ORDER BY ${order}`;
  check(
    typeof base === 'string' &&
      /^\s*SELECT\b/i.test(base) &&
      !base.includes(';') &&
      !/\bperf053\b/i.test(base),
    'STATIC_QUERY_INVALID',
  );
  const params = [...built.params];
  let sql = `SELECT * FROM (${base}) static_result`;
  if (tokens.length) {
    const org = params.push(organizationId);
    const token = params.push(tokens);
    sql = `SELECT * FROM (WITH static_candidates AS MATERIALIZED (
      SELECT posting.ticket_id FROM perf053.search_posting posting
      WHERE posting.organization_id=$${org}::uuid AND posting.generation=1
        AND posting.token=ANY($${token}::bytea[])
      GROUP BY posting.ticket_id HAVING count(*)=cardinality($${token}::bytea[])
    ), ticket AS NOT MATERIALIZED (
      SELECT source.* FROM public.ticket source JOIN static_candidates candidate ON candidate.ticket_id=source.id
      WHERE source.organization_id=$${org}::uuid
    ) ${base}) static_result`;
  }
  // An outer order is explicit: relying on the ordering of a nested SELECT is unsafe.
  sql += ` ORDER BY ${order}`;
  const positions = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
  check(
    Math.max(...positions) === params.length &&
      params.every((_, index) => positions.includes(index + 1)),
    'STATIC_QUERY_INVALID',
  );
  return { sql, params, limit: built.limit, candidateUsed: tokens.length > 0, sqlHash: hash(sql) };
}

const INDEXES = new Set([
  'search_posting_token_idx',
  'ticket_pkey',
  'ticket_id_org_asset_key',
  'ticket_number_key',
  'ticket_list_org_idx',
  'ticket_list_state_idx',
  'ticket_org_state_idx',
  'ticket_search_trgm_idx',
  'ticket_list_requester_idx',
  'ticket_requester_idx',
  'ticket_list_assignee_idx',
  'ticket_assignee_idx',
  'ticket_subject_trgm_idx',
  'ticket_number_pattern_idx',
  'ticket_group_queue_idx',
  'app_user_pkey',
  'assignment_group_pkey',
  'assignment_group_code_key',
  'sla_policy_pkey',
  'sla_policy_org_priority_key',
  'role_binding_user_idx',
  'role_binding_org_idx',
  'role_binding_pkey',
  'role_binding_active_key',
  'role_pkey',
  'role_code_key',
  'role_id_scope_key',
  'organization_pkey',
]);
const RELATIONS = new Set([
  'search_posting',
  'ticket',
  'app_user',
  'assignment_group',
  'sla_policy',
  'role_binding',
  'role',
  'organization',
]);
const CTES = new Set([
  'static_candidates',
  'ticket',
  'probe_keys',
  'probe_evaluation',
  'probe_status',
  'matched',
  'counted',
  'selected_keys',
  'page',
]);
const PARENTS = new Set(['Outer', 'Inner', 'InitPlan', 'SubPlan', 'Member', 'Subquery']);

/** Keep allowlisted identifiers and physical numbers, never expressions or tokens. */
export function summarizeStaticPlan(document) {
  check(
    Array.isArray(document) && document.length === 1 && document[0]?.Plan,
    'STATIC_PLAN_INVALID',
  );
  const postingScans = [];
  const ticketScans = [];
  let nodes = 0;
  const walk = (node, depth) => {
    check(node && depth <= 64 && ++nodes <= 512, 'STATIC_PLAN_INVALID');
    for (const [field, allowed] of [
      ['Index Name', INDEXES],
      ['Relation Name', RELATIONS],
      ['CTE Name', CTES],
      ['Parent Relationship', PARENTS],
    ])
      check(node[field] === undefined || allowed.has(node[field]), 'STATIC_PLAN_INVALID');
    if (node['Schema'] !== undefined)
      check(['public', 'perf053'].includes(node.Schema), 'STATIC_PLAN_INVALID');
    if (
      node['Relation Name'] === 'search_posting' ||
      node['Index Name'] === 'search_posting_token_idx' ||
      node['Relation Name'] === 'ticket'
    ) {
      const rows = node['Actual Rows'];
      const loops = node['Actual Loops'];
      const removed = node['Rows Removed by Filter'] ?? 0;
      const rechecked = node['Rows Removed by Index Recheck'] ?? 0;
      check(
        [rows, loops, removed, rechecked].every((value) => Number.isFinite(value) && value >= 0),
        'STATIC_PLAN_INVALID',
      );
      const scan = {
        nodeType: node['Node Type'],
        indexName: node['Index Name'] ?? null,
        rows,
        loops,
        returnedRows: rows * loops,
        visitedRows: (rows + removed + rechecked) * loops,
        tokenEquality:
          typeof node['Index Cond'] === 'string' &&
          /\btoken\s*=\s*(?:ANY\s*\(|\$|')/.test(node['Index Cond']),
        uniqueIdLookup:
          ['Index Scan', 'Index Only Scan'].includes(node['Node Type']) &&
          ['ticket_pkey', 'ticket_id_org_asset_key'].includes(node['Index Name']) &&
          typeof node['Index Cond'] === 'string' &&
          /\bid\s*=/.test(node['Index Cond']),
      };
      if (node['Relation Name'] === 'ticket') ticketScans.push(scan);
      else postingScans.push(scan);
    }
    check(node.Plans === undefined || Array.isArray(node.Plans), 'STATIC_PLAN_INVALID');
    for (const child of node.Plans ?? []) walk(child, depth + 1);
  };
  walk(document[0].Plan, 0);
  const plan = sanitizeExplain(document);
  const root = document[0].Plan;
  const buffers = Object.fromEntries(
    ['Shared Hit Blocks', 'Shared Read Blocks', 'Temp Read Blocks', 'Temp Written Blocks'].map(
      (name) => {
        const value = root[name] ?? 0;
        check(integer(value), 'STATIC_PLAN_INVALID');
        return [name, value];
      },
    ),
  );
  return {
    plan,
    rootBuffers: buffers,
    postingScans,
    ticketScans,
    postingIndexExecuted: postingScans.some(
      (scan) =>
        scan.indexName === 'search_posting_token_idx' &&
        ['Index Scan', 'Index Only Scan', 'Bitmap Index Scan'].includes(scan.nodeType) &&
        scan.loops > 0 &&
        scan.tokenEquality,
    ),
    postingVisitedRows: postingScans.reduce((sum, scan) => sum + scan.visitedRows, 0),
    ticketVisitedRows: ticketScans.reduce((sum, scan) => sum + scan.visitedRows, 0),
  };
}

/** Each executed ticket lookup must be bounded by the already selected candidate IDs. */
export function proveStaticNarrowing(plan, candidateIds) {
  check(
    integer(candidateIds) && candidateIds <= 4096 && Array.isArray(plan?.ticketScans),
    'STATIC_PLAN_INVALID',
  );
  return (
    plan.ticketScans.length > 0 &&
    plan.ticketScans.every(
      (scan) =>
        scan.loops === 0 ||
        (scan.uniqueIdLookup && scan.loops <= candidateIds && scan.visitedRows <= candidateIds),
    )
  );
}

const PROJECTION_SQL = `SELECT corpus.ordinality::int AS position,
  CASE WHEN $2::text IS NULL THEN true ELSE corpus.document ILIKE $2::text END AS oracle,
  CASE WHEN cardinality($3::bytea[])=0 THEN true ELSE NOT EXISTS (
    SELECT 1 FROM unnest($3::bytea[]) selected(token) WHERE NOT EXISTS (
      SELECT 1 FROM generate_series(1,char_length(lower(corpus.document))-2) position(n)
      WHERE convert_to(substr(lower(corpus.document),position.n,3),'UTF8')=selected.token
    )) END AS candidate
  FROM unnest($1::text[]) WITH ORDINALITY corpus(document,ordinality) ORDER BY corpus.ordinality`;

export function compareStaticProjection(rows, expectedRows, requiredCandidate, usedCandidate) {
  check(Array.isArray(rows) && rows.length === expectedRows, 'STATIC_RESULT_INVALID');
  let trueRows = 0;
  let nullRows = 0;
  let falseNegatives = 0;
  let mismatches = 0;
  rows.forEach((row, index) => {
    check(
      row.position === index + 1 &&
        [true, false, null].includes(row.oracle) &&
        typeof row.candidate === 'boolean',
      'STATIC_RESULT_INVALID',
    );
    trueRows += Number(row.oracle === true);
    nullRows += Number(row.oracle === null);
    falseNegatives += Number(row.oracle === true && !row.candidate);
    const reevaluated = row.oracle === null ? null : row.candidate ? row.oracle : false;
    mismatches += Number(reevaluated !== row.oracle);
  });
  return {
    pairs: rows.length,
    trueRows,
    nullRows,
    falseNegatives,
    mismatches,
    candidateUsed: usedCandidate,
    requiredCandidate,
    equal: falseNegatives === 0 && mismatches === 0 && (!requiredCandidate || usedCandidate),
  };
}

function validateFixture(fixture, corpus) {
  check(
    fixture &&
      UUID.test(fixture.organizationId) &&
      UUID.test(fixture.controlOrganizationId) &&
      fixture.organizationId !== fixture.controlOrganizationId &&
      Array.isArray(fixture.groups) &&
      fixture.groups.length === 2 &&
      fixture.groups.every((id) => UUID.test(id)),
    'STATIC_FIXTURE_INVALID',
  );
  for (const key of ACTORS) {
    const actor = fixture.actors?.[key];
    check(
      actor &&
        UUID.test(actor.userId) &&
        actor.context?.principal?.userId === actor.userId &&
        UUID.test(actor.context.organizationId) &&
        actor.context.now instanceof Date &&
        Number.isFinite(actor.context.now.getTime()),
      'STATIC_FIXTURE_INVALID',
    );
  }
  const stringOrNull = (value) => value === null || typeof value === 'string';
  check(
    corpus &&
      Array.isArray(corpus.documents) &&
      corpus.documents.length === 32 &&
      corpus.documents.every(stringOrNull) &&
      Array.isArray(corpus.keywords) &&
      corpus.keywords.length === 32 &&
      corpus.keywords.every((value) => typeof value === 'string') &&
      Array.isArray(corpus.additionalPairs) &&
      corpus.additionalPairs.length === 10 &&
      corpus.additionalPairs.every(
        (pair) => typeof pair.document === 'string' && typeof pair.keyword === 'string',
      ),
    'STATIC_CORPUS_INVALID',
  );
}

/** A1 projections and A2 stored posting are distinct evidence; neither adopts B1/B2. */
export async function analyzeSearchStatic({
  withReadOnly,
  buildTicketListQuery,
  fixture,
  corpus,
  signal,
  onProgress,
}) {
  const started = performance.now();
  const report = {
    completed: false,
    equivalent: false,
    protocolCompleted: false,
    catalogComplete: false,
    indexProofComplete: false,
    authorizationAdoption: false,
    adoptionEstablished: false,
    corpus: { matrixPairs: 0, additionalPairs: 0, boundaryPairs: 0, cases: [] },
    nativeCases: [],
    boundaries: [],
    plans: [],
    readOnlyContexts: [],
    elapsedMs: 0,
  };
  const progress = (stage) => onProgress?.(stage);
  const budget = () => {
    check(!signal?.aborted, 'STATIC_ABORTED');
    check(performance.now() - started < 600000, 'STATIC_TIME_LIMIT');
  };
  const read = (key, stage, callback) =>
    withReadOnly(key, async (client) => {
      budget();
      const proof = sanitizeReadOnlyProof(client.proof);
      const guard = await client.query(
        "SELECT coalesce(current_setting('app.autoclose',true),'')<>'on' AS disabled",
      );
      check(guard.rows.length === 1 && guard.rows[0].disabled === true, 'STATIC_RLS_FAILED');
      report.readOnlyContexts.push({ key, stage, proof, autocloseDisabled: true });
      return callback({
        query: async (sql, params = []) => {
          budget();
          const value = await client.query(sql, params);
          budget();
          return value;
        },
      });
    });
  try {
    check(
      typeof withReadOnly === 'function' && typeof buildTicketListQuery === 'function',
      'STATIC_RUNTIME_REQUIRED',
    );
    validateFixture(fixture, corpus);
    progress('static-start');
    await read('agent', 'catalog', async (client) => {
      report.catalog = sanitizeStaticCatalog((await client.query(CATALOG_SQL)).rows);
      report.catalogComplete = true;
    });
    progress('static-catalog');
    await read('requester', 'corpus', async (client) => {
      const compare = async (label, documents, keyword, required, kind) => {
        const entry = { label, kind, completed: false };
        report.corpus.cases.push(entry);
        const prepared = await preprocess(client, keyword);
        entry.tokenCount = prepared.tokens.length;
        entry.preprocessingMs = prepared.durationMs;
        entry.fallback = prepared.reason;
        entry.comparison = compareStaticProjection(
          (await client.query(PROJECTION_SQL, [documents, prepared.pattern, prepared.tokens])).rows,
          documents.length,
          required,
          prepared.eligible,
        );
        check(entry.comparison.equal, 'STATIC_EQUIVALENCE_FAILED');
        entry.completed = true;
        if (kind === 'matrix') report.corpus.matrixPairs += documents.length;
        if (kind === 'additional') report.corpus.additionalPairs += documents.length;
        if (kind === 'boundary') report.corpus.boundaryPairs += documents.length;
      };
      for (let i = 0; i < corpus.keywords.length; i++)
        await compare(`matrix-${i + 1}`, corpus.documents, corpus.keywords[i], false, 'matrix');
      for (let i = 0; i < corpus.additionalPairs.length; i++) {
        const pair = corpus.additionalPairs[i];
        await compare(`unicode-${i + 1}`, [pair.document], pair.keyword, true, 'additional');
      }
      await compare('long-repeated', ['a'.repeat(2048)], 'a'.repeat(16), true, 'boundary');
      await compare('null-value', [null], 'abc', true, 'boundary');
      await compare('null-empty', [null], ' ', false, 'boundary');
      const concat = await client.query(
        "SELECT 'number'::text || ' ' || 'subject'::text || ' ' || 'body'::text AS complete, 'number'::text || ' ' || NULL::text || ' ' || 'body'::text AS absent",
      );
      check(
        concat.rows.length === 1 &&
          concat.rows[0].complete === 'number subject body' &&
          concat.rows[0].absent === null,
        'STATIC_RESULT_INVALID',
      );
      await compare('field-boundary', [concat.rows[0].complete], 'er sub', true, 'boundary');
      await compare('null-concat', [concat.rows[0].absent], 'number', true, 'boundary');
    });
    check(
      report.corpus.matrixPairs === 1024 && report.corpus.additionalPairs === 10,
      'STATIC_PROTOCOL_FAILED',
    );
    progress('static-corpus');

    const compareNative = async (
      client,
      key,
      label,
      options,
      { expectedTotal, plan = false } = {},
    ) => {
      const actor = fixture.actors[key];
      const entry = { label, key, completed: false };
      report.nativeCases.push(entry);
      const prepared = await preprocess(client, options.filter?.keyword ?? '');
      const built = buildTicketListQuery(actor.context, options);
      const legacy = buildStaticStatement(built, options, actor.context.organizationId);
      const candidate = buildStaticStatement(
        built,
        options,
        actor.context.organizationId,
        prepared.tokens,
      );
      entry.tokenCount = prepared.tokens.length;
      entry.candidateUsed = candidate.candidateUsed;
      entry.preprocessingMs = prepared.durationMs;
      entry.statementHashes = { legacy: legacy.sqlHash, candidate: candidate.sqlHash };
      const oldResult = normalizeSearchCombinedRows(
        (await client.query(legacy.sql, legacy.params)).rows,
        built.limit,
      );
      const newResult = normalizeSearchCombinedRows(
        (await client.query(candidate.sql, candidate.params)).rows,
        built.limit,
      );
      entry.comparison = compareSearchResults(oldResult, newResult);
      entry.rows = newResult.rows.length;
      entry.total = newResult.total;
      const own = key !== 'agent';
      entry.organization = newResult.rows.every(
        (row) => row.organization_id === actor.context.organizationId,
      );
      entry.requester = !own || newResult.rows.every((row) => row.requester_id === actor.userId);
      check(
        entry.comparison.equal &&
          entry.organization &&
          entry.requester &&
          (expectedTotal === undefined || newResult.total === expectedTotal),
        'STATIC_EQUIVALENCE_FAILED',
      );
      if (plan) {
        const observation = {
          label,
          completed: false,
          preprocessingMs: prepared.durationMs,
          tokenCount: prepared.tokens.length,
          candidateUsed: prepared.eligible,
        };
        report.plans.push(observation);
        const population = await client.query(
          `SELECT count(*)::int AS candidates FROM (
          SELECT posting.ticket_id FROM perf053.search_posting posting
          WHERE posting.organization_id=$1 AND posting.generation=1 AND posting.token=ANY($2::bytea[])
          GROUP BY posting.ticket_id HAVING count(*)=cardinality($2::bytea[])
        ) candidate_population`,
          [actor.context.organizationId, prepared.tokens],
        );
        check(
          population.rows.length === 1 && integer(population.rows[0].candidates),
          'STATIC_RESULT_INVALID',
        );
        observation.candidateIds = prepared.eligible ? population.rows[0].candidates : null;
        observation.legacy = summarizeStaticPlan(
          (
            await client.query(
              'EXPLAIN (ANALYZE, TIMING OFF, BUFFERS, FORMAT JSON) ' + legacy.sql,
              legacy.params,
            )
          ).rows[0]?.['QUERY PLAN'],
        );
        observation.candidate = summarizeStaticPlan(
          (
            await client.query(
              'EXPLAIN (ANALYZE, TIMING OFF, BUFFERS, FORMAT JSON) ' + candidate.sql,
              candidate.params,
            )
          ).rows[0]?.['QUERY PLAN'],
        );
        observation.requiredIndex = ['selective-one', 'selective-zero'].includes(label);
        observation.ticketReevaluationBounded = prepared.eligible
          ? proveStaticNarrowing(observation.candidate, observation.candidateIds)
          : false;
        observation.indexProven =
          !observation.requiredIndex ||
          (prepared.eligible &&
            observation.candidate.postingIndexExecuted &&
            observation.candidateIds < 2048 &&
            observation.ticketReevaluationBounded &&
            observation.candidate.ticketVisitedRows < observation.legacy.ticketVisitedRows);
        check(observation.indexProven, 'STATIC_INDEX_NOT_PROVEN');
        observation.completed = true;
      }
      entry.completed = true;
      return newResult;
    };

    for (const key of [
      'agent',
      'requester',
      'other-requester',
      'foreign',
      'deactivated',
      'expired',
      'revoked',
    ]) {
      await read(key, 'native', async (client) => {
        await compareNative(client, key, 'scope', { filter: { keyword: 'static' }, limit: 50 });
        if (key === 'requester') {
          await compareNative(
            client,
            key,
            'other-requester-filter',
            {
              filter: { keyword: 'static', requesterId: fixture.actors['other-requester'].userId },
              limit: 50,
            },
            { expectedTotal: 0 },
          );
          await compareNative(
            client,
            key,
            'foreign-group-filter',
            { filter: { keyword: 'static', assigneeGroupIds: [fixture.groups[1]] }, limit: 50 },
            { expectedTotal: 0 },
          );
        }
      });
    }
    await read('agent', 'native-filters', async (client) => {
      const generated = await client.query(
        `SELECT bool_and(search_text IS NOT DISTINCT FROM number || ' ' || subject || ' ' || body) AS matches
        FROM public.ticket WHERE organization_id=$1`,
        [fixture.organizationId],
      );
      check(
        generated.rows.length === 1 && generated.rows[0].matches === true,
        'STATIC_EQUIVALENCE_FAILED',
      );
      report.generatedColumnMatches = true;
      const fieldBoundary = await compareNative(client, 'agent', 'generated-field-boundary', {
        filter: { keyword: '000 padding' },
        limit: 50,
      });
      check(fieldBoundary.total > 0, 'STATIC_EQUIVALENCE_FAILED');
      const missingPolicy = await compareNative(
        client,
        'agent',
        'missing-sla-policy',
        {
          filter: { keyword: 'TKT-00000', priority: ['low'] },
          limit: 50,
        },
        { expectedTotal: 2 },
      );
      check(
        missingPolicy.rows.length === 2 &&
          missingPolicy.rows.every(
            (row) => row.remaining_seconds === null && row.resolution_target_minutes === null,
          ),
        'STATIC_EQUIVALENCE_FAILED',
      );
      const tie = await compareNative(
        client,
        'agent',
        'deadline-exact-tie',
        {
          filter: { keyword: 'TKT-00000', priority: ['medium'], state: ['new'] },
          sort: { column: 'deadline', direction: 'asc' },
          limit: 50,
        },
        { expectedTotal: 2 },
      );
      check(
        tie.rows.length === 2 &&
          tie.rows[0].remaining_seconds !== null &&
          isDeepStrictEqual(tie.rows[0].remaining_seconds, tie.rows[1].remaining_seconds) &&
          tie.rows[0].id < tie.rows[1].id,
        'STATIC_EQUIVALENCE_FAILED',
      );
      report.slaBoundary = {
        missingPolicyRows: 2,
        tiedRows: 2,
        nativeNullPreserved: true,
        idTieOrder: true,
      };
      const filters = [
        ['single-state', { state: ['new'] }],
        ['multi-state', { state: ['new', 'pending'] }],
        ['priority', { priority: ['critical'] }],
        ['kind', { kind: ['request'] }],
        ['assigned', { assigneeId: fixture.actors.agent.userId }],
        ['unassigned', { unassignedOnly: true }],
        ['group', { assigneeGroupIds: [fixture.groups[0]] }],
        ['ungrouped', { ungroupedOnly: true }],
        ['sla', { slaBreachedOnly: true }],
        [
          'dates',
          {
            createdFrom: new Date('2020-01-01T00:00:00Z'),
            createdTo: new Date('2100-01-01T00:00:00Z'),
          },
        ],
      ];
      for (const [label, filter] of filters)
        await compareNative(client, 'agent', label, {
          filter: { keyword: 'static', ...filter },
          limit: 50,
        });
      for (const direction of ['asc', 'desc'])
        for (const limit of [1, 50, 200]) {
          const options = {
            filter: { keyword: 'static' },
            sort: { column: 'created_at', direction },
            limit,
          };
          const label = `paging-${direction}-${limit}`;
          const first = await compareNative(client, 'agent', label, options);
          check(first.rows.length > 0, 'STATIC_RESULT_INVALID');
          const last = first.rows.at(-1);
          const next = await compareNative(client, 'agent', label + '-next', {
            ...options,
            cursor: { createdAt: last.cursor_created_at, id: last.id },
          });
          check(
            next.total === first.total &&
              next.rows.every((row) => !first.rows.some((old) => old.id === row.id)),
            'STATIC_EQUIVALENCE_FAILED',
          );
          const reverse = await compareNative(client, 'agent', label + '-anchor', {
            ...options,
            sort: { column: 'created_at', direction: direction === 'asc' ? 'desc' : 'asc' },
            limit: 1,
          });
          const terminal = reverse.rows[0];
          check(terminal, 'STATIC_RESULT_INVALID');
          const empty = await compareNative(
            client,
            'agent',
            label + '-terminal',
            { ...options, cursor: { createdAt: terminal.cursor_created_at, id: terminal.id } },
            { expectedTotal: first.total },
          );
          check(empty.rows.length === 0, 'STATIC_EQUIVALENCE_FAILED');
        }
      for (const direction of ['asc', 'desc'])
        for (const limit of [1, 50, 200])
          await compareNative(client, 'agent', `deadline-${direction}-${limit}`, {
            filter: { keyword: 'static' },
            sort: { column: 'deadline', direction },
            limit,
          });
    });
    progress('static-native');

    for (const key of CONTEXTS)
      await read(key, 'boundary', async (client) => {
        const entry = { key, completed: false, httpAuthenticationProven: false };
        report.boundaries.push(entry);
        const actor = fixture.actors[key] ?? fixture.actors.requester;
        const org = key === 'foreign' ? fixture.controlOrganizationId : fixture.organizationId;
        const result = await client.query(
          `SELECT
        (SELECT count(*)::int FROM public.ticket WHERE organization_id=$1) AS tickets,
        (SELECT count(*)::int FROM public.ticket WHERE organization_id<>$1) AS foreign_tickets,
        (SELECT count(*)::int FROM perf053.search_posting WHERE organization_id=$1) AS postings,
        (SELECT count(*)::int FROM perf053.search_posting WHERE organization_id<>$1) AS foreign_postings,
        (SELECT count(DISTINCT posting.ticket_id)::int FROM perf053.search_posting posting
          JOIN public.ticket t ON t.id=posting.ticket_id AND t.organization_id=posting.organization_id
          WHERE posting.organization_id=$1 AND t.requester_id<>$2) AS other_requester_tickets`,
          [org, actor.userId],
        );
        const row = result.rows[0];
        check(
          result.rows.length === 1 &&
            row &&
            [
              'tickets',
              'foreign_tickets',
              'postings',
              'foreign_postings',
              'other_requester_tickets',
            ].every((name) => integer(row[name])),
          'STATIC_RESULT_INVALID',
        );
        Object.assign(entry, {
          tickets: row.tickets,
          postings: row.postings,
          foreignTickets: row.foreign_tickets,
          foreignPostings: row.foreign_postings,
          otherRequesterTickets: row.other_requester_tickets,
          requesterIsolationAdopted: false,
        });
        check(
          row.foreign_tickets === 0 &&
            row.foreign_postings === 0 &&
            row.tickets === 2048 &&
            row.postings > 0,
          'STATIC_RLS_FAILED',
        );
        entry.completed = true;
      });
    progress('static-boundary');
    await read('requester', 'plans', async (client) => {
      await compareNative(
        client,
        'requester',
        'selective-one',
        { filter: { keyword: 'qxzneedle' }, limit: 50 },
        { expectedTotal: 1, plan: true },
      );
      await compareNative(
        client,
        'requester',
        'selective-zero',
        { filter: { keyword: 'jkv' }, limit: 50 },
        { expectedTotal: 0, plan: true },
      );
      await compareNative(
        client,
        'requester',
        'broad',
        { filter: { keyword: 'static' }, limit: 50 },
        { plan: true },
      );
      await compareNative(
        client,
        'requester',
        'short-fallback',
        { filter: { keyword: 's' }, limit: 50 },
        { plan: true },
      );
      await compareNative(
        client,
        'requester',
        'empty-fallback',
        { filter: { keyword: ' ' }, limit: 50 },
        { plan: true },
      );
    });
    report.indexProofComplete =
      report.plans.length === 5 &&
      report.plans.every((entry) => entry.completed && entry.indexProven);
    progress('static-plans');
    report.equivalent =
      report.corpus.cases.every((entry) => entry.completed && entry.comparison.equal) &&
      report.nativeCases.every((entry) => entry.completed && entry.comparison.equal);
    report.protocolCompleted =
      report.catalogComplete &&
      report.indexProofComplete &&
      report.boundaries.length === 8 &&
      report.boundaries.every((entry) => entry.completed) &&
      report.equivalent;
    check(report.protocolCompleted, 'STATIC_PROTOCOL_FAILED');
    report.completed = true;
    progress('static-complete');
  } catch (error) {
    report.failureCode = FAILURES.has(error?.message) ? error.message : 'STATIC_DIAGNOSTIC_FAILED';
    progress('static-failed');
  }
  report.elapsedMs = performance.now() - started;
  return report;
}
