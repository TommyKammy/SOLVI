---
project: SOLVI
doc_id: "WP-P2-UIX-039"
title: "カタログ作成の手順化と編集中フォームの入力試験"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-11-10"
updated: "2026-11-10"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "catalog", "ui", "preview"]
source_of_truth: true
implementation_status: "review"
story_points: 5
risk: "medium"
workstream: "UIX"
phase: "P2"
requirement_ids: ["NFR-UX-001", "NFR-UX-002", "NFR-UX-003", "NFR-UX-004", "FR-CAT-002", "FR-CAT-003"]
depends_on: ["WP-P2-UIX-028", "WP-P2-UIX-037"]
---

# WP-P2-UIX-039: カタログ作成の手順化と編集中フォームの入力試験

## 1. Purpose

利用者が承認した改善優先順位の第1段階。PC貸与申請を基準に、既存の4種類の入力型・固定承認・ローカル模擬申請のまま、作成手順と未保存プレビュー・入力試験を改善する。

## 2. Requirement IDs

`NFR-UX-001`, `NFR-UX-002`, `NFR-UX-003`, `NFR-UX-004`, `FR-CAT-002`, `FR-CAT-003`

## 3. Dependencies

[[WP-P2-UIX-028]], [[WP-P2-UIX-037]]はdone。既存の下書き保存・公開排他制御、申請時点の定義固定を維持する。

## 4. Scope / Allowed Paths

- `apps/web/src/components/CatalogAdminForm.tsx`
- `apps/web/src/components/CatalogAdminForm.module.css`
- `apps/web/src/components/AppFrame.tsx`（375pxで作成リンクの読み上げ名が失われる不具合の修正のみ）
- `apps/web/src/components/CatalogLivePreview.tsx`
- `apps/web/src/components/CatalogLivePreview.module.css`
- `apps/web/src/lib/catalog-preview.ts`
- `tests/unit/catalog-authoring-ui.test.ts`
- `tests/unit/catalog-edit-ui.test.ts`
- `tests/unit/catalog-preview.test.ts`
- `tools/ui_catalog_authoring_check.mjs`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-039.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-UIX-039/`

## 5. Out of Scope

新しい入力型・カテゴリ・共有項目のデータモデル、編集者権限、API/DB/Migration/認可、実リソース操作、汎用Workflow、Freshserviceへの書込み。

## 6. Deliverables

- 基本情報、申請フォーム、承認と検証設定、確認・保存の作業領域と移動導線。
- 全編集入力を保持したまま移動できる構成。入力例・説明ガイド・内部キーの詳細表示。
- 編集フォーム外のライブプレビューと非送信の入力試験。保存済みプレビュー・公開版と明確に区別。
- 既存の保存・公開・pending・dirty・競合・冪等キーを維持する回帰検証。

## 7. Acceptance Criteria

- [x] PC貸与テンプレートから、内部キーを手入力せず新しい下書きを作成できる。
- [x] 作業領域間の移動と項目の並べ替えで値・保存payloadを失わない。
- [x] 編集した名前・説明・4種類の項目が未保存プレビューへ反映され、保存済み版は変わらない。
- [x] 入力試験が必須・長さ・候補・チェックを検証し、Enterでも保存・公開・申請を送信しない。
- [x] プレビュー入力は編集のFormDataへ混入せず、複数プレビューでIDが重複しない。
- [x] 未保存・保存中・公開中の既存の排他制御を維持する。
- [x] 375px/デスクトップで表示・キーボード・axeを確認し、関連ユニット・型・lint・check:all・本番ビルドが成功する。
- [x] API・DB・認可・既存申請を変更しない。

## 8. Verification and Evidence

追加ユニットと既存catalog関連テスト、ローカル実ブラウザで確認。入力試験中の業務書込み0、下書き保存は検証専用の新規合成データだけを対象とする。
Evidence: `evidence/WP-P2-UIX-039/`。

## 9. Security and Audit

プレビューはローカルの入力試験であり認可やサーバー検証を代替しない。保存・公開の既存経路を維持する。資格情報・実PIIを出力しない。

## 10. Rollback / 失敗時の扱い

表示層の変更と追加プレビューを戻す。Migrationなし。検証用下書きは非公開のまま残し、既存サービスは変更しない。

## 11. References

[[03.5_Catalog_and_Approval_Requirements]], [[03.13_UX_Accessibility_Requirements]], [[WP-P2-UIX-028]]。

## 12. Definition of Done

§7・検証コマンド・変更一覧・残課題・Evidenceを§13へ記録。全体テストの既存失敗は別記し、全体ゲートの成功と混同しない。

## 13. Execution Log

- 2026-11-10: 利用者の実装開始指示に基づき第1段階を開始。
- 2026-11-10: `CatalogAdminForm.tsx/.module.css`へ4領域の移動導線、説明ガイド、内部キー自動生成・詳細表示、質問の並べ替えを実装。全編集入力を保存フォーム内に保ち、未保存のプレビューをフォーム外へ分離した。
- 追加: `CatalogLivePreview.tsx/.module.css`、`lib/catalog-preview.ts`、`catalog-authoring-ui.test.ts`、`catalog-preview.test.ts`、`ui_catalog_authoring_check.mjs`。`catalog-edit-ui.test.ts`はキー編集の旧ケースを不変キーの検証へ更新し、既存のdirty/pending検証は維持した。
- 独立レビューで質問の型変更時に古い試験値が残る問題を検出。型変更・無効候補・削除値を除き、表示と検証の値を統一して7件の回帰テストを追加。再レビューの追加指摘なし。
- 375pxの実ブラウザ検証で共通ヘッダーの作成リンク名が消えることを確認。Allowed Pathsへ`AppFrame.tsx`の当該修正のみを追加し、明示の読み上げ名を付けた。
- 検証コマンド: `rtk proxy npx vitest run tests/unit/catalog-*.test.ts`（7ファイル304件成功）、`rtk proxy npx vitest run tests/unit/support-portal-ui.test.ts`（21件成功）、`rtk npm run typecheck`、`rtk npm run lint`、変更したソース・テスト・ツールの`rtk proxy npx prettier --check`、`rtk npm run check:all`、`rtk npm run build`（すべて成功）。追加・変更した3テストファイルは`rtk proxy npx tsc --noEmit --strict --target ES2022 --module esnext --moduleResolution bundler --jsx react-jsx --esModuleInterop --skipLibCheck apps/web/next-env.d.ts tests/unit/catalog-authoring-ui.test.ts tests/unit/catalog-edit-ui.test.ts tests/unit/catalog-preview.test.ts`でも成功。
- 全体: `rtk npm run test:unit -- --reporter=json --outputFile=.local/fix-039/unit.json`は3937成功・34失敗、ほかに1ファイル収集エラー。WP038の基準記録と失敗名が完全一致、新規失敗0。削除・skip・ガード無効化なし。全体ゲート合格としてDoneにはしない。
- 実ブラウザ: `rtk proxy node tools/ui_catalog_authoring_check.mjs`（資格情報は非出力の環境変数、WebKitでは`SOLVI_UI_BROWSER=webkit`）。Chrome157とWebKit26.5それぞれ11項目成功、各3画面のaxe違反0。375px横溢れ0、キーボード・ID分離・入力試験中の業務書込み0・保存payload・dirty/pendingを確認。AC上6項目はユニットと実ブラウザの双方で、公開中の排他は既存回帰テストで検証した。
- 保存結果が不確定になった検証ツール試行は読み取り照合し、Chromeの作成済み合成下書きを再利用。最終的な新規作成は各ブラウザ1件で、非公開のまま保持。既存サービス・申請・Freshserviceへの書込みなし。
- Migrationなし。ロールバックは本WPの表示層変更を戻す。セキュリティ影響: 認可・サーバー検証の変更なし。プレビューはローカル試験のみ。計画台帳・依存図・RTM・MANIFESTも更新。
- 未解決: 全体ユニットの既存失敗。Safari/Edge製品実機は未実施。新しい入力型・カテゴリ・共有項目・条件付き表示・編集権限は後続段階。
- Evidence: `evidence/WP-P2-UIX-039/README.md`、ブラウザ別`summary.json`とスクリーンショット、`unit-summary.json`。詳細ログはGit管理外`.local/fix-039/`。
