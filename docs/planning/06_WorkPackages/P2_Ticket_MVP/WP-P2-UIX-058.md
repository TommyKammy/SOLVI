---
project: "SOLVI"
doc_id: "WP-P2-UIX-058"
title: "サポートポータルから依頼者の表示を維持する"
category: "06_WorkPackages"
type: "work-package"
status: "baseline"
version: "0.1.0"
created: "2026-11-20"
updated: "2026-11-20"
owner: "SOLVI Product Team"
tags: ["ui", "requester-portal", "navigation"]
source_of_truth: true
implementation_status: "review"
workstream: "UIX"
phase: "P2"
risk: "low"
story_points: 5
requirement_ids: ["NFR-UX-002", "NFR-UX-004"]
depends_on: ["WP-P2-UIX-028", "WP-P2-UIX-033", "WP-P2-UIX-044"]
---

# WP-P2-UIX-058 サポートポータルから依頼者の表示を維持する

## 1. Purpose

サポートポータルのサービスカタログ・申請の状況・ヘルプ記事を、担当者や管理者が利用する場合も依頼者と同じ表示にする。既存の業務導線も利用できる。

## 2. Requirement IDs

`NFR-UX-002`、`NFR-UX-004`。

## 3. Dependencies

[[WP-P2-UIX-028]]、[[WP-P2-UIX-033]]、[[WP-P2-UIX-044]] はbaseline・done。基点は `cf874f6`。

## 4. Scope / Allowed Paths

- `apps/web/src/app/portal/page.tsx`
- `apps/web/src/app/catalog/page.tsx`
- `apps/web/src/app/catalog/[itemId]/page.tsx`
- `apps/web/src/app/knowledge/page.tsx`
- `apps/web/src/app/knowledge/[id]/page.tsx`
- `apps/web/src/app/requests/page.tsx`
- `apps/web/src/app/requests/[id]/page.tsx`
- `apps/web/src/app/requests/actions.ts`
- `apps/web/src/components/AppFrame.tsx`
- `apps/web/src/components/SupportFrame.tsx`
- `apps/web/src/components/RequestForms.tsx`
- `apps/web/src/lib/navigation.ts`
- `apps/web/src/lib/api.ts`
- `services/api/src/main.ts`
- `services/api/src/modules/knowledge/knowledge.routes.ts`
- `tests/unit/support-portal-ui.test.ts`
- `tools/ui_support_portal_check.mjs`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-058.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-UIX-058/`

## 5. Out of Scope

認証・認可、組織・ロールの切替、監査、RLS、書き込みAPI、職員用機能の表示条件、業務シェルからの遷移。

## 6. Deliverables

三つの画面だけを明示的な `portal=1` でポータル表示にする。同じ条件で検索、絞り込み、ページ送り、詳細、保存後の画面へ進める。カタログは公開済みサービス、申請はログイン本人の申請を表示する。ヘルプ記事の検索・詳細は既存の公開版を組織内向けの範囲へ絞る。ナレッジAPIには読み取りの絞り込みを追加し、同じ権限で既存の認可・組織条件を適用する。リンクの現在地をポータルのナビに表示する。

## 7. Acceptance Criteria

- AC-1 組織管理者と依頼者で三つの入口をPC 1440pxとモバイル375pxから開き、同じシェル・見出し・現在地を確認する。
- AC-2 検索、詳細、元の一覧、リロードの後も表示を維持する。本人の申請と組織内公開記事を確認し、担当者限定記事と他人の申請をポータル表示に含めない。管理者は従来URLで業務の画面を表示できる。
- AC-3 ブラウザのスクリーンショットとaxe、型、lint、ユニット、ガバナンスを確認する。

## 8. Verification and Evidence

開発版は読み取り検証、申請や公開記事を使う試験は隔離環境の合成データを使用する。

## 9. Security and Audit

URLの表示指定は認可に使用しない。APIの本人条件と既存の組織・ロール判定を使用し、読み取り対象を絞る。更新処理・監査には変更を加えない。

## 10. Rollback

マイグレーションなし。変更をrevertして旧表示に戻す。

## 11. References

[[11.3_Design_System]]、[[11.13_Mockup_Asset_Index]]、[[03.13_UX_Accessibility_Requirements]]、[[WP-P2-UIX-033]]。

## 12. Definition of Done

§7の結果とスクリーンショットを保存し、レビューへ提出する。

## 13. Execution Log

- 2026-11-20 現行実装のシェル分岐と三つのリンクを確認した。
- §4に記載した画面、共通ナビ・フォーム・URL処理、ナレッジの読み取りAPI、回帰テストを変更した。WP、台帳、依存関係、RTM、Manifest、Evidenceを整備した。
- AC-1 開発版と隔離環境で、組織管理者・依頼者の両方が三つのリンクを1440pxと375pxで開いた。各環境の12条件でサポートポータルのヘッダー、見出し、現在地が一致した。
- AC-2 検索、絞り込み、詳細、元の一覧、リロード、模擬申請の受付と自分の申請への復帰を確認した。本人の申請と組織内公開記事を表示し、他人の申請と担当者限定記事のポータル詳細は404になった。管理者が業務URLから業務画面を開けることと、依頼者のナレッジ管理API指定が403になることを確認した。
- AC-3 スクリーンショットを保存した。隔離ブラウザ12条件とロール別回帰11条件のaxe違反は0件。ユニット4,909件合格、既存skip 26件、失敗0件。型検査、lint、ガバナンス、本番用ローカルビルドに合格した。既存CSSのautoprefixer警告がビルドに出た。
- 既存の認証・認可、組織分離、更新・監査処理への変更なし。ヘルプ記事APIに既存権限の範囲を絞る読み取り条件を追加した。Migrationなし。変更のrevertで旧表示に戻る。
- モバイルはChromeのタッチエミュレーション。製品受入レビューは未実施。証跡、再現手順、検査ログは `evidence/WP-P2-UIX-058/20261120-0844/` に保存した。

```zsh
rtk proxy npm run typecheck
rtk proxy npm run lint -- --ignore-pattern '.claude/**'
rtk proxy npm run test:unit -- --reporter=json --outputFile="$qa_root/unit-final.json"
rtk proxy npm run check:all
rtk proxy node --env-file=.env "$qa_root/stack.mjs" prepare "$qa_database"
rtk proxy node "$qa_root/capture.mjs" "$qa_root/isolated-final" isolated
rtk proxy node "$qa_root/capture.mjs" "$qa_root/live-final" live
SOLVI_UI_BASE=http://127.0.0.1:3280 SOLVI_UI_BROWSER_CHANNEL=chrome SOLVI_UI_OUT="$qa_root/smoke-final" rtk proxy node tools/ui_support_portal_check.mjs
```
