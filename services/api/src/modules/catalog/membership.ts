/**
 * ADR-0023 §1 の「有効な所属」のSQL述語。
 *
 * 承認の解決(`approval-resolver`)・代行の導出(`approval-route-state`)・
 * 通知の宛先(`approval-notice`)が同じ判定を使う。**判定を二重に書かない。**
 *
 * ここには純粋なSQL断片だけを置き、ほかのモジュールを import しない。
 * 承認状態(`approval-state`)→通知→リゾルバ→承認状態という循環を作らないためである。
 * `userExpr` / `orgParam` / `atParam` は呼び出し側の固定のSQL式だけを渡す
 * (利用者入力を連結しない)。
 */
export function activeMembershipSql(
  userExpr: string,
  orgParam: string,
  atParam: string,
): string {
  return `EXISTS (
    SELECT 1 FROM role_binding rb
     WHERE rb.user_id = ${userExpr}
       AND rb.role_scope = 'org'
       AND rb.organization_id = ${orgParam}
       AND rb.valid_from <= ${atParam}
       AND (rb.valid_until IS NULL OR rb.valid_until > ${atParam})
  )`;
}
