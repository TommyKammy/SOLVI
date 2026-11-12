---
project: SOLVI
doc_id: "WP-P4-IDM-012"
title: "部署・組織プロフィール・部署長のスキーマとRLS"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-11-12"
updated: "2026-11-12"
owner: "SOLVI Product Team"
tags: ["workpackage", "p4", "identity", "organization", "rls"]
source_of_truth: true
implementation_status: "not-started"
story_points: 8
risk: "high"
workstream: "IDM"
phase: "P4"
requirement_ids: ["FR-IDM-010", "FR-IDM-011", "FR-IDM-012", "FR-IDM-013"]
depends_on: ["WP-P4-APR-010"]
---

# WP-P4-IDM-012: 部署・組織プロフィール・部署長のスキーマとRLS

| 項目 | 値 |
|---|---|
| Phase | P4 |
| Workstream | IDM |
| Risk | high |
| Story Points | 8 |
| Suggested Owner | Backend + Security Reviewer |
| Parallelizable | WP-P4-APR-011と並行可。後続のWP-P4-IDM-013 / WP-P4-APR-015の前提 |
| Gate | Gate B |

## 1. Purpose

上長・部署長による承認ルーティング([[ADR-0023_Relationship_Based_Approval_Authority]])の土台として、部署・組織プロフィール(主部署・上長・役職)・部署長のデータモデルをDBに作る。他組織の上長・部署の参照、部署・上長の循環(同時更新を含む)、同一部署・同一時刻の部署長の重複を、アプリではなく**DBの制約とトリガで**拒否する。APIとUI([[WP-P4-IDM-013]])、承認リゾルバ([[WP-P4-APR-015]])は本WPのテーブルを使う。

## 2. Requirement IDs

`FR-IDM-010`, `FR-IDM-011`, `FR-IDM-012`, `FR-IDM-013`

## 3. Dependencies

[[WP-P4-APR-010]](要求・設計基準。[[ADR-0023_Relationship_Based_Approval_Authority]]、[[02.18_Organization_Data_Model_and_RLS]] §2.1、[[03.7_Identity_OIDC_SCIM_Requirements]] FR-IDM-010〜014)。**ADR-0023が `accepted` になるまでMigrationを `main` に取り込まない**(監督者が判断)。

## 4. Scope / Allowed Paths

- `db/migrations/`
- `services/api/src/modules/auth/user-admin.service.ts`
- `tools/seed.mjs`
- `tools/create_local_user.mjs`
- `tools/seed_load_data.mjs`
- `tests/security/department-profile.test.ts`
- `tests/security/department-profile-concurrency.test.ts`
- `tests/security/user-admin.test.ts`
- `docs/planning/06_WorkPackages/P4_Approval_Automation/WP-P4-IDM-012.md`
- `evidence/WP-P4-IDM-012/`

## 5. Out of Scope

- API・UI(一覧・編集・部署管理画面)は[[WP-P4-IDM-013]]。本WPはスキーマ・トリガ・バックフィル・ロール作成経路への組織プロフィール作成だけ。
- 本人が自分の上長・主部署を変更できない規則のAPI実装は[[WP-P4-IDM-013]](DBはアクターを知らない)。
- 承認ルール・リゾルバ・経路([[WP-P4-APR-014]] / [[WP-P4-APR-015]])。
- 兼務(複数の主部署)、`cost_center`、カスタムユーザーフィールド、IdP/SCIMからの上長・部署の同期(いずれも後続)。
- `app_user` の変更(部署・上長は `app_user` に追加しない)。

## 6. Deliverables

1. Migration(着手時点で空いている最小番号。現在の最新は `0036_catalog_operations.sql` なので `0037_department_and_member_profile.sql` を想定)。`-- +migrate up` / `-- +migrate down` の両方を持つ。
   - `CREATE EXTENSION IF NOT EXISTS btree_gist;`
   - `department(id, organization_id, code, name, parent_id, active, created_at, updated_at)`: `UNIQUE(organization_id, code)`、`UNIQUE(id, organization_id)`、`FOREIGN KEY(parent_id, organization_id) REFERENCES department(id, organization_id)`、`CHECK(parent_id IS NULL OR parent_id <> id)`。削除しない(`active=false`)。
   - `org_member_profile(organization_id, user_id, primary_department_id, manager_user_id, job_title, location, employee_id, created_at, updated_at)`: `PRIMARY KEY(organization_id, user_id)`、`FOREIGN KEY(primary_department_id, organization_id) REFERENCES department(id, organization_id)`、`FOREIGN KEY(organization_id, manager_user_id) REFERENCES org_member_profile(organization_id, user_id)`、`CHECK(manager_user_id IS NULL OR manager_user_id <> user_id)`。`user_id` は `app_user(id)` を参照する。`cost_center` は持たない。
   - `department_head(id, department_id, organization_id, user_id, valid_from, valid_until, created_by, created_at)`: `FOREIGN KEY(department_id, organization_id)` と `FOREIGN KEY(organization_id, user_id)`(`org_member_profile`)、`CHECK(valid_until IS NULL OR valid_until > valid_from)`、`EXCLUDE USING gist (department_id WITH =, tstzrange(valid_from, valid_until) WITH &&)`。`UPDATE` は `valid_until` の短縮(終了日付け)のみ許すトリガを付ける。
   - 循環拒否トリガ(部署の親、上長の連鎖): 検査の前に組織単位の `pg_advisory_xact_lock(hashtextextended('department:' || organization_id, 0))` と `('manager:' || organization_id, 0)` を取得してから祖先をたどり、循環と深さ(部署は上限10)を検査する。2つのトランザクションが逆向きの関係を同時に作る場合も、後続が待機したうえで拒否される。
   - 無効化の参照確認: `department.active` を `false` にする更新は、有効な所属プロフィール(`primary_department_id`)・有効な部署長・子部署が残っている場合に拒否する。承認ルール・進行中申請による参照の確認は、それらのテーブルを作る [[WP-P4-APR-015]] / [[WP-P4-APR-014]] が同じトリガ(または検査関数)へ追加する。
   - 3テーブルとも `ENABLE` + `FORCE ROW LEVEL SECURITY`、`organization_id = app_current_org()` の `USING` / `WITH CHECK` ポリシー(既存の `*_isolation` の命名に合わせる)。`solvi_app` へ `SELECT, INSERT, UPDATE`(`DELETE` なし)、`solvi_auditor` へ `SELECT`。`updated_at` は `set_updated_at()` で更新する。
   - バックフィル: 有効期間内の org スコープ `role_binding` を持つ (組織, 利用者) ごとに空の `org_member_profile` を1行作る(`ON CONFLICT DO NOTHING`)。全組織を読むため、移行ロールが行レベルセキュリティを回避できることを `SET LOCAL row_security = off` で明示する(`0036_catalog_operations.sql` の down と同方式。回避できない場合は黙って0件にせず失敗させる)。
   - down: 3テーブルのいずれかにデータがある場合は拒否する(`0036` と同じ方式)。データがなければテーブル・トリガ・関数を削除する(`btree_gist` は他で使われうるため削除しない)。
2. 作成経路: 組織プロフィール行は、利用者の有効な所属が生じた時点で作る。コード上で `role_binding` を作る経路は次のとおり: `user-admin.service.ts` の `createUser` と `grantRole`、開発用の `tools/seed.mjs` / `tools/create_local_user.mjs` / `tools/seed_load_data.mjs`。各経路で、**同じトランザクション内**で `INSERT ... ON CONFLICT DO NOTHING` する。プロフィール行が無くても所属の有効性は `role_binding` で判定するので、行の欠落が権限の付与・拒否に影響しない(上長・部署が未設定として扱われるだけ)。IdP/SCIM経路(`source='idp_group'`)は未実装のため対象外とし、実装時に同じ規則を適用する([[WP-P5-GROUP-003]])。**`要確認`**: 作成経路を上記に特定したが、`binding-expiry.ts` など他の経路が `role_binding` を作る場合はDBトリガでの作成に切り替える判断が必要になる。
3. `tools/check_rls.mjs` が新テーブルを検出して通る(`NON_ORG_SCOPED` へ追加しない。3テーブルとも組織スコープ)。

## 7. Acceptance Criteria

- [ ] `app.current_org` 未設定のアプリロール接続で、3テーブルの `SELECT` が0件(fail closed)で、`INSERT` が拒否される。
- [ ] 組織Aのコンテキストから組織Bの部署・プロフィール・部署長を読めず、書けない(`tests/security` の2組織フィクスチャ)。
- [ ] 他組織の部署を `primary_department_id` に、他組織のプロフィールを `manager_user_id` に、他組織の部署・利用者を `department_head` に指定する `INSERT` / `UPDATE` が、複合外部キーで拒否される。
- [ ] 自分自身を上長にする、自分自身を親部署にする `INSERT` / `UPDATE` がCHECKで拒否される。
- [ ] 部署の親の循環(A→B→A、A→B→C→A)と上長の循環(甲→乙→甲、3人以上の輪)が `UPDATE` で拒否される。
- [ ] **2つのトランザクションが同時に逆向きの関係を作っても、少なくとも一方が拒否され、循環が残らない**(部署の親、上長の両方。`department-profile-concurrency.test.ts` で実PostgreSQLの2接続を使う)。
- [ ] 部署の深さが11になる親の設定が拒否される(深さ10までは許可)。
- [ ] 同一部署に時間が重なる部署長を2名登録できない(`tstzrange` の境界:終了=開始は許可、1ミリ秒の重複は拒否)。`valid_until <= valid_from` は拒否される。部署長の `UPDATE` は `valid_until` の短縮だけが許可され、`user_id` や `valid_from` の変更は拒否される。
- [ ] 子部署・有効な所属・有効な部署長が残る部署の `active=false` が拒否される。`DELETE` は(アプリロールで)権限エラーになる。
- [ ] バックフィル: Migration適用後、有効期間内の org スコープ `role_binding` を持つ (組織, 利用者) の件数と `org_member_profile` の件数が一致する(期限切れ・将来開始・platformスコープのみの利用者は作られない)。`row_security` を回避できない移行ロールでは失敗する。
- [ ] `createUser` と `grantRole` が、同一トランザクション内で `org_member_profile` を作成し、既存行があっても失敗しない。作成に失敗した場合はロール付与もロールバックされる。
- [ ] downは、3テーブルのいずれかに行がある場合に拒否され、すべて空の場合のみ成功する(up→down→upが繰り返せる)。
- [ ] `node tools/check_rls.mjs` と `npm run check:all` が通り、新規依存が0件である。

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-04(実PostgreSQLでの制約・トリガ・並行)
- TL-05(up/down、バックフィル、既存データ互換)
- TL-06(組織間の読み書き拒否、fail closed)

### Evidence

- 2接続の並行テストの実行ログ(後続トランザクションが待機して拒否された記録)
- `check_rls.mjs` の出力、バックフィル前後の件数比較
- Migration up/down の実行ログ

`evidence/WP-P4-IDM-012/<YYYYMMDD-HHMM>/` へ保存し、Command・Environment・Commit SHA・Result・Timestampを含める([[06.2_Evidence_Index]])。

## 9. Security and Audit

- 組織境界はAPI認可とRLSの二層で守る(AGENTS §1.6)。本WPは第二層(RLS・複合FK)を作る。第一層(API認可、閲覧範囲の制限)は[[WP-P4-IDM-013]]。RLSを主たる認可の代わりにしない。
- 上長・部署長は承認権限の根拠になるため、DB制約の欠落は承認者の作出につながる(脅威 [[02.14_Threat_Model]] T-26)。制約・トリガの網羅をテストで固定する。
- 本WPは監査イベントを生成しない(変更の監査は変更APIを持つ[[WP-P4-IDM-013]])。ただし `createUser` / `grantRole` の既存の監査イベント(`user.created` / `role.binding.created`)の内容は変えない。
- 組織プロフィールの内容(役職・社員番号)は個人データ。ログ・テスト出力・Evidenceに実データを含めない(合成データのみ)。
- **Security Reviewer(人間)のレビュー必須**(RLS・Identity・Migration)。

## 10. Rollback / 失敗時の扱い

Migrationの `down` は、データが入っていれば拒否する(取り込み後は前進修復: 互換readerを残し、書込みを止める)。データが空の段階では `down` で3テーブルとトリガ・関数を削除できる。`btree_gist` 拡張は削除しない。作成経路の変更(`createUser` / `grantRole`)はコードのrevertで戻せ、プロフィール行が無い状態は「未設定」として扱われるため、権限判定には影響しない。バックフィルは冪等(`ON CONFLICT DO NOTHING`)で再実行できる。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Packageのみを実装してください。

正本(この順で読む):
1. AGENTS.md(絶対ルール。特に §1.6 組織境界、§1.10 スキーマ変更)
2. 本WP(WP-P4-IDM-012)
3. ADR-0023_Relationship_Based_Approval_Authority(§1 有効な所属、§3 設定の特権性、§12 データモデル。statusを確認する)
4. 02.18_Organization_Data_Model_and_RLS(§2.1 組織プロフィール・部署・部署長)
5. 03.7_Identity_OIDC_SCIM_Requirements(FR-IDM-010〜014)
6. db/migrations/0002_identity_and_organization.sql、0028(reject_asset_history_change と既存トリガの書き方)、0036_catalog_operations.sql(RLS・GRANT・downの拒否方式)
7. tools/check_rls.mjs

手順:
1. ADR-0023のstatusを確認し、acceptedでなければMigrationを作成しても main へ取り込まない旨を報告する(着手は可)。
2. 受入基準(§7)をテストへ変換する。特に2接続の並行循環テストを最初に書き、トリガがロックなしでは落ちることを確認してから実装する。
3. Migrationを書く(btree_gist、3テーブル、複合FK、EXCLUDE、循環トリガ+組織単位advisory lock、RLS、GRANT、バックフィル、down拒否)。
4. createUser / grantRole とseed系ツールで、同一トランザクション内にプロフィール作成を足す。
5. check_rls.mjs と check:all を実行する。

やってはいけないこと:
- app_user への列追加。cost_center の追加。DELETE権限の付与。RLSを主たる認可の代わりにすること。
- 本人変更の禁止やAPIをこのWPで作ること(WP-P4-IDM-013)。
- row_securityを回避できない移行で件数0を成功として扱うこと(失敗させる)。
- テストのskip・削除。実データ・実PIIの使用。新規依存の追加。Allowed Paths外の変更。

完了時に報告すること:
- 変更ファイル一覧 / Migrationの内容とロールバック方法 / 実行した検証コマンドと結果(そのまま)
- §7 Acceptance Criteria の各項目の充足状況と証拠
- セキュリティ影響 / 未解決事項(`要確認`の作成経路を含む) / Evidenceの保存先
- Execution Log(§13)へ追記する
```

## 12. Definition of Done

- [ ] §7をすべて満たす / §8のテスト通過とEvidence保存
- [ ] Migration(up/down)とロールバック方針、既存データ互換(バックフィル)の説明
- [ ] 関連ドキュメント(02.18・RTMのStatus・WP自身のExecution Log)の更新
- [ ] 未解決のCritical/Highがない
- [ ] Security Reviewer(人間)のsign-off(RLS・Identity・Migrationのため必須)
- [ ] Execution Logへ追記

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| - | - | - | Not started | - | - |
