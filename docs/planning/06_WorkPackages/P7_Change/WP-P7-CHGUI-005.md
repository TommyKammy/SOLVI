---
project: "SOLVI"
doc_id: "WP-P7-CHGUI-005"
title: "資産CSV取込から通常変更・実施後レビューまでの画面導線"
category: "06_WorkPackages"
type: "work-package"
status: "baseline"
version: "0.1.0"
created: "2026-11-19"
updated: "2026-11-19"
owner: "SOLVI Product Team"
tags: ["ui", "asset", "change", "accessibility"]
source_of_truth: true
implementation_status: "review"
workstream: "CHGUI"
phase: "P7"
risk: "low"
story_points: 8
requirement_ids: ["FR-AST-002", "FR-AST-005", "FR-CHG-002", "FR-CHG-003", "FR-CHG-005", "NFR-UX-002", "NFR-UX-003", "NFR-UX-004"]
depends_on: ["WP-P2-UIX-029", "WP-P2-UIX-043", "WP-P2-UIX-044"]
---

# WP-P7-CHGUI-005 資産CSV取込から通常変更・実施後レビューまでの画面導線

| 項目 | 値 |
|---|---|
| Phase | P7 |
| Workstream | CHGUI |
| Risk | low |
| Story Points | 8 |
| Suggested Owner | Frontend |
| Parallelizable | No |
| Gate | Gate 7の画面検証 |

## 1. Purpose

第5段階。CSVの行ごとの検査でエラーと除外理由を確認し、正常行を資産台帳に確定する。確定結果から対象資産を開き、その資産を保持した通常変更の計画を作成する。同じ計画で承認、予定確定、実施開始と結果の合成記録、実施後レビューを順に確認する。

## 2. Requirement IDs

`FR-AST-002`、`FR-AST-005`、`FR-CHG-002`、`FR-CHG-003`、`FR-CHG-005` と `NFR-UX-002`〜`NFR-UX-004` の画面導線。

## 3. Dependencies

[[WP-P2-UIX-029]]、[[WP-P2-UIX-043]]、[[WP-P2-UIX-044]] は baseline・done。現行のWeb/APIにはCSVのプレビュー・確定・明細別の資産ID、資産詳細からの計画作成、通常変更の計画版・承認・開始・結果・PIRがある。第4段階を含む `603d9a4` を基点に、これらの契約を使う。[[03.8_Asset_CMDB_Requirements]] と [[03.9_Change_Management_Requirements]] を根拠とする。

## 4. Scope / Allowed Paths

- `apps/web/src/app/freshservice.css`
- `apps/web/src/app/assets/page.tsx`
- `apps/web/src/app/assets/[id]/page.tsx`
- `apps/web/src/app/assets/imports/page.tsx`
- `apps/web/src/app/assets/imports/new/page.tsx`
- `apps/web/src/app/assets/imports/[id]/page.tsx`
- `apps/web/src/app/changes/page.tsx`
- `apps/web/src/app/changes/new/page.tsx`
- `apps/web/src/app/changes/[id]/page.tsx`
- `apps/web/src/components/AssetCsvForms.tsx`
- `apps/web/src/components/AssetImportInspection.tsx`
- `apps/web/src/components/AssetImportInspection.module.css`
- `apps/web/src/components/ChangeForms.tsx`
- `apps/web/src/components/RelatedChangePanel.tsx`
- `tests/unit/assets-import-detail-ui.test.ts`
- `tools/ui_asset_import_inspection_check.mjs`
- `docs/planning/06_WorkPackages/P7_Change/WP-P7-CHGUI-005.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P7-CHGUI-005/`

## 5. Out of Scope

API・DB・認可・監査・承認条件・外部連携・実環境への変更実行・カレンダー・標準変更と緊急変更。Gate 6・7全体の合格判定。

## 6. Deliverables

- 資産台帳からCSV入力、列確認、プレビューへ進める。PCとモバイルでエラー行を確認でき、確定結果から保存した資産を開ける。
- 資産詳細から対象を選択済みの通常変更を作成し、変更詳細と資産詳細を相互にたどれる。
- 変更詳細に計画版、対象資産、進捗、現在できる操作、保存した結果と実施後レビューを表示する。既存の版固定、承認の失効・再検証、状態遷移、冪等性、履歴を維持する。

## 7. Acceptance Criteria

- AC-1 正常1行・エラー1行のCSVで、行番号・除外理由とエラー絞り込みを確認する。プレビュー中は台帳に存在せず、確定後は正常行の資産だけが保存される。エラーだけのCSVには確定操作が表示されない。
- AC-2 確定結果の資産から変更計画を開き、選択済みの資産と元チケットを確認して下書き・承認依頼を保存する。対象資産IDが承認対象の計画と一致し、相互の詳細リンクから同じIDを開ける。
- AC-3 別セッションの指名承認者が同じ計画を承認する。担当者が予定確定・実施開始・結果・PIRを順に記録し、保存後に詳細・履歴から読み直せる。承認前に実施操作は表示されず、承認者に実施操作は表示されない。外部変更は0件の合成記録。
- AC-4 PC 1440pxのEnterとモバイル幅375pxのタップで全操作を通す。各対の資産ID・変更IDをもう一方の画面でも照合し、ライト・ダークのaxe、横はみ出し、スクリーンショットを記録する。

## 8. Verification and Evidence

合成ユーザーと隔離PostgreSQLでSOLVIのWeb本番ビルドとAPIを使う。ユニット、型検査、lint、check:allと、役割別の画面操作を記録する。

## 9. Security and Audit

登録・処理の判断は既存のAPIに従う。閲覧可能なデータと操作をAPIの応答から表示する。外部サービスへ接続しない。認可・監査・実行条件の変更はない。

## 10. Rollback

Migrationなし。Webの差分をrevertする。

## 11. References

[[03.8_Asset_CMDB_Requirements]]、[[03.9_Change_Management_Requirements]]、[[03.13_UX_Accessibility_Requirements]]、[[11.3_Design_System]]、[[ADR-0015_Organization_Isolation_and_RLS]]、[[WP-P2-UIX-029]]、[[WP-P2-UIX-043]]、[[WP-P2-UIX-044]]。

## 12. Definition of Done

§7の判定と証拠を記録してレビューに提出する。

## 13. Execution Log

- 2026-11-19 第5段階の差分と受入基準をベースライン化。

### 2026-11-19 実装・ローカル検証

- Webでは `apps/web/src/app/assets/` の一覧、資産詳細、CSV履歴・入力・取込詳細、`apps/web/src/app/changes/` の一覧・新規・詳細を更新。使用したコンポーネントは `AssetCsvForms.tsx`、`AssetImportInspection.tsx` と `AssetImportInspection.module.css`、`ChangeForms.tsx`、`RelatedChangePanel.tsx`。共通スタイルは `freshservice.css`。単体検査 `tests/unit/assets-import-detail-ui.test.ts` とプレビューのブラウザ検査 `tools/ui_asset_import_inspection_check.mjs` の表示期待を更新した。WP台帳、依存関係、要求トレーサビリティ、Manifestを更新。
- Migrationなし。ロールバックはWebの差分をrevertする。セキュリティ影響はなし。既存の認可、版固定、承認と予定の再検証、合成実施、監査・永続化の契約を利用した。
- AC-1 達成。正常1行とエラー1行のプレビューで行番号・除外理由を両幅で確認し、確定後は正常1行のみ台帳に登録された。エラー行のみのCSVでは確定操作を表示しなかった。
- AC-2 達成。確定結果のリンクから登録資産へ進み、選択済みの資産版1を使って計画を作成した。変更詳細と資産詳細のリンクで同じレコードを照合した。
- AC-3 達成。指名承認者と担当者を別セッションにし、承認・予定確定・開始・結果・PIRを同じ計画版で保存した。成功・失敗の両方を試し、外部変更0件・承認と更新の履歴を照合した。失敗した変更のPIR未記入絞り込みを保存前後で確認した。
- AC-4 達成。1440pxのEnterとモバイル幅375pxのタップで全経路を通した。反対側の画面幅で同じIDのプレビュー、確定結果、承認待ち、実施結果、PIRを確認した。axe計20回で違反と判定保留は0件、文書とCSVプレビューの横はみ出しは0pxだった。
- Evidenceを `evidence/WP-P7-CHGUI-005/20261119-2049/` に保存した。取込ID・資産ID・変更IDを `summary.json` に記録。再現コマンド、画面、検査ログは同じフォルダに収録。
- 人による受入レビュー待ち。ルートlintが参照する別のローカルworktreeに自動生成ファイル由来の既存エラー4件がある。対象worktreeのlintは成功した。

```zsh
rtk proxy npm run test:unit -- --reporter=json --outputFile=/tmp/solvi-chgui005.2DCBUr/unit-delivery.json
rtk proxy npm run typecheck
rtk proxy npm run lint
rtk proxy npm run lint -- --ignore-pattern '.claude/**'
rtk proxy npm run check:all
rtk proxy node /tmp/solvi-chgui005.2DCBUr/capture.mjs /tmp/solvi-chgui005.2DCBUr/delivered 01
```

Web本番ビルドと変更ファイルのPrettier検査は成功。ユニットテストは4,858件成功、失敗0件、既存skip 26件。型検査と `check:all` は成功。
