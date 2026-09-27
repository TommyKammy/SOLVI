---
project: SOLVI
doc_id: "WP-P1-SEC-025"
title: "四半期アクセスレビューの自動起票と遅れの可視化"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-09-28"
updated: "2026-09-28"
owner: "SOLVI Product Team"
tags: ["workpackage", "p1", "security", "identity"]
source_of_truth: true
implementation_status: "done"
phase: "P1"
workstream: "SEC"
risk: "high"
story_points: 5
depends_on: ["WP-P1-SEC-024"]
requirement_ids: ["NFR-SEC-002"]
aliases: ["WP-P1-SEC-025"]
---

# WP-P1-SEC-025: 四半期アクセスレビューの自動起票と遅れの可視化

| 項目 | 値 |
|---|---|
| Phase | P1 |
| Workstream | SEC |
| Risk | high |
| Story Points | 5 |
| Suggested Owner | Tech Lead + Security Reviewer |
| Parallelizable | No |
| Gate | Gate 1 / 脅威 T-20 |

## 1. Purpose

[[WP-P1-SEC-024]] でアクセスレビューを**開き・判断し・閉じる**ことができるようになった。
**開くのは人だけである。** 誰も開かなければ、何も起きない。

`NFR-SEC-002` が求めているのは「**四半期**アクセスレビュー」である。
いま言えるのは「実施できる」までで、「四半期ごとに実施している」とは言えない。

| | 状態 |
|---|---|
| 開く・判断する・閉じる | **動く**([[WP-P1-SEC-024]]) |
| **期が来たら開く** | **無い** |
| **遅れていることが分かる** | **無い** |

手続きは、始める日と終わる日が決まっていなければ手続きにならない。
**始まらないことと、終わらないことの両方を、人が気付く前に機械が見る。**

## 2. Requirement IDs

`NFR-SEC-002`(レビューの側。Connector別最小スコープ表 = GB-7 は Phase 4 のまま)

## 3. Dependencies

- [[WP-P1-SEC-024]](完了・main 取り込み済み `65c8138`)

## 4. Scope / Allowed Paths

- `db/migrations/`
- `services/api/src/modules/auth/`
- `services/api/src/common/`
- `services/api/src/main.ts`
- `packages/shared/src/config/`
- `packages/shared/src/observability/`
- `apps/web/src/app/ops/`
- `apps/web/src/lib/`
- `tests/security/`
- `tests/unit/`
- `infra/monitoring/alerts/`
- `docs/ops/slo.md`
- `.env.example`
- `docs/planning/`
- `evidence/WP-P1-SEC-025/`

## 5. Out of Scope

- **完了期日の確定値。** 要求文書に数字が無い。**30日を仮値**とし、環境変数で変えられるようにする
  ([[99.4_Decision_Log|DL-035]] と同じ扱い。根拠の無い数値をコードに埋め込まない)
- **通知(メール)。** 遅れはメトリクスとアラートで運用側に出す。
  組織の管理者へのメール通知は、通知の宛先設計を伴うため別WP
- `platform` スコープの役割(SEC-024 §7.1 のとおり、この組織からは見えない)

## 6. Deliverables

- 期日の列と、定期処理が開いた期を表す制約(migration)
- 定期処理(期が来たら開く・遅れを数える)と、その起動
- 遅れのメトリクスとアラート規則、運用手順への追記
- 画面への期日・期日超過の表示

## 7. Acceptance Criteria

- [x] AC-1: 今期のレビューが無い組織すべてに、定期処理が `YYYY-Qn` を開く(`source = 'scheduled'`)
- [x] AC-2: 人が別の名前で今期に開いていれば開かない(開始時刻で判定)
- [x] AC-3: 前の期が未完了なら開かず、`blockedByOpen` と遅れに数える
- [x] AC-4: 2回回しても、同時に回しても、期は1つ(一意索引が競合を止める)
- [x] AC-5: 期日は `ACCESS_REVIEW_DUE_DAYS`(既定30日・**仮値**、1〜89)。人が開いた期にも付く
- [x] AC-6: `solvi_access_review_overdue` と `solvi_access_review_missing_this_quarter`。
      **名前は稼働中の `/metrics` で確認**し、Prometheus が規則を読み込んでいることも確認した
- [x] AC-7: 開くものが無い周回でも `opened=0 alreadyCovered=N` をログへ出す(記録用ロガーで検査)
- [x] AC-8: 監査は `actorType: system`、`opened_by` は NULL(DB制約で強制)
- [x] AC-9: 画面に完了期日・定期起票・「期日を過ぎています」(期日を一時的に過去へずらして確認)
- [x] AC-10: 候補抽出だけが読み取り例外を使う。開いた項目がその組織の役割だけであることを検査
- [x] AC-11: `check:all` 緑、`test:security` 568 passed を2回

### 7.1 遅れだけを見ていたら、始まらないことを見逃していた

最初は「期日を過ぎた未完了の件数」だけをメトリクスにした。
**定期処理が開けなくなると、期日を過ぎるレビューがそもそも存在しない。**
遅れは 0 のまま、誰も気付かずに四半期が過ぎる。

「この四半期にレビューが1つも開かれていない組織の数」を別に数え、別のアラートにした
(`SolviAccessReviewNotStarted`)。**終わらないことと、始まらないことは別の信号である**
→ [[99.4_Decision_Log|DL-063]]

## 8. Verification and Evidence

- TL-06(越境しない書き込み)/ TL-04(定期処理の冪等性)
- 稼働中のスタックで `/metrics` にメトリクスが出ていること
- `evidence/WP-P1-SEC-025/<YYYYMMDD-HHMM>/`

## 9. Security and Audit

- **security の WP である。人間のレビューが必須**(`AGENTS.md` §1.16)
- 組織横断の読み取り例外を1つ足す(候補抽出専用。書き込みは越境させない — 0016 と同じ形)
- 定期処理が開いたレビューは `opened_by` を持たない。**人ではないものを人として記録しない**

## 10. Rollback / 失敗時の扱い

- migration は `down` を持つ。列と方針を落とす。既存のレビュー記録は残る
- 定期処理が誤って開いたレビューは、完了させて残す(SEC-024 と同じ。記録を消す経路は作らない)

## 11. Codex app Prompt

### やってはいけないこと

- **期の判定を期の名前だけで行うこと。** 人は「2026-Q3-追加」のように名付けることがある。
  **その四半期に開かれたか**を開始時刻で判定する
- 定期処理のために、書き込みを越境させること
- 期日を過ぎたレビューを**自動で完了・自動で取り消す**こと。判断は人に残す
- メトリクス名を推測でアラート規則に書くこと(`SolviScannerSignaturesStale` の教訓)

## 12. Definition of Done

- [x] §7 の AC-1〜AC-11
- [x] Evidence の保存
- [x] Migration の up/down と既存データ互換の説明(§13)
- [x] 関連文書([[00.8_Status_Dashboard]] / [[99.4_Decision_Log]] / `docs/ops/slo.md`)の更新
- [x] `MANIFEST.md` の再生成
- [ ] **Security Reviewer の sign-off** — **未了。人間のレビューが必要である**
- [x] §13 Execution Log

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-09-28 | Opus 5.5 | `wp/WP-P1-SEC-025` | 実装完了(**sign-off 未了**) | `evidence/WP-P1-SEC-025/20260928-0800/` | 検査 568件×2回通過 |

### 変更したファイル

| ファイル | 変更 |
|---|---|
| `db/migrations/0025_access_review_schedule.sql` | `due_at`、開いた者と起票元の整合制約、候補抽出専用の読み取り例外2つ |
| `services/api/src/modules/auth/access-review-scheduler.ts` | 新規。四半期の判定・起票・遅れと未開始の計数・定期実行 |
| `services/api/src/modules/auth/access-review.service.ts` | 作成処理を人の経路と定期処理で共有。期日を付ける |
| `services/api/src/modules/auth/access-review.routes.ts` / `main.ts` | 期日の受け渡しと定期実行の起動・停止 |
| `packages/shared/src/config/env.ts` / `.env.example` | `ACCESS_REVIEW_DUE_DAYS`(仮値30) |
| `apps/web/src/app/ops/access-review/page.tsx` / `lib/api.ts` | 期日・定期起票・期日超過の表示 |
| `infra/monitoring/alerts/slo.yml` / `docs/ops/slo.md` | アラート2つと一次対応 |
| `tests/security/access-review-schedule.test.ts` | 新規。12件 |

### Migration と既存データ互換

`0025`。既存の行には `due_at = opened_at + 30日` を埋めてから NOT NULL にした。
`opened_by` の NOT NULL を外し、`source` との整合を制約で強制する(人が開いた行は必ず持つ)。
`up` / `down` / `up` を稼働中のDBで確認。**`down` は定期処理が開いた行があると失敗する** —
誰が開いたか分からない行を、黙って人の行にしないためである(意図した失敗)。

### 検証

| 実行 | 結果 |
|---|---|
| `npm run test:security` | **568 passed**(2回。本WPの12件を含む) |
| `npm run test:unit` | 886 passed |
| `npm run check:all` / `typecheck` | 緑 |
| `promtool check rules` | SUCCESS: 14 rules |
| Prometheus `/api/v1/rules` | 2規則とも health: ok |
| 稼働中の `/metrics` | 両メトリクスの名前と値を確認 |
| 期日超過の経路 | 画面表示とメトリクス 0→1→0 を確認(一時的にずらして戻した) |

`docker compose logs` の絞り込みは、この環境では今日のログを安定して返さなかった。
AC-7 は記録用ロガーの検査で確かめた。

### 13.1 テストと稼働中の API が、同じ DB で定期処理を回している

稼働中の API は**起動直後に定期処理を1周する**(役割の期限・自動クローズ・本WPの起票)。
テストは同じ DB を使う。

[[WP-P1-SEC-024]] §13.4 で原因不明とした「起動直後の初回だけ落ちる」テストは、
役割の期限の予告を検査するものだった。**起動時の期限処理がテストより先に予告を積んだ**
と考えると症状と合う。**再現はできていないので、仮説として置く。**

本WPも同じ形の危険を持つ — 起票の検査は「開いた件数」を数えるため、
テストの最中に API の定期処理が回れば数が合わなくなる。
直し方は、検査用のスタックでは定期処理を止めるか、検査を別のDBで回すこと。**別WPで扱う。**

### セキュリティ影響

**有る。** 組織横断の読み取り例外を2つ足した(候補抽出専用、書き込みは越境させない)。
定期処理は認可を通らずにレビューを開く — そのため `openScheduled` は HTTP の経路から呼べない。
**`AGENTS.md` §1.16 により、人間のセキュリティレビューが必要である。**

### 未解決事項

- **Security Reviewer の sign-off が未了**
- 完了期日 30日は**仮値**。確定したら `ACCESS_REVIEW_DUE_DAYS` を変える
- 検査と稼働中の定期処理の競合(§13.1)
- 管理者へのメール通知は範囲外(§5)
