import type pg from 'pg';

/**
 * 添付のスキャン結果を検査の下準備として書く (WP-P2-SCAN-012)。
 *
 * 本番でこの列を書くのは **worker の `AttachmentScanner` だけ**である。
 * 以前は `CollaborationService.recordScanResult` も書けたが、
 * そちらは migration 0012 で足された
 * `scan_signature` / `scan_attempts` / `scan_last_error` を知らないまま
 * 残っており、**中途半端な行を書く写し**になっていた。
 *
 * 検査は前提を作るために直接書いてよい。ただし**書き方は1つにする** —
 * 検査ごとに違う列を埋めると、「この状態のとき何が起きるか」を
 * 確かめているつもりで、検査ごとに違う状態を作ることになる。
 */
export async function markScanned(
  client: pg.PoolClient | pg.Client,
  attachmentId: string,
  status: 'clean' | 'infected',
  signature: string | null = null,
): Promise<void> {
  await client.query(
    `UPDATE ticket_attachment
        SET scan_status = $2,
            scanned_at = now(),
            scan_signature = $3,
            scan_attempts = COALESCE(scan_attempts, 0) + 1,
            scan_last_error = NULL
      WHERE id = $1`,
    // 検体名は infected のときだけ入る(DB制約 `ticket_attachment_signature_only_infected`)。
    [attachmentId, status, status === 'infected' ? (signature ?? 'Test.Signature') : null],
  );
}
