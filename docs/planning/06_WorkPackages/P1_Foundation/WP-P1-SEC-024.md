---
project: SOLVI
doc_id: "WP-P1-SEC-024"
title: "アクセスレビューの実施と記録"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-08-14"
updated: "2026-09-28"
owner: "SOLVI Product Team"
tags: ["workpackage", "p1", "security", "identity"]
source_of_truth: true
implementation_status: "done"
phase: "P1"
workstream: "SEC"
risk: "high"
story_points: 8
depends_on: ["WP-P1-IDM-015", "WP-P1-IDM-016"]
requirement_ids: ["NFR-SEC-002"]
aliases: ["WP-P1-SEC-024"]
---

# WP-P1-SEC-024: アクセスレビューの実施と記録

| 項目 | 値 |
|---|---|
| Phase | P1 |
| Workstream | SEC |
| Risk | high |
| Story Points | 8 |
| Suggested Owner | Tech Lead + Security Reviewer |
| Parallelizable | No |
| Gate | Gate 1 / 脅威 T-20 |

## 1. Purpose

`NFR-SEC-002`(最小権限+**四半期アクセスレビュー**、Must)のうち、
**レビューを実施し、実施したことを記録する部分**を作る。

いま在るもの・無いものは、はっきりしている。

| | 状態 |
|---|---|
| 誰が何を持っているか | **見える**(`/ops/users`) |
| 役割を配る・取り消す | **動く**([[WP-P1-IDM-015]]) |
| 期限で自動的に失効する | **動く**([[WP-P1-IDM-014]] / [[WP-P1-IDM-017]]) |
| **定期的に見直す手続き** | **無い** |

[[WP-P2-RTM-019]] §5 は、検査に要求IDを付けなかった唯一の security 要求として
この要求を挙げている。**「付けると、やっていないことをやったことにする」**からである。
[[06.4_Backlog]] C-3 も同じことを書いている。

### 見えることと、見直されることは違う

一覧が在っても、**見る機会が定義されていなければ誰も見ない。**
権限は増える方向にしか動かない — 異動で足され、兼務で足され、
「念のため」で足される。減らすのは、減らす日を決めたときだけである。

脅威 [[02.14_Threat_Model|T-20]](`platform_admin` の業務目的外の越権閲覧)の
対策にも「四半期アクセスレビュー」が挙がっており、Evidence は「監査レビュー記録」である。
**記録が無ければ、対策は存在しない。**

## 2. Requirement IDs

`NFR-SEC-002`

> [!warning] **この要求の一部だけを担う**
> `NFR-SEC-002` は「Connector別最小スコープ表 + 四半期アクセスレビュー」であり、
> Gate B の GB-7 は **Okta/Graph 資格情報のスコープ**を問う。
> Connector はまだ無い(Phase 4)。**このWPが満たすのはレビューの側だけである。**
> 台帳の Status が動いても、要求を満たしたことにはならない。

## 3. Dependencies

- [[WP-P1-IDM-015]](役割の付与と取り消し。取り消しの経路をここから使う)
- [[WP-P1-IDM-016]](利用者を作る経路)

## 4. Scope / Allowed Paths

- `db/migrations/`
- `services/api/src/modules/auth/`
- `services/api/src/common/audit/audit.ts`
- `services/api/src/main.ts`
- `apps/web/src/app/ops/`
- `apps/web/src/lib/`
- `tests/security/`
- `docs/planning/02_Architecture/02.17_Audit_Event_Catalog.md`
- `docs/planning/06_WorkPackages/`
- `docs/planning/00_Index/00.8_Status_Dashboard.md`
- `docs/planning/04_Development/04.23_Wiring_Verification.md`
- `docs/planning/99_Project_Files/99.4_Decision_Log.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P1-SEC-024/`

## 5. Out of Scope

- **Connector別最小スコープ表(GB-7)。** Connector が無い(Phase 4)
- **四半期の自動起票と、未実施の可視化。** → 後続WPで行う。
  このWPは「開いて・決めて・閉じる」ことと、その記録を作る
- **`platform` スコープの役割のレビュー。** 組織の文脈が無く、
  越境の例外を読み取りだけに保つため対象外([[WP-P1-IDM-014]] B-8 と同じ理由)。
  当初は「件数は出す」と書いたが、**RLS により件数すら見えないことが分かった**(§7.1)
- **レビュー者の分離(SoD)。** 管理者が1人の組織では実施不能になる。
  自分の役割を自分で承認したことは**記録に残す**(§7 AC-8)

## 6. Deliverables

- `access_review` / `access_review_item`(RLS つき)と migration
- `AccessReviewService`(開く・決める・閉じる)
- `/ops/access-review` の一覧と決定の導線
- 監査イベント3種と [[02.17_Audit_Event_Catalog]] への追記
- `tests/security/access-review.test.ts`

## 7. Acceptance Criteria

- [x] AC-1: 開始後に与えた役割はその期に入らない(検査で確認)
- [x] AC-2: 同じ組織で2つ同時に開けない(サービスで 409、DBにも一意索引)
- [x] AC-3: 理由の無い判断は 400 で拒む
- [x] AC-4: `revoke` は [[WP-P1-IDM-015]] の `revokeRole` を通り、**権限が実際に消える**
- [x] AC-5: 未判断が残っていれば 409。完了時刻と完了者を記録する
- [x] AC-6: 監査3イベントを閉じた列挙へ追加し、[[02.17_Audit_Event_Catalog]] へ反映
- [x] AC-7: 他組織のレビューは一覧に出ず、ID直指定でも 404
- [x] AC-8: 自己判断は `selfReviewed` として監査に残り、画面にも出る
- [x] AC-9: 開始後に別経路で失効した項目は `alreadyInactive`。revoke は 409
- [x] AC-10: `/ops/access-review` から開始・判断・完了ができる(**稼働中のスタックで確認**)
- [x] AC-11: `check:all` 緑。`test:security` **556件を実際に走らせて通した**

### 7.1 platform スコープの件数は「出せない」と分かった

§5 では [[WP-P1-IDM-014]] に倣って**対象外の件数を出す**と書いた。
列も作った。**実際に測ったら数えられなかった。**

`role_binding_isolation` は `organization_id = app_current_org()` であり、
platform 束縛は `organization_id` が NULL なので条件が NULL になる。
所有者から 3 件見える状態で、アプリからは **0 件**だった。

列を残せば、そこには常に 0 が入る。**0 は「無い」に見えるが、実際は「見えない」である。**
表示のためだけに越境読み取りの例外を増やすこともしない。
列を落とし、画面には「**この組織からは件数も見えません。0件という意味ではありません**」と書いた
→ [[99.4_Decision_Log|DL-062]]

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-06(AuthZ/RLS: 越境の拒否)
- TL-04(結合: 決定が実際に失効させること)
- TL-16(Security: 権限外の直接ID指定)

### Evidence

`evidence/WP-P1-SEC-024/<YYYYMMDD-HHMM>/` へ:

- `npm run test:security` の出力(**ローカルスタックを起動して実行した記録**)
- migration の up/down 実行結果
- 監査イベントが実際に記録されたことの確認
- `npm run check:all` の出力
- Command / Environment / Commit SHA / Result / Timestamp

## 9. Security and Audit

- **これは security の WP である。人間のレビューが必須**(`AGENTS.md` §1.16)
- 新しい表には `organization_id` と RLS ポリシーを必ず設ける(§1.6)。
  RLS を主たる認可の代わりにしない
- 監査は3イベント。`outcome: denied` を伴う経路は認可失敗時に既存の仕組みが記録する
- 脅威: T-20(内部者の越権閲覧)の対策の一部

## 10. Rollback / 失敗時の扱い

- Migration は `down` を持つ。表を落とすと**レビューの記録も消える** —
  本番で戻す場合は、記録を書き出してから行う
- 決定によって失効した役割は、migration を戻しても**戻らない**。
  取り消しは `role_binding.valid_until` に対する操作であり、レビューの表とは別である。
  **前進修復**(必要なら役割を再付与する)で扱う

## 11. Codex app Prompt

### 読む正本

- このWP / [[WP-P1-IDM-015]] / [[02.18_Organization_Data_Model_and_RLS]]
- [[02.17_Audit_Event_Catalog]] / [[02.14_Threat_Model]] T-20
- `AGENTS.md` §1.4〜§1.7、§1.16

### 手順

1. migration を書く(表・索引・RLS・GRANT・`down`)
2. 監査イベント型を**閉じた列挙へ追加**し、02.17 へ反映する
3. サービスを書く。**取り消しは既存の経路を呼ぶ**
4. ルートと画面を作る。**経路の無いサービスを残さない**
5. `tests/security/access-review.test.ts` を書く。越境・権限外・未決完了の拒否を含める
6. ローカルスタックを起動して `test:security` を通す

### やってはいけないこと

- **決定を記録するだけで、失効させない実装。** それは「レビューをした」という
  記録だけを作る仕組みであり、記録が嘘になる
- レビュー対象を「いま有効な役割」で毎回引き直すこと。
  **開いた時点で固定する** — 動く対象は判定できない
- SoD を理由に、管理者1人の組織でレビューを**実施不能**にすること
- `platform` スコープを黙って対象外にすること。**見えないなら「見えない」と画面に書く**

### 完了時の報告

- 追加した表・監査イベント・経路
- 越境と権限外を拒むことをどう確かめたか
- `platform` スコープの扱い(件数が出ているか)
- 走らせたテストと結果(**走らせていないものは走らせていないと書く**)

## 12. Definition of Done

- [x] §7 の AC-1〜AC-11 をすべて満たす
- [x] §8 の Evidence を保存した
- [x] Migration の up/down と既存データ互換を説明した(§13)
- [x] [[02.17_Audit_Event_Catalog]] を更新した
- [x] 関連文書([[00.8_Status_Dashboard]] / [[99.4_Decision_Log]] / [[04.23_Wiring_Verification]])を更新した
- [x] `MANIFEST.md` を再生成した
- [x] **Security Reviewer の sign-off**(§9)— 2026-09-28、リポジトリ所有者がレビュー済み
- [x] §13 Execution Log へ追記した

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-08-14 | Opus 5 | `8f1cde8` | 実装完了(sign-off 待ち) | `evidence/WP-P1-SEC-024/20260814-1130/` | 検査 556件通過。platform 件数は出せないと判明(§7.1) |
| 2026-09-28 | リポジトリ所有者 | — | **セキュリティレビュー済み** | — | `AGENTS.md` §1.16 の人間レビュー |
| 2026-09-28 | Opus 5.5 | merge | main へ取り込み | — | Dashboard / MANIFEST の衝突を解決(§13.3) |

### 変更したファイル

| ファイル | 変更 |
|---|---|
| `db/migrations/0024_access_review.sql` | 表2つ・索引・RLS・GRANT・`down` |
| `services/api/src/common/audit/audit.ts` | 監査イベント型3つを閉じた列挙へ追加 |
| `services/api/src/modules/auth/access-review.service.ts` | 新規。開く・一覧・詳細・判断・完了 |
| `services/api/src/modules/auth/access-review.routes.ts` | 新規。組織の文脈を張る経路 |
| `services/api/src/main.ts` | 5つのエンドポイントを登録 |
| `apps/web/src/app/ops/access-review/page.tsx` | 新規。開始・判断・完了の画面 |
| `apps/web/src/lib/api.ts` | 5つの呼び出し |
| `tests/security/access-review.test.ts` | 新規。10件 |
| `tests/security/audit-export.test.ts` | **件数比較を上位集合の検査へ**(§13.2) |
| `tests/support/cleanup.ts` | 新しい2表を削除順へ追加 |

### Migration と既存データ互換

`0024_access_review.sql`。**新しい表を足すだけ**で、既存の表・列・制約に触れていない。
`up` / `down` の両方を稼働中のDBで実行して確認した。既存データへの影響は無い。

`down` は表を落とすため、**レビューの記録も消える**。本番で戻す場合は先に書き出す。
判断によって失効した役割は `role_binding.valid_until` の側にあり、**戻しても復活しない**
(必要なら再付与する = 前進修復)。

### 検証

| 実行 | 結果 |
|---|---|
| `npm run test:security` | **556 passed / 25 files**(このWPの10件を含む) |
| `npm run test:unit` | 886 passed |
| `npm run check:all` | 緑 |
| migration up / down / up | すべて ok |
| **稼働中のAPIへの実行** | `POST /access-reviews` 201(10項目)・`GET` 200・`decide` 204・未判断での `complete` 409 |
| **画面の描画** | `GET /ops/access-review` 200。開始・判断・完了の導線が出ている |

`npm run test:integration` は **走らない** — `tests/integration/` にファイルが無い
(npm script だけが在る)。本WPの範囲外だが、記録しておく。

### 13.1 「テストが緑」と「動く」の間に、また1つあった

サービスの検査が10件通り、`check:all` も緑になった状態で、
**稼働中のAPIは `POST /access-reviews` に 404 を返した。**

原因は開発コンテナがソースを再読込しないことだった(ソースはマウントされているが、
プロセスは起動時のまま)。`docker compose restart api` で 201 になった。
画面も同じで、`web` を再起動するまで 404 だった。

**欠陥ではないが、確かめなければ欠陥と区別が付かない。**
DL-011 の3つ目の問い(実際に動いているか)は、今回も最後まで残った。

### 13.2 直したもの: 監査書き出しの検査が、測ることで対象を変えていた

`audit-export.test.ts` の「プラットフォーム監査者には全組織が出る」が落ちた。

書き出しは `audit.export.executed` を**自分で記録する**ため、後から取った側が必ず1件多い。
検査は platform を先に取り org を後に取り、**件数の大小**で比べていた。
他組織の記録がその日に在れば platform 側が上回るので通るが、
**その組織の記録しか無い状態(このWPの検査が作った)では必ず落ちる。**

順序を入れ替え、**platform が org の上位集合であること**を ID で確かめる形にした。
件数比較より強い主張であり、測定の順序に左右されない。
[[04.23_Wiring_Verification]] §26(測定条件は道具自身に言わせる)と同じ形である。

### 13.3 マージ時の衝突

実装(8/14)とレビュー(9/28)の間に、main へ Vault 反映のコミット(`aeba36d`)が入った。
同じ2ファイルを両側が変えていたため衝突した。

| ファイル | 解決 |
|---|---|
| `00.8_Status_Dashboard.md` | **両方を残した**。本WPの行(レビュー済みへ更新)と、main 側の REG-023 行(Vault反映済み) |
| `MANIFEST.md` | **手で直さず再生成した**。ハッシュの台帳は、どちらの側の値も正しくない — 合わせた後の実体から作り直すしかない |

### 13.4 マージ時の検証と、原因の分からない1回の失敗

マージ後の状態で `check:all` 緑・`typecheck` 緑・`test:unit` 886 passed。
`test:security` は**スタック起動直後の初回だけ** 1件落ちた。

`role-binding-expiry.test.ts` の「まもなく切れる束縛の予告が積まれる」(WP-P1-IDM-017)。
**単独実行では17件すべて通り、その後のフルスイートは3回連続で 556 passed。**

**原因は特定できていない。** 最初に疑った「稼働中の API が10秒ごとに Outbox を配送し、
テストと競合する」は、検査が処理済みの行も数えているため成り立たなかった。
落ちた回の出力を保存していなかったので、どの主張が外れたのかも分からない。

8/14 にも起動直後の初回だけ `audit-export` が落ちている(§13.2)。
あちらは原因が分かり直したが、**「起動直後の初回だけ落ちる」形がもう一度出た**ことは記録しておく。
マージの差分(main 側は文書のみ)はこのテストに触れていない。

### セキュリティ影響

**有る。** 権限の取り消しを実行する経路を新設した。

- 認可: `org_admin` / `platform_admin` のみ(閲覧は `auditor` も可)
- 越境: API認可とRLSの二層。他組織のレビューは一覧に出ず、ID直指定でも 404
- 監査: 開始・判断・完了の3イベント。取り消しは `role.binding.deleted` も残る
- 失効の実装は増やしていない([[WP-P1-IDM-015]] の経路を呼ぶ)ため、
  最後の管理者を守る判定はそのまま効く

**`AGENTS.md` §1.16 により、人間のセキュリティレビューが必要である。**
自己レビューは代替にならない。

### 未解決事項

- **`role-binding-expiry` の断続的な失敗の原因が未特定**(§13.4)。落ちたら出力を保存する
- **四半期の自動起票と未実施の可視化が無い。** いまは人が開くまで何も起きない。
  「四半期ごとに実施している」と言うには後続WPが要る(§5)
- `platform` スコープの役割はレビューできず、件数も見えない(§7.1)
- `tests/integration/` が空のまま `npm run test:integration` が存在する

## 14. 関連

- [[06.4_Backlog]] C-3 — この要求が未着手として置かれていた場所
- [[WP-P1-IDM-014]] / [[WP-P1-IDM-015]] / [[WP-P1-IDM-017]] — 役割の期限・付与・取り消し
- [[02.14_Threat_Model]] T-20
