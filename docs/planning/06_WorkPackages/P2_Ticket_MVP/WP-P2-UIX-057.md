---
project: "SOLVI"
doc_id: "WP-P2-UIX-057"
title: "依頼者ポータルを採用モックアップの構成に合わせる"
category: "06_WorkPackages"
type: "work-package"
status: "baseline"
version: "0.1.0"
created: "2026-11-20"
updated: "2026-11-20"
owner: "SOLVI Product Team"
tags: ["ui", "requester-portal", "responsive"]
source_of_truth: true
implementation_status: "review"
workstream: "UIX"
phase: "P2"
risk: "low"
story_points: 5
requirement_ids: ["NFR-UX-001", "NFR-UX-002", "NFR-UX-003", "NFR-UX-004"]
depends_on: ["WP-P2-PORTAL-002", "WP-P2-COLLAB-004", "WP-P2-UIX-032", "WP-P2-UIX-043", "WP-P2-UIX-044"]
---

# WP-P2-UIX-057 依頼者ポータルを採用モックアップの構成に合わせる

## 1. Purpose

トップ、障害報告、未解決・すべての問い合わせ、受付完了と詳細を、採用HTMLの `#portal`、`#report`、`#my-tickets`、`#request/…` に合わせる。

## 2. Requirement IDs

`NFR-UX-001`〜`NFR-UX-004`。

## 3. Dependencies

[[WP-P2-PORTAL-002]]、[[WP-P2-COLLAB-004]]、[[WP-P2-UIX-032]]、[[WP-P2-UIX-043]]、[[WP-P2-UIX-044]] はbaseline・done。基点は `a4a2dbc`。[[WP-P2-UIX-049]] のシナリオと現行の権限・動作を使い、同WPの人間による受入判定を維持する。

## 4. Scope / Allowed Paths

- `apps/web/src/app/freshservice.css`
- `apps/web/src/app/portal/page.tsx`
- `apps/web/src/app/tickets/new/page.tsx`
- `apps/web/src/app/tickets/[id]/page.tsx`
- `apps/web/src/components/SupportFrame.tsx`
- `apps/web/src/components/FreshserviceIcon.tsx`
- `apps/web/src/components/ThemeToggle.tsx`
- `apps/web/src/components/TicketForm.tsx`
- `apps/web/src/components/TicketReceipt.tsx`
- `tools/ui_support_portal_check.mjs`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-057.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-UIX-057/`

## 5. Out of Scope

業務API、DB、認証・認可、公開範囲、SLAと状態遷移、通知、担当者画面、模擬ロール切替、入力例の自動入力。サービスカタログ、申請、ナレッジの画面は既存の導線を使う。

## 6. Deliverables

折り返す依頼者ナビ、トップの主操作・ヘルプ検索・最近の問い合わせ。中央の障害報告フォーム、受付番号の案内。問い合わせ一覧の行リンクと条件。PCで本文・やり取りと対応状況を並べ、モバイルでは対応状況から縦に表示する。返信の送信、添付、追加情報、元の一覧への復帰を既存操作とともに保つ。

## 7. Acceptance Criteria

- AC-1 PC 1440pxとモバイル375pxで採用HTMLと5表示を比較し、余白、文字、フォーム、ボタン、一覧のホバー・フォーカス、進捗の位置を確認する。
- AC-2 両幅で未入力の回復、障害報告、担当者による割当・対応開始・公開返信、依頼者の一覧・詳細・追加返信を同じ受付番号で通す。別端末幅で同じ記録を再確認し、他人のチケットと内部メモへの非表示、一覧の条件とページの復帰を確認する。
- AC-3 表示テーマ、狭幅での横はみ出し、axe、フォームとキーボードの検査を行い、録画または比較画像と検査結果を保存する。型、lint、ユニット、本番向けビルド、ガバナンスを実行する。

## 8. Verification and Evidence

稼働中の開発版では読み取り比較を行う。業務操作は隔離PostgreSQLと合成利用者を使う。

## 9. Security and Audit

既存のサーバー側認可、公開・内部コメントの区別、送信処理を使用する。

## 10. Rollback

マイグレーションなし。コミットのrevertで元の表示に戻る。

## 11. References

[[11.3_Design_System]]、[[11.13_Mockup_Asset_Index]]、[[03.13_UX_Accessibility_Requirements]]、[[WP-P2-UIX-049]]。

## 12. Definition of Done

§7の結果と比較画像で受入レビューを依頼できること。

## 13. Execution Log

- 2026-11-20 採用HTMLと開発版のトップ、報告、一覧、詳細、受付案内をPC・モバイルで比較した。

- 変更箇所は `portal/page.tsx`、`tickets/new/page.tsx`、`tickets/[id]/page.tsx`、`freshservice.css`、`SupportFrame.tsx`、`FreshserviceIcon.tsx`、`ThemeToggle.tsx`、`TicketForm.tsx`、`TicketReceipt.tsx`。既存のポータル回帰スクリプトをナレッジの見出しと業務受信箱の件数表示に合わせた。WP・台帳・依存関係・RTM・Manifestを更新した。
- AC-1 開発版と本番向けローカルビルドをそれぞれ採用HTMLの5表示と比較した。両幅で見出しの左端・サイズ・ウェイト、行のホバーとフォーカス、検索欄とボタンの位置、障害報告の中央配置を確認した。PCの詳細では対応状況がやり取りの右、モバイルでは上に配置された。
- AC-2 1440pxで `INC-2026-000002`、375pxで `INC-2026-000003` を合成利用者で起票した。同じIDで受付と担当割当・対応開始・公開返信を確認し、依頼者の追加返信を担当者画面で照合した。反対側の幅でも同じ2件の返信・進捗を確認した。内部メモと別利用者のチケットの非表示、一覧の条件、該当行、2ページ目のカーソル復帰を確認した。
- AC-3 8幅・4画面の32測定でページ全体の横はみ出し0px。操作16条件、5表示の比較10条件、ロール別回帰11条件のaxe違反は0件。グラデーション上の見出しと組織名はaxe判定保留となり、ライトとダークの背景両端で計算し最小5.10:1を確認した。ユニット4,899件合格（既存skip 26件）、型検査、lint、ガバナンスと本番用ビルドに合格した。
- セキュリティ影響なし。現行認可、公開範囲、送信・返信処理を使用する。Migrationなし。変更コミットのrevertで元の表示に戻す。モバイルはChromeのタッチエミュレーションで検証し、製品受入レビューは未実施。
- Evidenceは `evidence/WP-P2-UIX-057/20261120-0832/`。比較画像・操作結果、コントラスト、検査ログ、再現手順を保存した。

```zsh
rtk proxy npm run typecheck
rtk proxy npm run lint -- --ignore-pattern '.claude/**'
rtk proxy npm run test:unit -- --reporter=json --outputFile="$qa_root/unit-final.json"
rtk proxy npm run check:all
rtk proxy node --env-file=.env "$qa_root/stack.mjs" prepare "$qa_database"
rtk proxy node "$qa_root/capture.mjs" "$qa_root/journey-final"
rtk proxy node "$qa_root/contrast.mjs" "$qa_root/contrast-final.json"
rtk proxy node "$qa_root/compare.mjs" "$qa_root/comparison" after http://127.0.0.1:3270 http://127.0.0.1:3271 "$qa_ticket"
rtk proxy node "$qa_root/compare.mjs" "$qa_root/live-final" after
```
