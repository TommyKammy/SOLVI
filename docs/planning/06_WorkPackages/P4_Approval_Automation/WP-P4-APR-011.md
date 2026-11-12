---
project: SOLVI
doc_id: "WP-P4-APR-011"
title: "全ステップ承認の実行前検証(assertApprovalComplete)の導入"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-11-12"
updated: "2026-11-12"
owner: "SOLVI Product Team"
tags: ["workpackage", "p4", "approval"]
source_of_truth: true
implementation_status: "done"
story_points: 5
risk: "high"
workstream: "APR"
phase: "P4"
requirement_ids: ["FR-CAT-004", "FR-CAT-007", "FR-CAT-008", "FR-CAT-015"]
depends_on: ["WP-P4-APR-010"]
---

# WP-P4-APR-011: 全ステップ承認の実行前検証(assertApprovalComplete)の導入

| 項目 | 値 |
|---|---|
| Phase | P4 |
| Workstream | APR |
| Risk | high |
| Story Points | 5 |
| Suggested Owner | Backend + Security Reviewer |
| Parallelizable | WP-P4-IDM-012と並行可(ファイルが重ならない)。WP-P4-APR-014より前に完了させる |
| Gate | Gate B(GB-3) |

## 1. Purpose

承認が実行(作業チェック更新・模擬完了)の唯一のゲートである以上、「承認済みか」の判定を1つの関数 `assertApprovalComplete` に集約する。現状は `approvalMatches`(snapshot_hash・revision・固定承認者の照合)と、模擬完了・決定処理のインライン検査が別々に書かれ、多段化(WP-P4-APR-014)で「現在の1行」だけを見る判定が残ると、一部承認の申請を承認済みと誤判定する。本WPは**スキーマを変えず**、現在の1段承認に適用できる検証項目だけで関数を導入し、既存の呼び出し箇所をすべて置き換える。挙動は「同じ判定をより厳密に」であり、唯一の挙動変更は [[ADR-0023_Relationship_Based_Approval_Authority]] §7(承認済みステップの承認者が後から無効になっても実行を止めない)である。WP-P4-APR-014 以降の多段検証(ステップ数と行数の一致、`route_hash`、`route_generation`)はこの関数の拡張として足す。

## 2. Requirement IDs

`FR-CAT-004`, `FR-CAT-007`, `FR-CAT-008`, `FR-CAT-015`

## 3. Dependencies

[[WP-P4-APR-010]](要求・設計基準とADR-0023)。**ADR-0023 §7(挙動変更)の実装は、ADR-0023が `accepted` になってから行う。** `accepted` 前は、§6の1〜3(関数の導入・呼び出し箇所の置き換え・厳密化)までを行い、`validateApprover` による実行時の承認者有効性検証は残す(監督者がstatusを切り替えた時点で §7 分を実施する)。

## 4. Scope / Allowed Paths

- `services/api/src/modules/catalog/catalog.routes.ts`
- `services/api/src/modules/catalog/approval-assertion.ts`
- `services/api/src/modules/catalog/snapshot-hash.ts`
- `tests/unit/approval-assertion.test.ts`
- `tests/security/approval-assertion.test.ts`
- `services/api/src/main.ts`(`CatalogController` へ logger を渡す1箇所だけ。2026-11-12 監督者が追加)
- `tests/unit/catalog-flexible.test.ts`
- `tests/unit/catalog-operations.test.ts`(上2件は偽DBが承認行の照会へ `decided_at` と `revision_hash_ok` を実DBと同じ形で返すための修正だけ。検証内容・期待値の緩和は不可。2026-11-12 監督者が追加。`check:paths` がファイル名のグロブを解決できないため、実在する2ファイルへ展開)
- `docs/planning/06_WorkPackages/P4_Approval_Automation/WP-P4-APR-011.md`
- `evidence/WP-P4-APR-011/`

## 5. Out of Scope

- スキーマ変更・Migration(`route` / `route_hash` / `route_generation` / `step_no` は [[WP-P4-APR-014]])。
- 多段・関係ベース承認・再割当・ルール・リゾルバ([[WP-P4-APR-014]] / [[WP-P4-APR-015]])。
- 監査イベント名の `request.*` → `approval.*` 移行([[WP-P4-APR-014]])。本WPのイベントは現行名のまま。
- `decide`(決定処理)の認可・状態遷移の変更。決定時点の `validateApprover` と固定承認者照合はそのまま残す。
- `canonical` / `hash` の `packages/shared` への移動(Executor接続時の [[WP-P4-EXEC-004]] で扱う。本WPはAPI内の別ファイルへの無変更の抽出に留める)。
- Executorとの接続([[WP-P4-EXEC-004]])。

## 6. Deliverables

1. `services/api/src/modules/catalog/snapshot-hash.ts`: `catalog.routes.ts` の `canonical` と `hash`(sha256)を**出力を変えずに**抽出する。既存の保存済みhashと一致することを固定ベクトルのテストで担保する。
2. `services/api/src/modules/catalog/approval-assertion.ts`: `checkApprovalComplete(client, {organizationId, requestId})` が `{ok:true, steps}` または `{ok:false, reason}` を返し、`assertApprovalComplete` がその失敗を `Problems.conflict` に変換する。検証項目は、現時点の1段承認に適用できる次の範囲([[ADR-0023_Relationship_Based_Approval_Authority]] §7、計画 §6.1):
   1. 申請が `approved`。
   2. 現在の版の承認行(`state<>'invalidated'`)がちょうど1行で、それが `current_approval_id` であり `approved`。同じ版に別の有効な行があれば失敗(多段化前の防御)。
   3. 期限内: 現行の挙動を維持して `expires_at > 現在時刻`、かつ `decided_at <= expires_at`。
   4. `snapshot_hash` が申請・版(`local_request_revision`)・承認行で一致し、`hash(snapshot)` の再計算値とも一致。`revision` が申請と承認行で一致。
   5. 定義に固定承認者 `approval.approverId` がある場合は承認行の `approver_id` と一致(現行の `approvalMatches` と同じ)。
   6. 申請者と承認者が同一でない。複数行になった場合は承認者同士が重複しない。
   7. **承認者の現在の有効性は要求しない**(ADR-0023 §7)。`fixed`/`legacy` も同じ。
3. 置き換え: `approvalMatches` の全呼び出し(`fulfillment` の `canUpdate` と `updateChecklist`)、および `simulate` のインライン検査(状態・期限・`validateApprover`・hash・固定承認者)を `assertApprovalComplete` / `checkApprovalComplete` に置き換え、`approvalMatches` を削除する。`fulfillment` の `canUpdate` は例外を投げず `checkApprovalComplete().ok` で判定する。`simulate` は既存のレシート返却(冪等リプレイ)を従来どおり検証より前に行う。
4. フィーチャーフラグ・環境変数に依存させない(全申請が必ずこの関数を通る)。
5. `validateApprover` の自己承認チェック(申請者≠承認者)は静的な非同一検査として関数側に移し、現在の有効な所属・`approver` ロールの再検査(実行時分)だけを外す(ADR-0023 `accepted` 後)。申請・変更時(`create` / 変更)と決定時(`decide`)の `validateApprover` 呼び出しは変更しない。

## 7. Acceptance Criteria

- [ ] `rtk proxy grep -rn "approvalMatches" services apps packages tests tools` が0件になる(置き換えの完了を静的に確認するテストが1件ある)。
- [ ] `fulfillment` の `canUpdate`・`updateChecklist`・`simulate` の3箇所すべてが `assertApprovalComplete` または `checkApprovalComplete` を通る(各箇所をスパイ/ログで確認するテストがある)。
- [ ] 既存の1段申請(固定承認者あり/なし)で、承認→作業チェック更新→模擬完了の成功経路の応答・状態・監査イベントが変更前と同一である(既存の `tests/unit/catalog-*.test.ts` と `tools/smoke_catalog_flow.mjs` 相当が変更なしで通る)。
- [ ] 次の各条件で `assertApprovalComplete` が拒否(409)する単体テストがある: 申請が `approved` でない / 承認行が `pending` / 現在の版に有効な承認行が2行ある / `current_approval_id` が `approved` でない / 期限切れ / `decided_at` が期限より後 / 申請の `snapshot_hash` と承認行が不一致 / snapshot本文を改変して再計算値と不一致 / 版の `snapshot_hash` と不一致 / `revision` 不一致 / 固定承認者が承認行の承認者と不一致 / 申請者=承認者 / 申請が `invalidated`(取消・変更後)。
- [ ] (ADR-0023 `accepted` 後)承認後に承認者の `app_user.status` を `deactivated` にする、または `approver` ロールの `role_binding` を期限切れにしても、作業チェック更新と模擬完了が成功する。これは挙動変更であり、変更前は403(`validateApprover` の `Problems.forbidden`)だったことをテスト名とコメントに明記する(当初の記載「409」は誤記。2026-11-12 訂正)。
- [ ] 申請者本人と承認者が同一の承認行(DBへ直接作成)では、承認者が有効でも拒否される。
- [ ] `snapshot-hash.ts` の `hash` が、既存の保存済み `snapshot_hash`(DBの既存行またはテスト固定ベクトル)と同じ値を返す。
- [ ] `check:all`・型・lintが通り、スキーマ変更・Migration・新規依存が0件である。

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-01(関数の分岐。各失敗条件)
- TL-02(承認状態と実行可否の対応)
- TL-04(実PostgreSQLでの `tests/security/approval-assertion.test.ts`)
- TL-16(承認バイパス: hash改ざん・版の取り違え・自己承認の全経路)

### Evidence

- 置き換え前後の呼び出し箇所一覧(`approvalMatches` 0件のgrep出力)
- 失敗条件ごとの拒否ログ、§7挙動変更のテスト結果(変更前の409と変更後の成功)
- 既存の全体unit失敗数の基点との照合結果(新規失敗0)

`evidence/WP-P4-APR-011/<YYYYMMDD-HHMM>/` へ保存し、Command・Environment・Commit SHA・Result・Timestampを含める([[06.2_Evidence_Index]])。

## 9. Security and Audit

- Gate B GB-3(未承認・一部承認・取消後・申請内容変更後の実行が0件)の土台になる。**Security Reviewerのsign-offは必須**。
- ADR-0023 §7は認可の挙動変更であり、ADRの `accepted` 前に実装しない。承認後に承認者が不正と判明した場合は承認取消(FR-CAT-009)で止める運用を前提にする。
- 検証失敗の理由はAPI応答に内部状態(他人のID・hash値)を含めない。詳細は拒否イベントではなくログに残す。
- 新しい監査イベントは作らない(現行の `request.*` を維持。`approval.*` への移行は [[WP-P4-APR-014]])。脅威: T-08。

## 10. Rollback / 失敗時の扱い

スキーマ変更がないため、PRのrevertで戻せる。§7の挙動変更だけを戻す場合は、`approval-assertion.ts` へ `validateApprover` の再検査を戻す(データ・Migration不要)。`snapshot-hash.ts` の抽出はhashの出力を変えないことをテストで保証し、保存済みhashの再計算・書き換えは行わない。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Packageのみを実装してください。

正本(この順で読む):
1. AGENTS.md(絶対ルール)
2. 本WP(WP-P4-APR-011)
3. ADR-0023_Relationship_Based_Approval_Authority(特に§2・§7。statusを確認する)
4. 03.5_Catalog_and_Approval_Requirements(FR-CAT-004/007/008/015、承認状態機械)
5. 02.16_Executor_Command_Contract §3、02.14_Threat_Model T-08
6. services/api/src/modules/catalog/catalog.routes.ts(approvalMatches、fulfillment、updateChecklist、simulate、decide)

手順:
1. 着手前に WP-P4-APR-010 がdoneか、ADR-0023のstatusが何かを確認する。ADR-0023が accepted でない場合は §6-2 の7と §6-5 を実施せず(validateApproverの再検査を残す)、その旨を報告に書く。
2. canonical/hash を snapshot-hash.ts へ出力不変で抽出し、固定ベクトルのテストを先に書く。
3. approval-assertion.ts に checkApprovalComplete / assertApprovalComplete を実装する。§6-2の検証項目を1項目ずつ単体テストへ変換してから実装する。
4. approvalMatches の全呼び出し(fulfillment.canUpdate、updateChecklist)と simulate のインライン検査を置き換え、approvalMatches を削除する。decide は変更しない。
5. 既存テストが無変更で通ることを確認する。挙動変更(§7)のテストは、変更前に409だったことを明記する。

やってはいけないこと:
- Migration・スキーマ・環境変数・フィーチャーフラグの追加。
- 多段・route_hash・route_generationを先取りして実装すること(WP-P4-APR-014)。
- 失敗するテストの削除・skip・条件無効化。
- hashの計算結果を変えること。保存済みhashの書き換え。
- 新規依存の追加。Allowed Paths外の変更(必要なら報告してWP追加を提案)。
- 検証を省略する一時的なバイパスを残すこと。

完了時に報告すること:
- 変更ファイル一覧 / Migrationなし / 実行した検証コマンドと結果(そのまま)
- §7 Acceptance Criteria の各項目の充足状況と証拠
- セキュリティ影響(§7の挙動変更を含む) / 未解決事項 / Evidenceの保存先
- Execution Log(§13)へ追記する
```

## 12. Definition of Done

- [ ] §7をすべて満たす / §8のテスト通過とEvidence保存
- [ ] Migrationなし(スキーマ互換への影響なしを説明に明記)、ロールバック方針の記載
- [ ] 関連ドキュメント(RTMのStatus、WP自身のExecution Log)の更新
- [ ] 未解決のCritical/Highがない
- [ ] Security Reviewer(人間)のsign-off(承認統制・認可の挙動変更を含むため必須)
- [ ] Execution Logへ追記

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-11-12 | Claude Code(実装担当) | 未コミット(基点 `5c33cca`、branch `wp/WP-P4-APR-011`) | Review(Security Reviewer sign-off待ち) | `evidence/WP-P4-APR-011/20261112-1449/` | 下記 |

### 実装記録(2026-11-12)

**前提**: WP-P4-APR-010 完了、ADR-0023 は `accepted`(利用者承認済み)。そのため §6-2 の7・§6-5(§7の挙動変更)まで実装した。

**変更ファイル**
- `services/api/src/modules/catalog/snapshot-hash.ts`(新規): `canonical` / `hash` を出力不変で抽出。
- `services/api/src/modules/catalog/approval-assertion.ts`(新規): `checkApprovalComplete` / `assertApprovalComplete`。
- `services/api/src/modules/catalog/catalog.routes.ts`: `approvalMatches` を削除し、`fulfillment.canUpdate`・`updateChecklist`・`simulate` を新関数へ置換。`simulate` のインライン検査(状態・期限・hash・固定承認者・`validateApprover`)を削除。`CatalogController` に任意の第4引数 `logger` を追加(未指定でも動く)。`decide` / `create` / `edit` は無変更。
- `tests/unit/approval-assertion.test.ts`(新規)、`tests/security/approval-assertion.test.ts`(新規)。
- 本WP、`evidence/WP-P4-APR-011/`。

**Migration**: なし(スキーマ・環境変数・フィーチャーフラグ・依存の変更0件)。ロールバック: PRのrevert。§7だけ戻す場合は `approval-assertion.ts` へ `validateApprover` 相当の再検査を戻す。データ互換: 保存済みhashは書き換えない。DB上の既存全申請・全版のhashが再計算値と一致することをsecurityテストで確認した。

**検証コマンドと結果**
```
npx vitest run tests/unit/catalog-*.test.ts tests/unit/portal-catalog.test.ts tests/unit/approval-assertion.test.ts  -> 18 files / 692 passed
npx vitest run tests/unit/approval-assertion.test.ts                                                                 -> 35 passed
npx vitest run tests/security/approval-assertion.test.ts   (.env読込、実PostgreSQL)                                  -> 18 passed (2回)
npm run test:unit   変更前: 34 failed | 4271 passed (4305)、変更後: 34 failed | 4306 passed (4340)。新規失敗0
npm run typecheck / npm run lint / npm run check:all  -> exit 0
grep -rn approvalMatches services apps packages tests tools  -> 0件(テスト内の「0件確認」記述を除く)
```

**§7 Acceptance Criteria の充足**
- [x] `approvalMatches` 0件: `tests/unit/approval-assertion.test.ts` の静的確認テスト。
- [x] 3箇所が検証を通る: 同ファイル「3つの呼び出し箇所すべてが検証を通る」(照会数で確認。`simulate` の既存レシート返却は検証より前で、検証を行わないことも確認)。
- [x] 既存1段申請の成功経路が同一: 既存 `tests/unit/catalog-*.test.ts` が無変更で成功、security「成功経路(固定承認者なし/あり)」で状態・監査イベントを確認。`tools/smoke_catalog_flow.mjs` は資格情報がなく**未実行**。
- [x] 拒否(409)の単体テスト: 同ファイル「assertApprovalComplete: 拒否(409)」に全条件(申請 pending / invalidated、承認行 pending、有効行2行、current_approval_id 不一致、期限切れ、decided_at が期限後、申請/版とのhash不一致、本文改変、固定承認者不一致、申請者=承認者)。`revision` 不一致は有効行の絞り込み(`revision = 現在の版`)で「有効行なし」として拒否される。
- [x] §7: security「ADR-0023 §7」3件(承認者 deactivated / role_binding 期限切れ / 削除)。変更前は **403**(WPの「409」は誤り)で止まっていたことを変更前コードで確認し、テスト名・コメントに明記。
- [x] 自己承認の承認行(DB直接作成): security「申請者=承認者」。承認者が有効な approver でも拒否。
- [x] `hash` の固定ベクトル: unit「snapshot-hash 固定ベクトル」と、security で DB 既存の全申請・全版の `snapshot_hash` を再計算して一致を確認。
- [x] `check:all`・型・lint 成功、Migration・依存の追加0件。

**セキュリティ影響**
- 認可の挙動変更: 作業チェック更新・模擬完了で、承認者の現在の所属・approverロール・利用者状態を再検査しなくなった(ADR-0023 §7)。承認が決定時点の事実として扱われる。不正な承認は承認取消(FR-CAT-009)で止める運用が前提。
- 変わらない: `decide`(決定時)と `create` / `edit` の `validateApprover`、固定承認者の照合、hash・版・期限の検証。検証は厳密化(版の `snapshot_hash`、有効行がちょうど1行、`decided_at <= expires_at`、申請者≠承認者を追加)。
- 失敗応答は固定の文言のみで内部ID・hash値を含まない。理由コードは `logger` が渡された場合だけ `warn` ログに出る。

**未解決事項**
- 検証失敗の理由ログを実際に出すには、`services/api/src/main.ts`(Allowed Paths外)で `CatalogController` へ logger を渡す必要がある(現状は未配線)。
- `tools/smoke_catalog_flow.mjs` は未実行(資格情報なし)。監督者環境での実行を要する。
- Security Reviewer(人間)のsign-offが必要(§12)。

**Evidenceの保存先**: `evidence/WP-P4-APR-011/20261112-1449/`(`raw/` はgitignore対象)。

### 追補(2026-11-12 監督者の検査後の修正)

- `approval-assertion.ts` を fail closed に変更: `revision_hash_ok !== true`、`decided_at` / `expires_at` が `Date` でない場合は拒否(型も必須化)。列が欠けた行を通さない単体テストを3件追加。
- `services/api/src/main.ts`: `new CatalogController(...)` へ既存の `logger` を渡す1行のみ。ログ内容は organizationId・requestId・reason のみ。
- 偽DBの修正(応答を実DBの形に合わせるだけ。期待値・件数は不変): `tests/unit/catalog-flexible.test.ts`(+6行)、`tests/unit/catalog-operations.test.ts`(+6行)。承認行に `decided_at` を持たせ、`revision_hash_ok` を `params[3](申請のsnapshot_hash) === 承認行のsnapshot_hash` で実際に計算して返す(常にtrueではない)。
- `check:paths` はファイル名中のグロブを解決できないため、§4 の `tests/unit/catalog-*.test.ts` を実在する2ファイルへ展開した。
- 再検証: 追加+関連unit 18 files / 695件成功、security 18件成功(手動削除不要、DB件数が実行前後で不変)、`npm run test:unit` 34失敗/4343件(新規失敗0)。Evidence: `evidence/WP-P4-APR-011/20261112-1454/`。
- 2026-11-12(監督者による追記): 利用者(人間)がセキュリティレビューとして本WPを承認した。利用者の指示により、PRを作らず `main` へ直接取り込んだ。`implementation_status` を `done` にした。未実施: `tools/smoke_catalog_flow.mjs`(開発用パスワードの環境変数が無いため)。
