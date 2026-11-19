---
project: "SOLVI"
doc_id: "WP-P2-UIX-048"
title: "担当者シェルの余白とチケット返信後の復帰"
category: "06_WorkPackages"
type: "work-package"
status: "baseline"
version: "0.1.0"
created: "2026-11-19"
updated: "2026-11-19"
owner: "SOLVI Product Team"
tags: ["ui", "ticket", "accessibility"]
source_of_truth: true
implementation_status: "review"
workstream: "UIX"
phase: "P2"
risk: "low"
story_points: 5
requirement_ids: ["FR-TKT-006", "NFR-UX-002", "NFR-UX-003", "NFR-UX-004"]
depends_on: ["WP-P2-UIX-043", "WP-P2-UIX-044", "WP-P2-UIX-045", "WP-P2-UIX-046"]
---

# WP-P2-UIX-048 担当者シェルの余白とチケット返信後の復帰

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

2026-11-19に承認されたモックアップ反映の第1段階。[[11.3_Design_System]] §6の本文寸法を担当者シェルへ反映する。運営状況・業務受信箱・チケット一覧から、既存の返信処理で返信し、閲覧元の検索条件・ページと選択位置へ戻れるようにする。

## 2. Requirement IDs

`FR-TKT-006`、`NFR-UX-002`、`NFR-UX-003`、`NFR-UX-004`。

## 3. Dependencies

- [[WP-P2-UIX-043]] フォーム復元とモバイル操作
- [[WP-P2-UIX-044]] 担当者シェルとデザイントークン
- [[WP-P2-UIX-045]] 運営状況
- [[WP-P2-UIX-046]] チケット一覧・詳細

いずれも着手時の `main`（`69cd6e7`）で `implementation_status: done` を確認。

## 4. Scope / Allowed Paths

- `11_UI_UX/11.3_Design_System.md`
- `06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-048.md`
- `06_WorkPackages/06.0_WorkPackage_Register.md`
- `06_WorkPackages/06.1_Dependency_Map.md`
- `03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `MANIFEST.md`
- `apps/web/src/app/freshservice.css`
- `apps/web/src/app/ops/page.tsx`
- `apps/web/src/app/ops/overview/page.tsx`
- `apps/web/src/app/ops/[id]/page.tsx`
- `apps/web/src/app/inbox/page.tsx`
- `apps/web/src/app/inbox/actions.ts`
- `apps/web/src/components/AppFrame.tsx`
- `apps/web/src/components/InboxOpenForm.tsx`
- `apps/web/src/components/TicketReturnFocus.tsx`
- `apps/web/src/lib/navigation.ts`
- `tests/unit/staff-ticket-return.test.ts`
- `evidence/WP-P2-UIX-048/`

## 5. Out of Scope

依頼者シェル、チケットのAPI・状態機械・認可・DB、既読の記録条件、通知、業務集計。今回のモバイル表示でも業務種別別の操作と既存の閲覧権限を維持する。

## 6. Deliverables

余白のトークン、担当者側の見出しとナビゲーション、一覧のURLと選択位置の復元、PC・モバイルの検証証跡。戻り先が未読のみで既読になった場合など、同じ条件内に該当行がなければ一覧の見出しへフォーカスする。

## 7. Acceptance Criteria

- AC-1  担当者シェルの左右余白・最大幅が正本と一致する。境界幅の600／601px、1100／1101pxと、320px・375px・1440px・1920pxを検査する。狭い画面で横スクロールは表内に収まり、画面全体ははみ出さない。
- AC-2  運営状況、業務受信箱、チケット一覧から同じ受付番号を開き、返信を保存して戻れる。検索条件、担当グループ、ページを保持し、選択位置へフォーカスを戻す。未読などの条件から行が外れた場合は、条件を保持した画面の見出しにフォーカスする。現在地は閲覧元と対応する。
- AC-3  古い会話コンテキストでの返信は拒否され、入力を保持して最新状態を確認できる。同じコンテキストの再送では投稿を重複させない。外部の戻り先を受け入れない。
- AC-4  認証済みのPC・モバイルで主要導線を通し、ライト／ダークで対象画面のスクリーンショットとaxe結果を取得する。フォーカス復帰をキーボードで確認する。

## 8. Verification and Evidence

既存のWPの検証、ユニットテスト、型検査・lint・`check:all` を実行する。ブラウザE2Eは合成データを含む隔離DBを使用し、コマンドと結果を `evidence/WP-P2-UIX-048/` に保存する。

## 9. Security and Audit

既存の認可・監査と返信時の競合検知を利用する。戻り先は既存の `safeReturnTo` で検証する。証跡に本番データ、パスワード、Cookieを含めない。

## 10. Rollback

変更をrevertする。Migrationは不要。

## 11. References

[[11.3_Design_System]]、[[11.2_Information_Architecture]]、[[11.11_UI_State_and_Error_Model]]、[[03.13_UX_Accessibility_Requirements]]、[[04.22_Gate_Definitions]]、[[WP-P2-UIX-043]]、[[WP-P2-UIX-044]]、[[WP-P2-UIX-045]]、[[WP-P2-UIX-046]]。

## 12. Definition of Done

§7の判定と証拠を記録し、実画面のレビューに提出する。

## 13. Execution Log

- 2026-11-19  採用した余白と第1段階の作業範囲・受入基準をベースライン化。着手時の差分WPと4件の依存を確認。
- 2026-11-19  共通シェル、一覧3画面、チケット詳細、受信箱を更新。実装ファイルは `freshservice.css`、`app/ops/page.tsx`、`app/ops/overview/page.tsx`、`app/ops/[id]/page.tsx`、`app/inbox/page.tsx`、`app/inbox/actions.ts`、`AppFrame.tsx`、`InboxOpenForm.tsx`、`TicketReturnFocus.tsx`、`lib/navigation.ts`。回帰検査は `tests/unit/staff-ticket-return.test.ts`。設計正本・本WP・台帳・依存図・要求トレーサビリティ・Manifestを更新。
- AC-1充足。認証済みの32測定で32／24／20pxと最大1536pxが一致し、画面全体の横はみ出し0px。狭い画面で横スクロールは表内に収まる。
- AC-2充足。同じ合成チケットでPCとモバイルの6ルートを通し、返信を依頼者権限の読み取りで確認。元の担当グループ・絞り込み・受信箱2ページ目とフォーカスを保持。既読後に未読条件から外れた場合は見出しへ復帰。
- AC-3充足。古いコンテキスト、同じコンテキストの再送、最新状態を読んでの入力復元と再送、外部の戻り先の拒否を確認。
- AC-4充足。本番ビルドに対してChromeのキーボードとタッチ操作を検証。4画面×2幅×2テーマのaxeは違反0件。判定保留のモバイル表内文字は別途確認し、40要素で最小5.96:1。PCの受信箱でフィルター操作を38pxに整列し、375pxの受信箱で行を開く操作が初期の表表示範囲に収まることを確認。
- `rtk proxy npm run typecheck`、`rtk proxy npm run check:all`、`rtk proxy npm run test:unit` を検証。ユニットテストは4,846件成功、失敗0件、既存skip 26件。ルートの `rtk proxy npm run lint` は別worktreeの生成型参照4件を検出し、`rtk proxy npm run lint -- --ignore-pattern '.claude/**'` で対象の作業ツリーを検証して成功。隔離Webの `next build` とブラウザの再現コマンドはEvidenceに記載。
- Migrationなし。ロールバックは本WP差分のrevert。セキュリティ境界の変更なし。既存の内部URL制限、認可、監査、競合検知を使用。レビュー待ち。
- Evidenceは `evidence/WP-P2-UIX-048/20261119-1901/README.md`、`summary.json`、`contrast.json`、`screens/`、`logs/`。
