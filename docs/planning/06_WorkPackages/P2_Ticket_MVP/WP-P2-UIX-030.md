---
project: SOLVI
doc_id: "WP-P2-UIX-030"
title: "左レールメニューの開閉と重なり修正"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-11-10"
updated: "2026-11-10"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "ui", "bugfix"]
source_of_truth: true
implementation_status: "done"
story_points: 2
risk: "low"
workstream: "UIX"
phase: "P2"
requirement_ids: ["NFR-UX-002", "NFR-UX-004"]
depends_on: ["WP-P2-UIX-025"]
---

# WP-P2-UIX-030: 左レールメニューの開閉と重なり修正

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

左レールのフライアウトが、メニュー項目をクリックした後も開いたままになり、
別のレール項目へホバーすると前のメニューと重なって表示される問題を修正する。

原因は、クリックしたリンクにフォーカスが残り、CSSの`:focus-within`が
前のフライアウトを開き続けていたこと。フォーカス依存のCSSをやめ、
「同時に開くのは1つだけ」「マウスで選択したら閉じる」を状態で管理する。

## 2. Requirement IDs

`NFR-UX-002`, `NFR-UX-004`

## 3. Dependencies

[[WP-P2-UIX-025]]

## 4. Scope / Allowed Paths

- `apps/web/src/components/AppFrame.tsx`
- `apps/web/src/app/freshservice.css`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-030.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-UIX-030/`

## 5. Out of Scope

- レールの項目追加・並び替え
- メニュー内のリンク先変更
- モバイルのメニュー構造の変更
- API・DB・認可の変更

## 6. Deliverables

- 状態で管理するフライアウト(`openGroup`)
- マウス選択後の閉じる処理
- 外側クリック・Escapeによる閉じる処理
- キーボードフォーカス時の開閉維持
- 回帰確認用のPlaywrightスクリプトとスクリーンショット

## 7. Acceptance Criteria

- [ ] フライアウト内の項目をマウスでクリックすると、遷移後にフライアウトが閉じる。
- [ ] 別のレール項目へホバーすると、表示されるフライアウトは1つだけになる。
- [ ] レール項目にキーボードでフォーカスするとフライアウトが開き、Tabで項目へ移動できる。
- [ ] キーボードで項目を実行した後も、隠れた要素にフォーカスを残さない。
- [ ] Escapeと外側クリックでフライアウトが閉じる。
- [ ] モバイルの常時表示メニューは従来どおり動く。
- [ ] `npm run typecheck`、`npm run lint`、`npm run check:all`が通る。
- [ ] API・DB・Migrationの変更がない。

## 8. Verification and Evidence

- Playwrightで「ホバー→クリック→別項目ホバー」を実行し、可視フライアウトが常に1つ以下であることを確認
- スクリーンショット: クリック後、別項目ホバー後
- axe: `/inbox`の違反0
- Evidence: `evidence/WP-P2-UIX-030/<YYYYMMDD-HHMM>/`

## 9. Security and Audit

- 表示層のみ。認可・RLS・監査の変更なし。
- Evidenceに実PII・Secretを含めない。

## 10. Rollback / 失敗時の扱い

`AppFrame.tsx` と `freshservice.css` の変更を戻す。Migrationなし。

## 11. Codex app Prompt

```text
WP-P2-UIX-030だけを実装してください。
- フライアウトは同時に1つだけ開く。
- マウスで項目を選んだら閉じる。
- キーボードフォーカスでは開いたままにする。
- 外側クリックとEscapeで閉じる。
- API/DBは変更しない。
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
| 2026-11-10 | Codex | - | Done | `evidence/WP-P2-UIX-030/20261110-1430/` | 利用者報告: クリック後にメニューが残り、別項目で重なる。 |

### 2026-11-10 の実行結果

- 変更ファイル:
  - `apps/web/src/components/AppFrame.tsx`
  - `apps/web/src/app/freshservice.css`
- 原因: クリックしたリンクにフォーカスが残り、`:focus-within`が前のフライアウトを開き続けていた。
- 修正: `openGroup`状態で同時に1つだけ開く。マウス選択時は閉じてフォーカスを外す。キーボード時は開いたまま。外側クリック/Escape/遷移で閉じる。
- 検証:
  - Playwright: ホバー→クリック→別項目ホバーで可視フライアウトが常に1つ以下
  - クリック後: `[]`、ナレッジホバー後: `["ナレッジ"]`
  - axe: `/inbox` 違反0
  - `npm run typecheck` / `npm run lint` / `npm run check:all` 成功
- セキュリティ影響: なし。表示層のみ。
- Rollback: `AppFrame.tsx` と `freshservice.css` の変更を戻す。
