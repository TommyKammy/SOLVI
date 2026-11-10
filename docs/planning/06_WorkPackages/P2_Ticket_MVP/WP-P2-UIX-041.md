---
project: SOLVI
doc_id: "WP-P2-UIX-041"
title: "カタログの再利用・委任編集・受付後運用"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-11-10"
updated: "2026-11-11"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "catalog", "delegation", "fulfillment"]
source_of_truth: true
implementation_status: "review"
story_points: 13
risk: "high"
workstream: "UIX"
phase: "P2"
requirement_ids: ["FR-CAT-001", "FR-CAT-002", "FR-CAT-003", "FR-IDM-006", "FR-IDM-008", "FR-TKT-003", "NFR-SEC-006", "NFR-UX-001", "NFR-UX-002", "NFR-UX-003", "NFR-UX-004"]
depends_on: ["WP-P2-UIX-028", "WP-P2-UIX-037"]
security_review_status: "pending"
---

# WP-P2-UIX-041: カタログの再利用・委任編集・受付後運用

## 1. Purpose

追加指示された改善優先度3。複製、共有質問セット、下書き編集の委任、担当責任者・処理グループ、作業チェックリスト、管理一覧の更新・未公開変更・公開前確認を実装する。

## 2. Requirement IDs

`FR-CAT-001`, `FR-CAT-002`, `FR-CAT-003`, `FR-IDM-006`, `FR-IDM-008`, `FR-TKT-003`, `NFR-SEC-006`, `NFR-UX-001/002/003/004`。

## 3. Dependencies

[[WP-P2-UIX-028]], [[WP-P2-UIX-037]]はdone。実装基点は[[WP-P2-UIX-040]]のローカルコミット`dc717d8`。040の関連465件・実API/PG7項目・両engine各9項目を確認済みだが、全体unitの既存失敗によりreviewを維持しており、本WPでDoneへ変更しない。新しい認可・永続化契約は[[ADR-0021_Catalog_Delegation_And_Fulfillment]]に従う。

## 4. Scope / Allowed Paths

- `db/migrations/0036_catalog_operations.sql`
- `packages/shared/src/catalog.ts`
- `services/api/src/common/authz/authz.ts`
- `services/api/src/common/audit/audit.ts`
- `services/api/src/modules/auth/user-admin.service.ts`
- `services/api/src/modules/auth/auth.routes.ts`
- `services/api/src/modules/catalog/catalog-admin.routes.ts`
- `services/api/src/modules/catalog/catalog.routes.ts`
- `services/api/src/modules/ticket/ticket.service.ts`
- `services/api/src/main.ts`
- `apps/web/src/lib/api.ts`
- `apps/web/src/lib/catalog-reuse.ts`
- `apps/web/src/lib/catalog-management-list.ts`
- `apps/web/src/lib/user-directory.ts`
- `apps/web/src/components/CatalogAdminForm.tsx`
- `apps/web/src/components/CatalogAdminForm.module.css`
- `apps/web/src/components/CatalogQuestionSetForm.tsx`
- `apps/web/src/components/CatalogChecklistForm.tsx`
- `apps/web/src/app/catalog/manage/page.tsx`
- `apps/web/src/app/catalog/manage/new/page.tsx`
- `apps/web/src/app/catalog/manage/[id]/page.tsx`
- `apps/web/src/app/catalog/manage/actions.ts`
- `apps/web/src/app/catalog/manage/question-sets/page.tsx`
- `apps/web/src/app/catalog/manage/question-sets/actions.ts`
- `apps/web/src/app/requests/[id]/page.tsx`
- `apps/web/src/app/requests/actions.ts`
- `tests/unit/catalog-operations.test.ts`
- `tests/unit/auth-role-clock.test.ts`
- `tests/unit/catalog-operations-ui.test.ts`
- `tests/unit/catalog-reuse.test.ts`
- `tests/unit/catalog-authoring-ui.test.ts`
- `tests/unit/catalog-edit-ui.test.ts`
- `tests/unit/catalog-management-list-ui.test.ts`
- `tests/unit/catalog-detail-recovery-ui.test.ts`
- `tests/unit/catalog-entry-recovery-ui.test.ts`
- `tests/unit/user-directory.test.ts`
- `tools/smoke_catalog_operations.mjs`
- `tools/ui_catalog_operations_check.mjs`
- `docs/planning/03_Requirements/03.5_Catalog_and_Approval_Requirements.md`
- `docs/planning/02_Architecture/02.17_Audit_Event_Catalog.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-041.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/07_ADR/ADR-0021_Catalog_Delegation_And_Fulfillment.md`
- `docs/planning/07_ADR/07.0_ADR_Index.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-UIX-041/`

## 5. Out of Scope

実リソース操作、外部連携、汎用Workflow、既存サービスの自動変更、共有セット更新の自動伝播、既存ロールへの一律権限追加、公開権限の委任、依存パッケージ追加。本番適用・main反映は含めず、認可変更の人間レビューを維持する。

## 6. Deliverables

- 許可されたサービスを新規の未保存フォームへ複製。新しい管理コード・作成意図キーで通常保存する。
- 管理者が版管理する共有質問セット。編集者は挿入時コピーし、質問/セクション/条件参照をまとめて新キーへ変換する。
- `catalog_editor`の組織ロール。既存の管理者限定・理由/期限/監査付き付与経路で委任する。全体staff権限には追加しない。
- 保存済みownerに基づく自身の下書き編集だけを許可。owner変更と公開は管理者だけ。APIのcapabilityでUIを制御する。
- ownerId/fulfillmentGroupId/checklistを任意の版属性として保存。現行の責任者・内容更新時刻・未公開変更・公開前確認を一覧へ表示する。
- 公開定義から解決した担当グループへ申請チケットを初期配置。作業進捗は申請revision別・独立versionで保存し、必須完了を模擬完了のサーバー条件に加える。

## 7. Acceptance Criteria

- [x] 複製を開くだけでは書込みせず、保存で独立した非公開サービスを1件作成できる。
- [x] 共有セットを作成/更新/挿入でき、キー衝突と条件参照を解決し、上限超過でも編集中入力を失わない。元セット更新が既存サービス・申請へ波及しない。
- [x] 編集者は自身の下書きのみ作成/編集でき、他者や別組織の直接URL/POST、owner偽装、公開、権限付与を拒否される。期限切れ/取消でも拒否する。
- [x] 管理者は既存の理由・期限付き委任UIで編集権限を付与/取消でき、公開は管理者だけが行う。
- [x] 責任者・グループは同組織の有効候補から選び、申請時もグループを再検証する。requesterの役割を偽装せず初期stateはnewを維持する。
- [x] チェック進捗を更新してもsnapshot/hash/申請versionを変えず、必須未完了・未知項目・古いversionをサーバーが拒否する。内容改訂では新進捗を開始し旧履歴を保持する。
- [x] 旧データ・既存認可と申請定義固定を維持し、新表にはRLS/組織FK/必要な不変性/監査を付ける。
- [x] 関連unit/型/lint/check:all/build、実API/PGの権限境界・RLS・履歴、PC/375pxのChrome/WebKit・キーボード・axeと画像を確認する。

## 8. Verification and Evidence

`evidence/WP-P2-UIX-041/`。ローカルの新規合成データのみを使用する。既存全体unit失敗は基点と照合して分離し、テスト削除・skipで通さない。権限付与の実測は合成ユーザーに限定し、終了時に取り消す。

## 9. Security and Audit

認可変更を含むため人間レビューが必要（AGENTS §1.16）。コード・テスト・ローカル証拠を具体化した上でreviewへ渡し、自動レビューを人間承認として扱わない。公開/権限付与は管理者だけ、対象owner判定はlock後の保存値、初期routingは公開定義とDB候補から解決し、ユーザー入力を特権パラメータに流さない。

## 10. Rollback / 失敗時の扱い

Migration0036。新データがある場合、表のdropやロール消去による損失を伴うdownは拒否し、readerとデータを保持した前方互換rollbackを用いる。既存版・申請・監査を消さない。開発環境停止でdownしない。

## 11. References

[[03.5_Catalog_and_Approval_Requirements]], [[03.13_UX_Accessibility_Requirements]], [[02.18_Organization_Data_Model_and_RLS]], [[ADR-0015_Organization_Isolation_and_RLS]], [[ADR-0021_Catalog_Delegation_And_Fulfillment]], [[WP-P2-UIX-040]]。

## 12. Definition of Done

§7と検証コマンド、Migration/rollback、変更一覧、セキュリティ影響、残課題を§13へ記録。人間レビューと既存全体ゲートの未完了を残したままDoneにはしない。

## 13. Execution Log

- 2026-11-10: 優先度2を検証・ローカルコミット後、追加指示された優先度3を別branchで開始。

- 実装: §4のsource/API/画面/検証ツール・テストを追加変更。複製・共有セット・owner編集制約・管理一覧情報・初期routing・独立チェック進捗を通した。全体staffへcatalog_editorを混ぜず、cap欠落時はUIも拒否する。
- Migration0036をローカルへ適用、checksum一致。共有版/進捗表に組織FKとRLS FORCE。共有版は不変、進捗は楽観versionと変更前後の監査付き。新データ存在時のunsafe downは拒否する。新依存なし。
- 独立レビューで複製の候補再取得URLがcopyFromを落とす問題を修正。owner候補はeditorへ自分だけを返す。承認/hash/revision整合・現在有効な承認者をチェック更新時も再確認。WebKit375で長い共有set選択名がはみ出す問題はgridとselect自身の省略表示で解消し、全文と読み上げ名は維持した。
- 実API検証で取消直後の59msのDB/ホスト時計差を発見。AuthController.authenticateでDB clockをAuthzContext.nowへ渡してRoleBindingの期間評価を統一し、Session寿命/idleは維持。host前後/future valid_from/expiry/再読込/clock欠落の7テストと取消直後403で確認した。
- コマンド: `rtk proxy npx vitest run tests/unit/catalog-*.test.ts tests/unit/portal-catalog.test.ts tests/unit/user-directory.test.ts tests/unit/auth-role-clock.test.ts`（16files586件成功）、`rtk npm run typecheck`、`rtk npm run lint`、`rtk npm run check:all`、`rtk npm run build`、変更source/test/toolのPrettier、追加・変更テストのstrict tsc（すべて成功）。
- 全体: `rtk npm run test:unit -- --reporter=json --outputFile=.local/fix-041/unit.json`は4174成功・既存34失敗と収集エラー1file。040の失敗名と一致、新規0。削除・skipなし。全体Gate成功としてDoneにはしない。
- `rtk proxy node --env-file=.env tools/smoke_catalog_operations.mjs`は14項目成功。実API/PGのrole/owner/別組織/期限/取消、共有版独立と競合、初期routing・state維持、required作業gate/hash/q.version不変、旧revision進捗保持、RLSと不変性を検証。合成userだけへgrantし取消済み、catalog非公開/group無効化済み。失敗試行は既存fixturesを照合して再利用し、余分な作成をしなかった。
- `rtk proxy node tools/ui_catalog_operations_check.mjs`（WebKitは`SOLVI_UI_BROWSER=webkit`、資格情報は非出力env）はChrome157/WebKit26.5各9checks/6axe違反0、PC/375横溢れ0、キーボード・共有/clone/申請/承認/作業/模擬完了を確認。各3catalog/1set/1request、既存サービスは不変更。後半再開の記録と読み取りだけの補足画像をEvidenceへ保存。
- セキュリティ影響: 新しい限定role・owner認可・正規監査event2件・role時計修正。人間レビューはpendingで、独立AIレビューを承認と扱わない。main反映なし。既存snapshot/承認/hash/Executor境界は維持。
- Evidence: `evidence/WP-P2-UIX-041/`。詳細はREADME/API smoke/browser summary/unit-summary/source-files。詳細ログはGit管理外`.local/fix-041/`。残課題は人間securityレビューと既存全体unit失敗。Safari/Edge製品実機は未実施。
