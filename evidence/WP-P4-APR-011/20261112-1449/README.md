# WP-P4-APR-011 検証記録

- Timestamp: 2026-11-12 14:41-14:52(JST、ローカル時刻)
- Commit SHA(基点のHEAD): `5c33cca794206bb52225536a9f4ab43a4b6cca1f`、branch `wp/WP-P4-APR-011`(変更は作業ツリー。コミットなし)
- Environment: macOS(darwin arm64)、Node v26.13.0、vitest 3.2.7、ローカルPostgreSQL(`.env` の `DATABASE_URL` / `DATABASE_ADMIN_URL`。値は記録しない)。合成データのみ。

## 結果

| 検証 | Command | 結果 |
|---|---|---|
| 関連unit(catalog-* / portal-catalog / 追加分) | `npx vitest run tests/unit/catalog-*.test.ts tests/unit/portal-catalog.test.ts tests/unit/approval-assertion.test.ts` | 18 files / 692件成功(既存テストは無変更で成功) |
| 追加unit | `npx vitest run tests/unit/approval-assertion.test.ts` | 35件成功 |
| 追加security(実PostgreSQL) | `npx vitest run tests/security/approval-assertion.test.ts`(`.env` を読み込んで実行) | 18件成功(2回連続。終了時に作成行を削除、既存行は不変) |
| 全体unit | `npm run test:unit` | 変更前 34失敗/4271成功(4305件、4 files失敗) → 変更後 34失敗/4306成功(4340件、4 files失敗)。**新規失敗0**([unit_comparison.json](unit_comparison.json)) |
| 型 / lint / check:all | `npm run typecheck` / `npm run lint` / `npm run check:all` | いずれも exit 0 |
| `approvalMatches` 参照 | `grep -rn approvalMatches services apps packages tests tools`(node_modules/dist除く) | 0件(残るのは「0件であること」を確認する `tests/unit/approval-assertion.test.ts` の記述のみ) |
| 既存スモーク `tools/smoke_catalog_flow.mjs` | 未実行 | `SOLVI_SMOKE_PASSWORD`(既存の開発用資格情報)を持たないため。同じ承認→作業チェック→模擬完了の流れは実DBのsecurityテストで通した |

## ADR-0023 §7(挙動変更)の変更前後

変更前のコード(`HEAD` の `catalog.routes.ts`)に同じsecurityテストを当てた結果が [raw/pre_change_section7.txt](raw/pre_change_section7.txt)(gitignore対象)。承認者の `deactivated` 化・approverロール期限切れ・role_binding削除の3件が、実行時の `validateApprover` により **403**(「現在有効な同組織の承認者を選んでください」)で止まっていた。変更後は3件とも成功する。**WP本文の「変更前は409」は誤りで、実際は403**。

## 既存失敗

基点と同じ34件(ナレッジの欠落fixture・性能比較の固定source不足など)。削除・skip・修正はしていない。
