---
project: "SOLVI"
doc_id: "WP-P2-UIX-049"
title: "依頼者ポータルの障害報告・返信・進捗確認"
category: "06_WorkPackages"
type: "work-package"
status: "baseline"
version: "0.1.0"
created: "2026-11-19"
updated: "2026-11-19"
owner: "SOLVI Product Team"
tags: ["ui", "portal", "ticket"]
source_of_truth: true
implementation_status: "review"
workstream: "UIX"
phase: "P2"
risk: "low"
story_points: 5
requirement_ids: ["FR-TKT-001", "FR-TKT-002", "FR-TKT-004", "NFR-UX-001", "NFR-UX-002", "NFR-UX-003", "NFR-UX-004"]
depends_on: ["WP-P2-PORTAL-002", "WP-P2-COLLAB-004", "WP-P2-UIX-032", "WP-P2-UIX-043", "WP-P2-UIX-044"]
---

# WP-P2-UIX-049 依頼者ポータルの障害報告・返信・進捗確認

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | UIX |
| Risk | low |
| Story Points | 5 |
| Suggested Owner | Frontend |
| Parallelizable | No |
| Gate | Gate A |

## 1. Purpose

第2段階の差分。依頼者がポータルの主操作から障害報告を送り、発行された受付番号を受け取る。担当者は既存の業務画面で同じチケットを開いて対応・公開返信を行う。依頼者は自分の問い合わせから同じ受付番号を開き、返信と現在の対応段階を確認する。

## 2. Requirement IDs

`FR-TKT-001`、`FR-TKT-002`、`FR-TKT-004`、`NFR-UX-001`〜`NFR-UX-004`。

## 3. Dependencies

- [[WP-P2-PORTAL-002]] の起票、受付、依頼者一覧・詳細
- [[WP-P2-COLLAB-004]] の公開返信・内部メモ
- [[WP-P2-UIX-032]] のポータル専用シェル
- [[WP-P2-UIX-043]] のフォーム復元・アクセシビリティ
- [[WP-P2-UIX-044]] のテーマとデザイントークン

5件が `done` であることを着手時点で確認した。本文寸法は [[11.3_Design_System]] §6を参照し、そのトークンを持つ第1段階のローカルコミット（`be8ecc9`）を作業ブランチの親とする。[[WP-P2-UIX-047]] は草案であり、本WPの根拠は採用された第2段階の導線と本WPに記載した受入基準とする。

## 4. Scope / Allowed Paths

- `apps/web/src/app/freshservice.css`
- `apps/web/src/app/portal/page.tsx`
- `apps/web/src/app/tickets/new/page.tsx`
- `apps/web/src/app/tickets/[id]/page.tsx`
- `apps/web/src/components/SupportFrame.tsx`
- `apps/web/src/components/TicketForm.tsx`
- `apps/web/src/components/CommentThread.tsx`
- `apps/web/src/components/TicketReceipt.tsx`
- `apps/web/src/lib/portal-overview.ts`
- `tests/unit/portal-catalog.test.ts`
- `tests/unit/support-portal-ui.test.ts`
- `tests/unit/ticket-detail-recovery-ui.test.ts`
- `tools/ui_support_portal_check.mjs`
- `docs/planning/11_UI_UX/11.3_Design_System.md`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-049.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-UIX-049/`

## 5. Out of Scope

API、DB、状態遷移、認可、監査、通知、担当者画面の変更。サービスカタログ・申請・ナレッジの個別画面の刷新は後続段階。モック専用のデモ役割切替・入力例自動入力は本体に持ち込まない。

## 6. Deliverables

- ポータルと自分の問い合わせ一覧。主要操作は障害報告と自分の問い合わせ。既存のサービス・ナレッジ・申請の入口を維持する。
- 既存入力・制約・下書きを備えた障害報告と、受付番号を示す受付完了表示。
- 詳細の対応状況。現在ステータス、報告受付・担当割当・対応・解決の現在位置、担当割当、公開のやり取りを示す。取消・統合には専用の現状を表示する。
- 担当者シェルと共通の余白・テーマ。モバイルでは対応状況をやり取りより上に配置する。

## 7. Acceptance Criteria

- AC-1  1440pxのキーボードと375pxのタップで、依頼者としてポータルから障害報告を送信し、受付番号・件名・受付ステータスが表示される。タイトルと本文が必須で、入力エラー時は入力を維持する。既存の起票APIに障害種別・影響・急ぎ具合が渡る。
- AC-2  それぞれの起票で発行された同じ受付番号を担当者のチケット一覧から開き、担当割当・対応開始と公開返信を記録する。依頼者セッションに戻り、自分の問い合わせからそのチケットを開き、同じ公開返信と現在の対応段階を確認する。別利用者のチケット・担当者の内部メモは依頼者に見えない。
- AC-3  依頼者の詳細で一覧へ戻ると未解決／すべてとページ条件を保つ。取消・統合を解決扱いにせず、待ちの場合は対応中の段階と待ち先を区別する。既存の追加連絡・添付・再開の導線を保持する。
- AC-4  ポータル・一覧・報告・詳細で本文の左右余白の境界幅と最大枠を実測し、320px以上で文書全体が横にはみ出さない。ライト・ダークの1440pxと375pxで画面と軸位置を確認し、スクリーンショットとaxeの結果を保存する。受付案内へキーボードフォーカスが移る。

## 8. Verification and Evidence

ユニットテスト、型検査、lint、`check:all`、本番ビルドを実行する。合成ユーザーと隔離DBから通常のWebとAPIを使い、第1段階を含む実画面で検証する。検証では依頼者と担当者のブラウザセッションを分ける。

## 9. Security and Audit

表示のみ。既存のセッション・所有者判定・公開範囲・監査を使用する。HTMLおよび証跡に資格情報・実データを含めない。

## 10. Rollback

本WP差分をrevertする。Migrationなし。

## 11. References

[[11.3_Design_System]]、[[11.2_Information_Architecture]]、[[11.11_UI_State_and_Error_Model]]、[[03.13_UX_Accessibility_Requirements]]、[[04.22_Gate_Definitions]]、[[WP-P2-PORTAL-002]]、[[WP-P2-COLLAB-004]]、[[WP-P2-UIX-032]]、[[WP-P2-UIX-043]]、[[WP-P2-UIX-044]]。

## 12. Definition of Done

§7を実画面で判定し、証拠と実行結果を記録してレビューに提出する。

## 13. Execution Log

- 2026-11-19  第2段階の対象・受入基準と既存機能の再利用範囲をベースライン化。第1段階をローカルコミットへ保存し、第2段階の差分を独立したブランチに分離した。
- 実装は `freshservice.css`、`app/portal/page.tsx`、`app/tickets/new/page.tsx`、`app/tickets/[id]/page.tsx`、`SupportFrame.tsx`、`TicketForm.tsx`、`TicketReceipt.tsx`、`CommentThread.tsx`、`lib/portal-overview.ts`。既存のポータル・チケット詳細検査3ファイルと `tools/ui_support_portal_check.mjs` を更新し、設計正本、WP台帳、依存図、要求マトリクスとManifestを同期した。
- AC-1充足。PCのEnterとモバイルのタップで報告を送り、起票APIの種別・件名・本文・影響・急ぎ具合、受付番号、現在段階を照合した。必須項目のエラー時に入力を保持し、送信後に受付案内へフォーカスした。
- AC-2充足。各端末で同じチケットを担当者が引き受け、対応を開始して公開返信した。依頼者は一覧から返信と対応中を確認し、反対の端末でも同じID・受付番号・返信本文を確認した。内部メモは依頼者に渡らず、別利用者のチケットは一覧に出ず、直接開くと404だった。
- AC-3充足。「すべて」の条件と2ページ目のカーソルを保持した。待ち・取消・統合の表示を回帰検査で確認し、追加連絡、添付と関連資産、対応再開の既存UIを維持した。
- AC-4充足。8幅×4画面で余白と枠幅を実測し、横はみ出し0px。2幅×2テーマ×4画面のaxeは違反0件、判定保留0件。5ロールで既存ナビゲーションと検索の回帰20件、axe 11件を確認した。
- `rtk proxy npm run test:unit` は4,857件成功、失敗0件、既存skip 26件。`rtk proxy npm run typecheck` と `rtk proxy npm run check:all` は成功。`rtk proxy npm run lint` は別worktreeの生成型参照4件を検出し、`rtk proxy npm run lint -- --ignore-pattern '.claude/**'` は成功。隔離Webの `next build` とブラウザ検証のコマンドをEvidenceに収録した。
- Migrationなし。既存の認可・監査・CSPおよび状態機械を利用し、セキュリティ境界の変更なし。ロールバックは本WPのrevert。レビュー待ち。
- Evidenceは `evidence/WP-P2-UIX-049/20261119-1944/README.md`、`summary.json`、`support-smoke.json`、`screens/`、`logs/`。
