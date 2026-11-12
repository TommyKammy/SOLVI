import type pg from 'pg';

/**
 * テスト間のデータ片付け。
 *
 * 削除順を1か所に集約する。各テストファイルが独自に DELETE を並べると、
 * 新しい子テーブルが増えたときに外部キー違反で**別のWPのテストが壊れる**
 * (実際に WP-P2-COLLAB-004 で ticket_comment を追加した際に発生した)。
 *
 * ここに新しいテーブルを追加するときは、**子から親の順**に並べること。
 */
const DELETE_ORDER = [
  // アクセスレビュー (WP-P1-SEC-024)。role_binding を ON DELETE RESTRICT で
  // 参照するため、**役割を消す検査より先に**消す必要がある。
  'access_review_item',
  'access_review',
  'notification',
  'outbox_event',
  'ticket_relation',
  'ticket_assignment',
  'ticket_attachment',
  'ticket_comment',
  'ticket',
  'ticket_number_counter',
] as const;

/** append-only のためトリガを一時無効化しないと消せないテーブル */
const APPEND_ONLY_TABLES = [
  { table: 'audit_event', triggers: ['audit_event_no_delete'] },
  { table: 'audit_anchor', triggers: ['audit_anchor_no_delete'] },
] as const;

/**
 * 業務データを削除する。seed で作った organization / app_user / role は残す。
 * @param admin owner 権限の接続(RLSとトリガを越える必要があるため)
 */
export async function cleanBusinessData(admin: pg.Client): Promise<void> {
  // 組織プロフィール(WP-P4-IDM-012)。`app_user` を消す後始末より前に、シード以外の利用者の行を消す。
  // `org_member_profile.user_id` は ON DELETE RESTRICT のため、残ると `DELETE FROM app_user` が失敗する。
  await cleanOrgProfiles(admin, { nonSeedUsers: true });
  for (const table of DELETE_ORDER) {
    await admin.query(`DELETE FROM ${table}`);
  }
}

/**
 * 監査データを削除する。
 * append-only はテスト用途でのみ、明示的にトリガを外して回避する。
 * 本番でこの操作を行う経路は存在しない(ADR-0009)。
 */
export async function cleanAuditData(admin: pg.Client, whereClause?: string): Promise<void> {
  for (const { table, triggers } of APPEND_ONLY_TABLES) {
    for (const trigger of triggers) {
      await admin.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    }
    const where = table === 'audit_event' && whereClause ? ` WHERE ${whereClause}` : '';
    await admin.query(`DELETE FROM ${table}${where}`);
    for (const trigger of triggers) {
      await admin.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    }
  }
}

/**
 * 組織プロフィール・部署長の行を消す (WP-P4-IDM-012)。
 *
 * `createUser` / `grantRole` はプロフィールを作る。`app_user` / `organization` を消すテストは、
 * その前にこれを呼ぶ。利用者は ON DELETE RESTRICT で守られており、ここで先に外す。
 * 対象はそのテストが作った利用者・組織に限る(`nonSeedUsers` はシード以外の全利用者)。
 *
 * @param admin owner 権限の接続
 */
export async function cleanOrgProfiles(
  admin: pg.Client,
  scope: { nonSeedUsers?: boolean; userIds?: string[]; orgIds?: string[] },
): Promise<void> {
  const users = scope.userIds ?? [];
  const orgs = scope.orgIds ?? [];
  const nonSeed = scope.nonSeedUsers === true;
  // 対象の利用者: シード以外(指定時)または userIds、または対象組織のプロフィールを持つ者
  const target = `(
      ($1::boolean AND user_id IN (SELECT id FROM app_user WHERE created_via <> 'seed'))
      OR user_id = ANY($2::uuid[]) OR organization_id = ANY($3::uuid[]))`;
  const args = [nonSeed, users, orgs];
  await admin.query(
    `DELETE FROM department_head
      WHERE ${target}
         OR ($1::boolean AND created_by IN (SELECT id FROM app_user WHERE created_via <> 'seed'))
         OR created_by = ANY($2::uuid[]) OR organization_id = ANY($3::uuid[])`,
    args,
  );
  // 残る行が消す行を上長として指している場合に備え、先に外す
  await admin.query(
    `UPDATE org_member_profile SET manager_user_id = NULL
      WHERE manager_user_id IS NOT NULL AND (
        ($1::boolean AND manager_user_id IN (SELECT id FROM app_user WHERE created_via <> 'seed'))
        OR manager_user_id = ANY($2::uuid[]))`,
    args.slice(0, 2),
  );
  await admin.query(`DELETE FROM org_member_profile WHERE ${target}`, args);
}
