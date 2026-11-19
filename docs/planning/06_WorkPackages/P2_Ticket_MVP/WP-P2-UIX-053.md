---
project: "SOLVI"
doc_id: "WP-P2-UIX-053"
title: "第1〜8段階の横断レビューと表示・操作の調整"
category: "06_WorkPackages"
type: "work-package"
status: "baseline"
version: "0.1.0"
created: "2026-11-19"
updated: "2026-11-19"
owner: "SOLVI Product Team"
tags: ["ui", "responsive", "acceptance"]
source_of_truth: true
implementation_status: "review"
workstream: "UIX"
phase: "P2"
risk: "low"
story_points: 8
requirement_ids: ["NFR-UX-002", "NFR-UX-003", "NFR-UX-004"]
depends_on: ["WP-P2-UIX-044", "WP-P2-UIX-045", "WP-P2-UIX-046"]
---

# WP-P2-UIX-053 第1〜8段階の横断レビューと表示・操作の調整

## 1. Purpose

採用した操作式モックアップとSOLVI本体をPC・モバイルで比較する。第1〜8段階の実操作と権限ごとの表示を確認し、主要操作の見つけやすさ、現在地、戻り先、フォーカス、文言の差分を修正する。

## 2. Requirement IDs

`NFR-UX-002`、`NFR-UX-003`、`NFR-UX-004`。

## 3. Dependencies

[[WP-P2-UIX-044]]、[[WP-P2-UIX-045]]、[[WP-P2-UIX-046]] はbaseline・done。レビューの対象は `e2836b1` の第1〜8段階と共通表示。各段階のWPの人間レビューと製品受入判定を維持する。

## 4. Scope / Allowed Paths

- `apps/web/src/app/freshservice.css`
- `apps/web/src/app/inbox/page.tsx`
- `apps/web/src/app/ops/admin/page.tsx`
- `apps/web/src/app/ops/page.tsx`
- `apps/web/src/components/AppFrame.tsx`
- `apps/web/src/components/SupportFrame.tsx`
- `apps/web/src/lib/navigation-groups.ts`
- `tools/e2e/operations_overview_flow.mjs`
- `tools/e2e/ticket_queue_flow.mjs`
- `tools/performance/workload.mjs`
- `tools/ui_inbox_recovery_check.mjs`
- `tools/ui_operator_detail_recovery_check.mjs`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-053.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-UIX-053/`

## 5. Out of Scope

認証・認可・データモデル・業務処理の変更、実テナントや外部サービスへの書込み、モック用の役割切替の追加。

## 6. Deliverables

- 各段階のモックアップとの比較記録と、PC・モバイルでの操作結果。
- 比較で見つかった共通ナビゲーション、一覧の文言・操作領域、フォーカス・読み上げ・表示順の調整。
- 検証コマンド、スクリーンショット、修正後の再検証結果と残る差分。

## 7. Acceptance Criteria

- AC-1 1440pxのキーボードと375pxのタップで、段階1の3つの一覧から詳細・公開返信・元の条件とフォーカスへの復帰、段階2の障害報告・担当者返信・依頼者の追加連絡と進捗を実際に保存して確認する。
- AC-2 両幅で、段階3の質問・条件・承認ルール設定からプレビュー・公開・申請・判断、段階4の下書き・レビュー・公開・検索・担当者限定と検索0件、段階5のCSVプレビュー・エラー除外・取込・承認・実施記録・PIRを、対象の番号またはIDを追って確認する。
- AC-3 両幅で、段階6の組織管理、閲覧者、権限外とセッション切れ復帰、段階7の集計から対象チケットと監査での承認・権限変更、段階8のAI提案採否・承認後の模擬実行・証跡と監査を確認する。
- AC-4 採用モックアップと各段階の代表画面を比較する。現在地、戻り先、見出し、余白、操作列、狭幅の表を確認し、差分の修正前後を記録する。役割や実データによって生じる表示差は理由を記録する。
- AC-5 修正後に両テーマのaxeと横はみ出し、キーボード操作、型・ユニット・ガバナンス検査を実行する。

## 8. Verification and Evidence

合成データの隔離PostgreSQL、実セッション、SOLVI本番向けビルドと採用済みHTMLを使う。Chromeのモバイル検証はタッチエミュレーションで実施する。開発サーバーの表示も再確認する。

## 9. Security and Audit

既存の認可、セッション、承認、AIと模擬実行、監査をそのまま通す。検証用の権限・セッション状態の準備は隔離DB内に限る。

## 10. Rollback

Migrationなし。この差分のコミットをrevertすれば従来の表示へ戻せる。

## 11. References

[[11.3_Design_System]]、[[11.13_Mockup_Asset_Index]]、[[03.13_UX_Accessibility_Requirements]]、[[WP-P2-UIX-052]]。業務検証は [[WP-P2-UIX-048]]、[[WP-P2-UIX-049]]、[[WP-P4-APR-022]]、[[WP-P3-KNWUI-060]]、[[WP-P7-CHGUI-005]]、[[WP-P2-ADMUI-050]]、[[WP-P2-RPT-051]]、[[WP-P4-SIMUI-023]] の受入基準を使う。

## 12. Definition of Done

§7の結果と残る差分を記録し、レビューへ提出する。

## 13. Execution Log

- 2026-11-19 第9段階の横断レビューを開始。
- 2026-11-19 共通CSS、担当者・依頼者のシェル、受信箱・チケット一覧・管理ホーム、ナビゲーションのラベルを調整。§4の検証スクリプトのラベル、WP台帳・依存マップ・RTM・Manifest、Evidenceを更新した。
  - Migrationなし。差分コミットのrevertで表示を戻せる。
  - AC-1合格。PCとモバイルで3つの一覧から同じチケットに公開返信し、元の条件・ページ・フォーカスへ復帰。別の障害報告で受付番号・対応開始・公開返信・依頼者からの追加連絡を同じチケットで再表示した。
  - AC-2合格。サービスの質問・条件・承認ルールを設定し、公開・申請・承認または理由付き却下までを各幅で確認。公開範囲の変更によるナレッジの0件・404と、同じ取込資産で計画・承認・実施結果・PIRを確認した。
  - AC-3合格。管理操作と閲覧者の権限外、再ログインでの復帰、レポートからの対象チケットと監査の絞り込み、AI提案の採否・承認後の模擬実行と監査を両幅で確認した。
  - AC-4合格。第1〜8段階の比較画像を保存。管理ホームの現在地、受信箱の操作列、チケットの用語・行見出し・375pxの件名タップ領域（16pxから44px）、詳細の操作列、ナレッジの検索とポータルメニューを修正した。ポート3000で修正後の主要表示を再確認した。
  - AC-5合格。Chromeでaxe計252条件、自動検出違反0件。コントラストの自動判定保留は11条件で、表の24要素の実測は最小5.95:1、ポータル見出しは背景グラデーションの端点で最小9.59:1。WebKitのモバイルエミュレーションで10画面の横はみ出し0pxと一覧から詳細・復帰を確認。型検査・lint（`.claude/` を除外）・ガバナンス・本番向けビルドが成功し、ユニットは4,897件合格・既存skip 26件・失敗0件。
  - セキュリティ影響なし。ロール別セッション、既存のAPI認可、承認、監査を検証に使用した。
  - モバイル実機の確認と製品の人間レビューは未完。モックアップとの差にはロール別表示、実データ、UTCの期間指定、対象申請に紐づく模擬実行結果がある。
  - Evidenceは `evidence/WP-P2-UIX-053/20261119-2300/`。READMEに比較画像・各段階の結果・本番向けビルドと検証の再現手順を記録した。

  ```sh
  rtk proxy python3 '/tmp/solvi-stage9.6wk0SN/run.py' fixed verified
  rtk proxy node '/tmp/solvi-stage9.6wk0SN/live-final.mjs'
  rtk proxy npm run typecheck
  rtk proxy npm run lint -- --ignore-pattern '.claude/**'
  rtk proxy npm run test:unit -- --reporter=json --outputFile='/tmp/solvi-stage9.6wk0SN/unit.json'
  rtk proxy npm run check:all
  ```
