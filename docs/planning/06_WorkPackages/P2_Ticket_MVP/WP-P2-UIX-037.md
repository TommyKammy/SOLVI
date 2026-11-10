---
project: SOLVI
doc_id: "WP-P2-UIX-037"
title: "チケット一覧の担当グループフィルタを期限の上へ移動"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-11-10"
updated: "2026-11-10"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "ui", "queue", "filter"]
source_of_truth: true
implementation_status: "done"
story_points: 2
risk: "low"
workstream: "UIX"
phase: "P2"
requirement_ids: ["BR-001", "NFR-UX-001", "NFR-UX-002", "NFR-UX-003", "NFR-UX-004"]
depends_on: ["WP-P2-UIX-036"]
---

# WP-P2-UIX-037: チケット一覧の担当グループフィルタを期限の上へ移動

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | UIX |
| Risk | low |
| Story Points | 2 |
| Suggested Owner | Frontend |
| Parallelizable | Yes |
| Gate | Gate A |

## 1. Purpose

チケット対応画面(`/ops`)のフィルタパネルで、「担当グループ」が
「詳細な条件」の中に隠れている。日常的に使う条件のため、
通常表示へ移し、「期限」の直上に配置する。

## 2. Requirement IDs

`BR-001`, `NFR-UX-001`, `NFR-UX-002`, `NFR-UX-003`, `NFR-UX-004`

## 3. Dependencies

[[WP-P2-UIX-036]]

## 4. Scope / Allowed Paths

- `apps/web/src/components/TicketFilters.tsx`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-037.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-UIX-037/`

## 5. Out of Scope

- フィルタ条件・API・URL仕様の変更
- 詳細な条件(状況・種別・優先度・受付日・依頼者)の変更
- フィルタパネルのデザイン変更
- 一覧・件数・並び順の変更

## 6. Deliverables

- 担当グループの選択欄を通常表示へ移動
- 表示順を「キーワード → 担当 → 担当グループ → 期限 → 並び順」にする
- 詳細な条件から担当グループを除く
- 不正なグループ指定時は、従来どおり hidden 入力で条件を保持する

## 7. Acceptance Criteria

- [ ] フィルタパネルの表示順が「キーワード、担当、担当グループ、期限、並び順」になる。
- [ ] 「詳細な条件」を開いても担当グループ欄は重複表示されない。
- [ ] 担当グループを選んで絞り込むと `group` がURLに反映され、一覧が絞り込まれる。
- [ ] 不正な `group` が指定された場合、条件を保持したまま解除リンクが表示される。
- [ ] 詳細な条件の「N条件を指定」に担当グループが二重計上されない。
- [ ] axeで対象画面にserious/criticalの違反がない。
- [ ] `npm run typecheck`、`npm run lint`、`npm run check:all`が通る。
- [ ] API・DB・Migrationの変更がない。

## 8. Verification and Evidence

- フィルタパネルの表示順(DOM順)
- 詳細な条件を開いたときの表示項目
- 担当グループ絞り込み後のURLと適用中チップ
- デスクトップ・モバイルのスクリーンショット
- axe結果
- Evidence: `evidence/WP-P2-UIX-037/<YYYYMMDD-HHMM>/`

## 9. Security and Audit

- 表示層のみ。認可・RLS・監査の変更なし。
- グループ候補は既存のAPI認可済みリストを使う。
- Evidenceに実PII・Secretを含めない。

## 10. Rollback / 失敗時の扱い

`TicketFilters.tsx` の変更を戻す。Migrationなし。

## 11. Codex app Prompt

```text
WP-P2-UIX-037だけを実装してください。
- /ops のフィルタで担当グループを期限の上に移動する。
- 詳細な条件からは担当グループを除く。
- 絞り込み・不正値の保持を壊さない。
- axe/typecheck/lint/check:allを実行する。
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
| 2026-11-10 | Codex | - | Done | `evidence/WP-P2-UIX-037/20261110-2015/` | 利用者報告: 担当グループを期限の上に配置したい。 |

### 2026-11-10 の実行結果

- 変更ファイル: `apps/web/src/components/TicketFilters.tsx`
- 修正:
  - 担当グループ欄を「詳細な条件」から通常表示へ移動。
  - 表示順を「キーワード、担当、担当グループ、期限、並び順」にした。
  - 詳細な条件の条件数から担当グループを除外した。
- 検証:
  - 通常表示の順序が想定どおり
  - 詳細な条件内に担当グループ欄なし
  - `group=mine` で絞り込みが反映
  - 不正なグループ指定は hidden 入力で保持し、解除リンクを表示
  - axe違反0、モバイル375pxで横スクロールなし
  - `npm run typecheck` / `npm run lint` / `npm run check:all` 成功
- セキュリティ影響: なし。表示層のみ。
- Rollback: `TicketFilters.tsx` の変更を戻す。
