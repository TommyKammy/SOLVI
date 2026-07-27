---
project: SOLVI
doc_id: "WP-P2-OPSUI-010"
title: "担当者向け操作画面とコメント往復"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-07-27"
updated: "2026-07-27"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "portal", "ops"]
source_of_truth: true
implementation_status: "partial"
phase: "P2"
workstream: "PORTAL"
risk: "medium"
story_points: 8
depends_on: ["WP-P2-PORTAL-002", "WP-P2-OPS-003", "WP-P2-COLLAB-004"]
requirement_ids: ["BR-001", "FR-TKT-003", "FR-TKT-004", "FR-TKT-005", "NFR-UX-001", "NFR-UX-002"]
aliases: ["WP-P2-OPSUI-010"]
---

# WP-P2-OPSUI-010: 担当者向け操作画面とコメント往復

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | PORTAL |
| Risk | medium |
| Story Points | 8 |
| Suggested Owner | Frontend + Backend |
| Gate | Gate A(GA-1 / GA-4) |

## 1. Purpose

**問い合わせの往復を画面だけで完結させる。**

[[WP-P2-GATE-007]] の Gate A 審査で、条件外ながら記録した問題を埋める。

- 担当者向けの操作画面が無く、IT担当は状態遷移も割当も画面から行えない
- コメントの画面が無く、依頼者は起票後に一切追記できない

この状態でパイロットを始めると「**使ってみたが結局電話した**」となり、
パイロットで測りたかったこと(SOLVIが電話とチャットを置き換えられるか)が
測れない。ゲート条件ではないが、実施前に埋めるべき欠落である。

APIは [[WP-P2-OPS-003]] と [[WP-P2-COLLAB-004]] で実装済みであり、
本WPは**画面とHTTP面だけ**を追加する。

## 2. Requirement IDs

`BR-001`, `FR-TKT-003`(状態遷移)、`FR-TKT-004`(内部メモ)、
`FR-TKT-005`(担当割当)、`NFR-UX-001`, `NFR-UX-002`

## 3. Dependencies

- [[WP-P2-PORTAL-002]] — 画面の土台と認証
- [[WP-P2-OPS-003]] — 一覧・割当・遷移のサービス
- [[WP-P2-COLLAB-004]] — コメントと内部メモのサービス

## 4. Scope / Allowed Paths

- `apps/web/src/`
- `services/api/src/modules/ticket/`
- `services/api/src/main.ts`
- `tests/`

## 5. Out of Scope

- 添付ファイルのアップロード画面 — 署名付きURLの発行と検証は
  [[WP-P2-COLLAB-004]] で実装済みだが、**ブラウザからの直接アップロードは
  経路の検証が別途必要**なため本WPでは扱わない
- 一括操作(複数チケットの同時割当など)
- 検索画面 — API は [[WP-P2-SEARCH-006]] で実装済み
- 通知の購読設定

## 6. Deliverables

- コメントのHTTPエンドポイント(投稿・一覧)
- 状態遷移・担当割当のHTTPエンドポイント
- 担当者向けチケット一覧
- チケット詳細のコメント欄(依頼者・担当者の双方)
- 内部メモの分離表示(担当者のみ)
- 操作の可否を画面に反映(できない操作を出さない)

## 7. Acceptance Criteria

- [x] 依頼者が自分のチケットへコメントを投稿できる
- [x] 担当者が公開コメントと内部メモを投稿できる
- [x] **内部メモが依頼者の画面に一切現れない**(本文・件数・存在の痕跡とも)
- [x] **内部メモが視覚的に明確に区別される**(担当者が誤って内部メモへ
      依頼者向けの返信を書かない / 逆も同様)
- [x] 担当者が引受・着手・解決・保留を画面から実行できる
- [x] **実行できない遷移がボタンとして表示されない**(押してからエラーにしない)
- [x] 依頼者には操作ボタンが表示されない
- [~] 担当者一覧で組織全体のチケットが見え、状態で絞り込める
      — **部分達成。** 組織全体の一覧は表示できるが、**状態での絞り込みは未実装**。
      APIには [[WP-P2-OPS-003]] で実装済みだが画面に出していない。
      件数が増えると担当者が探しにくくなる
- [x] axe による自動検査で violation 0
- [x] 越境・権限のテストがAPI層で通る

## 8. Verification and Evidence

- `tests/security/collaboration-routes.test.ts`
- `tools/check_accessibility.mjs`(画面追加分を対象に含める)

Evidenceは`evidence/WP-P2-OPSUI-010/<YYYYMMDD-HHMM>/`へ保存する。

## 9. Security and Audit

| 論点 | 対応 |
|---|---|
| 内部メモの漏えい | API層で `visibility` により除外。画面はAPIが返したものだけを描く |
| 誤投稿 | 内部メモと公開コメントを視覚的に強く区別する |
| 権限 | 実行できない操作を表示しない。ただし**表示しないことを防御にしない** — API層で必ず拒否する |
| 存在秘匿 | 権限の無いチケットは 404 |

## 10. Rollback / 失敗時の扱い

画面とHTTP面のみでDBスキーマを変更しない。

## 11. Definition of Done

- [ ] §7 Acceptance Criteriaをすべて満たす — **一覧の絞り込みが未実装**(§7参照)
- [x] §8のテストが通り、Evidenceを保存した
- [x] `check_rls.mjs` / `check_architecture.mjs` / `check_allowed_paths.mjs` が通る
- [x] Execution Logへ結果を追記した

## 12. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-07-27 | Fable 5 | `b11f831` | Done | `evidence/WP-P2-OPSUI-010/20260727-2302/` | 統合17件 + 往復21項目 + a11y 9画面。全体 1110 tests passed |

### 設計判断

**内部メモの除外は件数まで。** 本文を伏せても「1件隠されている」と分かれば、
依頼者は「何を書かれているのか」という疑念を持つ。除外は完全に行う。

**誤投稿を防ぐ既定値。** 内部メモを既定にすると「返事が来ない」が**毎回**起きる。
公開を既定にした場合の危険は、選択を誤ったときだけ起きる。
頻度の高いほうを既定にし、危険なほうに明示的な選択を求める。

**実行できない操作を出さないが、表示を防御にしない。**
`availableActions` に無い遷移を直接叩いても 422 で拒否されることをテストで固定した。
画面の作りが変わっても、この層が変わらなければ安全は保たれる。

**操作名は状態名ではなく行動で書く。** 「in_progress にする」ではなく
「対応を始める」。担当者が押すのは状態ではなく行動である。

### 審査中に整理した 403 と 404 の使い分け

| 応答 | 意味 |
|---|---|
| **403** | その役割にこの操作は存在しない(どのチケットでも同じ。存在は漏れない) |
| **404** | このチケットはあなたのものではない(存在を秘匿する必要がある) |

食い違いではなく、**漏れる情報の性質が違う**。すべて403にすると、
他人のチケットIDを総当たりしたときに実在が分かってしまう。

依頼者による取り消しだけは例外的に許されている。これが無いと
「やっぱり不要でした」のためだけに担当者へ連絡することになる。

### 残っている制約

- **添付ファイルのアップロード画面が無い。** 署名付きURLの発行と検証は
  [[WP-P2-COLLAB-004]] で実装済みだが、ブラウザからの直接アップロードは
  経路の検証が別途必要。**スクリーンショットを添付できないと障害報告の質が落ちる**
- 一覧の絞り込み(状態・優先度)がAPIにはあるが画面に無い
- 検索画面が無い(APIは [[WP-P2-SEARCH-006]] で実装済み)
- 通知は記録型のままで実メールは送られない
