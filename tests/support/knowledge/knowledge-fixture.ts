/**
 * ナレッジ・通知のセキュリティテスト用の合成データ (WP-P3-KNWUI-059)。
 *
 * 元は `evidence/WP-P3-KNWUI-054/20261007/knowledge-fixture.mjs` にあったが、
 * `751d6ae`(スナップショット取り込み)で失われた。テストが要求する性質から作り直した(DEC-009)。
 *
 * **使い捨てDB(名前が `solvi_wp054_test_<数字>_<8桁16進>`)以外には書かない。**
 * 書込みの前に、接続先の実際のDB名とロールを確かめる。
 *
 * すべて合成データ。実在の人物・組織とは無関係。ID は固定値なので、
 * `readKnowledgeFixture` は投入済みのDBから同じ形を組み立て直せる。
 */
import type pg from 'pg';
import type { AuthenticatedRequest } from '../../../services/api/src/modules/auth/auth.routes.js';
import type { RoleCode } from '../../../services/api/src/common/authz/authz.js';

/** 使い捨てDBの名前の形。ci-knowledge-db / isolated-knowledge-db が作る名前と同じ。 */
export const KNOWLEDGE_DATABASE_NAME = /^solvi_wp054_test_\d+_[a-f0-9]{8}$/;

const LOOPBACK = new Set(['127.0.0.1', 'localhost']);

function fail(code: string): never {
  throw new Error(code);
}

/**
 * アプリ接続と管理接続が、同じループバックの使い捨てDBを指し、
 * それぞれ `solvi_app` / `solvi_owner` であることを確かめる。資格情報はエラーに含めない。
 * @returns 使い捨てDBの名前
 */
export function assertKnowledgeDatabaseUrls(appUrl: string, adminUrl: string): string {
  let app: URL, owner: URL;
  try {
    app = new URL(appUrl);
    owner = new URL(adminUrl);
  } catch {
    return fail('KNOWLEDGE_OWNED_DATABASE_REQUIRED');
  }
  const database = app.pathname.replace(/^\//, '');
  const ok =
    ['postgres:', 'postgresql:'].includes(app.protocol) &&
    app.protocol === owner.protocol &&
    LOOPBACK.has(app.hostname) &&
    app.hostname === owner.hostname &&
    app.port !== '' &&
    app.port === owner.port &&
    app.pathname === owner.pathname &&
    app.search === '' &&
    owner.search === '' &&
    decodeURIComponent(app.username) === 'solvi_app' &&
    decodeURIComponent(owner.username) === 'solvi_owner' &&
    KNOWLEDGE_DATABASE_NAME.test(database);
  if (!ok) fail('KNOWLEDGE_OWNED_DATABASE_REQUIRED');
  return database;
}

// ---- 固定ID ----------------------------------------------------------------
// 05400000-...: 元の WP-P3-KNWUI-054 のテストが使っていた合成IDの帯をそのまま使う。

const uuid = (group: number, n: number) =>
  `05400000-0000-4000-${(0x8000 + group).toString(16)}-${n.toString(16).padStart(12, '0')}`;

const ORG = uuid(0, 0x101);
const CONTROL_ORG = uuid(0, 0x102);
const ACTORS = {
  requester: { id: uuid(1, 1), role: 'requester', organization: ORG },
  agent: { id: uuid(1, 2), role: 'agent', organization: ORG },
  admin: { id: uuid(1, 3), role: 'org_admin', organization: ORG },
  expired: { id: uuid(1, 4), role: 'agent', organization: ORG },
  foreign: { id: uuid(1, 5), role: 'requester', organization: CONTROL_ORG },
} as const satisfies Record<string, { id: string; role: RoleCode; organization: string }>;
type ActorName = keyof typeof ACTORS;

/** 検索語。互いに部分一致しないように選ぶ。 */
const SEARCH = {
  base: 'WP054基準語',
  published: 'WP054保持公開語',
  unpublished: 'WP054未公開下書き語',
} as const;
const BASE_COUNT = 205;
const BASE_TITLE_MATCHES = 60;

const BASE_IDS = Array.from({ length: BASE_COUNT }, (_, i) => uuid(2, i + 1));
const IDS = {
  base: BASE_IDS,
  publishedDraft: uuid(3, 1),
  staff: uuid(3, 2),
  draft: uuid(3, 3),
  retired: uuid(3, 4),
  foreign: uuid(3, 5),
};

/** 字句どおりの検索(題名・本文・タグ)を確かめるための記事。 */
const LITERALS = [
  { title: '検索の使い方', body: '題名に語を含む記事。', tags: '' },
  { title: '手順書', body: '長い前置きの後に本文後方一致の語が来る記事。', tags: '' },
  { title: 'タグの記事', body: 'タグだけに語を含む。', tags: '分類タグ' },
  { title: '記号の記事', body: '百分率 %_\\ を字句どおりに探す。', tags: '' },
  { title: '<script>alert(1)</script>', body: 'HTML として解釈しない。', tags: '' },
  { title: '日本語手順の例', body: '日本語手順を本文にも含む。', tags: '日本語手順' },
];
const LITERAL_IDS = LITERALS.map((_, i) => uuid(4, i + 1));

/** 件数は投入するデータから導く。readKnowledgeFixture は実DBの件数と照合する。 */
const COUNTS = {
  public: BASE_COUNT + LITERALS.length + 1, // + publishedDraft(公開中の第1版)
  staff: BASE_COUNT + LITERALS.length + 2, // + staff(担当者限定で公開)
  manage: BASE_COUNT + LITERALS.length + 4, // + publishedDraft / staff / draft / retired
};

const FIXTURE_NOW = new Date('2026-10-07T00:00:00Z');
const EMAIL_DOMAIN = 'knwui059.example.test';

export interface KnowledgeActor {
  userId: string;
  email: string;
  role: RoleCode;
  organizationId: string;
  auth: AuthenticatedRequest;
}

export interface KnowledgeFixture {
  organizationId: string;
  controlOrganizationId: string;
  actors: Record<ActorName, KnowledgeActor>;
  search: { base: string; published: string; unpublished: string };
  ids: {
    base: string[];
    publishedDraft: string;
    staff: string;
    draft: string;
    retired: string;
    foreign: string;
  };
  counts: { public: number; staff: number; manage: number };
}

function authFor(name: ActorName, now: Date): AuthenticatedRequest {
  const actor = ACTORS[name];
  return {
    userId: actor.id,
    sessionId: `knowledge-fixture-${name}`,
    authz: {
      organizationId: actor.organization,
      now,
      principal: {
        userId: actor.id,
        status: 'active',
        bindings: [
          {
            roleCode: actor.role,
            organizationId: actor.organization,
            validFrom: new Date('2026-01-01T00:00:00Z'),
            // expired だけは担当者の役割が既に切れている(管理画面に入れない)
            validUntil: name === 'expired' ? new Date('2026-01-02T00:00:00Z') : null,
          },
        ],
      },
    },
  };
}

function buildFixture(now = new Date()): KnowledgeFixture {
  const actors = Object.fromEntries(
    (Object.keys(ACTORS) as ActorName[]).map((name) => [
      name,
      {
        userId: ACTORS[name].id,
        email: `${name}@${EMAIL_DOMAIN}`,
        role: ACTORS[name].role,
        organizationId: ACTORS[name].organization,
        auth: authFor(name, now),
      },
    ]),
  ) as Record<ActorName, KnowledgeActor>;
  return {
    organizationId: ORG,
    controlOrganizationId: CONTROL_ORG,
    actors,
    search: { ...SEARCH },
    ids: { ...IDS, base: [...IDS.base] },
    counts: { ...COUNTS },
  };
}

// ---- 投入 ------------------------------------------------------------------

/**
 * 基準記事の更新時刻。2件ずつ同じ時刻にして ID で順位が決まる場合を作り、
 * マイクロ秒を 001〜999 にする(ミリ秒は 000、マイクロ秒は 0 にならない)。
 */
function baseUpdatedAt(index: number): string {
  const pair = Math.floor(index / 2);
  const at = new Date(FIXTURE_NOW.getTime() - pair * 1000);
  const micro = String((pair % 999) + 1).padStart(3, '0');
  return at.toISOString().replace(/\.\d{3}Z$/, `.000${micro}Z`);
}

function baseBody(index: number, titleMatch: boolean): string {
  const lead = `合成記事 ${index + 1} の本文です。接続や設定の確認手順を順に説明します。`;
  const filler = '確認した内容を記録し、結果を依頼者へ伝えます。'.repeat(14);
  // 題名で一致しない記事は、本文の後方(先頭300文字より後)で一致させる
  return titleMatch ? `${lead}${filler}` : `${lead}${filler}最後に ${SEARCH.base} を確かめます。`;
}

interface ArticleSpec {
  id: string;
  organizationId: string;
  state: 'draft' | 'published' | 'retired';
  publishedVersion: number | null;
  updatedAt: string;
  versions: { title: string; body: string; tags: string; audience: 'organization' | 'staff' }[];
}

function articles(): ArticleSpec[] {
  const list: ArticleSpec[] = [];
  BASE_IDS.forEach((id, i) => {
    const titleMatch = i < BASE_TITLE_MATCHES;
    list.push({
      id,
      organizationId: ORG,
      state: 'published',
      publishedVersion: 1,
      updatedAt: baseUpdatedAt(i),
      versions: [
        {
          title: titleMatch ? `${SEARCH.base} 手順 ${i + 1}` : `接続手順 ${i + 1}`,
          body: baseBody(i, titleMatch),
          tags: i % 7 === 0 ? `VPN,${SEARCH.base}` : 'VPN',
          audience: 'organization',
        },
      ],
    });
  });
  LITERALS.forEach((literal, i) =>
    list.push({
      id: LITERAL_IDS[i]!,
      organizationId: ORG,
      state: 'published',
      publishedVersion: 1,
      updatedAt: '2026-10-06T12:00:00.000500Z',
      versions: [{ ...literal, audience: 'organization' }],
    }),
  );
  list.push(
    {
      // 公開中の第1版(組織内)の後に、担当者限定の下書き(第2版)がある
      id: IDS.publishedDraft,
      organizationId: ORG,
      state: 'draft',
      publishedVersion: 1,
      updatedAt: '2026-10-06T11:00:00.000500Z',
      versions: [
        {
          title: `${SEARCH.published} の記事`,
          body: '保持される公開本文',
          tags: '',
          audience: 'organization',
        },
        {
          title: `${SEARCH.unpublished} の記事`,
          body: '担当者だけが見る下書き本文',
          tags: '',
          audience: 'staff',
        },
      ],
    },
    {
      id: IDS.staff,
      organizationId: ORG,
      state: 'published',
      publishedVersion: 1,
      updatedAt: '2026-10-06T10:00:00.000500Z',
      versions: [
        { title: '担当者限定の手順', body: '担当者だけが読む本文', tags: '', audience: 'staff' },
      ],
    },
    {
      id: IDS.draft,
      organizationId: ORG,
      state: 'draft',
      publishedVersion: null,
      updatedAt: '2026-10-06T09:00:00.000500Z',
      versions: [
        { title: '未公開の下書き', body: '公開前の本文', tags: '', audience: 'organization' },
      ],
    },
    {
      id: IDS.retired,
      organizationId: ORG,
      state: 'retired',
      publishedVersion: 1,
      updatedAt: '2026-10-06T08:00:00.000500Z',
      versions: [
        { title: '取り下げた記事', body: '取り下げ済みの本文', tags: '', audience: 'organization' },
      ],
    },
    {
      id: IDS.foreign,
      organizationId: CONTROL_ORG,
      state: 'published',
      publishedVersion: 1,
      updatedAt: '2026-10-06T07:00:00.000500Z',
      versions: [
        {
          title: '別組織の記事',
          body: '別組織だけが読む本文',
          tags: '',
          audience: 'organization',
        },
      ],
    },
  );
  return list;
}

export interface SeedOptions {
  signal?: AbortSignal;
}

/**
 * 合成データを投入する。**書く前に** 接続先の実際のDB名とロールを確かめる。
 * 中断されていれば何も問い合わせない。
 */
export async function seedKnowledgeFixture(
  client: pg.Client,
  database: string,
  options: SeedOptions = {},
): Promise<KnowledgeFixture> {
  if (options.signal?.aborted) fail('KNOWLEDGE_ABORTED');
  const identity = (
    await client.query('SELECT current_database() AS database, current_user AS role')
  ).rows[0] as { database?: unknown; role?: unknown } | undefined;
  if (
    !KNOWLEDGE_DATABASE_NAME.test(database) ||
    identity?.database !== database ||
    identity?.role !== 'solvi_owner'
  )
    fail('KNOWLEDGE_OWNED_DATABASE_REQUIRED');

  await client.query('BEGIN');
  try {
    const check = () => {
      if (options.signal?.aborted) fail('KNOWLEDGE_ABORTED');
    };
    for (const [id, code, name] of [
      [ORG, 'wp054-knowledge', '合成組織(ナレッジ)'],
      [CONTROL_ORG, 'wp054-control', '合成組織(対照)'],
    ])
      await client.query('INSERT INTO organization (id, code, name) VALUES ($1, $2, $3)', [
        id,
        code,
        name,
      ]);
    let bindingSeq = 0;
    for (const [name, actor] of Object.entries(ACTORS) as [
      ActorName,
      (typeof ACTORS)[ActorName],
    ][]) {
      check();
      await client.query(
        `INSERT INTO app_user (id, primary_email, display_name, status, created_via)
         VALUES ($1, $2, $3, 'active', 'seed')`,
        [actor.id, `${name}@${EMAIL_DOMAIN}`, `合成 ${name}`],
      );
      await client.query(
        `INSERT INTO role_binding (id, user_id, role_id, role_scope, organization_id, source, valid_from, valid_until)
         SELECT $1, $2, id, scope, $3, 'seed', '2026-01-01T00:00:00Z', $5::timestamptz FROM role WHERE code = $4`,
        [
          uuid(5, ++bindingSeq),
          actor.id,
          actor.organization,
          actor.role,
          name === 'expired' ? '2026-01-02T00:00:00Z' : null,
        ],
      );
      await client.query(
        `INSERT INTO org_member_profile (organization_id, user_id) VALUES ($1, $2)
         ON CONFLICT (organization_id, user_id) DO NOTHING`,
        [actor.organization, actor.id],
      );
    }
    for (const article of articles()) {
      check();
      // FORCE ROW LEVEL SECURITY の表へ書くので、記事ごとに組織の文脈を設定する
      await client.query("SELECT set_config('app.current_org', $1, true)", [
        article.organizationId,
      ]);
      await client.query(
        `INSERT INTO knowledge_article (id, organization_id, state, version, published_version, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $7::timestamptz)`,
        [
          article.id,
          article.organizationId,
          article.state,
          article.versions.length,
          article.publishedVersion,
          article.organizationId === ORG ? ACTORS.agent.id : ACTORS.foreign.id,
          article.updatedAt,
        ],
      );
      for (const [index, version] of article.versions.entries())
        await client.query(
          `INSERT INTO knowledge_version (article_id, organization_id, number, title, body, tags, audience, author_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)`,
          [
            article.id,
            article.organizationId,
            index + 1,
            version.title,
            version.body,
            version.tags,
            version.audience,
            article.organizationId === ORG ? ACTORS.agent.id : ACTORS.foreign.id,
            article.updatedAt,
          ],
        );
    }
    check();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
  return buildFixture();
}

/**
 * 投入済みの使い捨てDBから合成データの形を組み立てる。
 * 利用者・記事の件数が投入時の定義と違えば失敗する(別のDBや改変されたDBを使わない)。
 */
export async function readKnowledgeFixture(admin: pg.Client): Promise<KnowledgeFixture> {
  const identity = (
    await admin.query('SELECT current_database() AS database, current_user AS role')
  ).rows[0] as { database?: unknown; role?: unknown } | undefined;
  if (
    typeof identity?.database !== 'string' ||
    !KNOWLEDGE_DATABASE_NAME.test(identity.database) ||
    identity.role !== 'solvi_owner'
  )
    fail('KNOWLEDGE_OWNED_DATABASE_REQUIRED');
  const fixture = buildFixture();
  const users = Number(
    (
      await admin.query('SELECT count(*)::int AS n FROM app_user WHERE id = ANY($1::uuid[])', [
        Object.values(ACTORS).map((a) => a.id),
      ])
    ).rows[0].n,
  );
  const manage = Number(
    (
      await admin.query(
        'SELECT count(*)::int AS n FROM knowledge_article WHERE organization_id = $1',
        [ORG],
      )
    ).rows[0].n,
  );
  if (users !== Object.keys(ACTORS).length || manage !== COUNTS.manage)
    fail('KNOWLEDGE_FIXTURE_MISMATCH');
  return fixture;
}
