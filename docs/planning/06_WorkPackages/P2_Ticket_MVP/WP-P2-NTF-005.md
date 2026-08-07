---
project: SOLVI
doc_id: "WP-P2-NTF-005"
title: "Ticket NotificationとWebhook認証"
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
requirement_ids: ["FR-TKT-007", "NFR-SEC-007"]
---

# WP-P2-NTF-005: Ticket NotificationとWebhook認証

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | NTF |
| Risk | medium |
| Story Points | 5 |
| Suggested Owner | Backend |
| Parallelizable | Yes([[WP-P2-SLO-008]]と並行可) |
| Gate | Gate A |

## 1. Purpose

チケットの主要イベントを関係者へ通知する。

**通知は情報漏えいが最も起きやすい経路である。** 画面はログインした人にしか見えないが、通知は宛先を1つ間違えるだけで組織の外へ出る。しかも送信後に取り消せない。したがってこのWPの重点は「届くこと」より**「余計なものが届かないこと」**にある。

具体的には次の2点を構造的に防ぐ。

1. 他Organizationのデータが通知本文へ混入すること(02.18 §4)
2. 内部メモの内容が依頼者へ通知されること(FR-TKT-004)

## 2. Requirement IDs

`FR-TKT-007`, `NFR-SEC-001`, `NFR-SEC-007`, `NFR-PERF-003`, `AUD-001`

## 3. Dependencies

[[WP-P2-TKT-001]](完了済み)、[[WP-P1-OBS-005]](完了済み)

## 4. Scope / Allowed Paths

- `db/migrations/`
- `services/api/src/modules/notification/`
- `services/api/src/common/outbox/`
- `services/worker/src/`
- `packages/shared/src/`
- `tests/unit/`
- `tests/security/`

## 5. スコープの調整(Outboxの前倒し)

**Transactional Outbox の基盤を本WPで実装する。**

[[ADR-0008_Transactional_Outbox]] により、通知は業務トランザクションと同一に書いた
Outboxイベントを別プロセスが配送する方式でなければならない。同期送信は
「DBはコミットされたが通知は失敗」「通知は送ったがDBはロールバック」という
不整合を生む。

当初 Outbox は Phase 4 の [[WP-P4-WF-003]] に含めていたが、通知が先に必要になったため
**基盤(`outbox_event` テーブルとディスパッチャ)を本WPへ前倒しする**。
[[WP-P4-WF-003]] はその上に Workflow Run を載せる形に変更する(DL-007)。

前倒しする範囲: イベントの書込み、ディスパッチャ、リトライ、DLQ相当の失敗記録。
前倒ししない範囲: Workflow の状態機械、Command発行、補償処理(すべて Phase 4)。

## 6. Out of Scope

- **認証されたHTTPエンドポイント** — [[WP-P1-IDM-003]] 完了まで着手しない
- 実際のメール送信基盤(SES等)への接続。本WPでは配送インターフェースと
  開発用の記録型チャネルまで。実接続は環境確保後([[99.7_Environment_and_Integration_Inventory]])
- 利用者ごとの通知設定・購読管理(Watcher機能は[[01.5_Scope_and_Non_Goals]]でMVP非採用)
- SLA違反の通知・エスカレーション([[WP-P2-SLO-008]]で扱う)
- 受信Webhook(外部→SOLVI)。本WPは送信のみ。受信は連携先が決まってから

## 7. Deliverables

- `outbox_event` テーブルと Migration(業務Txと同一で書ける形)
- ディスパッチャ(Worker):at-least-once、指数バックオフ、失敗記録
- `notification` テーブル(宛先・チャネル・状態・失敗理由)
- 通知の組み立て(**本文最小化**:件名とリンクのみ、本文を載せない)
- 宛先解決(Organization内で完結)
- Webhookチャネル:HMAC-SHA256署名 + timestamp(NFR-SEC-007)
- 監査イベント(`notification.sent` / `notification.failed`)

## 8. Acceptance Criteria

- [x] `outbox_event` `notification` が organization_id を持ち、`check_rls.mjs` が問題0件で通る
- [x] 業務トランザクションがロールバックすると、Outboxイベントも書かれない(同一Tx)
- [x] ディスパッチャが同一イベントを**並行実行しても二重配送しない**(`FOR UPDATE SKIP LOCKED`)
- [x] 配送失敗時に指数バックオフで再試行し、上限到達後は失敗として記録される(無限リトライしない)
- [x] **通知本文にチケット本文・コメント本文が含まれない**(件名とリンクのみ。`notification`にbody相当のカラムを設けていない)
- [x] **内部メモの追加が依頼者へ通知されない**
- [x] 宛先解決が Organization 内で完結し、他組織のユーザが宛先にならない
- [~] Webhook送信に HMAC-SHA256 署名と timestamp ヘッダが付く
      — **部分達成。** 署名生成 `signWebhook()` と検証 `verifyWebhook()` は実装・テスト済みだが、
      実際にHTTPで送信するチャネル実装は本WPの Out of Scope(HTTPエンドポイント追加)に含まれるため未接続。
      送信チャネルを繋ぐ時点で本項を再確認する。
- [x] 署名の検証で、改ざん・5分超過の timestamp・再送(nonce重複)が拒否される
- [x] Outbox配送遅延がメトリクスとして記録される(NFR-PERF-003 / `recordOutboxLag`)
- [x] トレース文脈がOutboxを渡って伝播する(発行元から配送まで1つのtrace idで追える)

## 9. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-04(同一Tx、ディスパッチャの排他)
- TL-11(Webhook署名・timestamp・リプレイ)
- TL-06(宛先の組織境界、内部メモの非通知)
- TL-20(配送失敗時のリトライと打ち切り)

### Evidence

- 並行ディスパッチでの二重配送0件の確認
- 通知本文に本文・コメントが含まれないことの確認
- 署名検証の拒否ケース一覧

Evidenceは`evidence/WP-P2-NTF-005/<YYYYMMDD-HHMM>/`へ保存する。

## 10. Security and Audit

- **通知本文を最小化する。** 件名とリンクのみを載せ、本文は載せない。
  メールは転送・誤送信・端末紛失で第三者の目に触れる。リンク先で認証させれば、
  漏えい範囲を「そのチケットが存在すること」までに抑えられる
- 宛先解決は必ず Organization 内で完結させる。他組織のユーザが宛先になると、
  件名だけでも業務内容が漏れる
- 内部メモ由来のイベントは通知対象から除外する(FR-TKT-004)
- Webhookの署名鍵は Secrets Manager(ADR-0016)。ペイロードに秘密を載せない
- 該当する脅威: T-01(越境)、T-17(Webhook偽装)、T-22(通知経由の情報露出)

## 11. Rollback / 失敗時の扱い

Migration の down で `outbox_event` と `notification` を削除する。未配送のイベントは失われるが、
業務状態は残るため再通知は手動で行える。ディスパッチャの不具合時は Worker を停止すれば
配送が止まり、イベントはOutboxに滞留する(失われない)。

## 12. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Package(WP-P2-NTF-005)のみを実装してください。

正本: AGENTS.md → 本WP(特に §5 スコープの調整、§10 Security)
     → docs/planning/07_ADR/ADR-0008_Transactional_Outbox.md
     → docs/planning/02_Architecture/02.18_Organization_Data_Model_and_RLS.md §4
     → docs/planning/02_Architecture/02.13_Observability.md

作業内容:
1. outbox_event テーブルと、業務Txと同一で書ける記録関数を実装する。
   トレース文脈(traceparent)と correlation_id を列に持たせること。
2. ディスパッチャ(Worker)を実装する。
   - FOR UPDATE SKIP LOCKED で並行実行しても二重配送しない
   - 指数バックオフ、最大試行回数、上限到達で失敗として記録(無限リトライしない)
   - 配送遅延をメトリクスへ記録する
   - トレース文脈を復元してから配送する
3. 通知の組み立て。**本文最小化**:件名とリンクのみ。チケット本文・コメント本文を載せない。
4. 宛先解決を Organization 内で完結させる。
5. 内部メモ由来のイベントを通知対象から除外する。
6. Webhookチャネル: HMAC-SHA256署名 + timestamp。検証関数も実装する
   (改ざん・5分超過・再送を拒否)。

やってはいけないこと:
- 通知を同期送信すること(ADR-0008違反)
- 通知本文にチケット本文・コメント本文を載せること
- 内部メモの内容を依頼者へ通知すること
- 無限リトライ(失敗を永久に再送し続ける)
- HTTPエンドポイントの追加(WP-P1-IDM-003 未完了)

完了時に報告すること:
- 並行ディスパッチでの二重配送0件の確認
- 通知本文に本文が含まれないことの確認
- 署名検証の拒否ケース
- §8 Acceptance Criteria の充足状況
```

## 13. Definition of Done

- [x] §8 Acceptance Criteriaを満たす(Webhook送信チャネルのみ部分達成。理由は§8に明記)
- [x] §9のテストが通り、Evidenceを保存した
- [x] Migration に down があり、up→down→up が成功する(0008まで巻き戻して再適用)
- [x] `check_rls.mjs` と `check_architecture.mjs` が通る
- [x] Security Reviewer のレビューを完了した(通知は漏えい経路のため)
- [x] Execution Logへ結果を追記した

## 14. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-07-27 | Fable 5 | `a805d11` / merge `2f14e39` | Done | `evidence/WP-P2-NTF-005/20260727-1609/` | 25 integration + 19 unit。全体 995 tests passed |
| 2026-07-28 | Opus 5 | `31348f6` / merge `aefab5e` | **訂正** | `evidence/SELF-AUDIT-001/20260728-1536/` | **本WPは「Done」ではなかった。**§14.1 参照 |

### 14.1 訂正 — 通知は一度も送られていなかった (2026-07-28)

横断点検([[04.23_Wiring_Verification]])で判明した。

`enqueueOutboxEvent` を呼んでいたのは**テストだけ**であり、
`OutboxDispatcher` はどこからも生成されていなかった。
統合25件・単体19件は緑だったが、それはテストが自分でイベントを積み、
自分でディスパッチャを起動していたからである。

**業務処理は1件もイベントを積まず、配送プロセスも走っていなかった。
通知は一度も送られていない。**

受入基準は「通知の内容が正しいこと」「内部メモが漏れないこと」を
問うており、**それが実際に発生する経路を持つかを問うていなかった。**
基準を満たしていたことと、機能していたことが乖離した。

修正:

- `ticket.service.ts`(create / transition / assign)と
  `collaboration.service.ts`(コメント)の**業務トランザクション内**で
  `enqueueOutboxEvent` を呼ぶ
- `services/api/src/main.ts` で10秒周期の配送を開始
  (`services/worker` ではなく API 側。理由は `dispatcher.ts` の冒頭)
- テストの補助関数が自分でイベントを積むのをやめた。
  積み直すと元の状態に戻るため、補助関数にその旨を明記した
- 縦切りテストは**テストが1件も積まないこと**を前提に、
  業務処理が生む7件を数えるようにした

実経路での確認(テスト補助を使わない):

```
OK  全3件を配送
通知 1 件
  → requester@acme.example.test / "[INC-2026-000003] 新しいコメントがあります"
OK  内部メモは通知されていない
```

### 実装時の設計判断

**Outbox基盤の前倒し(DL-007)。** WP-P4-WF-003 が持っていた Transactional Outbox を本WPへ
移した。通知を業務トランザクションと同じ原子性で発火させるには先に必要であり、
後から差し替えると通知経路を二度作ることになる。WF-003 側にスコープ変更の注記を追加済み。

**Outboxの越境をディスパッチャに限定(migration 0010)。** ディスパッチャは全org走査の
背景ジョブで組織コンテキストを持たない。RLSをそのままにすると0件しか取れず、
`BYPASSRLS`を与えると業務データまで見えてしまう。`app.dispatcher = 'on'`(`SET LOCAL`)を
通す専用ポリシーを `outbox_event` **のみ**に設けた。→ [[02.18_Organization_Data_Model_and_RLS]] §3.1

**nonce の消費は署名検証の後。** 先に消費すると、攻撃者が不正な署名で正当な nonce を
潰し、正規の通知を妨害できてしまう。

**監査に宛先アドレスと件名を入れない。** 宛先はPIIであり、件名にはチケット番号が含まれる。
監査は参照IDで辿れれば足り、内容の複製を持つ必要はない。

### 実装中に見つけた不具合

1. **`ON CONFLICT` が部分一意索引の述語を欠いていた。** `notification_event_recipient_key` は
   `WHERE outbox_event_id IS NOT NULL` 付きの部分索引であり、競合対象にも同じ述語が要る。
   省略していたため冪等性が働かず、**通知が重複していた**。統合テストが捕捉。
2. **ディスパッチャがRLSで1件も取得できなかった。** 上記 migration 0010 で解決。

### 残っている制約

- メール送信は記録型 `RecordingEmailSender`。実SMTP/SES送信は未接続で、
  本番チャネルの選定は Gate A までに決める必要がある。
- Webhook 受信エンドポイントは未実装(本WPの Out of Scope)。
- nonce ストアはメモリ実装。複数プロセス構成では DB か Redis への置換が必要
  (単一プロセスでは replay を防げるが、水平展開すると防げない)。
