---
project: SOLVI
doc_id: "WP-P1-IDM-010"
title: "組織IDの手入力を無くす"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-07-28"
updated: "2026-07-28"
owner: "SOLVI Product Team"
tags: ["workpackage", "p1", "identity", "ux"]
source_of_truth: true
implementation_status: "done"
phase: "P1"
workstream: "IDM"
risk: "medium"
story_points: 5
depends_on: ["WP-P1-IDM-009"]
requirement_ids: ["FR-IDM-006", "NFR-UX-001", "NFR-UX-002"]
aliases: ["WP-P1-IDM-010"]
---

# WP-P1-IDM-010: 組織IDの手入力を無くす

| 項目 | 値 |
|---|---|
| Phase | P1 |
| Workstream | IDM |
| Risk | medium |
| Story Points | 5 |
| Gate | Gate A(GA-1 / GA-4) |

## 1. Purpose

**利用者が知らない値を入力させない。**

[[WP-P1-IDM-009]] のログイン画面は、組織IDのUUIDを手入力させていた。

```
組織ID [ 00000000-0000-4000-9000-000000000001 ]
所属する組織のIDを入力してください。分からない場合は管理者へお問い合わせください。
```

3つの点で誤っている。

1. **利用者はその値を知らない。** 知っているのは「自分がどの会社の人間か」である。
   ヒント文が「分からない場合は管理者へ」と書いている時点で、
   画面が利用者に答えられない問いを立てている
2. **打ち間違いに気付けない。** UUIDは意味を読めない文字列である
3. **そもそも入力が要らない。** 所属は `role_binding` として既に保持している

同じ判断を [[WP-P2-RELUI-012]] では「担当者にUUIDを写させない」として下している。
**ログイン画面だけが逆のことをやっていた。**

## 2. Requirement IDs

`FR-IDM-006`(兼務)、`NFR-UX-001`, `NFR-UX-002`

## 3. Dependencies

- [[WP-P1-IDM-009]] — ローカル認証とセッション基盤

## 4. Scope / Allowed Paths

- `services/api/src/modules/auth/`
- `services/api/src/main.ts`
- `packages/shared/src/errors/`
- `apps/web/src/`
- `db/migrations/`
- `tools/`
- `tests/`

## 5. Out of Scope

- 外部IdPの属性からの組織決定 — Gate D([[WP-P1-IDM-003]])
- ヘッダからの組織切り替え導線 — §12 の残作業

## 6. Deliverables

- 役割束縛からの組織解決(所属1つなら自動、兼務なら選択)
- 組織の選択・切り替えエンドポイント
- 組織の選択画面
- 「未選択」専用の Problem 型
- migration 0015(`app.auth` の読み取り例外に `organization` を追加)

## 7. Acceptance Criteria

- [x] **ログイン画面に組織IDの入力欄が無い**
- [x] 所属が1つなら、選択画面を挟まずにログインが完了する
- [x] **兼務者には選ばせる**(勝手に片方を選ばない)
- [x] 所属が無ければログインできない
- [x] **所属していない組織は指定しても切り替えても通らない**
- [x] 組織が未選択のまま業務APIを呼ぶと**専用の型**で拒否される
- [x] 未選択でも組織一覧は取得できる(行き止まりを作らない)
- [x] 組織は**名前で**選ばせる(IDを画面に出さない)
- [x] 期限切れの束縛は所属に数えない
- [x] 切り替えが監査に残る
- [x] **ヘッダにいまの組織が常に出る**(切り替えたことを忘れない)
- [x] **所属が1つなら切り替えリンクを出さない**
- [x] ログイン前にログアウトが並ばない
- [x] axe による自動検査で violation 0

## 8. Verification and Evidence

- `tests/security/auth.test.ts`(組織解決の検査7件)
- `tools/e2e/portal_flow.mjs`(組織選択16項目)
- `tools/check_accessibility.mjs`(組織の選択画面を追加)

Evidenceは`evidence/WP-P1-IDM-010/<YYYYMMDD-HHMM>/`へ保存する。

## 9. Security and Audit

| 論点 | 対応 |
|---|---|
| 顧客リストの漏えい | 組織の一覧は**認証を通した本人の所属のみ**。未認証で見せる経路は作らない |
| 名乗り | `organizationId` を明示しても、所属していなければ拒否する(従来どおり) |
| 越境 | 切り替え時も役割束縛を確認する。認証と認可は別 |
| 存在秘匿 | 所属していない組織への切り替えは 403。存在の有無は答えない |
| 監査 | 切り替えを `platform.org_context.switched` として記録 |

## 10. Rollback / 失敗時の扱い

migration 0015 は `FOR SELECT` のポリシー追加のみ。`down` で削除できる。

## 11. Definition of Done

- [x] §7 Acceptance Criteriaをすべて満たす
- [x] §8のテストが通り、Evidenceを保存した
- [x] `check_rls.mjs` / `check_architecture.mjs` / `check_allowed_paths.mjs` が通る
- [x] `check_unwired.mjs` が通る
- [x] **稼働中のスタックで実際に動くことを確認した**
- [x] Execution Logへ結果を追記した

## 12. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-07-28 | Opus 5 | `dbcbdcd` / merge `e6b4977` | Done | `evidence/WP-P1-IDM-010/20260728-2222/` | 検査7件 + 通し確認16項目 + a11y 12画面。全体 1232 tests passed |
| 2026-07-28 | Opus 5 | `fa8d70a` / merge `89cf468` | Done | 同上 | 追補: 切り替え導線とヘッダ。通し確認に4項目追加 |

### 設計判断

**兼務者に勝手に組織を選ばない。** 組織をまたぐ誤記入は、
**他社の情報を見せる事故**になる。最初の一歩で本人に決めさせる。
一方、所属が1つの人には選択画面を出さない — 大多数にとって意味の無い一手間になる。

**「未選択」と「権限が無い」を別の型にした。**
`Problems.organizationNotSelected()` を新設(`/organization-not-selected`)。

一般の 403 に混ぜると、画面は「権限がありません」としか出せない。
兼務者は正しい資格情報を持っているのに何をすべきか分からず、
**何度ログインしても同じ画面に戻る行き止まり**になる。

| 応答 | 利用者がとるべき行動 |
|---|---|
| forbidden | 諦めるしかない |
| organizationNotSelected | 組織を選べば進める |

**判定を1か所に閉じた。** `requireSession()` が
「未ログイン → ログイン画面」「未選択 → 選択画面」を判定する。
各画面で個別に書くと、新しい画面を足した人が片方を書き忘れる。

**組織は名前で選ばせ、IDは画面に出さない。** 利用者が読めない値を
見せても選択の助けにならない。

### RLS の罠、5回目 (migration 0015)

`memberOrganizations` は `organization` を JOIN する。
ところが `organization` のRLSは `id = app_current_org()` であり、
**認証の最中はまだ組織が決まっていない**(決めるために引いているのだから当然)。
JOINが0件になり「所属が無い」ように見えた。

同じ形を既に4回踏んでいる(migration 0010 / 0011 / 0012 / 0014、
[[04.23_Wiring_Verification]])。

今回は**既存のテストが即座に落ちた**ため、静かに壊れることはなかった。
認証は全経路が通るので、壊れれば必ず表に出る。
「壊れたら必ず気付く場所」と「壊れても誰も気付かない場所」の差が、
そのまま検知までの時間の差になる。

`app.auth` に `organization` を加えた。新しいフラグは作らない —
0011 が既に `app_user` と `role_binding` を同じフラグで覆っており、
**フラグの単位は「テーブル」ではなく「認証層という用途」**である。

### またしても、テストがシードを壊していた

通し確認が「兼務者は組織が決まらない」で落ちた。
シードの兼務束縛が `source='manual'` で作られており、テストの片付け
(`DELETE FROM role_binding WHERE source = 'manual'`)で消えていた。

**消えると兼務者が居なくなり、組織選択の経路が誰も通らないまま緑になる。**

1. 片付けを `created_via = 'admin'` の利用者に絞った
   ([[WP-P2-RELUI-012]] で資格情報について行ったのと同じ)
2. シードの兼務束縛を `source = 'seed'` にした。合成データであって
   手動付与ではない。表記が実態に合っていなかった

### 追補: 切り替え導線とヘッダ (2026-07-28)

**いまどの組織として操作しているかを、常に見えるところへ置いた。**

兼務者は組織を切り替えられる。切り替えたことを忘れたまま書き込むと、
別の会社の問い合わせに社内の事情を書いてしまう。
「どちらに居るか」は操作のたびに確認できなければならない。

| 状態 | ヘッダの表示 |
|---|---|
| 未ログイン | 題字のみ。**ログアウトを並べない**(自分の状態が分からなくなる) |
| 所属1つ | 組織名。**切り替えリンクは出さない**(選択肢が1つの導線を作らない) |
| 兼務 | 組織名 + 「組織を切り替える」 |

選択画面の文言も初回と切り替えで変えた。
初回は「決めてください」、切り替えは「いま何処に居るか」を先に示す。

**ヘッダは `me()` ではなく `myOrganizations()` を使う。**
`me()` は組織が未選択だと 403 になるため、
組織の選択画面でだけヘッダが消えるという不整合が起きる。

### 残作業

- 外部IdP接続 (Gate D) では、IdP側の属性から組織を決める経路も要る
