---
project: SOLVI
doc_id: "WP-P2-UIX-026"
title: "チケット一覧・詳細のFreshservice化"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-11-10"
updated: "2026-11-10"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "ui", "ticket"]
source_of_truth: true
implementation_status: "done"
story_points: 8
risk: "medium"
workstream: "UIX"
phase: "P2"
requirement_ids: ["FR-TKT-003", "FR-TKT-006", "NFR-UX-001", "NFR-UX-002", "NFR-UX-003", "NFR-UX-004"]
depends_on: ["WP-P2-UIX-025", "WP-P2-OPSUI-010", "WP-P2-SEARCH-006"]
---

# WP-P2-UIX-026: チケット一覧・詳細のFreshservice化

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | UIX |
| Risk | medium |
| Story Points | 8 |
| Suggested Owner | Frontend + Product Owner |
| Parallelizable | No(一覧と詳細の両方に触れる) |
| Gate | Gate A |

## 1. Purpose

Freshserviceのチケット一覧(左の高密度テーブル+右の絞り込み)と、チケット詳細(上部のタブ+右のプロパティ)に寄せる。
既存の検索・絞り込み・並び順・ページング・状態遷移・返信・添付・関連付けの処理は変えない。

## 2. Requirement IDs

`FR-TKT-003`, `FR-TKT-006`, `NFR-UX-001`, `NFR-UX-002`, `NFR-UX-003`, `NFR-UX-004`

## 3. Dependencies

[[WP-P2-UIX-025]], [[WP-P2-OPSUI-010]], [[WP-P2-SEARCH-006]]

## 4. Scope / Allowed Paths

- `apps/web/src/app/ops/page.tsx`
- `apps/web/src/app/ops/[id]/page.tsx`
- `apps/web/src/components/TicketFilters.tsx`
- `apps/web/src/components/TicketPagination.tsx`
- `apps/web/src/components/HashOpenDetails.tsx`
- `apps/web/src/app/freshservice.css`
- `apps/web/src/app/globals.css`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-026.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-UIX-026/`

## 5. Out of Scope

- API・DB・認可・監査・SLA計算の変更
- 一括選択・一括更新・CSVエクスポートなど、新しい業務操作の追加
- チケット項目の追加
- Freshworksの画像・アイコン素材の複製

## 6. Deliverables

- `/ops` の2カラム化(左: 一覧、右: 絞り込み)
- 一覧テーブルへの依頼者・担当グループ列の追加
- `/ops/{id}` の上部タブ(アンカー)と右プロパティパネル
- モバイル幅では絞り込みが一覧の下に積まれるレイアウト
- スクリーンショットとaxe結果

## 7. Acceptance Criteria

- [ ] 1100px以上で `/ops` が左の一覧+右の絞り込みパネルの2カラムになる。
- [ ] 1100px未満では絞り込みが一覧の下に移動し、横スクロールなしで操作できる。
- [ ] 一覧に「問い合わせ」「依頼者」「状況」「優先度」「担当」「グループ」「SLAの目安」「受付日時」が表示される。
- [ ] キーワード・担当・期限・並び順・詳細条件・ページングが従来どおりURLに反映され、同じ結果になる。
- [ ] `/ops/{id}` に「詳細」「やり取り」「返信」「添付」「関連・資産・変更」のアンカータブが表示され、各節へ移動できる。
- [ ] `/ops/{id}` の右パネルに「プロパティ」見出しと既存の状況・担当・依頼者・グループ・受付日時が表示される。
- [ ] 既存の引き受け・状態遷移・返信・添付・関連付け・統合の操作が変わらず動作する。
- [ ] axeで `/ops` と `/ops/{id}` にserious/criticalの違反がない。
- [ ] `npm run typecheck`、`npm run lint`、`npm run check:all`、チケット関連の単体テストが通る。
- [ ] API・DB・Migrationの変更がない。

## 8. Verification and Evidence

- デスクトップ(1440×900)とモバイル(375×812)の `/ops`、`/ops/{id}` スクリーンショット
- 絞り込み適用後のURLと結果件数の記録
- axeの結果
- `tools/smoke_ticket_flow.mjs` の成功結果

Evidence: `evidence/WP-P2-UIX-026/<YYYYMMDD-HHMM>/`

## 9. Security and Audit

- 表示層のみ。認可・RLS・監査・Secretの扱いを変更しない。
- 依頼者名・件名などの既存APIが返す範囲だけを表示する。
- Evidenceに実PII・Secretを含めない。

## 10. Rollback / 失敗時の扱い

Migrationなし。`ops/page.tsx`、`ops/[id]/page.tsx`、`TicketFilters`、CSSの変更を戻すだけでロールバックできる。

## 11. Codex app Prompt

```text
WP-P2-UIX-026だけを実装してください。API/DBは変更しない。
- /ops を左一覧+右フィルタの2カラムにする。
- 一覧に依頼者・グループ列を追加する。
- /ops/{id} にアンカータブと「プロパティ」見出しを追加する。
- 既存のフォーム・状態遷移・ページングを壊さない。
- typecheck/lint/check:all/axe/smokeを実行し、Evidenceを保存する。
```

## 12. Definition of Done

- [ ] §7をすべて満たす
- [ ] §8のEvidenceを保存した
- [ ] API/DB変更なしを確認した
- [ ] WP台帳・RTM・Dependency Map・MANIFESTを更新した
- [ ] Execution Logへ追記した

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-11-10 | Codex | - | Done | `evidence/WP-P2-UIX-026/20261110-1315/` | Freshservice UI移植の第2段階。 |

### 2026-11-10 の実行結果

- 変更ファイル:
  - `apps/web/src/app/ops/page.tsx`
  - `apps/web/src/app/ops/[id]/page.tsx`
  - `apps/web/src/components/TicketFilters.tsx`
  - `apps/web/src/components/HashOpenDetails.tsx`(新規)
  - `apps/web/src/app/freshservice.css`
- Migration: なし。API/DB/認可/監査の変更なし。
- 検証:
  - `npm run typecheck` 成功
  - `npm run lint` 成功
  - `npm run check:all` 成功
  - axe: `/ops`, `/ops/{id}` 違反0
  - 絞り込み: keyword=VPN 3件 / assignment=unassigned 4件 / sort=deadline 7件
  - 詳細タブ: `#ticket-relations` へ移動し `details.open=true`
  - `tools/smoke_ticket_flow.mjs` 成功(INC-2026-000005)
- セキュリティ影響: なし。
- 未解決事項: 一括操作、モバイルのカード表示、タブの独立画面化。
- Rollback: `ops/page.tsx`、`ops/[id]/page.tsx`、`TicketFilters`、`freshservice.css` の変更を戻す。
