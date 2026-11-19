---
project: "SOLVI"
doc_id: "WP-P2-UIX-056"
title: "サービス管理を採用モックアップの構成に合わせる"
category: "06_WorkPackages"
type: "work-package"
status: "baseline"
version: "0.1.0"
created: "2026-11-20"
updated: "2026-11-20"
owner: "SOLVI Product Team"
tags: ["ui", "service-management", "responsive"]
source_of_truth: true
implementation_status: "review"
workstream: "UIX"
phase: "P2"
risk: "low"
story_points: 8
requirement_ids: ["NFR-UX-002", "NFR-UX-003", "NFR-UX-004"]
depends_on: ["WP-P2-UIX-044", "WP-P2-UIX-046"]
---

# WP-P2-UIX-056 サービス管理を採用モックアップの構成に合わせる

## 1. Purpose

「サービス管理」から開くナレッジ、カタログ・申請、資産台帳・CSV、変更管理を採用HTMLに揃える。公開記事などの共用画面も対象とする。

## 2. Requirement IDs

`NFR-UX-002`、`NFR-UX-003`、`NFR-UX-004`。

## 3. Dependencies

[[WP-P2-UIX-044]] と [[WP-P2-UIX-046]] はbaseline・done。基点 `7b84215` で稼働中の機能、認可とフォーム契約を使用する。検証シナリオは §11 の各機能WPを参照する。

## 4. Scope / Allowed Paths

- `apps/web/src/app/assets/[id]/edit/page.tsx`
- `apps/web/src/app/assets/[id]/page.tsx`
- `apps/web/src/app/assets/assets.module.css`
- `apps/web/src/app/assets/imports/[id]/page.tsx`
- `apps/web/src/app/assets/imports/new/page.tsx`
- `apps/web/src/app/assets/imports/page.tsx`
- `apps/web/src/app/assets/new/page.tsx`
- `apps/web/src/app/assets/page.tsx`
- `apps/web/src/app/catalog/[itemId]/page.tsx`
- `apps/web/src/app/catalog/manage/[id]/page.tsx`
- `apps/web/src/app/catalog/manage/new/page.tsx`
- `apps/web/src/app/catalog/manage/page.tsx`
- `apps/web/src/app/catalog/manage/question-sets/page.tsx`
- `apps/web/src/app/catalog/page.tsx`
- `apps/web/src/app/changes/[id]/edit/page.tsx`
- `apps/web/src/app/changes/[id]/page.tsx`
- `apps/web/src/app/changes/changes.module.css`
- `apps/web/src/app/changes/new/page.tsx`
- `apps/web/src/app/changes/page.tsx`
- `apps/web/src/app/freshservice.css`
- `apps/web/src/app/knowledge/[id]/page.tsx`
- `apps/web/src/app/knowledge/new/page.tsx`
- `apps/web/src/app/knowledge/page.tsx`
- `apps/web/src/app/requests/[id]/page.tsx`
- `apps/web/src/app/requests/page.tsx`
- `apps/web/src/components/AssetCsvForms.tsx`
- `apps/web/src/components/CatalogAdminForm.module.css`
- `apps/web/src/components/ChangeForms.tsx`
- `apps/web/src/components/KnowledgeEditor.module.css`
- `apps/web/src/components/KnowledgeEditor.tsx`
- `apps/web/src/components/ServicePageHeading.tsx`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-056.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-UIX-056/`
- `tests/unit/assets-import-history-ui.test.ts`
- `tests/unit/assets-ui.test.ts`
- `tests/unit/changes-ui.test.ts`
- `tests/unit/knowledge-search-page.test.ts`

## 5. Out of Scope

API、DB、権限、既存検索の条件と範囲、公開・承認・取込・変更の状態遷移、外部実行。自動化の操作は実装済みのチケット・申請からの導線を使用する。

## 6. Deliverables

ナレッジの検索欄・件数・結果行・空表示・記事の本文と情報欄。カタログと申請の行リンク、作成・編集のフォームと補助情報。資産台帳・CSV履歴・変更一覧の表、詳細と操作欄。採用HTMLの密度、行の反応とPC・モバイルの配置を参照する。

## 7. Acceptance Criteria

- AC-1 PC 1440px、モバイル375pxのChromeでサービス管理の入口と作成画面を採用HTMLと比較し、見出し、検索、結果、操作列を確認する。ナレッジの行のホバーとフォーカスを確認する。
- AC-2 隔離環境でナレッジ下書き・公開・検索（0件と公開範囲を含む）、カタログ公開・申請・承認、資産CSVプレビュー・確定と関連変更の実施後レビューを確認する。
- AC-3 両幅でページ外への横はみ出し、キーボード操作、axeを検査する。型、lint、ユニット、ガバナンスの結果と画面の比較画像を保存する。

## 8. Verification and Evidence

開発版で表示を計測し、業務操作は隔離PostgreSQLと合成ユーザーで検証する。

## 9. Security and Audit

既存のサーバー側認可と操作を使用する。

## 10. Rollback

マイグレーションなし。コミットのrevertで元の表示に戻す。

## 11. References

[[11.3_Design_System]]、[[11.13_Mockup_Asset_Index]]、[[03.13_UX_Accessibility_Requirements]]、[[WP-P3-KNWUI-060]]、[[WP-P4-APR-022]]、[[WP-P7-CHGUI-005]]。

## 12. Definition of Done

§7の比較画像と検証結果を添えてレビューへ提出する。

## 13. Execution Log

- 2026-11-20 採用HTMLと実装済みのサービス管理導線を照合した。

- 変更箇所は§4のWeb画面、共通見出し、ナレッジ編集、カタログ編集CSS、CSV入力と変更計画フォーム、共有CSS、各一覧のCSSと表示テスト。VaultのWP・登録表・依存関係・RTM・Manifestを更新した。既存テストでは意図した見出し文言、列分割と行セマンティクスに関するアサーションを更新し、権限・検索・復帰先の検査を継続した。
- AC-1 採用HTMLとSOLVIの15画面を1440px・375pxで比較した。両幅で見出しのサイズと太さ、ナレッジ検索ボタンとの下端、取込・変更計画の列位置を照合した。PCで記事のホバー・フォーカスの背景色を比較した。ポート3000で同じ読み取り検査を実行した。
- AC-2 隔離環境で両幅の記事公開と範囲変更、0件、カタログの条件付き質問の保存・プレビュー・公開・申請・判断、CSVプレビューのエラー行・正常行取込と変更の承認・結果・PIRを確認した。PCは承認・実施成功、モバイルは申請却下・変更失敗の記録も確認した。
- AC-3 比較30条件と操作時64条件でaxe違反・判定保留0件、ページ全体の横はみ出し0px。PCはキーボード、モバイルはChromeのタッチエミュレーションを使用した。型検査、lint、ユニット（4,899件合格・既存skip 26件）、ガバナンス、本番向けビルドに合格した。
- セキュリティ影響なし。既存の認可・監査とサーバー操作を使用する。Migrationなし。変更コミットのrevertで元の表示に戻る。製品の受入レビュー待ち。
- Evidenceは `evidence/WP-P2-UIX-056/20261120-0810/`。画面比較、計測、各業務の結果、実行ログと再現手順を保存した。

```zsh
rtk proxy npm run typecheck
rtk proxy npm run lint -- --ignore-pattern '.claude/**'
rtk proxy npm run test:unit -- --reporter=json --outputFile="$qa_tmp/final-unit.json"
rtk proxy npm run check:all
rtk proxy node --env-file=.env "$qa_tmp/qa/stack.mjs" prepare "$qa_database"
rtk proxy node "$qa_tmp/qa/knowledge/capture.mjs" "$qa_tmp/final/knowledge" 03
rtk proxy node "$qa_tmp/qa/catalog/capture.mjs" "$qa_tmp/final/catalog"
rtk proxy node "$qa_tmp/qa/asset/capture.mjs" "$qa_tmp/final/asset" 03
rtk proxy node "$qa_tmp/compare.mjs" "$qa_tmp/final/compare" after http://127.0.0.1:3260 http://127.0.0.1:3261
rtk proxy node "$qa_tmp/compare.mjs" "$qa_tmp/final-live" after
```
