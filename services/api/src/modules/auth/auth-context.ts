import type pg from 'pg';

/**
 * 認証トランザクションの開始 (WP-P1-IDM-009 / migration 0011)。
 *
 * 認証は組織コンテキストが確立する前に走るため、`app_user` と `role_binding` を
 * 通常のRLS配下では引けない(組織を決めるにはセッションが要り、
 * セッションを引くには利用者が要る、という循環になる)。
 *
 * `app.auth = 'on'` は **読み取り専用の例外**である。
 * ポリシーが `FOR SELECT` に限定されているため、この文脈で業務データは書けない。
 * `SET LOCAL` なのでトランザクション外・次の利用者へは漏れない。
 *
 * **この関数を経由しない認証クエリを書かないこと。** 直接 BEGIN すると
 * fail-closed で0件になり、「利用者が存在しない」と区別がつかない状態になる。
 */
export async function beginAuthTransaction(client: pg.PoolClient | pg.Client): Promise<void> {
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.auth', 'on', true)");
}
