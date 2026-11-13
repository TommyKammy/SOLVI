---
project: SOLVI
doc_id: "WP-P4-APR-014"
title: "承認の経路・ステップのスキーマ、状態機械、監査イベントのapproval.*移行"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.2.0"
created: "2026-11-12"
updated: "2026-11-13"
owner: "SOLVI Product Team"
tags: ["workpackage", "p4", "approval", "state-machine", "audit"]
source_of_truth: true
implementation_status: "review"
story_points: 8
risk: "high"
workstream: "APR"
phase: "P4"
requirement_ids: ["FR-CAT-004", "FR-CAT-005", "FR-CAT-008", "FR-CAT-009", "FR-CAT-011", "FR-CAT-013", "FR-CAT-015"]
depends_on: ["WP-P4-APR-011"]
---

# WP-P4-APR-014: 承認の経路・ステップのスキーマ、状態機械、監査イベントのapproval.*移行

| 項目 | 値 |
|---|---|
| Phase | P4 |
| Workstream | APR |
| Risk | high |
| Story Points | 8 |
| Suggested Owner | Backend + Security Reviewer |
| Parallelizable | WP-P4-IDM-013と並行可 |
| Gate | Gate B(GB-3) |

## 1. Purpose

承認を「申請の版に1行」から「版ごとに固定された経路と直列のステップ」へ拡張する。本WPは経路とステップの**器**(スキーマ・状態機械・全ステップの無効化・期限・監査イベント名)を作り、承認者の決め方(ルール・リゾルバ)は[[WP-P4-APR-015]]が担う。ルール未設定の既存項目は現行どおり1段で動く(`authority_type='legacy'`)。[[WP-P4-APR-011]]の `assertApprovalComplete` を多段向けに拡張する(ステップ数と行数、`route_hash`、`route_generation`)。

## 2. Requirement IDs

`FR-CAT-004`, `FR-CAT-005`, `FR-CAT-008`, `FR-CAT-009`, `FR-CAT-011`, `FR-CAT-013`, `FR-CAT-015`

## 3. Dependencies

[[WP-P4-APR-011]](done)。ADR-0023 は `accepted`。2026-11-13 に監督者が §6.1 の確定事項を加えて `baseline` に実体化した。

## 4. Scope / Allowed Paths

- `db/migrations/`
- `services/api/src/modules/catalog/catalog.routes.ts`
- `services/api/src/modules/catalog/approval-assertion.ts`
- `services/api/src/modules/catalog/approval-state.ts`
- `services/api/src/modules/catalog/snapshot-hash.ts`
- `services/api/src/common/audit/audit.ts`
- `tests/unit/approval-state.test.ts`
- `tests/security/approval-steps.test.ts`
- `tests/security/approval-migration-compat.test.ts`
- `tests/security/approval-assertion.test.ts`(多段への追従と、「DBに既存の申請がある」前提の除去。2026-11-13 監督者が追加)
- `tests/unit/approval-assertion.test.ts`(多段への追従。2026-11-13 監督者が追加)
- `tests/unit/catalog-flexible.test.ts`(偽DBを新しい列・問い合わせへ追従させる変更だけ。期待値の緩和は不可。2026-11-13 監督者が追加)
- `tests/unit/catalog-operations.test.ts`(同上)
- `tests/security/department-profile.test.ts`(Migration `0037` の down を検証するテストが「最後のMigrationは0037」を前提にしている箇所だけを、後続のMigrationがあっても成り立つ形へ直す。検証内容の緩和は不可。2026-11-13 監督者が追加)
- `services/api/src/modules/inbox/inbox.routes.ts`(承認待ちの抽出が多段で誤らないための最小限の変更だけ。不要なら変更しない。2026-11-13 監督者が追加)
- `docs/planning/06_WorkPackages/P4_Approval_Automation/WP-P4-APR-014.md`
- `evidence/WP-P4-APR-014/`

## 5. Out of Scope

- 承認ルール・リゾルバ・関係ベースの権限・プレビュー・再割当・一覧の可視性([[WP-P4-APR-015]])。本WPのステップ種別は `legacy` / `fixed` のみ生成する(`manager` / `department_head` は列の許容値として用意するが、生成しない)。
- UI([[WP-P4-APR-016]])。代理承認・高リスク二重承認・並列/定足数/グループ承認・リマインド/エスカレーション([[WP-P4-APR-017]])。Executor接続([[WP-P4-EXEC-004]])。
- 営業日カレンダー(期限は72時間の暫定値。[[ADR-0023_Relationship_Based_Approval_Authority]] §8)。

## 6. Deliverables

1. Migration(着手時点の最新番号+1): [[ADR-0023_Relationship_Based_Approval_Authority]] §11 の加算的な列追加。`local_request_revision` に `route jsonb NULL` / `route_hash text NULL` / `route_generation integer NOT NULL DEFAULT 1`。`local_request_approval` に `step_no integer NOT NULL DEFAULT 1` / `route_generation integer NOT NULL DEFAULT 1` / `authority_type text NOT NULL DEFAULT 'legacy'`(`CHECK IN ('legacy','fixed','manager','department_head')`)/ `resolved_from text NULL` / `decided_by uuid NULL`、`UNIQUE(request_id, organization_id, revision, route_generation, step_no)`。既存行は `step_no=1, authority_type='legacy'`、`route` は NULL のまま(再解決しない)。downはデータがあれば拒否する。
2. 状態機械(`approval-state.ts`): 03.5 の承認状態機械を遷移表として定義し、文字列の直接更新を禁止する。遷移: 途中ステップ承認→当該 `approved` + 次ステップを `pending` で作成(申請は `pending` のまま)/ 最終ステップ承認→申請 `approved` / いずれかの却下→申請 `rejected` / 申請内容の変更→その版の**全ステップ** `invalidated` + 新版で `pending` / 承認取消→**全ステップ** `invalidated`・申請 `invalidated` / 期限切れ→当該 `expired`(申請の `expired` は導出。`local_service_request.state` のCHECKは変更しない)。未定義遷移はAPIで拒否する。
3. 期限: ステップごとに、そのステップが `pending` になった時点から72時間。後続ステップの行は前のステップが承認された時点で作る。`current_approval_id` は現在 `pending` のステップ、全承認後は最終ステップを指す。
4. 冪等リプレイ・一覧・詳細・取消・変更の各処理を「現在の1行」前提から「その版・現在の `route_generation` の全ステップ」前提へ改修する(現行の `catalog.routes.ts` の `decide`、`create` の冪等リプレイ(revision=1の承認行1行を前提に `approverId` を比較している箇所)、変更、`list`、`detail`)。
5. `assertApprovalComplete` の拡張: 現在の版・現在の `route_generation` のステップがすべて `approved`、`route` のステップ数と行数の一致、`route_hash` が `route` の再計算値と一致(`route` がある場合)。
6. 監査イベントの `request.*` → `approval.*` 移行([[02.17_Audit_Event_Catalog]] §2.1 の対応表に従う)。`AUDIT_EVENT_TYPES` へ追加し、既存行は書き換えない。

### 6.1 実体化で確定した事項(2026-11-13 監督者)

- **経路の形**: `local_request_revision.route` は `{ "steps": [{ "stepNo": 1, "approverId": "<uuid>", "authorityType": "legacy|fixed|manager|department_head", "resolvedFrom": "<text|null>" }], "ruleRef": null }`。`ruleRef` は[[WP-P4-APR-015]]が `{ "ruleId", "revision" }` を入れる。`route_hash` は `snapshot-hash.ts` の `hash(route)`(sha256、64桁)で算出する。
- **新規の版には必ず経路を保存する**: 本WP以降に作られる版(新規申請・申請内容の変更)は、1段の経路を保存する。定義に固定承認者があれば `authorityType='fixed'`、申請者が選んだ承認者なら `'legacy'`。Migration 以前の行だけが `route IS NULL` で、その場合は従来の1行の検証を行う。
- **経路を決める箇所を1つにする**: 申請・変更時に経路を決める処理を1つの関数にまとめる(本WPでは常に1段を返す)。[[WP-P4-APR-015]]はこの関数を差し替える。2段以上の経路は本WPの製品コードからは生成されないが、状態機械・検証・監査は `route` の段数に従って動く(テストは、版の `route` に2段を持つ申請をDBへ直接用意して、製品コードの決定処理で2段目が作られることを確かめる)。
- **次のステップの作成**: 前のステップの承認と同一トランザクションで、`route` の次の段から行を作る。作成時に承認者が無効でも行は作る(自動では差し替えない。決定は拒否される。ADR-0023 §6)。申請行のロック(既存の `FOR UPDATE`)の内側で行い、同時の決定で2段目が二重に作られないこと。
- **監査イベントの対応(02.17 §2.1 の `要確認` を確定)**:
  - 申請内容の変更: `request.changed` を維持し、無効化したステップごとに `approval.invalidated`(原因 `request_changed`)、新版の最初のステップに `approval.requested` を記録する。
  - 承認取消: 無効化したステップごとに `approval.invalidated`(原因 `revoked`)。`request.revoked` は書かない。
  - `approval.cancelled` は申請の取下げ用に予約し、本WPでは書かない(現行に取下げ操作が無い)。
  - `approval.expired` は本WPでは書かない(期限切れは導出のまま。記録は期限処理を持つ[[WP-P4-APR-017]])。
  - `request.submitted` / `request.simulated` / `request.checklist.updated` は維持する。
  - 各 `approval.*` イベントは `afterState` に、版・`route_generation`・`stepNo`・段数・`authorityType` を含める。申請の入力値・スナップショット本文は載せない。
- **APIの応答は加算的に変える**: `detail` の `approval`(現在のステップ)と `history` は形を保ち、`steps`(現在の版・現在の `route_generation` の全ステップ)を追加する。`list` の項目の意味は「現在のステップ」とする。Web(`apps/web/`)は本WPで変更しない([[WP-P4-APR-016]])。既存の画面が壊れないこと。
- **決定者の記録**: 決定時に `decided_by` へ決定者を記録する(本WPでは常に `approver_id` と同じ。代理は[[WP-P4-APR-017]])。
- **一意制約**: `UNIQUE(request_id, organization_id, revision, route_generation, step_no)` は、既存データに重複があれば Migration を失敗させる(黙って直さない)。
- **承認取消・却下・期限切れの申請は、内容の変更で再申請できる(現行の挙動を維持)**: 申請者による内容の変更は、申請が `pending` / `approved` / `rejected` / `invalidated` のいずれでも新しい版を作り、新しい承認を生成する(03.5 の「再申請として新しいApprovalを生成する」は、この新しい版の承認を指す)。拒否するのは `completed` と `cancelled` だけ。既存の画面は取消済み・却下済みの申請に「理由を確認して修正・再申請する」を案内している。2026-11-13 監督者の検査で確定。
- **011のテストの不備を直す**: `tests/security/approval-assertion.test.ts` の「DBに既存の申請がある」ことを前提にしたテストを、テスト内で必要なデータを作る形へ直す(空のDBでも通ること)。

## 7. Acceptance Criteria

- [ ] 03.5 の状態機械の全遷移が遷移表(`approval-state.ts`)として定義され、表と1:1の単体テスト(TL-02)がある。未定義の遷移(例: `approved` のステップを再度 `approved`、`rejected` 後の承認)がAPIで409になる。
- [ ] 2段(テストでは `fixed` 2段をDB直接またはテスト用の経路で構成)の申請で、1段目のみ承認された状態では `assertApprovalComplete` が失敗し、作業チェック更新・模擬完了が実行できない。2段とも承認すると成功する。
- [ ] 申請内容の変更で、その版の全ステップ(承認済み・`pending` の両方)が `invalidated` になり、新版で `pending` になる。承認取消で全ステップが `invalidated`、申請が `invalidated` になり、以降の実行が拒否される。
- [ ] ステップの期限が、そのステップが `pending` になった時点から72時間である(2段目は1段目の承認時刻から起算する)。期限切れのステップでは決定も実行も拒否される。
- [ ] 既存の全行が `step_no=1, authority_type='legacy'` でバックフィルされ、既存申請の表示・決定・作業チェック更新・模擬完了が壊れない(Migration適用前後の同一データで比較する互換テスト)。既存申請は再解決されない。
- [ ] 冪等リプレイ: 同じキー・同じ内容は再生され、異なる内容は409。経路があるときは `route_hash` で同一性を判定する。
- [ ] 新規の承認イベントが `approval.*` で記録され、同一トランザクションで書かれる。既存の `request.*` 行は変更されない。読み手(監査の閲覧・エクスポート)は新旧の両方を扱える。
- [ ] `route_hash` を改ざんした行、ステップ数と行数が一致しない版、旧 `route_generation` のステップでの決定が、すべて拒否される。
- [ ] downは新しい列にデータ(`route` が非NULL等)があれば拒否される。`check:all`・型・lint・既存テストが通り、新規依存が0件である。

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-02(状態機械の全遷移と1:1、不正遷移の網羅拒否)、TL-04、TL-05(Migration互換)、TL-06、TL-16(承認バイパス)

### Evidence

- 状態機械テストの網羅結果、Migration前後の互換テストの結果、監査イベントのサンプル(新旧)

`evidence/WP-P4-APR-014/<YYYYMMDD-HHMM>/` へ保存する([[06.2_Evidence_Index]])。

## 9. Security and Audit

- Gate B GB-3の対象。**Security Reviewer(人間)のレビュー必須**。承認レコードの削除経路を作らない(状態遷移としてのみ変更)。
- 生成する監査イベント: `approval.requested|approved|rejected|invalidated|cancelled|expired`(対応表は02.17)。脅威 [[02.14_Threat_Model]] T-08。
- 多段化の窓: [[WP-P4-APR-011]]が先に完了していること(フラグを戻しても旧コードが「現在の1行」で承認済みと判定しない)。

## 10. Rollback / 失敗時の扱い

加算的な列追加のため、新コードを戻しても既存行は `legacy` の1段として読める(`assertApprovalComplete` は全ステップを要求し続ける)。downはデータがあれば拒否し、前進修復(互換readerを維持し、多段の生成を止める)とする。`request.*` から `approval.*` への移行は、既存の監査行を書き換えないため、コードのrevertで戻せる(戻した後に記録された `approval.*` 行は残る)。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Packageのみを実装してください(baselineに実体化された後のみ)。

正本: AGENTS.md / 本WP / ADR-0023(§6・§8・§11) / 03.5(承認状態機械) / 02.17(§2.1の対応表) / 02.16 §3 /
services/api/src/modules/catalog/catalog.routes.ts / WP-P4-APR-011 の approval-assertion.ts。

手順:
1. WP-P4-APR-011 が完了していること、ADR-0023 が accepted であることを確認する。満たなければ実装せず報告する。
2. 遷移表を先に書き、遷移表と1:1の単体テストを作る。
3. Migration(加算的な列、legacyバックフィル、down拒否)を書き、既存データでの互換テストを作る。
4. decide・create(冪等リプレイ)・変更・取消・list・detail を全ステップ前提に改修する。
5. assertApprovalComplete を拡張する。監査イベントを approval.* へ移行する。

やってはいけないこと:
- 承認ルール・リゾルバ・関係ベース権限の先取り(WP-P4-APR-015)。manager/department_head のステップを生成すること。
- 「現在の1行」だけを見る判定を1箇所でも残すこと。承認行の削除経路。
- 既存の監査行・既存申請の書き換え。既存申請の再解決。環境変数のフラグでの切替。
- テストのskip・削除、新規依存、Allowed Paths外の変更。
完了時に報告: 変更ファイル、Migrationと rollback、検証コマンドと結果、受入基準ごとの充足、セキュリティ影響、未解決事項、Evidence。
```

## 12. Definition of Done

- [ ] §7をすべて満たす / §8のテスト通過とEvidence保存
- [ ] Migration(up/down)とロールバック方針、既存データ互換の説明
- [ ] 関連ドキュメント(02.17・RTMのStatus)の更新
- [ ] 未解決のCritical/Highがない
- [ ] Security Reviewer(人間)のsign-off
- [ ] Execution Logへ追記

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-11-13 | Codex (WP-P4-APR-014) | 作業ツリー(未コミット) | Implemented / review requested | `evidence/WP-P4-APR-014/20261113-0946/` | Migration 0038、`approval-state.ts`、`assertApprovalComplete` の多段拡張、`approval.*` 監査への移行。受入基準の充足は下記。 |
| 2026-11-13 | Codex (WP-P4-APR-014 R2) | 作業ツリー(未コミット) | R2 fixed / review requested | `evidence/WP-P4-APR-014/20261113-1006/` | 検査指摘3点の修正: 取消後の変更の復帰、`department-profile` の0037 down追従、`decide` の `state`/`stepState`。下記R2メモ。 |

### 2026-11-13 実装メモ

- 変更ファイル: `db/migrations/0038_approval_route_and_steps.sql`(新規)、`services/api/src/modules/catalog/approval-state.ts`(新規)、`catalog.routes.ts`、`approval-assertion.ts`、`common/audit/audit.ts`、`tests/unit/approval-state.test.ts`(新規)、`tests/unit/approval-assertion.test.ts`、`tests/unit/catalog-flexible.test.ts`、`tests/unit/catalog-operations.test.ts`、`tests/security/approval-steps.test.ts`(新規)、`tests/security/approval-migration-compat.test.ts`(新規)、`tests/security/approval-assertion.test.ts`、本WP。
- Migration: `local_request_revision` に `route` / `route_hash` / `route_generation`、`local_request_approval` に `step_no` / `route_generation` / `authority_type` / `resolved_from` / `decided_by` を加算。既存行は `step_no=1, authority_type='legacy', route_generation=1`、既存版の `route` は NULL のまま(再解決しない)。`UNIQUE(request_id, organization_id, revision, route_generation, step_no)`。down は新しい列にデータがあれば拒否(前進修復)。
- ロールバック: 0038 の down は `route IS NOT NULL`、`step_no<>1`、`authority_type<>'legacy'`、`resolved_from`/`decided_by` 非NULL のいずれかで拒否する。データが無ければ down 可能で、旧コードは legacy 1段として読める。
- 状態機械: `approval-state.ts` の `APPROVAL_TRANSITIONS` が 03.5 の多段の読み方と1:1。遷移の検証と承認行・申請行の更新は同ファイルの関数だけが行う。未定義遷移は 409。
- 検証: `tests/unit` の変更前後比較で新規失敗0(既存34失敗は不変)。`tests/security` は既知の読み込み不能6ファイルを除き、`department-profile.test.ts` の「最後のMigration=0037」前提1件を除いて失敗0。詳細は `.local/briefs/WP-P4-APR-014.report.md`。
- 未解決: `tests/security/department-profile.test.ts:1095` は `migrate down` が最後のMigrationを戻す前提で、0038 を最後に追加したため1件失敗する(Allowed Paths外のため未修正。`down --to 0036` 相当への追従が必要)。`03.18` の Status 3行更新は指示により未実施(`node tools/check_traceability.mjs --write` が必要)。(R2 で `down --to 0037` により解消。`03.18` は監督者が更新済み。)
- セキュリティ影響: 承認の判定を全ステップ・経路世代・route_hash に拡張し、実行前検証を fail closed にした。決定時の認可(approver ロール、approver_id 一致、自己承認拒否)は緩めていない。承認行の DELETE 経路は追加していない。監査は業務と同一トランザクションで `approval.*` を記録し、既存 `request.*` 行は変更しない。

### 2026-11-13 R2 修正メモ(検査指摘への対応)

- 変更ファイル: `services/api/src/modules/catalog/approval-state.ts`(遷移表に `edit: approved/rejected` と `edit: invalidated/invalidated` を追加。既に `invalidated` のステップは UPDATE も `approval.invalidated` も重ねない)、`catalog.routes.ts`(`edit` の拒否を `completed` / `cancelled` だけに戻す。`decide` は `state`=申請の状態、`stepState`=ステップの状態を返す)、`tests/unit/approval-state.test.ts`、`tests/security/approval-steps.test.ts`、`tests/security/approval-migration-compat.test.ts`(応答の追従)、`tests/security/department-profile.test.ts`(`down --to 0037` で後続 Migration を先に巻き戻してから 0037 の down を検証し、最後に必ず up へ戻す)、本WP、`evidence/WP-P4-APR-014/20261113-1006/`。
- Migration: 変更なし(0038 のまま。R2 ではスキーマを変えない)。
- 検証: `npm run test:unit` 34 failed / 4368 passed(4402)。失敗テスト名は前回の基点と差分なし(新規失敗0)。`vitest run tests/security` は既知の読み込み不能6ファイル以外 0 failed(687 passed / 10 skipped)。対象8ファイルは 235 passed。`npm run check:all` 成功(exit 0)、`typecheck` / `lint` 成功。使い捨てDBで 0038 down → up を確認。開発用DBの件数は不変、`schema_migration` は37件・最大 `0037`。
- セキュリティ影響: 取消済みの申請の変更は新しい版・経路・最初のステップを作り、旧版のステップは `invalidated` のまま決定・実行の対象にならない。認可(approver ロール、approver_id 一致、自己承認拒否、有効な所属)・固定承認者の一致は変更していない。承認行の削除経路・環境変数による切替は追加していない。
- 詳細: `.local/briefs/WP-P4-APR-014-R2.report.md`、`evidence/WP-P4-APR-014/20261113-1006/README.md`。
