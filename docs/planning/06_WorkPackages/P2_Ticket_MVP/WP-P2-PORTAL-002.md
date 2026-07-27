---
project: SOLVI
doc_id: "WP-P2-PORTAL-002"
title: "PortalからTicket作成"
category: "06_WorkPackages"
type: "work-package"
status: "baseline"
version: "0.2.0"
created: "2026-07-27"
updated: "2026-07-27"
owner: "SOLVI Product Team"
tags: ["work-package", "p2", "portal"]
source_of_truth: true
implementation_status: "done"
phase: "P2"
workstream: "PORTAL"
risk: "medium"
story_points: 8
depends_on: ["WP-P2-TKT-001", "WP-P1-IDM-009"]
requirement_ids: ["BR-001", "FR-TKT-001", "FR-TKT-002", "NFR-UX-001", "NFR-UX-003", "NFR-SEC-006"]
aliases: ["WP-P2-PORTAL-002"]
---

# WP-P2-PORTAL-002: 依頼者ポータルからのチケット作成

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | PORTAL |
| Risk | medium |
| Story Points | 8 |
| Suggested Owner | Frontend + Backend |
| Parallelizable | No(TKT-001 / IDM-009 後) |
| Gate | Gate A(GA-1 / GA-4 / GA-5) |

## 1. Purpose

依頼者が自分で障害を報告し、依頼を出せる画面を作る。

SOLVIの価値はここで決まる。**利用者がこの画面を使わなければ、
これまでどおり電話とチャットで依頼が来る**。裏側がどれだけ整っていても、
入口が使いにくければ何も変わらない。

したがって本WPの設計判断は一貫して「**利用者に考えさせない**」に寄せている。

## 2. Requirement IDs

`BR-001`, `FR-TKT-001`, `FR-TKT-002`, `NFR-UX-001`, `NFR-UX-003`, `NFR-SEC-006`

## 3. Dependencies

- [[WP-P2-TKT-001]] — チケットのドメインと状態機械
- [[WP-P1-IDM-009]] — 認証([[ADR-0019_Local_Authentication_For_Development]]により外部IdPを待たない)

## 4. Scope / Allowed Paths

- `apps/web/src/`
- `services/api/src/modules/ticket/`
- `services/api/src/common/http/`
- `services/api/src/main.ts`
- `tools/`
- `tests/`

## 5. Out of Scope

- 担当者向けの操作画面(状態遷移・割当) → [[WP-P2-OPS-003]] のAPIは実装済み、画面は Phase 3 以降
- コメント・添付の画面 → [[WP-P2-COLLAB-004]] のAPIは実装済み
- ナレッジ検索の統合 → Phase 3
- 外部IdPへのリダイレクト → [[WP-P1-IDM-003]](Gate D)

## 6. Deliverables

- ログイン画面
- Portalトップ(主要行動2つ + 最近の問い合わせ)
- 起票フォーム(障害の報告 / 依頼)
- 受付完了・詳細画面
- チケットのHTTPエンドポイント(作成・一覧・個別取得)
- ルータのパスパラメータ対応
- 合成監視の `login` / `ticket_create` 導線の有効化

## 7. Acceptance Criteria

- [x] 依頼者がログインし、障害の報告と依頼を送信できる
- [x] **優先度を利用者に選ばせない。** 影響と緊急度から自動で決まる(`FR-TKT-002`)
- [x] 入力の誤りを**まとめて**返し、各項目へ移動できるエラー要約を出す(`NFR-UX-003`)
- [x] 受付番号が完了画面に大きく出る
- [x] 未認証では業務APIが 401 を返す
- [x] **他人・他組織のチケットは 404**(403ではない / `NFR-SEC-006`)
- [x] 依頼者の一覧は自分の分のみ、担当者は組織全体
- [x] 応答に担当者ID・依頼者ID・組織IDを含めない
- [x] ログアウトでセッションが失効し、同じCookieでは通らない
- [x] すべての入力に `label` が紐づき、誤りは色**と**文言の両方で示す
- [x] キーボードのフォーカスが常に見える(`outline` を消さない)
- [x] 状態を**色だけで伝えない**(文言だけで意味が通る)
- [x] axe による自動アクセシビリティ検査で violation 0(GA-5)
      — **達成**(2026-07-27)。`tools/check_accessibility.mjs`。
      主要4画面に加え、**エラー表示の状態も含めた6画面**で violation 0。
      検査器が実際に違反を検出できることも確認済み(意図的な違反を注入して検証)

## 8. Verification and Evidence

### テスト

- `tests/security/ticket-routes.test.ts`(19件)
- `tools/e2e/portal_flow.mjs`(稼働中スタックへの通し確認)

Evidenceは`evidence/WP-P2-PORTAL-002/<YYYYMMDD-HHMM>/`へ保存する。

## 9. Security and Audit

| 論点 | 対応 |
|---|---|
| 存在秘匿 | 権限の無いチケットは 404。403 は「そのIDは存在する」と教えてしまう |
| 応答項目 | 依頼者向けの形へ明示的に絞る。サービスの戻り値をそのままJSONにしない |
| セッション | ブラウザから直接APIを叩かせず、Next.jsのサーバ側でCookieを転送する |
| URL | 検証エラーの持ち回しに**入力値を載せない**。件名や内容がブラウザ履歴と参照元ヘッダに残る |
| ログアウト | POST のみ。GET だと `<img src>` を踏ませるだけで他人をログアウトさせられる |

## 10. Rollback / 失敗時の扱い

画面のみの変更であり、DBスキーマを変更しない。
`AUTH_LOCAL_ENABLED=false` にすればログイン経路ごと止まる。

## 11. Definition of Done

- [x] §7 Acceptance Criteriaをすべて満たす
- [x] §8のテストが通り、Evidenceを保存した
- [x] DB変更なし
- [x] `check_rls.mjs` / `check_architecture.mjs` / `check_allowed_paths.mjs` が通る
- [x] Execution Logへ結果を追記した

## 12. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-07-27 | Fable 5 | — | Done | `evidence/WP-P2-PORTAL-002/` | 統合19件 + 通し確認23項目。全体 1090 tests passed |

### 設計判断

**入力させる項目を増やさない。** 分類・カテゴリ・サブカテゴリを選ばせる作りにすると、
利用者は「どれを選べばいいか分からない」で止まり、結局電話に戻る。
件名・内容・影響・緊急度の4つだけにした。

**優先度は利用者に選ばせない。** 全員が「高」を選ぶためである。
影響と緊急度から機械的に導き(`FR-TKT-002`)、詳細画面で
「なぜこの優先度になったか」を示すことで問い合わせを減らす。

**障害の報告と依頼を分ける。** 緊急度の扱いが違う。同じ入口にすると、
止まっている業務が依頼の列に埋もれる。

**受付番号を完了画面に大きく出す。** これが無いと利用者は届いたか不安になり、
同じ内容を電話でもう一度伝えてくる。

**エラー要約に各項目へのリンクを置く。** 「どこが違うのか」を探させないことが、
やり直しの負担を減らす。誤りは色**と**文言の両方で示す — 色だけだと
色覚特性のある利用者と白黒印刷で情報が消える。

**状態の内部識別子を画面に出さない。** `in_progress` と表示されても意味が分からず、
問い合わせが増える。

**ブラウザから直接APIを叩かせない。** セッションCookieが `HttpOnly` なので
JSから読めず、またAPIのオリジンを露出させるとCORSの設定が必要になり、
緩めた分だけ攻撃面が広がる。

### 実装中に見つけた問題

1. **役割束縛の `valid_from` 既定値による不安定なテスト。**
   既定の `now()` は**DBの時計**で入るため、ホストの時計が僅かに遅れていると
   「まだ有効になっていない束縛」と判定され、テストが時々落ちた。
   実運用では問題にならないが、fixture では過去時刻を明示することにした。

2. **テストファイル間の削除順の衝突。**
   `ticket-routes.test.ts` が残したチケットが `app_user` を参照しており、
   `auth.test.ts` の利用者削除がFK違反で失敗していた。単体では通るが
   全体実行で39件が落ちる、という形で現れた。業務データの削除を先に置いて解決。

### 残っている制約

- **ユーザビリティテスト(GA-4: 初見5名中4名以上)は未実施。** 実利用者が必要。
  axe の violation 0 は「合格」ではなく「**最低限の水準を割っていない**」を意味する。
  読み上げ順序の妥当性や文言の分かりやすさは人が確かめる必要がある
- 担当者向けの操作画面は無い。APIは実装済みだが画面は Phase 3 以降
- コメント・添付の画面が無い。依頼者は起票後に追記できない
