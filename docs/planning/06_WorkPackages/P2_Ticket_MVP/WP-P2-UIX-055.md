---
project: "SOLVI"
doc_id: "WP-P2-UIX-055"
title: "管理画面を採用モックアップの構成に合わせる"
category: "06_WorkPackages"
type: "work-package"
status: "baseline"
version: "0.1.0"
created: "2026-11-20"
updated: "2026-11-20"
owner: "SOLVI Product Team"
tags: ["ui", "administration", "responsive"]
source_of_truth: true
implementation_status: "review"
workstream: "UIX"
phase: "P2"
risk: "low"
story_points: 8
requirement_ids: ["NFR-UX-002", "NFR-UX-003", "NFR-UX-004"]
depends_on: ["WP-P2-UIX-029", "WP-P2-UIX-044"]
---

# WP-P2-UIX-055 管理画面を採用モックアップの構成に合わせる

## 1. Purpose

管理ホームと利用者、部署、担当グループ、承認ルール、通知状況、アクセスレビューを、採用HTMLの `#admin` と各配下画面に合わせる。

## 2. Requirement IDs

`NFR-UX-002`、`NFR-UX-003`、`NFR-UX-004`。

## 3. Dependencies

[[WP-P2-UIX-029]]、[[WP-P2-UIX-044]] はbaseline・done。[[WP-P2-ADMUI-050]] が定めた実際の表示権限・管理操作・再ログイン導線は既存のまま使う。基点は `433c6dc`。

## 4. Scope / Allowed Paths

- `apps/web/src/components/AdminWorkspace.tsx`
- `apps/web/src/components/AdminNotificationDetails.tsx`
- `apps/web/src/app/ops/admin/page.tsx`
- `apps/web/src/app/ops/users/page.tsx`
- `apps/web/src/app/ops/departments/page.tsx`
- `apps/web/src/app/ops/groups/page.tsx`
- `apps/web/src/app/ops/groups/[id]/page.tsx`
- `apps/web/src/app/ops/approvals/page.tsx`
- `apps/web/src/app/ops/notifications/page.tsx`
- `apps/web/src/app/ops/access-review/page.tsx`
- `apps/web/src/app/freshservice.css`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-055.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-UIX-055/`

## 5. Out of Scope

認証・認可・操作の契約、セッション失効の仕組み、ロールの試験切替、API・DB・監査・通知の配信方式、管理ホームから移動できる別領域の画面。

## 6. Deliverables

- 組織名・表示役割と管理機能タブ、管理ホームの分類パネルと行リンク。現在地・ホバー・フォーカスを採用HTMLに合わせる。
- 利用者と承認ルールの一覧・詳細、部署ツリー、担当グループとメンバーを広幅時に並べる。モバイルは操作順で1列にする。通知の状態別フィルターと表、アクセスレビューの判断行と実施記録を整える。
- 実データ・実権限、現行の追加フォーム、監査担当者の閲覧範囲、権限案内と再ログイン復帰を使用する。

## 7. Acceptance Criteria

- AC-1 7画面をPC 1440px・モバイル375pxで参照と比較し、タイトル、操作列、タブ、管理ホームのホバーと分類、一覧と選択先を確認する。
- AC-2 既存の6機能の保存・検索・経路プレビュー・通知の再試行受付・アクセスレビュー完了を両幅の実セッションで確認する。監査担当者の表示、権限外、失効後の復帰も確認する。
- AC-3 両テーマのaxeとページの横はみ出しを検証し、比較画像・結果と型・lint・ユニット・ガバナンスの証拠を残す。

## 8. Verification and Evidence

隔離PostgreSQLと合成データ、Chrome、本番向けWebビルドを使用し、稼働中の開発版でも表示を計測する。

## 9. Security and Audit

現行の認可条件と実セッションを使用し、既存の管理データの表示範囲を適用する。

## 10. Rollback

Migrationなし。変更コミットのrevertで元の表示へ戻る。

## 11. References

[[11.3_Design_System]]、[[11.13_Mockup_Asset_Index]]、[[03.13_UX_Accessibility_Requirements]]、[[WP-P2-ADMUI-050]]。

## 12. Definition of Done

§7の結果とスクリーンショットを保存し、レビューへ提出する。

## 13. Execution Log

- 2026-11-20 採用HTMLの7画面と現行の管理機能を比較し、表示・配置の差分を定義した。
- `AdminWorkspace.tsx` に共通見出し、表示役割、管理タブと権限案内を整備した。`ops/admin`、`ops/users`、`ops/departments`、`ops/groups` と `ops/groups/[id]`、`ops/approvals`、`ops/notifications`、`ops/access-review` の各 `page.tsx` と `freshservice.css` を更新した。`AdminNotificationDetails.tsx` を追加し、表示済みの通知情報から詳細を開けるようにした。WP、登録表、依存関係、RTM、Manifestを更新した。
- Migrationなし。変更コミットのrevertで元の表示に戻せる。セキュリティ影響なし。既存のサーバー側認可を使用し、通知の詳細に内部IDを公開していないことを回帰確認した。
- AC-1 7画面をPC 1440px・モバイル375pxで比較した。見出し左端と文字サイズ、ホームの列数とホバー色、各タブの現在地を照合した。通知を含む5画面で、一覧との並列表示とモバイルの縦並びを確認した。同じ表示計測をポート3000で実行した。
- AC-2 両幅で利用者検索・保存、部署作成、担当グループ作成・所属追加、承認ルール保存・経路プレビュー、失敗通知の詳細と再試行受付、アクセスレビューの開始・判断・完了を確認した。監査担当者の閲覧範囲、権限案内からの復帰と失効後の再ログインを実セッションで確認した。
- AC-3 両幅・両テーマの44条件でaxe違反・判定保留0件、ページ全体の横はみ出し0px。ユニット4,899件合格、既存skip 26件、失敗0件。型検査、lint、ガバナンス、Web本番向けビルドに合格した。
- 検証コマンドと結果は `evidence/WP-P2-UIX-055/20261120-0741/README.md`、`logs/`、`summary.json`、`geometry.json` に保存した。モバイルはChromeのタッチエミュレーションで確認し、通知の再試行は隔離DBの受付を確認した。受入レビュー待ち。

```zsh
rtk proxy npm run typecheck
rtk proxy npm run lint -- --ignore-pattern '.claude/**'
rtk proxy npm run test:unit -- --reporter=json --outputFile="$qa_tmp/unit.json"
rtk proxy npm run check:all
rtk proxy node --env-file=.env "$qa_tmp/stack.mjs" prepare "$qa_database"
rtk proxy node --env-file=.env "$qa_tmp/capture.mjs" "$qa_tmp/release" "$qa_database" 01
rtk proxy node "$qa_tmp/compare.mjs" "$qa_tmp/comparison" after http://127.0.0.1:3230 http://127.0.0.1:3231
rtk proxy node "$qa_tmp/compare.mjs" "$qa_tmp/live-final" after
```
