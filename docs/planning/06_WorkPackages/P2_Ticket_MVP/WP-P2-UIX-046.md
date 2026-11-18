---
project: SOLVI
doc_id: "WP-P2-UIX-046"
title: "UI v2のチケット一覧・詳細"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.2.0"
created: "2026-11-18"
updated: "2026-11-18"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "ui"]
source_of_truth: true
implementation_status: "review"
story_points: 8
risk: "medium"
workstream: "UIX"
phase: "P2"
requirement_ids: ["FR-TKT-003", "FR-TKT-006", "NFR-UX-001", "NFR-UX-002", "NFR-UX-003", "NFR-UX-004"]
depends_on: ["WP-P2-UIX-044", "WP-P2-UIX-026"]
---

# WP-P2-UIX-046: UI v2のチケット一覧・詳細

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | UIX |
| Risk | medium |
| Story Points | 8 |
| Suggested Owner | Frontend + Product Owner |
| Parallelizable | UIX-045と並行できる(触るファイルが重ならない) |
| Gate | Gate A |

## 1. Purpose

チケット一覧(`/ops`、`/inbox`)と詳細(`/ops/[id]`)の見た目をUI v2に揃える。
**状態機械・認可・API・監査は変えない。** 操作の種類と順序は [[WP-P2-UIX-026]] の結果を保ったまま、見た目と配置だけを変える。

見本: `assets/ui/SOLVI_UI_v2_Mockup.html` の一覧と詳細。

- 一覧: 上部に絞り込みボタン(未完了・担当者未割当・自分の担当・確認・対応待ち・解決期限超過・最優先)を置き、その下に罫線だけの表を置く。優先度は色の点と文字、状態は控えめなラベルで表す
- 詳細: 左にやり取りのスレッドと返信欄、右に項目一覧(状態・優先度・解決期限・担当グループ・担当者・依頼者・カテゴリ・関連資産)と履歴を置く。社内メモは背景色で区別する

## 2. Requirement IDs

`FR-TKT-003`, `FR-TKT-006`, `NFR-UX-001`, `NFR-UX-002`, `NFR-UX-003`, `NFR-UX-004`

## 3. Dependencies

[[WP-P2-UIX-044]], [[WP-P2-UIX-026]]

## 4. Scope / Allowed Paths

- `apps/web/src/app/ops/page.tsx`
- `apps/web/src/app/ops/[id]/page.tsx`
- `apps/web/src/app/inbox/page.tsx`
- `apps/web/src/components/TicketFilters.tsx`
- `apps/web/src/components/TicketPagination.tsx`
- `apps/web/src/components/TableRegion.tsx`
- `apps/web/src/components/CommentThread.tsx`
- `apps/web/src/components/ReplyForm.tsx`
- `apps/web/src/components/TicketRoutingForm.tsx`
- `apps/web/src/components/HashOpenDetails.tsx`
- `apps/web/src/app/freshservice.css`
- `tests/unit/ticket-detail-recovery-ui.test.ts`
- `tests/unit/table-regions.test.ts`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-046.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-UIX-046/`

## 5. Out of Scope

- 状態機械・遷移・認可・API・監査の変更
- requester向けのチケット画面(`/tickets/[id]`)の変更
- AIによる参考情報の表示。モックアップにある「AIによる参考情報」欄は、P8_AIのWPで扱う
- 一覧の列の表示切替(「表示項目」ボタン)。モックアップにはあるが、保存先が決まっていないため含めない
- 新規npm依存の追加

## 6. Deliverables

- 一覧: 絞り込みボタン、表、空の表示、ページ送り
- 詳細: スレッド(社内メモの区別あり)、返信欄、右側の項目一覧、履歴
- 両テーマのスクリーンショットとaxeの結果

## 7. Acceptance Criteria

- [x] `/ops` の絞り込みボタンは、既存の `OPERATIONS_METRICS` の項目と同じクエリを使う。押した状態は `aria-pressed` で伝わる。
- [x] 一覧の表は、番号・件名・状態・優先度・担当グループ・担当者・解決期限を出す。状態と優先度の表示名は `labels.ts` に従う。
- [x] 優先度は色の点と文字の両方で、解決期限超過は色と文字の両方で伝える。
- [x] 表は `TableRegion` を通し、狭い幅では横スクロールで読める。ページ全体は横にスクロールしない。
- [x] 詳細のスレッドで、社内メモが返信と見た目で区別され、「社内メモ」の文字も付く。
- [x] 返信欄から、従来どおり返信・社内メモ・解決を送れる。送信後の表示と、競合時のエラー表示が変わらない。
- [x] 右側の項目一覧に既存の `TicketRoutingForm` を置き、従来どおり送信ボタンで状態・優先度・担当グループ・担当者を変えられる(権限がある場合だけ)。押してすぐ保存する形にはしない。選べる値は既存APIの返す候補だけで、自由入力にしない。
- [x] 履歴は既存の取得結果を新しい順に出す。
- [x] `/inbox` も同じ表の見た目になる。列は番号・件名・種類・状態・期限を共通にし、種類(チケット・申請承認・変更)はラベルで示す。種類が違っても一つの表で並べる。
- [x] 既存のUIX-026の受け入れ条件が引き続き満たされる。
- [x] `npm run typecheck`、`npm run lint`、`npm run check:all`、§4のテストが通る。
- [x] axeで `/ops`、`/inbox`、チケット詳細を両テーマで検査し、serious/criticalの違反がない。

## 8. Verification and Evidence

- TL-12: 受信箱→一覧の絞り込み→詳細→返信送信
- TL-13: axe(両テーマ)
- `evidence/WP-P2-UIX-046/<YYYYMMDD-HHMM>/` に、変更前後のスクリーンショット、検証コマンドと結果、axeの結果を保存する。

## 9. Security and Audit

- 表示層だけの変更。状態の変更・担当の変更は既存のフォームとAPIを通し、監査記録の経路を変えない。
- 選択肢は既存APIの候補から出し、IDの自由入力を作らない(AGENTS.md §4)。
- Evidenceには実データ・実PIIを含めない。

## 10. Rollback / 失敗時の扱い

Migrationはない。§4のファイルをUIX-044完了時点に戻せばよい。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。WP-P2-UIX-046だけを実装してください。
正本: AGENTS.md、本WP、docs/planning/assets/ui/SOLVI_UI_v2_Mockup.html(一覧・詳細)、WP-P2-UIX-026、既存の /ops・/inbox・/ops/[id] 実装。
見た目と配置だけを変え、状態機械・API・認可・監査には触れないこと。
AIの参考情報欄と「表示項目」ボタンは作らないこと。新規npm依存を追加しないこと。
完了時は、変更ファイル・検証コマンドと結果・§7の充足状況・セキュリティ影響・未解決事項・Evidenceの保存先を報告すること。
```

## 12. Definition of Done

- [x] §7をすべて満たす
- [x] §8のテストが通り、Evidenceを保存した
- [x] 関連ドキュメントを更新した
- [ ] Product Ownerの承認を得た
- [x] Execution Logへ結果を追記した

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-11-18 | Claude | - | Draft | `assets/ui/SOLVI_UI_v2_Mockup.html` | UI v2のWP案として起草した。 |
| 2026-11-18 | Product Owner | - | Baseline | - | 未決事項の決定を反映し、baselineとして承認。 |
| 2026-11-18 | OpenCode | - | Review | `evidence/WP-P2-UIX-046/20261118-1458/` | UI v2の一覧・受信箱・詳細を実装。API/DB/認可/監査は変更なし。 |
| 2026-11-18 | OpenCode | - | Review fix | `evidence/WP-P2-UIX-046/20261118-1458/logs/review-fix.txt` | `ops/page.tsx`のprettier整形と、公開コメントの表示名を`authorIsRequester`で「依頼者からのコメント」「依頼者への返信」に分離(履歴も同一規則、不明時は「公開コメント」)。 |

### 2026-11-18 の実行結果

- 変更ファイル:
  - `apps/web/src/app/ops/page.tsx`
  - `apps/web/src/app/ops/[id]/page.tsx`
  - `apps/web/src/app/inbox/page.tsx`
  - `apps/web/src/components/CommentThread.tsx`
  - `apps/web/src/app/freshservice.css`
  - `tests/unit/table-regions.test.ts`
  - `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-046.md`
  - `docs/planning/MANIFEST.md`
  - `evidence/WP-P2-UIX-046/20261118-1458/`
- Migration: なし。DB・API・認可・監査・状態機械の変更なし。
- 実装:
  - `/ops`: `OPERATIONS_METRICS` の6ボタン(`role="button"` + `aria-pressed`)。クエリは `operationsMetricQuery` と同一。罫線だけの表(番号・件名・状態・優先度・担当グループ・担当者・解決期限・依頼者・受付日)。優先度は色の点と文字、期限超過は `--danger` と「◯◯超過」で表示。
  - `/inbox`: チケット・申請承認・変更を1つの表に統合。列は番号・件名・種類・状態・期限・次の対応。種類は「チケット」「申請承認」「変更」のラベル。既存の `InboxOpenForm` は維持。
  - `/ops/[id]`: 左にやり取り・返信・添付、右にプロパティ・履歴・操作・担当グループ変更・優先度/影響・関連。社内メモは背景色と左罫線、「社内メモ（依頼者には表示されません）」の文字で区別。履歴は取得済みの起票・解決・コメント・添付を新しい順に表示。`TicketRoutingForm` は送信ボタン式のまま、候補はAPIの `availableGroups` だけ。
- 検証:
  - `npm run typecheck` 成功(`logs/typecheck.txt`)
  - `npm run lint` は追跡外の `.claude/worktrees/*/apps/web/next-env.d.ts` 3件のみ失敗(`logs/lint-full.txt`)。追跡ファイルだけのlintは成功(`logs/lint-tracked-files.txt`)。変更ファイルのlintも成功(`logs/lint-changed-files.txt`)。
  - `npm run check:all` 成功(`logs/check-all.txt`)
  - `npx vitest run tests/unit/ticket-detail-recovery-ui.test.ts tests/unit/table-regions.test.ts tests/unit/navigation-ui.test.ts tests/unit/ui-contrast-and-focus.test.ts` 99件成功(`logs/vitest-targeted.txt`)
  - `npm run test:unit` 116ファイル / 4810成功・26 skip(`logs/test-unit.txt`)
  - axe(`wcag2a/2aa/21a/21aa/22aa`): 変更前後32スキャン、違反0。serious/critical 0。両テーマ・1440/375(`axe/`)
  - 375px: ページ全体の横スクロール0。表だけが横スクロール(`summary.json` の `afterTableLocalScroll`: `/ops` 343→1040、`/inbox` 343→940)。
  - TL-12: ログイン→`/inbox`→`/ops`→「担当者未割当」(`aria-pressed=false`→`true`)→詳細→返信送信「返信を保存しました。」(`summary.json` の `checks.tl12`、`tl12/`)。
- セキュリティ影響: 表示層のみ。新しいAPI呼び出し・自由入力・ID入力・外部CSS/フォント/CSP緩和なし。Evidenceは合成データのみで、パスワード・Cookieは保存していない。
- 未解決事項:
  - 詳細の「カテゴリ」は既存APIが返さないため表示していない。項目追加はAPI変更になるため別WPとする。
  - 「関連資産」はプロパティから既存の「関連する問い合わせ・資産・変更」へ移動するリンクにした。資産の直接一覧は同節の `TicketAssetPanel` にある。
  - `npm run lint` の3件は `.claude/worktrees` 由来。`.claude` をlint対象外にする変更はAllowed Paths外のため未実施。
  - `docs/planning/06.0_WorkPackage_Register.md` / `06.1_Dependency_Map.md` / `03.18_Requirements_Traceability_Matrix.md` は既に本WPを参照しており、変更不要だった。
- Rollback: Migrationなし。§4の画面・CSS・テストをUIX-045完了時点へ戻す。


## 14. 決定事項(2026-11-18 Product Owner)

- **詳細の右側の編集方法**: 既存のフォーム(送信ボタン式)を右側に置き直す。押してすぐ保存する形は採らない。
- **`/inbox` の列**: 共通の列(番号・件名・種類・状態・期限)にし、種類をラベルで示す。一つの表で並べる。
