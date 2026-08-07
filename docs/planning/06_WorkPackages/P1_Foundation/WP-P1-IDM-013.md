---
project: SOLVI
doc_id: "WP-P1-IDM-013"
title: "期限切れセッションの掃除"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-08-07"
updated: "2026-08-07"
owner: "SOLVI Product Team"
tags: ["workpackage", "p1", "identity", "privacy", "operations"]
source_of_truth: true
implementation_status: "done"
phase: "P1"
workstream: "IDM"
risk: "medium"
story_points: 3
depends_on: ["WP-P1-IDM-009"]
requirement_ids: ["FR-IDM-008", "NFR-SEC-002"]
aliases: ["WP-P1-IDM-013"]
---

# WP-P1-IDM-013: 期限切れセッションの掃除

| 項目 | 値 |
|---|---|
| Phase | P1 |
| Workstream | IDM |
| Risk | medium |
| Story Points | 3 |
| 依存 | [[WP-P1-IDM-009]] |
| Evidence | `evidence/WP-P1-IDM-013/20260807-0230/` |

## 1. 出発点

`SessionService.purgeExpired` は [[WP-P1-IDM-009]] で書かれ、
冒頭にこう書かれていた。

> 期限切れセッションの削除。**定期実行から呼ぶ。**

その定期実行が無かった。

## 2. 繋いでみたら、動かなかった

検査を書いて実行したところ、こうなった。

```
permission denied for table session
```

migration 0011 の GRANT は `SELECT, INSERT, UPDATE` までで、
**DELETE が無い。**

つまりこの関数は、**未接続だっただけでなく、繋いでも動かなかった。**
呼ぶ者が居なかったので、誰もそれに気付かなかった。

**「書いてある」ことと「動く」ことの間には、権限という層がもう一枚ある。**
静的検査は「呼ばれていない」までは言えるが、
「呼んだら失敗する」ことは言えない。
→ [[99.4_Decision_Log|DL-034]] / [[04.23_Wiring_Verification]] §10

migration 0019 で `GRANT DELETE ON session` を足した。

## 3. 何を消して、何を消さないか

| 状態 | 掃除 |
|---|---|
| 生きている | **消さない** |
| 発行から100日経つが絶対期限は先 | **消さない**(まだ使える) |
| 失効したばかり | 消さない(保持期間の中) |
| 絶対期限が保持期間より前 | 消す |
| 失効から保持期間が過ぎた | 消す |

**「作られてから何日経ったか」では消さない。**
古い発行でも絶対期限が先ならまだ使えるセッションであり、
消すと利用者が理由なく締め出される。

## 4. 消しても記録は失わない

`session` 行は業務の記録ではなく**運用の状態**である。

| 失効の理由 | 監査に残るもの |
|---|---|
| `logout` | `session.revoked` |
| `user_deactivated` | `user.deactivated`([[WP-P1-IDM-011]]) |
| `password_changed` | `credential.set`([[WP-P1-IDM-012]]) |

「誰がいつログインしたか」「なぜ失効したか」は `audit_event` 側に
追記専用・ハッシュ連鎖で残る(ADR-0009)。

**減るなら消してはいけない。** その判断のためにこの表を書いた。
検査でも「掃除しても `audit_event` の件数が変わらない」ことを固定している。

migration 0019 のコメントにも書いた —
**消してよい表と消してはいけない表を、権限で区別する。**
監査(migration 0003)には DELETE を与えていない。

## 5. 保持日数の根拠が無いことを明示した

`SESSION_RETENTION_DAYS`(既定30)。

[[03.16_Data_Retention_and_Privacy]] は「法務・監査による最終保持年数確定」を
**対象外**としている。つまり**数値の根拠はまだ無い。** 30日は仮の値である。

環境変数にし、既定値のコメントに「仮である」と書いた。
根拠の無い数値をコードへ埋め込むと、
後から「なぜ30なのか」を誰も説明できなくなる。
→ [[99.4_Decision_Log|DL-035]]

## 6. 動かす場所と間隔

APIプロセスで6時間おき。自動クローズ([[WP-P2-CLOSE-014]])と同じ理由で、
セッションの取り扱いは `services/api` にあり worker から使うと境界を越える。

**起動時に1周走る。** 短期間で落ちて上がるときも取りこぼさない。

0件の周回はログに書かない。**毎周書くと、実際に消えた日が埋もれる。**

## 7. 検証

| 検査 | 結果 |
|---|---|
| `npx vitest run` | **1343 passed (29 files)** — 掃除の検査12件を追加 |
| マイグレーション往復 (0019 down → up) | OK |
| `check_unwired.mjs` | OK。`purgeExpired` を承知リストから外した |
| e2e 6本 | すべて OK |

実スタック — 90日前に発行し80日前に失効したセッションを植え、APIを再起動:
残り0件、`session purge deleted=1` がログに出た。

## 8. 残っている制約

- **保持日数の根拠が無い**(§5)。Gate 0 の法務確認待ち
- **掃除の実施が監査に残らない。** ログには出るが `audit_event` には書かない
- 大量に溜まった状態で初回を回すと1文でまとめて消す
- `local_credential` / `identity` には同種の掃除が無い(消す条件が無い)

## 9. 関連

- [[WP-P1-IDM-009]] — `purgeExpired` の実装元と migration 0011
- [[WP-P1-IDM-011]] / [[WP-P1-IDM-012]] — 失効理由の監査
- [[04.23_Wiring_Verification]] §10
