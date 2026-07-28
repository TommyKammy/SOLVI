---
project: SOLVI
doc_id: "WP-P2-RELUI-012"
title: "チケット関連付け・統合の経路と画面"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-07-28"
updated: "2026-07-28"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "portal", "ops"]
source_of_truth: true
implementation_status: "done"
phase: "P2"
workstream: "PORTAL"
risk: "medium"
story_points: 5
depends_on: ["WP-P2-REL-009", "WP-P2-OPSUI-010"]
requirement_ids: ["FR-TKT-010", "FR-TKT-011", "NFR-UX-001", "NFR-UX-002"]
aliases: ["WP-P2-RELUI-012"]
---

# WP-P2-RELUI-012: チケット関連付け・統合の経路と画面

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | PORTAL |
| Risk | medium |
| Story Points | 5 |
| Suggested Owner | Frontend + Backend |
| Gate | Gate A(GA-1) |

## 1. Purpose

**作ったのに誰も呼べない機能を、呼べるようにする。**

[[WP-P2-REL-009]] は 2026-07-27 に「実装済み」とされたが、
横断点検([[04.23_Wiring_Verification]])で **HTTP経路も画面も無い**
ことが判明した。`RelationService` はテストからしか呼ばれておらず、
利用者はチケットを関連付けることも統合することもできなかった。

サービス層・スキーマ・1階層制約の3層防御はすべて完成している。
**欠けているのは経路だけ**だが、経路が無い機能は存在しないのと同じである。

## 2. Requirement IDs

`FR-TKT-010`(関連付け)、`FR-TKT-011`(統合)、`NFR-UX-001`, `NFR-UX-002`

## 3. Dependencies

- [[WP-P2-REL-009]] — サービス層とスキーマ
- [[WP-P2-OPSUI-010]] — 担当者の作業画面(関連の表示先)

## 4. Scope / Allowed Paths

- `services/api/src/modules/ticket/`
- `services/api/src/main.ts`
- `apps/web/src/`
- `tools/e2e/`
- `tools/check_accessibility.mjs`
- `tests/`

## 5. Out of Scope

- 関連付ける相手を**一覧から選ぶ**機能 — 番号を手で入れる。
  検索画面([[WP-P2-SEARCH-006]])から番号を写す運用になる
- 統合の取り消し — 統合が不可逆であることは [[WP-P2-REL-009]] の設計判断
- 多階層の親子 — `01.5 Non-Goals`

## 6. Deliverables

- 関連の一覧・追加・解除のHTTPエンドポイント
- 統合のHTTPエンドポイント
- 受付番号からチケットを引くエンドポイント(統合前の確認用)
- 担当者の作業画面の関連セクション
- **統合の専用確認画面**(2段構え)
- 依頼者の詳細画面での関連表示(読み取りのみ)
- 未解決の子の警告表示

## 7. Acceptance Criteria

- [x] 担当者が受付番号で関連付けできる(`related` / `parent_of`)
- [x] 担当者が関連を解除できる
- [x] **依頼者は関連付けも統合もできない**(見ることはできる)
- [x] **他組織のチケットとは関連付けも統合もできない**
      — 番号でもUUID直指定でも成立しない
- [x] 存在しない番号と閲覧できない番号が**同じ文面**で返る(存在秘匿)
- [x] **統合が1画面で完結しない** — 相手を確認するまで実行ボタンが出ない
- [x] 統合の確認画面に**相手の件名**が表示される(打ち間違いに気付ける)
- [x] 統合には理由が必須で、監査に残る
- [x] 統合後もコメント・添付が元チケットに残る
- [x] 未解決の子が**警告として**表示され、解決は拒否されない
- [x] axe による自動検査で violation 0(統合の確認画面を含む)
- [x] **実スタックへのHTTPで通し確認が通る**(テスト用の道具を使わない)

## 8. Verification and Evidence

- `tests/security/relation-routes.test.ts`(統合25件 + 回帰1件)
- `tools/e2e/relation_flow.mjs`(32項目)
- `tools/check_accessibility.mjs`(統合の確認画面2つを追加)
- `npm run check:unwired` — `RelationService` が承知の未接続一覧から外れる

Evidenceは`evidence/WP-P2-RELUI-012/<YYYYMMDD-HHMM>/`へ保存する。

## 9. Security and Audit

| 論点 | 対応 |
|---|---|
| 越境 | 番号の解決はRLS + 閲覧権限判定を通す。UUID直指定も `loadBoth` が両側を検査 |
| 存在秘匿 | 見つからない場合と権限が無い場合を同じ文面にする。403にすると実在が漏れる |
| 権限 | 関連付け・統合は `agent` / `org_admin` / `platform_admin` のみ |
| 不可逆操作 | 統合は理由必須。2段確認。監査に「誰が・どれを・なぜ」を残す |
| 表示を防御にしない | 画面がボタンを出さないことは安全の根拠にしない。API層で必ず拒否する |

## 10. Rollback / 失敗時の扱い

DBスキーマを変更しない。経路と画面のみ。

## 11. Definition of Done

- [x] §7 Acceptance Criteriaをすべて満たす
- [x] §8のテストが通り、Evidenceを保存した
- [x] `check_rls.mjs` / `check_architecture.mjs` / `check_allowed_paths.mjs` が通る
- [x] **`check_unwired.mjs` が通る**(本番経路から呼ばれている)
- [x] **稼働中のスタックで実際に動くことを確認した**
- [x] Execution Logへ結果を追記した

## 12. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-07-28 | Opus 5 | `2227851` / merge `de7158d` | Done | `evidence/WP-P2-RELUI-012/20260728-1603/` | 統合26件 + 通し確認32項目 + a11y 11画面。全体 1225 tests passed |

### 設計判断

**統合を1画面で完結させない。**

統合は取り消せない。元のチケットは `merged` の終端状態になり、
以降どの状態にも戻せない。

```
1段目: 相手の受付番号を入れる → 相手が誰かを画面に出す
2段目: 件名と状況を目で確かめてから理由を書いて実行する
```

番号を1文字打ち間違えても、**実在する別のチケットに当たることがある。**
番号だけを見て押させると、その取り違えに気付く機会が無い。
確認表に件名を出すのは親切ではなく、**誤操作を止める唯一の手段**である。

作業画面には統合ボタンを置かず、リンクで別画面へ送る。
他の操作と同じ重さに見せない。

**受付番号で指定する。** 担当者が見ているのは番号であり UUID ではない。
UUID を手で写させると、写し間違いが起きるうえ**間違えたことにも気付けない**
(どちらも意味を読めない文字列だから)。

**関係の向きを言葉で書く。** 「related / parent / child」をそのまま出しても
どちらがどちらか分からない。「まとめている問い合わせ(親)」
「この問い合わせから分かれたもの(子)」のように、
**読んだ人が次に何をすべきか分かる言い方**にする。

**未解決の子は警告であって拒否ではない。** 子が別チームの担当で
長期化することがあり、拒否すると運用が詰まる。判断は人に残す。
`unresolvedChildren` は実装済みでありながらどこからも呼ばれていなかったので、
関連一覧の応答に同梱した(別の呼び出しにすると画面が取りに行くのを忘れる)。

### 受付番号は組織ごとの採番である

同じ番号が別の組織にも存在しうる。したがって
「他組織の番号を引くと必ず失敗する」わけではなく、
**自組織に同じ番号があればそちらが返る。** それが正しい動作である。

確かめるべきは「他組織の行が返らないこと」であり、
通し確認もそう書いてある。最初この前提を誤って書いたため、
検査が偽の失敗を報告した。

### 通し確認で見つかった欠陥

**「先に関連付けてから統合する」が必ず 500 になっていた。**

`RelationService.merge` は統合先から元チケットを辿る関連を挿入する際、
一意制約違反(23505)を JavaScript の `catch` で握り潰していた。

**PostgreSQL では文がエラーになった時点でトランザクション全体が中断する。**
例外を捕まえても中断は解けず、以降のクエリはすべて
`current transaction is aborted` で失敗する。

担当者が「関連していそうだ」と気付いて先に関連付け、そのあと
「やはり重複だ」と統合する — これは異常な操作順ではなく自然な流れである。
サービス層のテストが緑だったのは、統合の前に関連付ける手順を
踏んでいなかったからにすぎない。

部分一意索引に合わせた `ON CONFLICT ... DO NOTHING` に直した。
`WHERE relation_type = 'related'` を省くと索引が一致せず落ちるので必ず書く。

**テストがシードの資格情報を全消ししていた。**

テストを流したあとはシードの誰もログインできず、通し確認が全て 401 になる。
画面は正常に見えるため、原因は認証の不具合に見える。
片付けを `created_via = 'admin'` に絞り、
**テストと通し確認が同じDBで共存できる**ようにした。

その修正により、`auth.test.ts` の3か所が
「`local_credential` に行が1件しか無い」前提だったことが露呈した。
全消しの片付けに依存していたためである。

### 残っている制約

- 関連付けの相手を一覧から選べない(番号を手で入れる)
- 統合の取り消しは無い
