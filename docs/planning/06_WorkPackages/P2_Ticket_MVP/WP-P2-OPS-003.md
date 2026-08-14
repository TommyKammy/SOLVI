---
project: SOLVI
doc_id: "WP-P2-OPS-003"
title: "Ticket一覧・フィルタ・担当割当"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.2.0"
created: "2026-07-27"
updated: "2026-07-27"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2"]
source_of_truth: true
implementation_status: "done"
story_points: 8
risk: "high"
workstream: "OPS"
phase: "P2"
requirement_ids: ["FR-TKT-003"]
---

# WP-P2-OPS-003: Ticket一覧・フィルタ・担当割当

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | OPS |
| Risk | high |
| Story Points | 8 |
| Suggested Owner | Backend |
| Parallelizable | Yes([[WP-P2-COLLAB-004]]と並行可) |
| Gate | Gate A |

> **分割の経緯**: 当初13ポイントで「一覧・詳細・関連付け」を1WPにまとめていたが、
> 単一PRに収まらないため関連付けとMergeを[[WP-P2-REL-009]]へ分離した(2026-07-27)。

## 1. Purpose

IT担当が日々使う一覧・フィルタと、担当者の割当を実装する。

一覧は**最も件数が多く、最も権限漏れが起きやすい経路**である。詳細画面は1件ずつの認可で守れるが、一覧は「条件に合う全件」を返すため、絞り込み条件に権限が組み込まれていないと一度に大量に漏れる。ここでの認可はWHERE句の一部として実装する。

## 2. Requirement IDs

`FR-TKT-003`, `FR-TKT-006`, `NFR-SEC-001`, `NFR-SEC-006`, `NFR-PERF-001`, `AUD-001`

## 3. Dependencies

[[WP-P2-TKT-001]](完了済み)

## 4. Scope / Allowed Paths

- `db/migrations/`
- `services/api/src/modules/ticket/`
- `packages/shared/src/`
- `tests/unit/`
- `tests/security/`

## 5. Out of Scope

- **認証されたHTTPエンドポイント** — [[WP-P1-IDM-003]] 完了まで着手しない
- 関連付け・Merge([[WP-P2-REL-009]])
- 全文検索・SLA表示([[WP-P2-SEARCH-006]])。本WPの検索は番号・件名の前方一致と属性フィルタまで
- 一括処理(複数チケットの同時更新)。Gate A後の運用実績を見て判断する
- 保存済みビュー・ダッシュボード

## 6. Deliverables

- 担当割当(individual / group)と割当履歴
- 一覧クエリ(状態・優先度・担当・種別・期間・キーワードのフィルタ)
- **キーセットページネーション**(オフセットではない)
- 一覧の認可をWHERE句へ組み込む実装
- 監査イベント(`ticket.assigned`)

## 7. Acceptance Criteria

- [ ] 担当者を割り当てると `ticket.assigned` 監査イベントが生成され、割当履歴が残る
- [ ] 割当先が同一Organizationに所属していない場合、割当が拒否される
- [ ] 依頼者(requester)の一覧結果に**自分が依頼者でないチケットが1件も含まれない**
- [ ] 担当者(agent)は組織内の全チケットを一覧できるが、**他組織のチケットは1件も含まれない**
- [ ] 認可条件がWHERE句に含まれている(取得後のフィルタでない)
- [ ] ページネーションがキーセット方式で、同一条件の連続取得で重複・欠落が発生しない
- [ ] フィルタ値に不正な列名・SQL片を渡しても、パラメータとして扱われ注入されない
- [ ] 1万件のチケットに対する一覧取得が p95 1.5秒以内(NFR-PERF-001の一部)
- [ ] 件数取得(total)が権限で絞られた件数を返す(全体件数を漏らさない)

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-06(一覧の権限絞り込み、越境)
- TL-03(フィルタ入力の検証、SQL注入)
- TL-15(1万件での応答時間)
- TL-04(割当と履歴)

### Evidence

- 依頼者・担当者それぞれの一覧結果件数と、他者/他組織の混入0件の確認
- ページネーションの連続取得で重複・欠落0件の確認
- 1万件での応答時間の実測

Evidenceは`evidence/WP-P2-OPS-003/<YYYYMMDD-HHMM>/`へ保存する。

## 9. Security and Audit

- **一覧の認可はWHERE句で行う。** 全件取得後にフィルタする実装にしない(件数が多いほど漏えい規模が大きくなる)
- 件数(total)も同じ条件で数える。全体件数を返すと、権限外のチケット数が漏れる
- フィルタの列名・ソート順は**許可リスト**で受ける。文字列連結でSQLを組み立てない(脅威 T-03)
- 割当先ユーザの所属を検証する。他組織のユーザを担当者にできると、そのユーザ経由で内容が読める
- 該当する脅威: T-01(越境)、T-02(IDOR)、T-03(mass assignment / SQL注入)

## 10. Rollback / 失敗時の扱い

Migration の down で割当履歴テーブルを削除できる。`ticket.assignee_id` は
[[WP-P2-TKT-001]] で作成済みの列であり、本WPでは削除しない(down で NULL に戻すのみ)。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Package(WP-P2-OPS-003)のみを実装してください。

正本: AGENTS.md → 本WP → docs/planning/03_Requirements/03.3_Ticket_Requirements.md
     → docs/planning/02_Architecture/02.18_Organization_Data_Model_and_RLS.md §4

作業内容:
1. 担当割当を実装する。割当先が同一Organizationに所属していることを検証する。
   割当履歴を残し、ticket.assigned 監査イベントを生成する。
2. 一覧クエリを実装する。**認可条件をWHERE句に含める**。
   - requester: 自分が依頼者のチケットのみ
   - agent 以上: 組織内の全チケット
   取得後のフィルタにしないこと。件数(total)も同じ条件で数えること。
3. フィルタ(状態・優先度・担当・種別・期間・キーワード)を実装する。
   列名・ソート順は許可リストで受ける。文字列連結でSQLを組み立てない。
4. ページネーションはキーセット方式(created_at, id の複合カーソル)。
   オフセットは件数が増えると重くなり、同時更新で重複・欠落が出る。
5. 1万件の合成データで応答時間を計測し、記録する。

やってはいけないこと:
- 全件取得してからアプリでフィルタすること
- 権限で絞る前の総件数を返すこと
- ソート列やフィルタ列を文字列連結でSQLへ埋め込むこと
- HTTPエンドポイントの追加(WP-P1-IDM-003 未完了)

完了時に報告すること:
- 依頼者・担当者それぞれの一覧件数と、混入0件の検証結果
- ページネーションの重複・欠落検証
- 1万件での応答時間
- §7 Acceptance Criteria の充足状況
```

## 12. Definition of Done

- [ ] §7 Acceptance Criteriaをすべて満たす
- [ ] §8のテストが通り、Evidenceを保存した
- [ ] Migration に down があり、up→down→up が成功する
- [ ] `check_rls.mjs` と `check_architecture.mjs` が通る
- [ ] Security Reviewer のレビューを完了した(一覧の権限漏れは影響が大きいため)
- [ ] Execution Logへ結果を追記した

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-07-27 | Claude (Codex) | `2dc7206` | Done | `evidence/WP-P2-OPS-003/20260727-1505/verification.md` | 全876テスト通過。認可をWHERE句へ組込み、件数も同条件で算出。1万件でp95 7.9ms(目標1500ms、ローカル計測のため本番再計測が必要)。**バグ2件を発見・修正**: (a) JS Dateのマイクロ秒切り捨てでカーソルが機能せず2ページ目以降が0件だった → `created_at::text`で持ち回る (b) 件数クエリにカーソル条件が混入しtotalが減っていた → カーソル前のWHEREを件数用に保持。 |
