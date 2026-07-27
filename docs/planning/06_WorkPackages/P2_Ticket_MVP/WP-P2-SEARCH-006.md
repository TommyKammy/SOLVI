---
project: SOLVI
doc_id: "WP-P2-SEARCH-006"
title: "Ticket SearchとSLA Lite"
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
---

# WP-P2-SEARCH-006: Ticket SearchとSLA Lite

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | SEARCH |
| Risk | medium |
| Story Points | 8 |
| Suggested Owner | Backend |
| Parallelizable | No([[WP-P2-OPS-003]]後) |
| Gate | Gate A |

## 1. Purpose

チケットの日本語全文検索と、SLA(応答・解決期限)の計測を実装する。

**SLAの本質はクロックの停止条件にある。** 「利用者からの返信待ち」の時間をIT部門の
応答時間に数えると、担当者は返信を待つほど成績が悪くなる。結果として、
指標を守るために不要な催促や、実態と合わない期限設定が起きる。
停止条件を正しく実装することが、この指標を運用に耐えるものにする条件である。

検索は[[ADR-0011_Postgres_FTS_then_pgvector]]に従いPostgreSQLの全文検索で実装する。
外部検索クラスタは導入しない。

## 2. Requirement IDs

`FR-TKT-006`, `FR-TKT-008`, `NFR-SEC-001`, `NFR-SEC-006`, `NFR-PERF-001`, `NFR-PERF-002`

## 3. Dependencies

[[WP-P2-OPS-003]](完了済み)

## 4. Scope / Allowed Paths

- `db/migrations/`
- `services/api/src/modules/ticket/`
- `packages/shared/src/`
- `tests/unit/`
- `tests/security/`
- `tools/`

## 5. Out of Scope

- **認証されたHTTPエンドポイント** — [[WP-P1-IDM-003]] 完了まで着手しない
- ナレッジ記事の検索([[WP-P3-SRCH-002]])。本WPはチケットのみ
- セマンティック検索・pgvector([[ADR-0011_Postgres_FTS_then_pgvector]]の判断基準に達していない)
- SLA違反時の通知・エスカレーション([[WP-P2-NTF-005]])
- 営業時間・カレンダーを考慮したSLA計算。**初期は暦時間(24時間)で計算する**
  営業時間対応は祝日マスタと組織別設定が必要で、Gate A後の運用実績を見て判断する
- SLAポリシーの画面からの編集(初期は組織ごとの既定値のみ)

## 6. 設計判断

| 論点 | 決定 | 理由 |
|---|---|---|
| 日本語検索の方式 | **pg_bigm ではなく PostgreSQL 標準の `simple` 設定 + pg_trgm** を初期採用 | 追加拡張を増やさずに始める。形態素解析が必要な精度要求が出た時点で[[ADR-0011_Postgres_FTS_then_pgvector]]のFollow-upとして再評価する |
| SLAクロックの保持方法 | **累積経過時間を都度計算せず、状態遷移のたびに加算して保持** | 都度計算は遷移履歴の全走査が必要で、一覧表示で重くなる。加算方式なら列を読むだけで済む |
| 停止条件 | `pending` で停止、`in_progress` で再開([[03.3_Ticket_Requirements]]の遷移表 `slaClock`) | 遷移表に既に定義済み。実装はその表を参照する |
| SLA目標値 | 優先度別の既定値を組織単位で持つ | 初期は固定値。組織ごとの調整余地だけ残す |
| 期限超過の扱い | 記録するが**遷移を止めない** | SLAは計測指標であり統制ではない。超過を理由に業務を止めると現場が回らない |

## 7. Acceptance Criteria

- [ ] `sla_policy` が organization_id を持ち、`check_rls.mjs` が問題0件で通る
- [ ] 日本語の件名・本文で検索でき、部分一致(「ログイン」で「ログインできない」が)ヒットする
- [ ] 検索結果に**権限外のチケットが1件も含まれない**(一覧と同じ認可条件を使う)
- [ ] 検索キーワードに特殊文字(`&` `|` `!` `:` `'`)を含めても例外にならず、注入されない
- [ ] **`pending` に遷移するとSLAクロックが停止し、経過時間が加算されない**
- [ ] `pending` から `in_progress` に戻るとクロックが再開する
- [ ] 応答期限(初回応答まで)と解決期限を優先度別に判定できる
- [ ] 期限超過が記録されるが、**状態遷移は拒否されない**
- [ ] 停止・再開を複数回繰り返しても経過時間が正しく累積する
- [ ] 1万件での検索が p95 2.0秒以内(NFR-PERF-002)

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-01(SLAクロックの加算・停止・再開。時刻を制御して決定的に検証する)
- TL-06(検索結果の権限絞り込み)
- TL-03(検索キーワードの特殊文字)
- TL-15(1万件での検索応答時間)

### Evidence

- クロックの停止・再開を含むシナリオでの経過時間の実測値
- 検索結果に権限外が含まれないことの確認
- 1万件での検索応答時間

Evidenceは`evidence/WP-P2-SEARCH-006/<YYYYMMDD-HHMM>/`へ保存する。

## 9. Security and Audit

- 検索の認可条件は一覧([[WP-P2-OPS-003]])と**同一の実装を使う**。検索用に別の絞り込みを書くと、片方だけ修正されたときに漏れる
- 検索キーワードは `plainto_tsquery` 等でパラメータとして扱う。`to_tsquery` に生文字列を渡さない(構文エラーと注入の両方を避ける)
- SLA違反の情報は担当者向け。依頼者へ「対応が遅れている」ことを自動的に開示しない
- 該当する脅威: T-01(越境)、T-02(検索経由での存在推測)、T-03(注入)

## 10. Rollback / 失敗時の扱い

Migration の down で `sla_policy` と SLA関連の列・索引を削除する。
チケット本体は残る。SLAの計測値が失われるが、状態遷移の履歴(監査イベント)から再計算できる。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Package(WP-P2-SEARCH-006)のみを実装してください。

正本: AGENTS.md → 本WP(特に §6 設計判断)
     → docs/planning/03_Requirements/03.3_Ticket_Requirements.md(§状態機械の slaClock)
     → docs/planning/07_ADR/ADR-0011_Postgres_FTS_then_pgvector.md

作業内容:
1. 検索を実装する。**一覧(ticket-query.ts)の認可条件をそのまま使う**。
   検索用に別の絞り込みを書かないこと。片方だけ修正されると漏れる。
2. 検索キーワードはパラメータとして扱う。to_tsquery に生文字列を渡さない。
   特殊文字(& | ! : ')を含んでも例外にならないこと。
3. SLAクロックを実装する。**累積経過時間を列に保持し、状態遷移のたびに加算**する。
   都度計算は遷移履歴の全走査が必要で一覧が重くなる。
   停止・再開の条件は 03.3 の遷移表 slaClock を参照すること。
4. 応答期限・解決期限を優先度別に判定する。**超過しても遷移は止めない**。
   SLAは計測指標であり統制ではない。
5. 1万件での検索応答時間を計測する。

やってはいけないこと:
- 検索用に別の認可条件を書くこと
- SLA超過を理由に状態遷移を拒否すること
- 営業時間・祝日を考慮した計算(初期は暦時間。Out of Scope)
- HTTPエンドポイントの追加(WP-P1-IDM-003 未完了)

完了時に報告すること:
- クロックの停止・再開を含むシナリオでの経過時間の実測
- 検索結果に権限外が含まれないことの確認
- 1万件での検索応答時間
- §7 Acceptance Criteria の充足状況
```

## 12. Definition of Done

- [ ] §7 Acceptance Criteriaをすべて満たす
- [ ] §8のテストが通り、Evidenceを保存した
- [ ] Migration に down があり、up→down→up が成功する
- [ ] `check_rls.mjs` と `check_architecture.mjs` が通る
- [ ] Execution Logへ結果を追記した

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-07-27 | Claude (Codex) | `aa91812` | Done | `evidence/WP-P2-SEARCH-006/20260727-1520/verification.md` | 全941テスト通過。SLAは実経過4時間のうち3時間の待ちを除外し1時間のみ算入することを実測。停止条件は状態機械の`slaClock`を唯一の根拠とし、遷移表との一致をテストで固定。検索はILIKEのワイルドカード`%` `_`をエスケープ(未エスケープだと`%`単体で全件ヒット)。1万件で検索p95 9.8ms(目標2000ms、ローカル計測)。 |
