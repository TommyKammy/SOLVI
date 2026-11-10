---
project: SOLVI
doc_id: "WP-P2-UIX-042"
title: "サービス別の共通項目表示と回答による質問の分岐"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-11-11"
updated: "2026-11-11"
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

# WP-P2-UIX-042: サービス別の共通項目表示と回答による質問の分岐

## 1. Purpose

利用する理由・希望する利用日数をサービスごとに表示ON/OFFし、必要なアイテムのチェックボックス選択と回答による後続質問の分岐を作成できるようにする。依頼されたFreshserviceのitems/83（機器の複数選択と情報のセクション）とitems/52（申請内容によるURL・日付の表示）を実画面で確認した。第三者の実データは取り込まず、合成例として実装する。

## 2. Requirement IDs

`FR-CAT-001`, `FR-CAT-002`, `FR-CAT-003`, `NFR-UX-001/002/003/004`。

## 3. Dependencies

[[WP-P2-UIX-028]], [[WP-P2-UIX-037]]はdone。実装基点はローカルコミット`5c196fd`。[[WP-P2-UIX-040]]/[[WP-P2-UIX-041]]の関連検証済みフォーム基盤を利用するが、両WPのreview状態・041の人間securityレビュー待ちを変更せず、main公開も本作業に含めない。新たな認証・認可・特権操作には踏み込まない。定義の任意属性追加は[[ADR-0022_Catalog_Optional_Request_Fields]]を根拠とする。

## 4. Scope / Allowed Paths

- `packages/shared/src/catalog.ts`
- `services/api/src/modules/catalog/catalog-definition.ts`
- `services/api/src/modules/catalog/catalog.routes.ts`
- `apps/web/src/lib/api.ts`
- `apps/web/src/lib/catalog-preview.ts`
- `apps/web/src/lib/catalog-form.ts`
- `apps/web/src/lib/catalog-templates.ts`
- `apps/web/src/components/CatalogAdminForm.tsx`
- `apps/web/src/components/CatalogAdminForm.module.css`
- `apps/web/src/components/CatalogLivePreview.tsx`
- `apps/web/src/components/CatalogLivePreview.module.css`
- `apps/web/src/components/RequestForms.tsx`
- `apps/web/src/app/catalog/manage/actions.ts`
- `apps/web/src/app/requests/actions.ts`
- `apps/web/src/app/requests/[id]/page.tsx`
- `tests/unit/catalog-flexible.test.ts`
- `tests/unit/catalog-flexible-ui.test.ts`
- `tests/unit/catalog-flexible-templates.test.ts`
- `tests/unit/catalog-authoring-ui.test.ts`
- `tests/unit/catalog-preview.test.ts`
- `tests/unit/catalog-priority-two-ui.test.ts`
- `tests/unit/catalog-reuse.test.ts`
- `tests/unit/portal-catalog.test.ts`
- `tools/smoke_catalog_flexible.mjs`
- `tools/ui_catalog_flexible_check.mjs`
- `docs/planning/03_Requirements/03.5_Catalog_and_Approval_Requirements.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-042.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/07_ADR/ADR-0022_Catalog_Optional_Request_Fields.md`
- `docs/planning/07_ADR/07.0_ADR_Index.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-UIX-042/`

## 5. Out of Scope

実リソース操作、第三者サービスへの申請・書込み、汎用条件式/Workflow、独自スクリプト、認可/ロール/RLS/監査契約の変更、依存追加、既存サービスの自動上書き、mainへのpush。

## 6. Deliverables

- `requestFields?: {reason?: boolean; duration?: boolean}`を版属性として追加。省略時は現行どおり表示・必須。OFF値を空文字/仮の日数で補わず、新申請のinputsから除去する。
- プレビューと申請で表示・必須判定を統一し、サーバーも保存された定義で判定。再送は元の固定版で正規化して比較し、公開定義更新の影響を受けない。
- 既存select/checkboxのequalsに加え、multiselectのcontainsによる条件を提供。既知候補・参照・型・循環を検証し、非表示の必須判定と古い回答を除去する。
- 作成画面に共通項目ON/OFF、複数選択・分岐の設定導線と合成テンプレートを用意。既存の複製・質問セット挿入は条件参照を維持する。
- 詳細・承認履歴・チケット本文・模擬結果で存在しない共通項目を表示しない。旧snapshot/hash/承認は無変更。

## 7. Acceptance Criteria

- [x] 両項目のON/OFF4組合せを保存・再読込・プレビューでき、未設定サービスは従来どおり表示・必須になる。
- [x] OFFの項目なしで申請・改訂でき、直接APIの余分なOFF値もsnapshotへ入らない。ONの空/不正値はサーバーで拒否する。
- [x] 機器を複数チェックでき、選択に応じる後続質問を表示できる。選択解除時には子孫も非表示となり、古い回答を送らない。
- [x] select分岐・checkbox分岐・multiselect分岐を保存/再読込でき、未知候補・不正な演算子・自己参照・循環を拒否する。
- [x] 公開設定更新後も既存申請/承認履歴/hashを維持し、同一作成キーの再送が重複せず、改訂は固定定義を使う。
- [x] 関連unit/型/lint/check:all/build、実API/PG、Chrome/WebKitで1440/375px、キーボード、axe、画像Evidenceを確認する。

## 8. Verification and Evidence

`evidence/WP-P2-UIX-042/`。既存合成アカウントと新規合成サービスだけを利用する。既存の全体unit失敗34件と収集エラー1fileを基点と照合し、新規失敗を分離する。skip/削除でゲートを通さない。

## 9. Security and Audit

認証・認可・RLS・固定承認・hash規則・Executor境界は変更しない。非表示はUI/データ収集の設定であってアクセス制御ではない。送信の認可と定義の検証は従来どおりAPIが担当する。041のsecurityレビュー待ちは継続する。

## 10. Rollback / 失敗時の扱い

DDL/Migrationなし。任意の定義属性とinputsを既存JSONへ保存する。旧snapshotは書き換えない。新定義保存後は新形式readerを残した前方互換rollbackとし、旧strict schemaへ単純に戻さない。

## 11. References

[[03.5_Catalog_and_Approval_Requirements]], [[03.13_UX_Accessibility_Requirements]], [[ADR-0020_Catalog_Form_Definition_Extensions]], [[ADR-0022_Catalog_Optional_Request_Fields]], [[WP-P2-UIX-040]], [[WP-P2-UIX-041]]。

## 12. Definition of Done

§7の各項目と検証結果、変更一覧、Migration/rollback、security影響、残課題を§13へ記録する。未達ゲートは明記してreviewとし、Doneを偽らない。

## 13. Execution Log

- 2026-11-11: ユーザーの具体的な追加要望をbaseline化。Freshserviceの2フォームを読取確認し、元の選択を復元、申請・実データ取得は行っていない。別branchで着手。
- 実装: §4のshared/API/DTO・編集/プレビュー/申請/詳細/履歴・新テンプレート・テスト/検証ツールを変更。共通項目4組合せ、OFF値の除去、旧定義の省略状態維持、containsとequalsの分岐、複製/質問セットの参照維持を実装。具体的な変更ファイルとSHA-256は`evidence/WP-P2-UIX-042/source-files.json`。
- 独立レビューで未保存の選択肢/条件の空白と保存後の解釈の差、および質問種類変更時の条件値の型不一致を修正。不正な演算子/候補/型/自己参照/循環を拒否し、UIから条件を選び直せることをテストした。
- 検証: `rtk proxy npx vitest run tests/unit/catalog-*.test.ts tests/unit/portal-catalog.test.ts tests/unit/user-directory.test.ts tests/unit/auth-role-clock.test.ts`は19files683件成功。`rtk npm run typecheck`、`rtk npm run lint`、変更テスト7filesのstrict tsc、Prettier、`rtk npm run check:all`、`rtk proxy env NODE_ENV=production npm run build`は成功。build時は開発サーバーを停止し、生成物を消してから再起動した。
- 全体: `rtk npm run test:unit -- --reporter=json --outputFile=.local/fix-042/unit.json`は4271成功・既存34失敗と収集エラー1file。041の失敗名と一致、新規失敗0。削除/skipなし。全体Gateの未達を維持してreviewとし、Doneにしない。
- 実API/PG: `rtk proxy node --env-file=.env tools/smoke_catalog_flexible.mjs`は10項目成功。1catalog/2requestsの合成データで、OFF値除去、直接APIの必須条件、含む条件と子孫除去、旧snapshot/hash/承認/履歴、元キー再送、固定定義改訂、模擬結果の欠落項目省略、別組織API404/RLS3tables0を確認。サービスは非公開へ戻した。
- ブラウザ: `rtk proxy node tools/ui_catalog_flexible_check.mjs`をChrome157/WebKit26.5で実行し、各9scenarios/axe9回違反0、1440/375px横溢れ0、キーボードを確認。各engine保存/公開/申請/改訂を各1回だけ行い、実データは利用していない。履歴hash検証スクリプトとナビゲーション遷移後の画像を読取照合して補正し、業務操作は再送していない。
- Migrationなし。互換rollbackは新形式readerと既存データを保持。セキュリティ影響は認証/認可/RLS/監査契約/Executorの変更なし。041のsecurity人間レビュー待ちを継続し、main反映なし。
- Evidenceは`evidence/WP-P2-UIX-042/`。未解決は既存全体unit、041の人間review、Safari/Edge製品実機の受入。ローカルWeb/APIは再起動して利用可能。
