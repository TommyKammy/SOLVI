---
project: SOLVI
doc_id: "WP-P2-UIX-036"
title: "運営状況の件数カードと内訳の導線を修正"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-11-10"
updated: "2026-11-10"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "ui", "dashboard", "bugfix"]
source_of_truth: true
implementation_status: "done"
story_points: 3
risk: "low"
workstream: "UIX"
phase: "P2"
requirement_ids: ["BR-001", "NFR-UX-001", "NFR-UX-002", "NFR-UX-003", "NFR-UX-004"]
depends_on: ["WP-P2-UIX-035"]
---

# WP-P2-UIX-036: 運営状況の件数カードと内訳の導線を修正

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | UIX |
| Risk | low |
| Story Points | 3 |
| Suggested Owner | Frontend |
| Parallelizable | Yes |
| Gate | Gate A |

## 1. Purpose

管理者向け画面の次の4点を修正する。

1. 右上のユーザーアイコンが通知アイコンとY方向に揃っていない。
2. 「現在の件数」の外枠と個別カードの枠が二重に見える。
3. 件数カードの数字をクリックしても一覧へ遷移しない。
4. 優先度・状況の内訳の中央数字から一覧へ遷移できない。

## 2. Requirement IDs

`BR-001`, `NFR-UX-001`, `NFR-UX-002`, `NFR-UX-003`, `NFR-UX-004`

## 3. Dependencies

[[WP-P2-UIX-035]]

## 4. Scope / Allowed Paths

- `apps/web/src/app/freshservice.css`
- `apps/web/src/app/globals.css`
- `apps/web/src/components/DonutChart.tsx`
- `apps/web/src/app/ops/overview/page.tsx`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-036.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-UIX-036/`

## 5. Out of Scope

- 運営状況の集計ロジック・API・DBの変更
- 一覧(`/ops`)のフィルタ仕様の変更
- 左レール・サポートポータルの変更
- 新しいグラフや指標の追加

## 6. Deliverables

- `.fs-user-menu summary` のグローバルな `summary` パディングを打ち消し、通知アイコンと中心Yを揃える
- 「現在の件数」の外枠・縦区切りを外し、個別カードの枠だけにする
- 件数カード全体をラベルリンクのクリック領域にし、数字からも一覧へ遷移できるようにする
- `DonutChart` に中央リンクを追加し、優先度・状況の内訳から一覧へ遷移できるようにする

## 7. Acceptance Criteria

- [ ] ユーザーアイコンと通知アイコンの中心Yが一致する(差1px以内)。
- [ ] 「現在の件数」に外枠がなく、6枚の個別カードの枠だけが見える。
- [ ] 6項目すべてで、数字をクリックすると `/ops` の該当フィルタへ遷移する。
- [ ] 遷移先の見出しが「問い合わせの一覧」で、フィルタ条件が反映されている。
- [ ] 優先度の内訳の中央数字をクリックすると、未完了の一覧へ遷移する。
- [ ] 状況の内訳の中央数字をクリックすると、未完了の一覧へ遷移する。
- [ ] キーボードでカードと中央数字にフォーカスでき、フォーカスが見える。
- [ ] axeで対象画面にserious/criticalの違反がない。
- [ ] `npm run typecheck`、`npm run lint`、`npm run check:all`が通る。
- [ ] API・DB・Migrationの変更がない。

## 8. Verification and Evidence

- ユーザーアイコン・通知アイコンの bounding box
- 「現在の件数」の computed border / background
- 6項目の数字クリック後のURLとフィルタ表示
- 2つのドーナツ中央クリック後のURL
- デスクトップ・モバイルのスクリーンショット
- axe結果
- Evidence: `evidence/WP-P2-UIX-036/<YYYYMMDD-HHMM>/`

## 9. Security and Audit

- 表示層のみ。認可・RLS・監査の変更なし。
- 遷移先は既存の `operationsQueueHref` が許可したクエリだけを使う。
- Evidenceに実PII・Secretを含めない。

## 10. Rollback / 失敗時の扱い

CSS・`DonutChart.tsx`・`page.tsx` の変更を戻す。Migrationなし。

## 11. Codex app Prompt

```text
WP-P2-UIX-036だけを実装してください。
- 右上ユーザーアイコンと通知アイコンのYを揃える。
- 現在の件数の外枠を外し、個別カードの枠だけにする。
- 件数カードの数字から該当フィルタの一覧へ遷移させる。
- ドーナツ中央数字から未完了一覧へ遷移させる。
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
| 2026-11-10 | Codex | - | Done | `evidence/WP-P2-UIX-036/20261110-1930/` | 利用者報告: アイコンYずれ、件数の二重枠、数字クリック不可、中央数字クリック不可。 |

### 2026-11-10 の実行結果

- 変更ファイル:
  - `apps/web/src/app/freshservice.css`
  - `apps/web/src/app/globals.css`
  - `apps/web/src/components/DonutChart.tsx`
  - `apps/web/src/app/ops/overview/page.tsx`
- 修正:
  - `.fs-user-menu summary` の `padding` を 0 にし、通知アイコンと中心Yを揃えた。
  - 「現在の件数」の外枠・縦区切りを削除し、個別カードの枠だけにした。
  - 件数カード全体をリンク領域にし、数字からも一覧へ遷移できるようにした。
  - `DonutChart` の中央数字にリンクを追加し、未完了一覧へ遷移できるようにした。
- 検証:
  - 通知アイコン centerY 32px / ユーザーアイコン centerY 32px
  - `.overview-counts` border 0 / 個別カード border 1px
  - 6指標すべて数字クリックで該当フィルタの `/ops` へ遷移
  - ドーナツ2種の中央クリックで未完了一覧へ遷移
  - axe: 運営状況・一覧とも違反0
  - モバイル375pxで横スクロールなし
  - `npm run typecheck` / `npm run lint` / `npm run check:all` 成功
- セキュリティ影響: なし。表示層のみ。
- Rollback: CSS・`DonutChart.tsx`・`page.tsx` の変更を戻す。
