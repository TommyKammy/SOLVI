---
project: SOLVI
doc_id: "WP-P2-UIX-040"
title: "申請フォームの入力型・条件表示・セクション・業務カテゴリ"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-11-10"
updated: "2026-11-10"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "catalog", "forms"]
source_of_truth: true
implementation_status: "review"
story_points: 8
risk: "medium"
workstream: "UIX"
phase: "P2"
requirement_ids: ["FR-CAT-001", "FR-CAT-002", "FR-CAT-003", "NFR-UX-001", "NFR-UX-002", "NFR-UX-003", "NFR-UX-004"]
depends_on: ["WP-P2-UIX-028", "WP-P2-UIX-037"]
---

# WP-P2-UIX-040: 申請フォームの入力型・条件表示・セクション・業務カテゴリ

## 1. Purpose

利用者が指示した改善優先度2を実装する。日付・数値・複数選択、補足説明、条件付き表示、セクション、業務カテゴリを、作成・入力試験・保存・公開・申請・履歴まで通す。

## 2. Requirement IDs

`FR-CAT-001`, `FR-CAT-002`, `FR-CAT-003`, `NFR-UX-001`, `NFR-UX-002`, `NFR-UX-003`, `NFR-UX-004`。

## 3. Dependencies

[[WP-P2-UIX-028]], [[WP-P2-UIX-037]]はdone。実装基点はmain反映済み`0e1aa3e`。[[WP-P2-UIX-039]]の機能と証拠を継承するが、同WPは全体テストの既存失敗によりreviewのまま維持し、本WPでDoneへ変更しない。永続化契約は[[ADR-0020_Catalog_Form_Definition_Extensions]]で定義する。

## 4. Scope / Allowed Paths

- `packages/shared/src/catalog.ts`
- `packages/shared/package.json`
- `services/api/src/modules/catalog/catalog-definition.ts`
- `services/api/src/modules/catalog/catalog.routes.ts`
- `apps/web/src/lib/api.ts`
- `apps/web/src/lib/catalog-form.ts`
- `apps/web/src/lib/catalog-preview.ts`
- `apps/web/src/lib/catalog-templates.ts`
- `apps/web/src/lib/portal-overview.ts`
- `apps/web/src/components/CatalogAdminForm.tsx`
- `apps/web/src/components/CatalogAdminForm.module.css`
- `apps/web/src/components/CatalogFieldInputs.tsx`
- `apps/web/src/components/CatalogFieldInputs.module.css`
- `apps/web/src/components/CatalogValueSummary.tsx`
- `apps/web/src/components/CatalogLivePreview.tsx`
- `apps/web/src/components/CatalogLivePreview.module.css`
- `apps/web/src/components/RequestForms.tsx`
- `apps/web/src/app/catalog/manage/actions.ts`
- `apps/web/src/app/catalog/page.tsx`
- `apps/web/src/app/catalog/[itemId]/page.tsx`
- `apps/web/src/app/requests/actions.ts`
- `apps/web/src/app/requests/[id]/page.tsx`
- `tests/unit/catalog-definition.test.ts`
- `tests/unit/catalog-request-fields-ui.test.ts`
- `tests/unit/catalog-priority-two-ui.test.ts`
- `tests/unit/catalog-authoring-ui.test.ts`
- `tests/unit/catalog-edit-ui.test.ts`
- `tests/unit/catalog-preview.test.ts`
- `tests/unit/portal-catalog.test.ts`
- `tools/smoke_catalog_fields.mjs`
- `tools/ui_catalog_schema_check.mjs`
- `docs/planning/03_Requirements/03.5_Catalog_and_Approval_Requirements.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-040.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/07_ADR/ADR-0020_Catalog_Form_Definition_Extensions.md`
- `docs/planning/07_ADR/07.0_ADR_Index.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-UIX-040/`

## 5. Out of Scope

実リソース操作、認証・認可・RLSの変更、共有項目管理、作成権限の委任、ユーザー参照型、汎用条件式・Workflow、既存版の書換え、外部Freshserviceへの書込み、新しい依存パッケージ。既存の理由・利用日数・固定承認の模擬申請契約と最大10質問は維持する。

## 6. Deliverables

- 副作用・Node依存のない共有定義・検証モジュール。旧定義へ既定キーを挿入しない。
- date（日付と任意の上下限）、number（有限数と任意の上下限）、multiselect（候補内の複数選択）。
- helpText、section参照、select/checkboxとの単一一致条件visibleWhen。循環・不正参照を保存時に拒否する。
- 業務カテゴリはdefinition.category。未設定は表示時のみ「未分類」。旧target URLを維持し、新category URLと模擬対象を分離する。
- 編集、プレビュー、申請、復元、現行・履歴の表示、サーバー検証、実PG/API・ブラウザの証拠。

## 7. Acceptance Criteria

- [x] 新3型・補足・セクション・条件・カテゴリを内部キー入力なしで作成し、保存・再読込・公開できる。
- [x] 非表示の必須質問を要求せず、古い非表示値を再表示・保存で復活させず、サーバーも非表示値を除く。
- [x] 不正日付、範囲外/非有限/不正型の数値、未知/重複選択、循環・不正参照をクライアント迂回でも拒否する。
- [x] 未保存入力と全メタデータがdirty判定対象となり、既存の保存・公開pending排他と失敗時の入力保持が維持される。
- [x] 旧4型・旧URL・旧snapshotの表示/再送は互換。新版のカテゴリ・質問変更が過去申請の定義・入力・hash・承認を変えない。
- [x] 利用者一覧は認可済み公開アイテムの業務カテゴリで検索・絞込みでき、targetLabelを分類へ推測しない。
- [x] 型、関連unit、lint、check:all、本番ビルド、実API/PGの組織境界とsnapshot、Chrome/WebKitのPC/375px・キーボード・axeを確認する。

## 8. Verification and Evidence

`evidence/WP-P2-UIX-040/`。既存の全体unit34失敗と収集エラーは別記し、新規失敗を比較する。検証はローカル合成データだけを作成し、既存サービスを変更しない。

## 9. Security and Audit

サーバーを検証の正本とし、同じ純粋検証をプレビューでも用いる。未知キーは拒否、非表示値は保存せず、既存の組織認可/RLS・自己承認禁止・監査を維持。新しい特権経路なし。

## 10. Rollback / 失敗時の扱い

DDL/Migrationなし。新形式の読取・検証を残して編集UIを戻す。新形式保存後に旧strict readerへ戻さない。旧版・旧申請を改変せず、検証データも非公開で区別する。

## 11. References

[[03.5_Catalog_and_Approval_Requirements]], [[03.13_UX_Accessibility_Requirements]], [[ADR-0020_Catalog_Form_Definition_Extensions]], [[WP-P2-UIX-028]], [[WP-P2-UIX-039]]。

## 12. Definition of Done

§7の証拠、変更・Migration/rollback・検証コマンド・セキュリティ影響・未解決事項を§13に記録。既存全体失敗を隠してDoneとはしない。

## 13. Execution Log

- 2026-11-10: 優先度2の実装指示に基づき開始。現行JSONBへの任意属性追加と共有検証で、旧版を移行せず拡張する。

- 実装: 共有のcatalog定義・純粋検証subpath、7入力型、補足説明・DAG条件・セクション・カテゴリ。管理Editor/保存/入力試験/公開一覧/申請/復元/凍結summaryを一貫して拡張した。変更一覧は§4のうち新検証ツールを含む全対象とEvidenceを参照。
- PC貸与テンプレートを9質問・2セクションへ更新。返却希望日は一時貸出だけ、希望台数は数値、周辺機器は複数選択。既存サービス・既存申請は変更しない。
- 独立レビューで任意補足を空へ戻した際の偽dirty、条件元を型変更した際のselect表示と実値の不一致、任意カテゴリ空白の保存/試験不一致を修正。制約メッセージも共有schemaで日本語化した。フォームのobject key順だけではdirtyにしない。
- コマンド: `rtk proxy npx vitest run tests/unit/catalog-*.test.ts tests/unit/portal-catalog.test.ts`、`rtk npm run typecheck`、`rtk npm run lint`、`rtk npm run check:all`、`rtk npm run build`、変更TS/TSX/test/toolのPrettier checkとstrict standalone test型check。関連unit・型・lint・構造検査・本番ビルド成功。全体unitの集計/比較はEvidenceのunit-summary.jsonに記録し、既存失敗を隠さない。
- 実API/PG: `rtk proxy node --env-file=.env tools/smoke_catalog_fields.mjs`（資格情報は非出力の環境変数）。7項目成功。新型server拒否、hidden値除去、0保持、multi再送正規化、新catalog版に対する旧申請snapshot/hash/承認/history不変、別組織API404とRLS3表0件を確認。合成catalog1件を検証後非公開へ戻した。
- ブラウザ: `rtk proxy node tools/ui_catalog_schema_check.mjs`（WebKitは`SOLVI_UI_BROWSER=webkit`、資格情報は非出力）。Chrome157/WebKit26.5各9検査、各5画面のaxe違反0、1440px/375px横溢れ0、キーボード・preview Enter書込み0。各1件の新規合成catalog保存/公開/申請で型と条件をsnapshotまで確認した。WebKitのhydration待機不備は既存fixtureを照合して申請部分のみ再開し、重複作成/公開なし。最終テンプレート画像は追加の読み取りのみで確認。
- Migrationなし。新しい依存パッケージなし。認可/RLS/監査/Executor経路の変更なし。共有package exportだけを追加。rollbackはADR0020のとおり新形式readerを保持する。既存全体unitの34失敗と収集エラーが残るためreviewを維持。
- Evidence: `evidence/WP-P2-UIX-040/`、詳細ログはGit管理外`.local/fix-040/`等。Safari/Edge製品実機は未実施。続く優先度3は別WP/branchで扱う。
