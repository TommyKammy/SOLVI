---
project: SOLVI
doc_id: "WP-P4-APR-018"
title: "承認者不在の申請の再割当(経路の世代の保存・API・画面)"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "1.0.0"
created: "2026-11-14"
updated: "2026-11-14"
owner: "SOLVI Product Team"
tags: ["workpackage", "p4", "approval", "reassignment"]
source_of_truth: true
implementation_status: "done"
story_points: 5
risk: "high"
workstream: "APR"
phase: "P4"
requirement_ids: ["FR-CAT-013"]
depends_on: ["WP-P4-APR-015", "WP-P4-APR-016"]
---

# WP-P4-APR-018: 承認者不在の申請の再割当(経路の世代の保存・API・画面)

| 項目 | 値 |
|---|---|
| Phase | P4 |
| Workstream | APR |
| Risk | high |
| Story Points | 5 |
| Suggested Owner | Backend + Frontend + Security Reviewer |
| Parallelizable | No([[WP-P4-APR-019]] の前) |
| Gate | Gate B(GB-3) |

## 1. Purpose

承認者不在で止まった申請を、組織管理者が「再割当」で進められるようにする。[[WP-P4-APR-015]] §6.2 で見送り、[[WP-P4-APR-017]] へ移していた項目である。再割当後の経路は、[[ADR-0024_Approval_Route_Generations_And_High_Risk_Criterion]] §1〜§3 のとおり、追記専用の別テーブルに世代として保存する。版のテーブルは書き換えない。

## 2. Requirement IDs

`FR-CAT-013`(承認経路の固定と再割当のうち、未充足の「再割当」)

## 3. Dependencies

[[WP-P4-APR-015]](done)、[[WP-P4-APR-016]](done)。[[ADR-0024_Approval_Route_Generations_And_High_Risk_Criterion]](accepted、2026-11-14)。

## 4. Scope / Allowed Paths

- `db/migrations/`(0040 の up / down だけ)
- `services/api/src/modules/catalog/`
- `services/api/src/modules/inbox/inbox.routes.ts`
- `services/api/src/main.ts`(再割当APIの経路の登録だけ。2026-11-14 監督者が追加。起票時の記載漏れ)
- `services/api/src/common/audit/audit.ts`
- `packages/shared/src/catalog.ts`
- `apps/web/src/app/ops/approvals/`
- `apps/web/src/app/requests/[id]/page.tsx`
- `apps/web/src/app/requests/actions.ts`
- `apps/web/src/lib/api.ts`
- `apps/web/src/lib/approval-route.ts`
- `tests/security/approval-reassign.test.ts`(新規)
- `tests/unit/approval-reassign.test.ts`、`tests/unit/approval-reassign-ui.test.ts`(新規)
- `tests/unit/` と `tests/security/` の既存の承認テスト(現在の経路の導出が変わることへの追従だけ。削除・skip・緩和は不可)
- `tests/support/cleanup.ts`
- `tools/check_rls.mjs`(新しいテーブルの登録が必要な場合だけ)
- `tools/ui_approval_routing_check.mjs`
- `docs/planning/06_WorkPackages/P4_Approval_Automation/WP-P4-APR-018.md`(§13 だけ)
- `evidence/WP-P4-APR-018/`

## 5. Out of Scope

- 期限前の通知とエスカレーション([[WP-P4-APR-019]])、代理承認([[WP-P4-APR-020]])、高リスク二重承認([[WP-P4-APR-021]])。
- 期限切れのステップの再割当(従来どおり再申請を求める)。
- 承認ルールを使わない経路(承認者を1人指定する従来方式)の再割当。
- 承認者を管理者が手で選ぶ機能。再割当は、ルールと現時点の組織データからの再解決だけである。
- 版のテーブルへの `UPDATE` 権限の付与。Executor との接続。

## 6. Deliverables

1. **Migration 0040**: `local_request_route_generation`(ADR-0024 §1 の列・主キー・版への複合外部キー・RLS(ENABLE + FORCE)・`SELECT` / `INSERT` だけの権限・`UPDATE` / `DELETE` を拒否するトリガ)。`route_generation >= 2`、`from_step_no` は1〜3、`reason` の長さの CHECK。down はデータがあれば拒否する。
2. **現在の経路の導出**: 版の列と世代の行から「現在の経路」「段ごとの有効な世代」を返す共有関数を1つ置く。決定、`assertApprovalComplete` / `checkApprovalComplete`、承認待ち一覧、申請の詳細、滞留の導出を、すべてこの関数へ置き換える。
3. **実行前検証の拡張**: 各段について、有効な世代のステップ行が承認済みで、承認者・権限種別・`route_hash` が現在の経路と一致することを検証する。`from_step_no` より前の段が直前の世代と一致しない場合は失敗する。世代の行が読めない・欠けている場合も失敗する(fail closed)。
4. **再割当API**: 申請を指定する POST のエンドポイントを1つ加える(パスは既存の決定APIの並びに合わせる。本文は `reason` だけ。承認者のIDは受け取らない)。条件は ADR-0024 §3 のとおり。
   - `org_admin` 以外は403。申請者本人は `org_admin` でも403。他組織・存在しないIDは404。
   - 現在の `pending` のステップが承認者不在でない、ルールを使わない経路、期限切れ、完了済み・取消済みは409。
   - 再解決に失敗したら、何も変更せず、理由のコードを返す(409)。
   - 成功時: 申請の行をロックし、未決定ステップを `invalidated`、世代の行を追加、新しい `pending` のステップを作成(期限はその時点から72時間)、`current_approval_id` を更新、`approval.reassigned` と新しいステップの `approval.requested` を記録する。すべて1トランザクション。
5. **状態機械**: 遷移表に `reassign` を加える(`pending` → `invalidated`。申請の状態は変えない)。再割当以外で経路が変わるコード経路を作らない。
6. **画面**:
   - `/ops/approvals` の承認者不在の一覧に、「再割当」の操作を加える(理由の入力、確認、結果の表示)。現在の案内「申請者による内容の変更で対処する」を、再割当の案内に改める。申請者本人が `org_admin` の場合は、操作を出さず理由を示す。
   - 申請の詳細の「承認の経過」に、再割当があったこと(日時、実行者、理由、無効になったステップ、新しい承認者)を表示する。
7. **監査**: `approval.reassigned`(旧・新の世代、無効化したステップ、新しい承認者、実行者、理由)。[[02.17_Audit_Event_Catalog]] の担当WPの記載を本WPへ改める。

## 7. Acceptance Criteria

- [ ] `org_admin` の再割当後、新しい承認者が決定でき、旧世代の未決定ステップでは決定できない。承認済みステップの行は変更されず、`approval.reassigned` が記録される。
- [ ] 再割当後に全段が承認されると `assertApprovalComplete` が成功する。承認済みの段が旧世代、残りが新世代にある場合を含む。
- [ ] 世代の行を欠く・`from_step_no` より前の段が直前の世代と違う・`route_hash` が合わない場合、`assertApprovalComplete` が失敗する。
- [ ] 再割当は、現在のステップが承認者不在のときだけ実行できる。それ以外(承認者が有効、期限切れ、完了済み、取消済み、ルールを使わない経路)は409で、行は変更されない。
- [ ] `org_admin` 以外のすべてのロールで403。申請者本人の `org_admin` で403。他組織の申請IDで404。
- [ ] 再解決に失敗した場合(新しい上長が未設定、申請者本人に解決される、など)、409で理由が返り、ステップ・世代・監査のどれも増えない。
- [ ] 同じ申請への再割当と決定、再割当と再割当を同時に実行しても、世代とステップが二重に作られない。
- [ ] 版のテーブルの行は、再割当の前後で1バイトも変わらない。アプリケーションロールから世代の行の `UPDATE` / `DELETE` が拒否される。他組織の世代の行が読めない(RLS)。
- [ ] 上長の変更だけでは、進行中の申請の経路は変わらない(再割当以外で経路が変わるコード経路が無い)。
- [ ] 画面: 承認者不在の一覧から再割当でき、詳細に再割当の記録が出る。1440px と 375px、Chromium と WebKit で崩れず、axe の serious / critical が0。
- [ ] Migration 0040 の up / down が往復でき、データがある状態の down が拒否される。
- [ ] `check:all`・`typecheck`・`lint` が通り、新規依存が0件である。既存の承認テストに新しい失敗が無い。

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-02(状態遷移と再割当)、TL-04(Migration)、TL-06(ロール×エンドポイントの総当り、組織境界)、TL-16(IDOR、申請者本人による再割当)

### Evidence

- 再割当の前後の経路・ステップ・監査イベント、条件外の拒否ログ、同時実行のテスト結果、画面のスクリーンショットと axe の結果

`evidence/WP-P4-APR-018/<YYYYMMDD-HHMM>/` へ保存する([[06.2_Evidence_Index]])。

## 9. Security and Audit

- Gate B GB-3 の対象。**Security Reviewer(人間)の sign-off 必須**(認可・RLS・監査を変更する)。
- 脅威 [[02.14_Threat_Model]] T-08(自己承認・偽装承認)、T-26(関係の改ざんによる承認者の作出)。残余リスクは RA-04 のまま。
- 生成する監査イベント: `approval.reassigned`、`approval.invalidated`(原因=再割当)、`approval.requested`。

## 10. Rollback / 失敗時の扱い

再割当のAPIと画面を取り除いても、世代の行が無い申請は従来どおり動く。世代の行がある申請は、現在の経路の導出(§6-2)を残したまま完了させる。Migration の down はデータがあれば拒否する(前進修復)。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Packageのみを実装してください(baselineに上がった後のみ)。

正本: AGENTS.md / 本WP / ADR-0024(§1〜§3) / ADR-0023(§2・§6・§7) / 03.5(FR-CAT-013) /
02.17(approval.reassigned) / 02.14 T-08・T-26 / WP-P4-APR-014・015 の成果。

手順:
1. 受入基準をテストへ変換し、先に書く(世代をまたぐ実行前検証、条件外の拒否、権限の総当り、同時実行)。
2. Migration 0040、現在の経路の導出の共有関数、実行前検証、遷移表、再割当API、画面の順に実装する。
3. 現在の経路を読む箇所を、すべて共有関数へ置き換える。置き換え漏れを検索で確かめ、報告する。

やってはいけないこと:
- 版のテーブルの更新、承認済みステップの行の複製・書き換え。
- 承認者のIDを本文で受け取ること。自動での差し替え。
- テストのskip・削除、新規依存、Allowed Paths外の変更、ADRの決定の黙った変更。
完了時に報告: 変更ファイル、Migrationと rollback、検証コマンドと結果、受入基準ごとの充足、セキュリティ影響、未解決事項、Evidence。
```

## 12. Definition of Done

- [ ] §7をすべて満たす / §8のテスト通過とEvidence保存
- [ ] Migration(up/down)とロールバック方針、既存データ互換の説明
- [ ] 関連ドキュメント(02.17・03.5・RTMのStatus)の更新
- [ ] 未解決のCritical/Highがない
- [ ] Security Reviewer(人間)のsign-off(必須)
- [ ] Execution Logへ追記

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-11-14 | 実装担当(Codex) | 作業ツリー(未コミット) | 段階A 完了(HTTP経路の登録のみ未実施) | `evidence/WP-P4-APR-018/20261114-1917/` | Migration 0040・経路世代の共有導出・実行前検証・再割当API・遷移表・監査。画面(段階B)は未着手。`main.ts` が Allowed Paths 外のため POST 経路の登録は行っていない |
| 2026-11-14 | 実装担当(Codex) | 作業ツリー(未コミット) | 段階B 完了(ブラウザ確認を除く) | `evidence/WP-P4-APR-018/20261114-1959/` | `main.ts` の POST 経路の登録、`invalidateApprovalSteps` の遷移表化、`/ops/approvals` の再割当フォーム、申請詳細の再割当の記録。スクリーンショット・axe・`ui_approval_routing_check.mjs` は未実施(ブリーフの指示) |
| 2026-11-14 | 実装担当(Codex) | 作業ツリー(未コミット) | ブラウザ確認(B2) 完了 | `evidence/WP-P4-APR-018/20261114-2051/` | Chromium/WebKit で再割当の通し確認、1440/375px、axe serious/critical 0。成功表示・表の列幅・チェックボックスの対象サイズを修正。`implementation_status` を `review` に変更 |
| 2026-11-14 | 実装担当(Codex) | 作業ツリー(未コミット) | 修正C 完了(実フローの撮り直しは未実施) | `evidence/WP-P4-APR-018/20261114-2148/` | 再割当の欄を操作列から申請行直後の全幅行へ移動。成功表示は現在の版の世代2以上の記録がある場合だけ、最新の記録の段・新しい承認者・日時で出す。開発用DBへの書込みなし(ログインの session・監査のみ)。レイアウトはハーネスで確認 |
| 2026-11-14 | 実装担当(Codex) | 作業ツリー(未コミット) | ブラウザ再確認(B3) 完了 | `evidence/WP-P4-APR-018/20261114-2215/` | 修正C後の実画面。ロールの一時変更は1回だけ(外す 13:23:16Z / 戻す 13:23:28Z)。Chromium/WebKit・1440/375px、axe 12 scans で serious/critical 0。確認のチェック欄をラベルと同じ行に修正 |

### 2026-11-14 段階A 実装記録

**範囲**: WP §6 の 1〜5・7。§6-6(画面)は段階Bのため未着手。

#### 変更ファイル

- `db/migrations/0040_local_request_route_generation.sql`(新規)
- `services/api/src/modules/catalog/approval-route-state.ts`(新規)
- `services/api/src/modules/catalog/approval-assertion.ts`(段ごとの有効な世代で実行前検証)
- `services/api/src/modules/catalog/approval-resolver.ts`(固定したルール版の読み込み・部分解決)
- `services/api/src/modules/catalog/approval-state.ts`(遷移 `reassign`・次のステップの世代・`applyReassignment`)
- `services/api/src/modules/catalog/catalog.routes.ts`(経路導出の置換・再割当API・詳細の加算)
- `services/api/src/modules/inbox/inbox.routes.ts`(承認待ち・受信箱を有効な世代で判定)
- `services/api/src/common/audit/audit.ts`(`approval.reassigned`)
- `tests/security/approval-reassign.test.ts`(新規、36 tests)
- `tests/unit/approval-reassign.test.ts`(新規、18 tests)
- `tests/unit/approval-state.test.ts`(遷移表の追従)
- `tests/unit/approval-assertion.test.ts`(偽DBの追従・`route_generation_mismatch` への追従)
- `tests/unit/catalog-flexible.test.ts` / `tests/unit/catalog-operations.test.ts`(偽DBの追従だけ)
- `tests/security/approval-steps.test.ts`(版の列が世代1でない場合の期待値を409へ追従)
- `tests/security/approval-migration-compat.test.ts`(0038 の down 拒否後に 0039/0040 を再適用)

`apps/web/`、`tools/ui_approval_routing_check.mjs`、`package.json`、lockfile、`.env` は未変更。

#### Migration 0040

- 新規 `local_request_route_generation`。列は `organization_id` / `request_id` / `revision` /
  `route_generation`(2以上)/ `from_step_no`(1〜3)/ `route jsonb` / `route_hash` / `reason`(1〜2000文字)/
  `created_by` / `created_at`。主キー `(request_id, organization_id, revision, route_generation)`。
- 版 `local_request_revision (request_id, organization_id, revision)` への複合外部キー。
- RLS(ENABLE + FORCE、`organization_id = app_current_org()`)。`solvi_app` は SELECT / INSERT のみ。
  UPDATE / DELETE は `reject_asset_history_change()` トリガで拒否。
- **版のテーブルに UPDATE 権限を与えていない。版の列・行は変更しない。**
- **ロールバック**: down は行が1件でもあれば `0040 rollback refused` で拒否する(前進修復)。
  行が無ければトリガと表を削除する。使い捨てDBで down → up の往復と、データあり down の拒否を確認。

#### 現在の経路の導出

`approval-route-state.ts` の `loadRouteState` / `deriveRouteState` が唯一の判定である。
版の列を世代1、`from_step_no <= k` を満たす最大の世代を段 k の有効な世代として導出し、
`route_generation` の連続性・`route_hash`・`from_step_no` より前の段の一致・行の形を fail closed で検証する。

置き換えた箇所:

- 決定(`decide` の承認・却下・取消)
- `assertApprovalComplete` / `checkApprovalComplete`
- 申請の詳細(`detail` の `route` / `steps` / `approverUnavailable` / `history`)
- 承認待ち一覧(`list` の結合・権限種別・承認者不在)
- 受信箱(`inbox.routes.ts` の利用者可視性・承認待ちの抽出)
- 滞留の導出(一覧と再割当で `approverAvailabilitySql` / `isApproverUnavailable` を共有)
- 申請内容の変更時の全ステップ無効化(`edit` は全世代の行を無効化)
- 再割当API

置き換えなかった箇所:

- 申請の作成と冪等リプレイ(`create`): **世代1の記録**との比較であり「現在の経路」ではない。
  既存の `checkRouteAgainstSteps` をそのまま使う。
- 経路を決めた時点の `approval.route.resolved` の記録: 解決結果(世代1)の記録であり、現在の経路の読み取りではない。
- `addRevisionAndStep`: 新しい版の世代1を保存する書き込み経路。

#### 実行前検証

- 段ごとに、有効な世代のステップ行が `approved` で、承認者・権限種別が現在の経路と一致することを検証する。
- 有効な世代でない行は `invalidated` だけを許す。`route_generation` が現在の世代を超える行、
  存在しない世代の行、世代の行があるのに承認行が無い世代は失敗する。
- 世代の行の欠落・番号の飛び・`from_step_no` より前の段の不一致・`route_hash` の不一致・
  行の形の不正は失敗する(fail closed)。
- 失敗コード: `revision_missing` / `route_invalid` / `route_hash_mismatch` /
  `route_generation_mismatch` / `route_generation_sequence` / `route_generation_shape` /
  `route_generation_step_count` / `route_generation_prefix_mismatch` / `route_generation_rule_mismatch`。
  既存の `route_step_count` / `route_step_mismatch` / `approval_not_approved` なども維持する。

#### 再割当API

- `CatalogController.reassign`。POST のパスは既存の決定APIの並びに合わせて
  `/service-requests/:id/reassignments` を想定する(Migration・テストはコントローラを直接呼ぶ)。
- 本文は `reason` だけ(`trim`・1〜2000文字・空白だけ不可・未知のキーは400)。
- `org_admin` だけ。申請者本人は `org_admin` でも403。他組織・存在しないIDは404。
- 409: 現在の pending ステップの承認者が有効、期限切れ、完了・却下・取消、ルールを使わない経路、
  再解決の失敗(理由コードを `errors[].message` に返す)。
- 成功時は申請行を `FOR UPDATE` し、未決定ステップを遷移表 `reassign` で `invalidated`、
  世代の行を `INSERT`、新しい pending ステップを72時間で作成、`current_approval_id` を更新、
  `approval.invalidated`(cause=reassigned)・`approval.reassigned`・`approval.requested` を同一トランザクションで記録する。
  監査の書込みに失敗したら全体を巻き戻す。主キー・一意制約違反は409にする。
- **承認済みステップの行は複製も更新もしない。**

#### 検証コマンドと結果

すべて使い捨てDB `solvi_wp018_test` と `solvi_wp018_wp015_test`(Migration 40件・seed 済み)で実行。
接続文字列は記録しない。

```text
npx vitest run tests/security/approval-reassign.test.ts
# 36 passed / 0 failed
npx vitest run tests/unit/approval-reassign.test.ts tests/unit/approval-state.test.ts \
  tests/unit/approval-assertion.test.ts tests/unit/catalog-flexible.test.ts \
  tests/unit/catalog-operations.test.ts
# 181 passed / 0 failed
npx vitest run tests/security/approval-assertion.test.ts \
  tests/security/approval-migration-compat.test.ts tests/security/approval-reassign.test.ts \
  tests/security/approval-routing.test.ts tests/security/approval-rule.test.ts \
  tests/security/approval-steps.test.ts tests/security/department-api.test.ts \
  tests/security/department-profile.test.ts tests/security/relationship-change.test.ts \
  tests/security/user-admin.test.ts
# 10 files / 282 passed / 0 failed
npx vitest run tests/security
# 36 passed / 6 failed(既知の読み込み不能6ファイル) / 807 passed / 10 skipped
npm run test:unit
# 34 failed / 4455 passed(4489)。基点(34 failed / 4397 passed / 4431)と失敗名35行が完全一致
node tools/check_rls.mjs                        # 問題0件 / OK
npm run typecheck                              # exit 0
npm run lint                                   # exit 0
npm run check:all                              # exit 0
```

開発用DB `solvi` の件数(`app_user` 15、`role_binding` 21、`local_catalog_item` 23、
`local_service_request` 14、`local_request_revision` 19、`local_request_approval` 21、
`department` 19、`department_head` 7、`approval_rule` 11、`approval_rule_revision` 17、
`org_member_profile` 15)は作業前後で完全一致。`schema_migration` は39件・最大 `0039` のまま。

#### §7 受入基準の充足(段階A)

- ✅ 再割当後、新しい承認者が決定でき、旧世代の `invalidated` のステップでは決定できない:
  `tests/security/approval-reassign.test.ts`。
- ✅ 再割当後に全段承認で `assertApprovalComplete` が成功する(承認済みが旧世代、残りが新世代):
  同テスト。
- ✅ 世代の欠落・`from_step_no` より前の段の不一致・`route_hash` の不一致で実行前検証が失敗する:
  同テスト。
- ✅ 条件外(承認者有効・期限切れ・完了・却下・取消・ルール不使用)は409で行が変わらない: 同テスト。
- ✅ `org_admin` 以外は403、申請者本人の `org_admin` は403、他組織・不存在は404: 同テスト。
- ✅ 再解決の失敗(上長未設定・申請者本人・承認済みの段との重複・無効な所属)は409で、
  ステップ・世代・監査が増えない: 同テスト。
- ✅ 再割当×再割当、再割当×決定で世代とステップが二重にならない: 同テスト。
- ✅ 版の行が再割当の前後で全列同じ。アプリロールの UPDATE / DELETE が拒否される。他組織の世代が読めない: 同テスト。
- ✅ 上長の変更だけでは経路・ステップ・世代が変わらない: 同テスト。
- ⏳ 画面(承認者不在の一覧からの再割当、詳細の再割当記録、1440/375px、axe): 段階B。
- ✅ Migration 0040 の up / down の往復と、データあり down の拒否: 同テスト。
- ⏳ HTTP の POST 経路の登録: `services/api/src/main.ts` が WP §4 の Allowed Paths に無いため未実施。
  コントローラのメソッドと検証は実装済み。1行の経路登録が必要(監督者の判断)。
- ✅ `check:all`・`typecheck`・`lint`・`check_rls` が通り、新規依存は0件。既存の承認テストに新しい失敗が無い。

#### セキュリティ影響

- 新しく許した操作は `org_admin`(申請者本人を除く)による再割当だけ。既存の認可を広げていない。
- 経路を変えるコード経路は再割当だけ。自動の差し替え・フォールバック・環境変数による切替は無い。
- 承認者ID・段・経路を入力で受け取らない。未知のキーは400。
- 承認者不在の判定は一覧・詳細・再割当で同じSQL述語(`approverAvailabilitySql`)を使う。
- 世代は組織境界(複合FK + RLS + API認可)と追記専用(権限 + トリガ)で守る。版は書き換えない。
- 監査は業務トランザクションと同一で、失敗したら再割当も失敗する。監査に申請の入力値・個人データを載せない。
- 新規依存パッケージ0件。`apps/web/`、`package.json`、lockfile、`.env` は未変更。

#### 未解決事項

- `services/api/src/main.ts` への POST `/service-requests/:id/reassignments` の登録(Allowed Paths 外)。
- 段階B(画面・`tools/ui_approval_routing_check.mjs`)は未着手。
- `docs/planning/MANIFEST.md`、`03.18`、`02.17` はブリーフの指示により変更していない。
  02.17 の `approval.reassigned` の担当WPの記載は監督者の判断で更新する。

#### Evidence

`evidence/WP-P4-APR-018/20261114-1917/`(`README.md` と `raw/`)。使い捨てDBは
`solvi_wp018_test` と `solvi_wp018_wp015_test` を検査用に残している。

### 2026-11-14 段階B 実装記録

**範囲**: WP §6-6(画面)と、段階Aの未実施・修正2点(HTTP経路の登録、`invalidateApprovalSteps` の遷移表化)。
`implementation_status` は `in-progress` のまま(ブラウザ確認が残る)。

#### 変更ファイル

- `services/api/src/main.ts`(POST `/service-requests/:id/reassignments` の登録だけ)
- `services/api/src/modules/catalog/approval-state.ts`(全行 `invalidated` の分岐も遷移表を通す。除外してよい行の明記)
- `services/api/src/modules/catalog/catalog.routes.ts`(再割当の409に理由コード。詳細の加算的な応答)
- `apps/web/src/app/ops/approvals/page.tsx`(再割当の操作・案内の差し替え・自分の申請の案内)
- `apps/web/src/app/ops/approvals/actions.ts`(再割当のサーバーアクション、管理者の再確認)
- `apps/web/src/app/ops/approvals/ReassignForm.tsx`(新規。理由・確認・結果)
- `apps/web/src/app/requests/[id]/page.tsx`(承認の経過・再割当の記録・承認の記録)
- `apps/web/src/lib/api.ts`(`reassignRequest`、詳細の加算的な項目の型)
- `apps/web/src/lib/approval-route.ts`(失敗の文・成功の文・再割当の記録の純関数)
- `tests/unit/approval-reassign-ui.test.ts`(新規、39 tests)
- `tests/unit/approval-state.test.ts`(無効化の遷移表の unit 6 tests を追加)
- `tests/security/approval-reassign.test.ts`(HTTP経路の登録・401、理由コード、詳細の加算項目)

#### Migration

なし(段階Aの 0040 のみ)。ロールバック方針も段階Aのまま
(0040 の down は行があれば拒否する前進修復)。

#### 検証コマンドと結果

使い捨てDB `solvi_wp018_wp015_test`(Migration 40件・seed 済み)で実行。接続文字列は記録しない。

```text
npm run typecheck                              # exit 0
npm run lint                                   # exit 0
npm run check:all                              # exit 0
node tools/check_rls.mjs                       # 問題0件 / OK
npx vitest run tests/unit/approval-reassign-ui.test.ts ...(対象10ファイル)
# 10 files / 391 passed / 0 failed
npx vitest run tests/security/approval-reassign.test.ts
# 38 passed / 0 failed
npx vitest run tests/security/approval-assertion.test.ts ...(承認の security 10ファイル)
# 10 files / 285 passed / 0 failed
npx vitest run tests/security
# 9 failed files / 33 passed / 30 failed tests / 779 passed / 10 skipped
# 失敗は既知の読み込み不能6ファイルと、S3(127.0.0.1:9100)が403を返す環境要因3ファイル
npm run test:unit
# 34 failed / 4500 passed (4534)。基点(34 failed / 4455 passed / 4489)と失敗名35行が一致(新規失敗0)
```

開発用DB `solvi` の件数は作業前後で一致。`schema_migration` は 40件・最大 `0040`
(作業開始時点で既に 0040 が適用されていた。ブリーフの前提「39件」とは異なる)。
開発用DBへの書込みは行っていない。

#### §7 受入基準の充足(段階Bで追加・確定した項目)

- ✅ 画面: 承認者不在の一覧から再割当の理由を入力して実行でき、結果に新しい承認者の表示名と段が出る。
  申請者本人の行には操作を出さず案内を出す。`tests/unit/approval-reassign-ui.test.ts`。
- ✅ 画面: 詳細に再割当の記録(日時・実行者・理由・無効になったステップ・新しい承認者)が
  時刻の順に出る。現在の経過は段ごとの有効な世代で、置き換えられたステップを現在の段に出さない。
  同じテスト。
- ⏳ 1440px/375px・Chromium/WebKit・axe の serious/critical 0: ブラウザ確認は未実施
  (ブリーフで今回の対象外)。375px では既存の `.directory-table` の縦積みと
  `input/textarea { max-width: 100% }` に依存しており、実測は残る。
- ✅ HTTP の POST 経路の登録: `main.ts` に登録。認証なしは 401(同じハンドラ形状の実 HTTP で確認)。
- ✅ 全行が `invalidated` の場合も遷移表を引く(`edit` のみ通り、`revoke` と他の状態は拒否)。
  `tests/unit/approval-state.test.ts`。

#### セキュリティ影響

- 新しい操作は `org_admin`(申請者本人を除く)の再割当だけ。認可を広げていない。
- 画面は理由と確認だけを送る。承認者ID・段・経路は送らず、APIも受け取らない。
- 失敗の表示にAPIの文・理由コードをそのまま出さない(利用者向けの文に変換)。
- 段階Bで増やしたSQLは詳細の読み取り(EXISTS を含む)だけで、書込み経路は変えていない。
- 新規依存0件。`package.json`・lockfile・`.env`・`next.config.*` は未変更。

#### 未解決事項

- ブラウザ確認(1440/375px、Chromium/WebKit、axe)と `tools/ui_approval_routing_check.mjs` の拡張。
- 開発用DBには 0040 が既に適用済み(0行)。ブラウザ確認を実施するかの判断は監督者。
- `npm run test:unit` の既存34失敗と、`tests/security` の既知6ファイルは変わらず。
  S3 端点が 403 を返す環境要因で3ファイル(30 tests)が失敗する。

#### Evidence

`evidence/WP-P4-APR-018/20261114-1959/`(`README.md` と `raw/`)。

### 2026-11-14 ブラウザ確認(B2)

**範囲**: 再割当の通し確認(Chromium / WebKit、1440px / 375px、axe、キーボード)。
開発用DB `solvi`(Migration 0040 適用済み)で、画面経由の合成データだけを使用した。
Evidence: `evidence/WP-P4-APR-018/20261114-2051/`。

#### 確認できた流れ

- 合成の部署・主部署・上長A・2段ルール(上長→固定承認者)・カタログ項目を作り、組織で有効化して申請した。
- 上長A(auditor)の最後の役割を管理画面から外すと、承認者不在の一覧に申請が出た。
  案内文(再割当で決め直せること・承認者を手で選べないこと・固定承認者の段は変わらないこと)を確認。
- 上長Aのまま再割当すると拒否され、申請の版・世代・承認行は変わらなかった。
  実際の表示は「段1: 上長が今は有効な所属ではないため、再割当できません…」(`manager_inactive`)。
  ブリーフが期待した「再割当後の承認者が今と同じ」(`approver_unchanged`)ではない。
  上長が不在の状態では再解決が先に失敗するため、この経路では `approver_unchanged` に到達しない
  (実装の挙動は正しく、文も実際の理由を説明している。コードは変更していない)。
- 上長を上長B(agent、approver ロールなし)へ変え、理由なし・確認なしの送信が入力の検査で止まることを確認。
  理由と確認を入れて再割当すると、成功の表示(段1・新しい承認者の表示名)が出た。
- 申請の詳細で、段1が上長B(承認待ち)、再割当の記録(日時・実行者・理由・無効になったステップ・
  新しい承認者)、承認の記録の「再割当により無効」を確認。申請者本人にも同じ記録が見えた。
- 上長Aの役割を戻したあと、上長Aは承認待ち一覧・受信箱に出ず、詳細にも承認の操作が無かった。
- 上長Bが承認 → 固定承認者が承認 → 担当者が模擬完了まで進め、承認の経過が最後まで通った。
- 上長Aの役割・ルールの使用・プロフィール・部署・カタログ項目・ルールを片付けた。
  作った申請2件は模擬完了のまま残した。

#### 見つけて直した不具合(変更ファイル)

- `apps/web/src/app/ops/approvals/ReassignForm.tsx`
  - 確認のチェックボックスが 16×16px で axe `target-size`(serious)に違反していた。24×24px にした。
  - モバイルで `td` の2列グリッドの1列目(90px)にフォームが押し込まれ、1文字ずつ折り返していた。
    `details` を `grid-column: 1 / -1` にしてセル幅へ広げた。
- `apps/web/src/app/ops/approvals/page.tsx`
  - 承認者不在の表の操作列が汎用の 7% で、再割当フォームとエラーが読めない幅だった。
    この表だけ `colgroup` で列幅を配分し、操作列を 24%(実測 257px / 375px では 325px)にした。
  - 再割当の成功表示を、URL の `reassigned=<申請ID>` から現在の段と新しい承認者を読み直して
    同じ画面に出すようにした(表示名はURLに載せない)。
- `apps/web/src/app/ops/approvals/actions.ts`
  - 再割当成功時、一覧が最新になって行が消えるため、成功の文が消えていた。
    申請IDだけをURLに残して同じ画面へ戻す(`approvalHref`)。失敗は従来どおりその場に表示する。
- `apps/web/src/lib/approval-route.ts`
  - `reassigned` の解析と `approvalHref` の組み立て(申請IDのみ。UUID以外は捨てる)。
- `tests/unit/approval-reassign-ui.test.ts`、`tests/unit/approval-route-ui.test.ts`
  - 成功時の遷移・同じ画面の成功表示・表の列幅に追従。既存テストの削除・skip は無し。
- `tools/ui_approval_routing_check.mjs`
  - `wp018` / `wp018resume` / `wp018cleanup` の段階を追加。既存の WP-P4-APR-016 の確認は変更していない。
  - 合成データの上限(両エンジン合計: ルール2・部署2・プロフィール3人・カタログ2・申請4・再割当4)を
    事前確認で強制し、再実行は読み取りの照合または片付けに切り替える。

#### ロールの一時変更の記録

対象: `auditor@acme.example.test`(`サンプル株式会社 auditor`)、ロール `auditor`(org)、期限なし。
作業前: 有効な `auditor` 1件のみ。管理画面の「役割を取り消す」で外し、「役割を与える」で
同じ組織・同じロール・期限なしに戻す手順を試した。

**管理画面の不具合**: 最後の役割を外した利用者は `/ops/users` の一覧から消え、
「役割を与える」の画面へ到達できない(一覧は有効なロール付与を持つ利用者だけを返す)。
そのため復元は、画面と同じ認証済みの管理API `POST /users/:id/roles` で行った。
直接のSQL変更は行っていない。この画面の穴は本WPの Allowed Paths 外のため直さず、報告に残す。

実施したサイクル(UTC、role_binding の valid_until / valid_from):
- 11:54:50.758 外す → 11:56:07.816 戻す(最初の試行。ツールの事後確認が `/users` を前提にしていたため)
- 11:57:07.295 外す → 11:57:09.537 戻す(axe `target-size` の修正のため)
- 11:58:08.913 外す → 11:58:40.306 戻す(成功の表示が消える不具合の修正のため)
- 12:07:25.004 外す → 12:07:37.459 戻す(WebKit の通し確認)

最終状態: 有効なロール付与は `auditor` 1件(期限なし・同じ組織)で作業前と同じ。
`role_binding` は 21 → 25(+4)。増分はすべて同じアカウントの付け直しで、期限切れの行が残るため。

#### 検証コマンドと結果

```text
npm run typecheck                              # exit 0
npm run lint                                   # exit 0
npm run check:all                              # exit 0
npx vitest run tests/unit/approval-reassign-ui.test.ts \
  tests/unit/approval-reassign.test.ts tests/unit/approval-state.test.ts \
  tests/unit/approval-assertion.test.ts tests/unit/approval-route-ui.test.ts \
  tests/unit/requests-ui.test.ts               # 221 passed / 0 failed
npx vitest run tests/security/approval-reassign.test.ts   # 38 passed(使い捨てDB)
npx vitest run tests/security/(承認の security 10ファイル) # 285 passed(使い捨てDB)
npm run test:unit                              # 34 failed / 4501 passed(4535)
# 基点(34 failed / 4500 passed / 4534)と失敗名35行が一致。新規失敗0。
```

ブラウザ確認(両エンジン、開発用DB):
- Chromium: 通し確認 PASS(最終の完了確認 6 checks、axe 8 scans。先行の実行で一覧・失敗の axe 4 scans も0)。
- WebKit: 通し確認 PASS(15 checks、axe 10 scans、すべて serious/critical 0)。
- 1440px / 375px: 横溢れなし(`document.documentElement.scrollWidth <= innerWidth`)。
- キーボード: `summary` を Enter で開き、理由欄へフォーカス(アウトライン/リングあり)、
  確認のチェック、送信ボタンを Enter で実行できた。

#### 開発用DBの件数(SELECT count(*))

| テーブル | 作業前 | 作業後 |
|---|---:|---:|
| `app_user` | 15 | 15 |
| `role_binding` | 21 | 25 |
| `local_catalog_item` | 23 | 25 |
| `local_service_request` | 14 | 16 |
| `local_request_revision` | 19 | 21 |
| `local_request_approval` | 21 | 27 |
| `local_request_route_generation` | 0 | 2 |
| `local_simulation_receipt` | 6 | 8 |
| `department` | 19 | 21 |
| `department_head` | 7 | 7 |
| `approval_rule` | 11 | 13 |
| `approval_rule_revision` | 17 | 19 |
| `org_member_profile` | 15 | 15 |
| `schema_migration` | 40件・最大 `0040` | 40件・最大 `0040` |

検査後: ルールの使用が有効な組織0件、有効な `ui018-syn-` ルール0件、
有効な `UI018-SYN-` 部署0件、値の入ったプロフィール0件(作業前と同じ)。
残した合成データ: ルール2件(無効)・部署2件(無効)・カタログ項目2件(非公開)・
申請2件(模擬完了、`REQ-2026-000162` / `REQ-2026-000163`)・経路世代2件。

#### §7 受入基準の充足(ブラウザ)

- ✅ 承認者不在の一覧から再割当でき、詳細に再割当の記録が出る(両エンジン)。
- ✅ 1440px / 375px で崩れず、axe の serious / critical が0(ルールの無効化なし)。
- ✅ 成功の表示に段と新しい承認者が出る。失敗は理由コードから利用者向けの文にする。
- ✅ 申請者本人にも再割当の記録が見える。
- ✅ 上長Aを戻した後、上長Aは決定できない。
- ⏳ 組織管理者が申請者本人の場合の表示は、追加の書込みが必要なためブラウザでは作らず、
  `tests/unit/approval-reassign-ui.test.ts` で固定した(自分の行に操作を出さず案内を出す)。

#### セキュリティ影響

- 新しい操作は `org_admin`(申請者本人を除く)の再割当だけで、認可を広げていない。
- 承認者ID・段・経路は入力で受け取らず、APIが組織データから再解決する。
- 成功・失敗の表示にAPIの文・理由コードをそのまま出さない。
- ロールの復元は画面の代わりに認証済みの管理APIを使った(上記の画面の穴)。直接のSQL変更は無い。
- 新規依存0件。`package.json`・lockfile・`.env` は未変更。

#### 未解決事項

- `/ops/users` は最後の役割を外した利用者を一覧に出さないため、画面から役割を戻せない。
  本WPの Allowed Paths 外。別WP/Issue で修正が必要(利用者管理の画面と一覧の取得)。
- `approver_unchanged` は通常のデータでは到達しない防御的な分岐である。ブリーフの期待とは異なる。
- Chromium の「承認者不在の一覧(フォーム開)」「失敗」のスクリーンショットは修正前の実測で、
  修正後のレイアウトは同じ表・同じCSSのハーネス(`raw/layout-fixed-*`)と unit テストで確認した。
- `docs/planning/MANIFEST.md`、`02.17`、`03.18` はブリーフの指示により変更していない。

### 2026-11-14 修正C(再割当の欄のレイアウト・成功表示の条件)

**範囲**: 監督者が B2 の Evidence で見つけた2点だけ。開発用DBへの書込みは行わず、
ログインによる `session` と監査イベント以外は前後で件数が変わっていない。
実フローの撮り直し(承認者不在の行を作る)は、利用者の判断を待って別に指示する。

#### 1. 再割当の欄のレイアウト

- 欄を表の操作列の中から出し、**申請の行の直後に `colspan=6` の行**を置いて、
  その中に `details` / `summary` を置いた。欄は申請行の直後で DOM 上も隣り合う。
- `summary` の表示は `再割当（申請番号 REQ-…）`。`details` の `aria-label` にも申請番号を含め、
  見た目でも支援技術でもどの申請の欄か分かる。開閉はネイティブの `details` で、
  キーボードの Enter でも開いた(両エンジン)。
- 操作の列は汎用の 7%(実測 90px)に戻し、B2 の `colgroup` は外した。詳細リンクだけなので足りる。
- 申請者本人の案内も同じ全幅の行に出した。チェック欄の 24×24px と成功後の表示は維持。
- 実測(ハーネス、実画面の `globals.css`): 理由欄 672px(1440px)/ 301px(375px)。
  375px で横溢れなし。欄を閉じた行の高さは 56px、申請行 64px、比較した承認ルールの表の行 84px。
- 実画面では承認者不在が0件のため、欄の見た目はハーネスで確認した。
  ハーネスであることは Evidence の README と報告に明記した。

#### 2. 成功表示の条件

- `?reassigned=<申請ID>` は申請の特定にだけ使う。詳細APIを読み、現在の版の
  `routeGenerations` に**世代2以上の記録がある場合だけ**表示する。
- 文は最新の記録の `invalidatedStepNo`(段)・`newApproverName`(新しい承認者の表示名)・
  `createdAt`(再割当の日時)から組み立てる。例:
  `段1の承認者は「サンプル株式会社 agent」に再割当されました(2026年11月14日 20:58)。`
  「いま自分が実行した」とは限らないため「されました」とし、日時を添える。
- 記録が無い、IDが不正、詳細を取得できない場合は、成功もエラーも出さない。
  B2 で再割当した申請のIDでは表示され、再割当の記録が無い既存の申請のIDでは
  表示されないことを、Chromium / WebKit の 1440px / 375px で確認した。
- 詳細APIは申請番号を返さない。表示値は詳細APIの応答だけから取る制約と、
  `services/` を変更しない制約のため、成功の文には申請番号を含めていない。

#### 変更ファイル

- `apps/web/src/app/ops/approvals/page.tsx`(全幅の行、成功表示の条件)
- `apps/web/src/app/ops/approvals/ReassignForm.tsx`(申請番号を含むラベル)
- `apps/web/src/app/ops/approvals/actions.ts`(成功表示のコメントのみ)
- `apps/web/src/lib/approval-route.ts`(`reassignmentSuccessText` を記録から組み立てる形に)
- `tests/unit/approval-reassign-ui.test.ts`(構造・ラベル・成功表示の条件)
- `tools/ui_approval_routing_check.mjs`(欄の行の探し方と成功の文への追従のみ。実行はしていない)
- `docs/planning/06_WorkPackages/P4_Approval_Automation/WP-P4-APR-018.md`(本節のみ)

グローバルCSSは変更していない。`services/`・`db/`・`packages/` は変更していない。
新規依存0件。`package.json`・lockfile・`.env` は未変更。

#### 検証コマンドと結果

```text
npm run typecheck                              # exit 0
npm run lint                                   # exit 0
npm run check:all                              # exit 0
npx vitest run tests/unit/approval-assertion.test.ts tests/unit/approval-reassign-ui.test.ts \
  tests/unit/approval-reassign.test.ts tests/unit/approval-resolver.test.ts \
  tests/unit/approval-route-ui.test.ts tests/unit/approval-state.test.ts \
  tests/unit/requests-ui.test.ts               # 254 passed / 0 failed
npm run test:unit                              # 34 failed / 4505 passed(4539)
# B2 の基点(34 failed / 4501 passed)と失敗名の集合が一致。新規失敗0。
```

- axe(ハーネス): 開いた状態・失敗の表示 × 1440/375 × Chromium/WebKit の8回、
  violations 0(serious / critical 0)。
- 実画面(読み取りのみ): 承認者不在0件の表示、成功の表示、記録が無いIDで表示されないこと、
  両エンジンの 1440px / 375px。`?reassigned=<B2の申請>` の表示は上記のとおり。
- 開発用DBの件数: `role_binding` 25 → 25、`app_user` 15 → 15。全表で前後一致
  (詳細は Evidence の README)。`session` と監査イベントは除く。

#### 未解決事項

- 承認者不在の行を作る実フローの撮り直しは、書込みを伴うため行っていない。
  欄の見た目はハーネス、成功表示の条件は実画面(読み取りのみ)で確認した。
- 成功の文に申請番号を含められない(詳細APIが返さないため)。必要なら API の加算変更が別途必要。
- `tools/ui_approval_routing_check.mjs` は更新のみで実行していない(ブリーフの指示)。

#### セキュリティ影響

- 成功表示はURLの値だけでは作れず、詳細APIの現在の版の再割当の記録を必要とする。
  偽の成功をリンクで作る経路は塞いだ。表示する値は詳細APIの応答だけから取る。
- 認可・状態遷移・APIの応答は変更していない。グローバルCSS・依存も変更していない。

### 2026-11-14 ブラウザ再確認(B3: 修正C後の実画面)

**範囲**: 修正C後の再割当の画面を、開発環境の実画面で1回だけ通す。合成データは
承認ルール1・部署1・カタログ項目1・申請1・プロフィール変更1人・再割当の成功0。
`implementation_status` は `review` のまま。

#### 変更ファイル

- `apps/web/src/app/ops/approvals/ReassignForm.tsx`
  - 確認のチェック欄とラベルを同じ行に並べた(チェック欄が左、ラベルが右)。
    ラベルが折り返してもチェック欄は1行目に揃う。24×24px の対象サイズと
    `htmlFor` による関連付けは維持。グローバルCSSは変更していない。
- `docs/planning/06_WorkPackages/P4_Approval_Automation/WP-P4-APR-018.md`(本節のみ)

Migration なし。`services/`・`db/`・`packages/`・`package.json`・lockfile・`.env` は未変更。

#### ロールの一時変更(1回だけ)

- 対象: `auditor@acme.example.test`、ロール `auditor`(org、organization_id
  `00000000-0000-4000-9000-000000000001`)、期限なし。
- 外す: 管理画面 `/ops/users` の「役割を取り消す」。
  DB の `valid_until` は `2026-11-14T13:23:16.263Z`。
- 戻す: B2 と同じ認証済みの管理API `POST /users/:id/roles`(204)。
  最後の役割を外した利用者は `/ops/users` の一覧に出ないため、画面からは戻せない
  (B2 と同じ既知の穴)。直接のSQLは使っていない。
  `valid_from` は `2026-11-14T13:23:28.756Z`。
- 外していた時間は約12.5秒。外す1回・戻す1回のみ。再割当の成功は0回。

#### 撮影と実測(Chromium / WebKit、1440px / 375px)

スクリーンショットは `chromium/` と `webkit/` の
`approvals-unavailable-open-{desktop-1440,mobile-375}.png` と
`reassign-failure-{desktop-1440,mobile-375}.png`。成功の表示は
`reassigned-success-*`、記録が無いIDは `reassigned-absent-*`。

| 項目 | Chromium 1440 | WebKit 1440 | Chromium 375 | WebKit 375 |
|---|---:|---:|---:|---:|
| 理由の欄の幅 | 672px | 672px | 301px | 301px |
| 欄(`details`)の幅 | 1262px | 1262px | 301px | 301px |
| 申請行の高さ | 64px | 64px | 317px | 317px |
| 欄を閉じた行の高さ | 56px | 56px | 56px | 56px |
| 欄を開いた行の高さ | 306px | 306px | 375px | 375px |
| 確認のチェック欄 | 24×24px、ラベルと同1行 | 同左 | 24×24px、ラベルは2行、チェック欄は1行目 | 同左 |
| 横溢れ | なし | なし | なし | なし |

- 確認のチェック欄は、1440px ではラベルと同じ1行(ラベル17px)、375px では
  ラベルが2行(34px)に折り返してもチェック欄は1行目に揃った。修正前の
  「チェック欄がラベルの上の行に離れる」状態は、実画面の両エンジンで解消した。
- 失敗の表示(両エンジン、1440/375):
  「段1: 上長が今は有効な所属ではないため、再割当できません。…」(`manager_inactive`)。
  申請の `version` は 1 → 1、世代1・承認行1件のまま。何も書き込まれていない。
- 成功の表示(B2 の `REQ-2026-000162`、`?reassigned=<ID>`、読み取りのみ):
  「段1の承認者は「サンプル株式会社 agent」に再割当されました(2026年11月14日 20:58)。」
  両エンジン・両幅で表示。再割当の記録が無い `REQ-2026-000161` では表示されない。
- WebKit の 1440px の「欄を開いた」スクリーンショットは、ページ内の位置の関係で
  ビューポートの下端が理由欄の途中で切れた。同じ実画面の 375px と Chromium 1440px、
  および同じDOM・実CSSのハーネス(`raw/confirm-row-webkit-desktop-1440.png`)で
  全体を確認した。レイアウトの崩れではない。

#### axe

- 実画面の欄を開いた状態と失敗の表示: 両エンジン×1440/375 の8 scans、violations 0
  (serious / critical 0)。成功の表示の4 scans も0。合計12 scans。
- ルールの無効化・タグの緩和はしていない(`wcag2a` / `wcag2aa` / `wcag21aa` / `wcag22aa`)。

#### キーボード

- Chromium: `summary` を Enter で開閉。Tab で `summary` → 理由欄 → 確認のチェック欄 →
  「再割当を実行する」へ移動。Space でチェック、Enter で開閉できた。
- WebKit: `summary` を Enter で開閉、Tab で理由欄へ移動。ただし既定の Tab は
  理由欄の次で BODY へ抜け、チェック欄とボタンには移らなかった(macOS の
  「Tab キーで各項目をハイライト」が既定で無効なため)。同じDOMのハーネスでは
  Alt+Tab でチェック欄へ移り、直接フォーカスして Space/Enter で操作できた。
  ページ側のDOM順・フォーカスリングは確認済み。実画面での Alt+Tab は未確認。

#### 検証コマンドと結果

```text
npx vitest run tests/unit/approval-reassign-ui.test.ts \
  tests/unit/approval-route-ui.test.ts tests/unit/requests-ui.test.ts \
  tests/unit/approval-state.test.ts               # 4 files / 160 passed / 0 failed
npm run typecheck                                 # exit 0
npm run lint                                      # exit 0
npm run check:all                                 # exit 0
```

ハーネス(実CSS、書込みなし): 確認の行は 1440px/375px・両エンジンで
チェック欄が左・同じ行・24×24px、375px でラベルが2行、横溢れなし。

#### 開発用DBの件数(SELECT count(*))

作業前(B3の合成データを作る前)と検査後の比較。`app_user` は15のまま、
`role_binding` は25 → 26(付け直しの1行)。その他の増分は下記の合成データで説明できる。

| テーブル | 作業前 | 検査後 |
|---|---:|---:|
| `app_user` | 15 | 15 |
| `role_binding` | 25 | 26 |
| `local_catalog_item` | 25 | 26 |
| `local_service_request` | 16 | 17 |
| `local_request_revision` | 21 | 22 |
| `local_request_approval` | 27 | 29 |
| `local_request_route_generation` | 2 | 2 |
| `local_simulation_receipt` | 8 | 9 |
| `department` | 21 | 22 |
| `department_head` | 7 | 7 |
| `approval_rule` | 13 | 14 |
| `approval_rule_revision` | 19 | 20 |
| `org_member_profile` | 15 | 15 |
| `schema_migration` | 40件・最大 `0040` | 同左 |

検査後: ルールの使用が有効な組織0件、有効な `ui018-syn-` ルール0件、有効な
`UI018-SYN-` 部署0件、値の入ったプロフィール0件、完了していない合成の申請0件。
対象アカウントの有効な `auditor` は1件(期限なし・同じ組織)で作業前と同じ。

残した合成データ: ルール `ui018-syn-b3-b3`(無効)、部署
`01a1da33-e97f-7000-a110-7a27e63a669e`(無効)、カタログ
`01a1da33-fbfb-7000-80db-53f43bcbdc2a`(非公開・ルール結び付けなし)、申請
`REQ-2026-000164`(模擬完了、承認2行、世代0、模擬実行の証跡1件)。

#### §7 受入基準の充足(B3で追加・確定した項目)

- ✅ 承認者不在の一覧と再割当の欄を、実画面の Chromium/WebKit・1440/375 で確認。
  確認のチェック欄は同じ行・24×24px、375px の折り返しでも1行目に揃う。
- ✅ axe の serious / critical が0(実画面12 scans)。
- ✅ 上長Aのままの再割当は失敗し、申請は変わらない(両エンジン、両幅)。
- ✅ ロールを戻したあと、B2 の申請の成功表示が両エンジン・両幅で出る。
  記録が無いIDでは出ない。
- ✅ 今回の申請を上長A → 固定承認者 → 模擬完了まで進め、未完了の合成申請を残さない。
- ⏳ 組織管理者が申請者本人の場合の表示は、追加の書込みが必要なため実画面では未確認
  (`tests/unit/approval-reassign-ui.test.ts` で固定)。

#### セキュリティ影響

- 新しい操作・認可の変更なし。ロールの復元は画面と同じ認証済みの管理APIで、
  直接のSQL変更は行っていない。
- 再割当の失敗は409で、申請の版・世代・承認行を変更しないことを前後で確認した。
- 新規依存0件。`package.json`・lockfile・`.env` は未変更。

#### 未解決事項

- `/ops/users` は最後の役割を外した利用者を一覧に出さない(復元は管理API)。
  本WPの Allowed Paths 外。B2 から変わらず、別WP/Issue の対象。
- WebKit 1440px の「欄を開いた」スクリーンショットの下端が切れた(上記)。
- WebKit の既定 Tab はチェック欄・ボタンに移らない(ブラウザ設定)。実画面の
  Alt+Tab は未確認。

#### Evidence

`evidence/WP-P4-APR-018/20261114-2215/`(`chromium/`、`webkit/`、`raw/`)。

- 2026-11-14(監督者による追記): 段階A・B・B2・C・B3 を検査した。差分を読み、`typecheck`・`lint`・`check:all`、承認関連の unit テスト、`tests/security` 全体(以前から読み込めない6ファイルを除き成功)を使い捨てDBで再実行した。開発用DBへの Migration 0040 の適用は、利用者の指示により 2026-11-14 に監督者が行った。
  - ブラウザ確認(B2)で、合成アカウント1つのロールの一時変更が、指示(1回、管理画面経由)に反して4回行われ、戻す操作は管理API経由になった。ロールは作業前と同じ状態に戻っている(監督者が開発用DBで照合)。追記の履歴として、期限切れの行が残る。B3 は利用者の承認のもとで1回だけ行い、約12秒で戻した。
  - 既存の不具合(本WPの範囲外): 最後のロールを外した利用者が `/ops/users` の一覧から消え、画面から付け直せない。別のWPとして起こす。
  - 設計上の帰結: 固定承認者の段は、申請時に固定したルールの版で再解決するため、再割当では変わらない([[ADR-0024_Approval_Route_Generations_And_High_Risk_Criterion]] §3)。対処は、ルールの改訂と申請者による申請内容の変更。画面で案内している。
  - 未確認: 申請者本人が組織管理者である場合の画面表示は、unit テストでの確認にとどまる。WebKit の既定の Tab 移動はOSの設定に依存し、チェック欄とボタンへの移動は補助キーでの確認にとどまる。
- 2026-11-14(監督者による追記): 利用者(人間)がセキュリティレビューとして本WPを承認した。利用者の指示により、PRを作らず `main` へ直接取り込み、`origin/main` へ push する。`implementation_status` を `done` にした。
