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
