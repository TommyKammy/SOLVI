---
project: "SOLVI"
doc_id: "WP-P2-UIX-059"
title: "業務画面のページ見出しをパンくずに集約する"
category: "06_WorkPackages"
type: "work-package"
status: "baseline"
version: "0.1.0"
created: "2026-11-20"
updated: "2026-11-20"
owner: "SOLVI Product Team"
tags: ["ui", "navigation", "accessibility"]
source_of_truth: true
implementation_status: "review"
workstream: "UIX"
phase: "P2"
risk: "low"
story_points: 5
requirement_ids: ["NFR-UX-002", "NFR-UX-004"]
depends_on: ["WP-P2-UIX-033", "WP-P2-UIX-044"]
---

# WP-P2-UIX-059 業務画面のページ見出しをパンくずに集約する

## 1. Purpose

担当者・管理者の業務画面は、ページの現在地を上部バーで示し、本文は情報と操作から始める。

## 2. Requirement IDs

`NFR-UX-002`、`NFR-UX-004`。

## 3. Dependencies

[[WP-P2-UIX-033]] と [[WP-P2-UIX-044]] はbaseline・done。基点 `d08b05c`。

## 4. Scope / Allowed Paths

- `apps/web/src/app/assets/[id]/edit/page.tsx`
- `apps/web/src/app/assets/imports/[id]/page.tsx`
- `apps/web/src/app/assets/imports/new/page.tsx`
- `apps/web/src/app/assets/imports/page.tsx`
- `apps/web/src/app/assets/new/page.tsx`
- `apps/web/src/app/assets/page.tsx`
- `apps/web/src/app/catalog/manage/new/page.tsx`
- `apps/web/src/app/catalog/manage/page.tsx`
- `apps/web/src/app/catalog/manage/question-sets/page.tsx`
- `apps/web/src/app/catalog/page.tsx`
- `apps/web/src/app/changes/[id]/edit/page.tsx`
- `apps/web/src/app/changes/new/page.tsx`
- `apps/web/src/app/changes/page.tsx`
- `apps/web/src/app/freshservice.css`
- `apps/web/src/app/globals.css`
- `apps/web/src/app/inbox/page.tsx`
- `apps/web/src/app/knowledge/new/page.tsx`
- `apps/web/src/app/knowledge/page.tsx`
- `apps/web/src/app/ops/[id]/merge/page.tsx`
- `apps/web/src/app/ops/approvals/changes/page.tsx`
- `apps/web/src/app/ops/audit/page.tsx`
- `apps/web/src/app/ops/overview/page.tsx`
- `apps/web/src/app/ops/page.tsx`
- `apps/web/src/app/ops/reports/page.tsx`
- `apps/web/src/app/requests/page.tsx`
- `apps/web/src/app/settings/delegations/page.tsx`
- `apps/web/src/app/settings/notifications/page.tsx`
- `apps/web/src/app/tickets/new/page.tsx`
- `apps/web/src/components/AdminWorkspace.tsx`
- `apps/web/src/components/AppFrame.tsx`
- `apps/web/src/components/ServicePageHeading.tsx`
- `tests/unit/assets-form-ui.test.ts`
- `tests/unit/assets-import-detail-ui.test.ts`
- `tests/unit/assets-import-form-ui.test.ts`
- `tests/unit/assets-import-history-ui.test.ts`
- `tests/unit/assets-ui.test.ts`
- `tests/unit/knowledge-search-page.test.ts`
- `docs/planning/11_UI_UX/11.3_Design_System.md`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-059.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-UIX-059/`

## 5. Out of Scope

依頼者ポータルのデザイン、認証・認可、DBとAPI、業務ロジック。

## 6. Deliverables

業務画面の現在地はパンくずに表示する。画面名と定型説明だけの見出しは省き、本文の操作と情報を上に詰める。支援技術のページ見出し、レコード名・状態、エラーや復帰の案内、操作、閲覧ロールの表示を保持する。スマートフォンの上部バーも現在地を表示する。

## 7. Acceptance Criteria

- AC-1 業務受信箱、ダッシュボード、チケット、サービス管理、管理、レポート、監査の対象ページを開く。PC 1440pxとモバイル375pxで、パンくずに現在地、本文に既存の操作・節見出しが表示される。通常時にページ名と定型説明が本文の行の高さを占有しない。
- AC-2 支援技術用のレベル1見出し、詳細のレコード名、権限・エラー案内、依頼者ポータルの見出しと申請・カタログ・記事への遷移を確認する。
- AC-3 ブラウザのスクリーンショット、axe、型検査、lint、ユニット、ガバナンスの結果を保存する。

## 8. Verification and Evidence

ローカルの合成データのみ使う。表示・遷移とキーボード操作を確認する。

## 9. Security and Audit

HTML構造とCSSのみ変更する。認可・監査は既存の処理に従う。

## 10. Rollback

Migrationなし。このWPの差分をrevertする。

## 11. References

[[11.3_Design_System]]、[[03.13_UX_Accessibility_Requirements]]、[[WP-P2-UIX-033]]、[[WP-P2-UIX-044]]。

## 12. Definition of Done

§7とブラウザ証跡を記録し、レビューへ提出する。

## 13. Execution Log

- 2026-11-20 業務シェルのパンくず、業務受信箱と各業務画面のページ見出しを調査した。
- §4のWeb画面と共通ナビ・見出し・CSS、既存ユニットテストを更新した。設計正本、WP、台帳、依存関係、RTM、Manifest、Evidenceを整備した。
- AC-1 30画面×2幅でパンくず・見出し・ページ全体の横はみ出しを検証した。件数欄は業務受信箱のPCで58px、モバイルで115px上がった。日付絞り込みはレポートのPCで92px、モバイルで86px上がった。
- AC-2 両幅で業務受信箱への遷移、レポートの日付絞り込み、チケットの件名・返信操作、行が見つからない場合のフォーカス、権限案内を確認した。管理者・依頼者の両方で依頼者向けカタログ、申請、ヘルプ記事に移動し、ポータルの大見出しを確認した。
- AC-3 両幅の画面画像とaxe結果を保存した。axe違反0件。モバイルのチケット一覧の横スクロール表は色コントラスト192要素が判定保留となり、基点と修正版で一致した。ユニット4,909件合格、失敗0、既存skip 26件。型、lint、ガバナンス、本番用ローカルビルドに合格した。
- Migrationなし。revertで元の表示に戻す。セキュリティ影響なし。モバイルはChromeのタッチエミュレーション。製品受入レビューは未実施。本番用ローカルビルドに既存CSSのautoprefixer警告が出た。
- Evidenceは `evidence/WP-P2-UIX-059/20261120-0914/`。測定、画面、操作結果、再現手順、検査ログを保存した。

```zsh
rtk proxy npm run typecheck
rtk proxy npm run lint -- --ignore-pattern '.claude/**'
rtk proxy npm run test:unit -- --reporter=json --outputFile="$qa_root/unit-final.json"
rtk proxy npm run check:all
rtk proxy node "$qa_root/capture.mjs" after "$qa_root/final"
SOLVI_UI_BASE=http://127.0.0.1:3290 rtk proxy node "$qa_root/capture.mjs" after "$qa_root/release-screens"
SOLVI_UI_BASE=http://127.0.0.1:3292 rtk proxy node "$qa_root/capture.mjs" before "$qa_root/baseline-screens"
SOLVI_UI_BASE=http://127.0.0.1:3290 rtk proxy node "$qa_root/journeys.mjs" "$qa_root/journeys-release.json"
rtk proxy node "$qa_root/queue-baseline.mjs"
```
