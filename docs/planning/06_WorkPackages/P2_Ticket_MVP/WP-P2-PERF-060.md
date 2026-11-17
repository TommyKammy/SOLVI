---
project: SOLVI
doc_id: "WP-P2-PERF-060"
title: "失われた性能比較の基準を現行コミット基準で取り直す"
category: "06_WorkPackages"
type: "workpackage"
status: "draft"
version: "0.1.0"
created: "2026-11-17"
updated: "2026-11-17"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2"]
source_of_truth: false
implementation_status: "not-started"
story_points: 8
risk: "medium"
workstream: "PERF"
phase: "P2"
requirement_ids: ["NFR-PERF-001", "NFR-PERF-002"]
---

# WP-P2-PERF-060: 失われた性能比較の基準を現行コミット基準で取り直す

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | PERF |
| Risk | medium |
| Story Points | 8 |
| Suggested Owner | Tech Lead |
| Parallelizable | Yes(`tools/performance/` と性能テストに触れる他のWPと同時に進めない) |
| Gate | Gate A |

> `draft`。[[00.6_Decision_Register]] DEC-009 の「置き換え」側。元の作業環境が見つかった場合は、このWPを実体化せずに `archived` とする。

## 1. Purpose

公開リポジトリは `751d6ae`(Publish current SOLVI development snapshot、2026-11-10)で 2026-10-03〜11-10 の履歴を1コミットに潰している。そのため、性能比較の道具(`tools/performance/`)が `git show <ref>:<path>` で読む旧ソース6版と、WP-P2-PERF-053 の承認入力・証拠(`evidence/WP-P2-PERF-053/20261006-approval/` と、commit `82afbaee` 時点の `evidence/` 目録)が失われた。これらに依存する単体テスト26件は DEC-009 により期限付きで skip している。

このWPは、失われた基準に頼らず、**現行コミットを基準として**比較の入力を取り直し、skip したテストを置き換える。

## 2. Requirement IDs

`NFR-PERF-001`, `NFR-PERF-002`

## 3. Dependencies

なし(DEC-009 の skip が入っていること)。

## 4. Scope / Allowed Paths

- `tools/performance/`
- `tests/unit/performance-runtime.test.ts`
- `tests/unit/performance-search-static-cli.test.ts`
- `tests/fixtures/performance/`
- `evidence/WP-P2-PERF-060/`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-PERF-060.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/00_Index/00.6_Decision_Register.md`
- `docs/planning/MANIFEST.md`

## 5. Out of Scope

- 製品コード(`services/`、`apps/`、`packages/`)の変更。
- 性能目標値(NFR-PERF-001/002 の閾値)の変更。
- 失われた計測結果そのものの再現(結果ではなく比較の入力を取り直す)。

## 6. Deliverables

- 旧ソース6版(WP044〜048 の基準、ref `08a0904` / `035288f` / `d66537c` / `15016d7` / `1d5e0ec` / `1e491c9`)に代わる比較の基準。現行コミットに存在するバイト列を fixture としてコミットし、`git show` に依存しない読み方にする(WP049 の基準で行った方法と同じ)。
- WP-P2-PERF-053 の承認入力(`inputs.json`、`corpus.json`、ソース目録、凍結した `evidence/` の目録)を現行コミット基準で作り直し、改めて承認を受ける。
- DEC-009 で skip した26件の置き換え(skip の解除、または同じ性質を検査する新しいテスト)。

## 7. Acceptance Criteria

1. `tests/unit/performance-runtime.test.ts` と `tests/unit/performance-search-static-cli.test.ts` に DEC-009 の `SKIP-UNTIL` が1件も残らない。
2. 両テストファイルが CI の単体テストで全件通る(shallow clone でも通る。`git show` で過去のコミットを読まない)。
3. 固定した基準のバイト列は sha256 で照合され、1バイトでも変われば失敗する検査が残っている。
4. 新しい承認入力は人間が承認し、その記録が `evidence/WP-P2-PERF-060/` にある。

## 8. Verification and Evidence

- `npm run test:unit`、`npm run check:skips`、`npm run check:all`
- 承認入力の sha256 と承認者の記録

Evidence: `evidence/WP-P2-PERF-060/<YYYYMMDD-HHMM>/`

## 9. Security and Audit

- テストと計測道具のみ。製品の認可・RLS・監査は変えない。
- 計測用の合成データのみを使う。実データ・Secret を fixture や証拠に含めない。

## 10. Rollback / 失敗時の扱い

Migration なし。変更を戻すと DEC-009 の skip の状態に戻る。

## 11. Codex app Prompt

```text
WP-P2-PERF-060だけを実装してください。製品コードは変更しない。
- 失われた旧ソース6版に代わる基準を現行コミットから作り、fixture として読む。
- WP053 の承認入力を現行コミット基準で作り直し、承認を受ける。
- DEC-009 の skip 26件を置き換え、check:skips と test:unit を通す。
```

## 12. Definition of Done

- [ ] §7をすべて満たす
- [ ] §8のEvidenceを保存した
- [ ] WP台帳・RTM・Decision Register・MANIFESTを更新した
- [ ] Execution Logへ追記した

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-11-17 | Claude | - | Draft | - | DEC-009 の置き換え側として起票。元の環境が見つかれば archived とする。 |
