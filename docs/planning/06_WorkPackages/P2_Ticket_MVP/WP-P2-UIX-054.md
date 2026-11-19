---
project: "SOLVI"
doc_id: "WP-P2-UIX-054"
title: "レポートの集計カードと内訳を採用モックアップに合わせる"
category: "06_WorkPackages"
type: "work-package"
status: "baseline"
version: "0.1.0"
created: "2026-11-20"
updated: "2026-11-20"
owner: "SOLVI Product Team"
tags: ["ui", "report", "responsive"]
source_of_truth: true
implementation_status: "review"
workstream: "UIX"
phase: "P2"
risk: "low"
story_points: 5
requirement_ids: ["FR-TKT-006", "FR-TKT-008", "NFR-UX-002", "NFR-UX-004"]
depends_on: ["WP-P2-SLAUI-016", "WP-P2-SEARCH-017", "WP-P2-UIX-044"]
---

# WP-P2-UIX-054 レポートの集計カードと内訳を採用モックアップに合わせる

## 1. Purpose

SOLVIの `/ops/reports` を `assets/ui/SOLVI_Operations_Mockup.html#reports` の構成・操作に合わせる。受付開始日・終了日によるUTCの絞り込みと入力検証は現行どおり。

## 2. Requirement IDs

`FR-TKT-006`、`FR-TKT-008`、`NFR-UX-002`、`NFR-UX-004`。

## 3. Dependencies

[[WP-P2-SLAUI-016]]、[[WP-P2-SEARCH-017]]、[[WP-P2-UIX-044]] は baseline・done。実装の基点は `60c71aa`。[[WP-P2-RPT-051]] と [[WP-P2-UIX-053]] のレポートの操作および画面を見直す。

## 4. Scope / Allowed Paths

- `apps/web/src/app/ops/reports/page.tsx`
- `apps/web/src/app/freshservice.css`
- `apps/web/src/components/TicketReturnFocus.tsx`
- `apps/web/src/lib/ops-insights.ts`
- `tests/unit/ops-insights.test.ts`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-054.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-UIX-054/`

## 5. Out of Scope

日付入力とUTC日付境界、API、認可、SLAや状態の判定、監査ログ、Migration。

## 6. Deliverables

- モックアップの見出し、枠線、集計カードと導線。ホバー・フォーカス・選択状態の枠と背景、件数と単位のサイズ、期限超過の色を揃える。
- 初期表示は担当グループ別の受付・解決済み・期限超過の実データと受付件数の横棒。選択後は対象一覧を表で表示し、チケット詳細と集計の往復を可能にする。SLA列は既存APIが返す残り時間・超過・停止を表示する。
- 現行APIの組織・担当グループの絞り込みを再利用する。集計に失敗した場合は0件と区別する。

## 7. Acceptance Criteria

- AC-1 1440pxと375pxで採用モックアップと並べ、集計カードの余白とホバーの枠・背景、通常／フォーカス／選択の差、4列／2列、カード全体の操作と対象一覧へのフォーカスを確認する。
- AC-2 実データのグループ別集計とカードから各対象一覧を開く。詳細から同じ日付・グループ・集計・行へ復帰し、一覧からグループ別の集計へ戻れる。SLA停止中を期限超過に含めない。
- AC-3 既存の開始日・終了日、空の結果と日付検証、絞り込み条件を保持する。両テーマのaxe、文書の横はみ出し、実画面の証拠とリポジトリの検査を記録する。

## 8. Verification and Evidence

採用HTMLと本体をChromeで比較し、隔離PostgreSQLと合成チケットで件数と実操作を照合する。ポート3000の表示も確認する。

## 9. Security and Audit

既存の担当者権限と組織範囲を使用する。

## 10. Rollback

Migrationなし。差分コミットのrevertで以前のレポート表示に戻る。

## 11. References

[[WP-P2-RPT-051]]、[[WP-P2-UIX-053]]、[[11.3_Design_System]]、[[11.13_Mockup_Asset_Index]]、[[03.13_UX_Accessibility_Requirements]]。

## 12. Definition of Done

§7を検証し、比較画像と計測値を保存する。

## 13. Execution Log

- 2026-11-20 採用HTMLと稼働中のレポートを比較。受付件数のホバー背景と枠、件数カードの補助表示、初期表示の内訳、選択後の表に差分があった。
- 2026-11-20 レポートの画面とCSS、選択状態のURL、対象一覧へのフォーカス復帰を更新した。§4のユニット検査、WP台帳・依存マップ・RTM・ManifestとEvidenceを更新した。
  - Migrationなし。差分コミットのrevertで以前の表示に戻る。
  - AC-1合格。Chromeのライト・ダークで通常時とホバー時の受付件数カードの色・寸法が参照と一致。PC 4列、高さ113.39px、モバイル2列、高さ103.73px。選択後と戻った集計の見出しへフォーカスする。
  - AC-2合格。両幅・両テーマで、グループ別の受付4・解決済み1・期限超過1、カードの未解決3を検証した。停止中は期限超過から除外。対象表の同じチケットを開き、日付・グループ・集計・行へ復帰した。
  - AC-3合格。UTC日付の既存入力、0件と不正な範囲、入力値と集計の保持を確認した。axeは16条件で違反・判定保留0件、ページ横はみ出し0px。型、lint（別のワークツリーを除外）、ガバナンス、本番向けビルドが成功。ユニット4,899件合格、既存skip 26件、失敗0件。
  - セキュリティ影響なし。担当者権限と既存APIの組織条件を使用した。監査担当者へのレポート表示拒否を実セッションで確認した。
  - 現行のページ送りを使うため対象表は受付の新しい順。期限列は現在のAPIが返す残り時間・超過・停止を表示する。モバイル幅はエミュレーション。
  - Evidenceは `evidence/WP-P2-UIX-054/20261120-0657/`。READMEと `summary.json` にモックアップとの照合、合成データでの確認結果、ポート3000の計測を記録した。

  ```sh
  rtk proxy node --env-file=.env '/tmp/solvi-rpt054.wLUOKz/qa/stack.mjs' prepare 'solvi_rpt051_1795125502_test'
  rtk proxy node --env-file=.env '/tmp/solvi-rpt054.wLUOKz/qa/capture.mjs' '/tmp/solvi-rpt054.wLUOKz/release' 'solvi_rpt051_1795125502_test' 01
  rtk proxy node '/tmp/solvi-rpt054.wLUOKz/live.mjs' '/tmp/solvi-rpt054.wLUOKz'
  rtk proxy npm run typecheck
  rtk proxy npm run lint -- --ignore-pattern '.claude/**'
  rtk proxy npm run test:unit -- --reporter=json --outputFile='/tmp/solvi-rpt054.wLUOKz/unit.json'
  rtk proxy npm run check:all
  ```
