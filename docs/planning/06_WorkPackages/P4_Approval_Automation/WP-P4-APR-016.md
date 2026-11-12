---
project: SOLVI
doc_id: "WP-P4-APR-016"
title: "申請・詳細・承認ルール管理・滞留と再割当のUI"
category: "06_WorkPackages"
type: "workpackage"
status: "draft"
version: "0.1.0"
created: "2026-11-12"
updated: "2026-11-12"
owner: "SOLVI Product Team"
tags: ["workpackage", "p4", "approval", "ui", "accessibility"]
source_of_truth: true
implementation_status: "not-started"
story_points: 8
risk: "medium"
workstream: "APR"
phase: "P4"
requirement_ids: ["FR-CAT-011", "FR-CAT-012", "FR-CAT-016", "FR-CAT-017", "NFR-UX-002"]
depends_on: ["WP-P4-IDM-013", "WP-P4-APR-015"]
---

# WP-P4-APR-016: 申請・詳細・承認ルール管理・滞留と再割当のUI

| 項目 | 値 |
|---|---|
| Phase | P4 |
| Workstream | APR |
| Risk | medium |
| Story Points | 8 |
| Suggested Owner | Frontend |
| Parallelizable | No(IDM-013とAPR-015の後) |
| Gate | Gate B(Gate AのUI/a11y基準を準用) |

## 1. Purpose

承認ルーティングを利用者・承認者・管理者が画面で使えるようにする。申請前に解決された経路を示し、解決できないときは送信を止めて理由を示す。詳細には承認タイムラインを出す。管理者には承認ルールの管理(プレビュー付き)、承認者不在の滞留一覧と再割当の操作を提供する。認可と検証はすべてAPI([[WP-P4-APR-015]])が担い、UIは表示制御に過ぎない。

## 2. Requirement IDs

`FR-CAT-011`, `FR-CAT-012`, `FR-CAT-016`, `FR-CAT-017`, `NFR-UX-002`

## 3. Dependencies

[[WP-P4-IDM-013]], [[WP-P4-APR-015]]。実体化(`draft` → `baseline`)は両WPのレビュー完了後に行う。

## 4. Scope / Allowed Paths

- `apps/web/src/app/catalog/[itemId]/`
- `apps/web/src/app/requests/page.tsx`
- `apps/web/src/app/requests/actions.ts`
- `apps/web/src/app/requests/[id]/page.tsx`
- `apps/web/src/app/catalog/manage/`
- `apps/web/src/app/ops/approvals/`
- `apps/web/src/components/RequestForms.tsx`
- `apps/web/src/components/CatalogAdminForm.tsx`
- `apps/web/src/lib/api.ts`
- `apps/web/src/lib/approval-route.ts`
- `apps/web/src/lib/navigation.ts`
- `tests/unit/approval-route-ui.test.ts`
- `tests/unit/requests-ui.test.ts`
- `tools/ui_approval_routing_check.mjs`
- `docs/planning/06_WorkPackages/P4_Approval_Automation/WP-P4-APR-016.md`
- `evidence/WP-P4-APR-016/`

## 5. Out of Scope

- API・スキーマ・認可の変更(あれば[[WP-P4-APR-015]]へ戻す)。代理承認・二重承認・並列/定足数・リマインド/エスカレーションのUI([[WP-P4-APR-017]])。部署・利用者管理画面([[WP-P4-IDM-013]])。

## 6. Deliverables

- 申請画面: 申請前に解決された経路(ステップ順・承認者名・種別)を表示。解決できない場合は送信を無効化し、足りない設定と連絡先を表示。ルールのある項目では承認者選択を出さず `approverId` を送らない。
- 詳細: 承認タイムライン(ステップ順・状態・日時・理由・期限)と再割当の履歴。承認者が `approver` ロール無しでも、自分宛ての承認待ちを承認待ち一覧に表示し、詳細で決定できる。
- 承認ルール管理: 一覧・作成・版の履歴・無効化、経路プレビュー(申請者を選んで承認者を確認)、現在の全利用者のうち解決できない人の一覧。
- 滞留一覧(承認者不在)と再割当の操作(`org_admin` のみ)。
- プロフィール充足率(上長未設定・部署未設定・部署長不在)への導線。

## 7. Acceptance Criteria

- [ ] 申請画面で、ルールのある項目の経路がステップ順に表示される。上長が未設定の申請者では送信ボタンが無効で、理由と連絡先が表示され、送信APIを直接呼んでも拒否される。
- [ ] ルールのある項目で承認者選択が表示されず、送信本文に `approverId` が含まれない。ルールのない項目は現行の承認者選択を維持する。
- [ ] `approver` ロールを持たない上長でログインしたとき、承認待ち一覧に自分宛てが表示され、承認・却下できる。他人宛ての詳細URLは404ページになる。
- [ ] 詳細の承認タイムラインに、各ステップの状態(待機・承認・却下・期限切れ・無効)、決定日時、却下理由、期限、再割当の履歴が表示される。
- [ ] 滞留一覧に承認者不在の申請が表示され、`org_admin` だけが再割当を実行できる。再割当後に一覧から消え、タイムラインに履歴が残る。`org_admin` 以外にはメニューも操作も出ない。
- [ ] 承認ルール管理で、保存前にプレビュー(申請者を選ぶと承認者の経路)が表示され、解決できない利用者の一覧が表示される。
- [ ] 追加・変更した全画面で、キーボードだけで操作でき、axeのserious/critical違反が0、1440px/375pxで横溢れがない。画面のスクリーンショットをEvidenceに保存する(AGENTS §1.15)。
- [ ] `check:all`・型・lint・関連unitが通り、新規依存が0件である。

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-13(axe自動+キーボード)、TL-12(E2E: 管理者が部署・上長・ルールを設定 → 利用者が申請 → 上長が承認 → 固定承認者が承認 → 模擬完了)、TL-01(経路表示の整形)

### Evidence

- 画面ごとのスクリーンショット(1440/375)、axe結果、E2Eの実行ログ(合成データのみ)

`evidence/WP-P4-APR-016/<YYYYMMDD-HHMM>/` へ保存する([[06.2_Evidence_Index]])。

## 9. Security and Audit

- 非表示・無効化はUIの制御であってアクセス制御ではない。認可・検証はAPIが担う。
- 表示する個人データは、閲覧範囲(API層)が返した範囲だけ。画面・ログ・Evidenceに実データ・実PIIを含めない。
- 新しい監査イベントはない(APIが記録する)。UI変更のため人間レビューは通常手順。再割当操作の誤表示が権限の誤解を生まないことをレビューで確認する。

## 10. Rollback / 失敗時の扱い

UIのみの変更で、スキーマ変更なし。revertで戻せる。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Packageのみを実装してください(baselineに実体化された後のみ)。

正本: AGENTS.md / 本WP / ADR-0023(§5・§6・§9) / 03.5 / 03.13_UX_Accessibility_Requirements /
WP-P4-APR-015 のAPI契約 / apps/web の既存の申請・詳細・カタログ管理画面。

手順:
1. 依存WPのAPIが利用できること、受入基準(§7)が実行可能なテストへ変換できることを確認する。
2. 表示ロジック(経路の整形)を純関数に切り出し、単体テストを先に書く。
3. 画面を実装し、キーボード・axe・スクリーンショットを確認する。E2E(通し)を追加する。

やってはいけないこと:
- UIだけで権限を判定すること(APIの拒否に依存する)。承認者のIDの自由入力。
- API・スキーマの変更、実データの使用、新規依存、テストのskip・削除、Allowed Paths外の変更。
完了時に報告: 変更ファイル、Migrationなし、検証コマンドと結果、受入基準ごとの充足、スクリーンショットとaxe結果の保存先、未解決事項。
```

## 12. Definition of Done

- [ ] §7をすべて満たす / §8のテスト通過とEvidence保存(スクリーンショット・axe結果)
- [ ] Migrationなし(スキーマ互換への影響なしを説明)、ロールバック方針の記載
- [ ] 関連ドキュメント(画面一覧・User Story・RTMのStatus)の更新
- [ ] 未解決のCritical/Highがない
- [ ] Execution Logへ追記

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| - | - | - | Not started | - | - |
