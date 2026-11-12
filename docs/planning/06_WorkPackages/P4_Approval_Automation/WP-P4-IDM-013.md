---
project: SOLVI
doc_id: "WP-P4-IDM-013"
title: "利用者管理・部署管理のAPIとUI"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.3.0"
created: "2026-11-12"
updated: "2026-11-12"
owner: "SOLVI Product Team"
tags: ["workpackage", "p4", "identity", "organization", "ui"]
source_of_truth: true
implementation_status: "in-progress"
story_points: 8
risk: "high"
workstream: "IDM"
phase: "P4"
requirement_ids: ["FR-IDM-010", "FR-IDM-011", "FR-IDM-012", "FR-IDM-013", "FR-IDM-014"]
depends_on: ["WP-P4-IDM-012"]
---

# WP-P4-IDM-013: 利用者管理・部署管理のAPIとUI

| 項目 | 値 |
|---|---|
| Phase | P4 |
| Workstream | IDM |
| Risk | high |
| Story Points | 8 |
| Suggested Owner | Backend + Frontend + Security Reviewer |
| Parallelizable | WP-P4-APR-014と並行可 |
| Gate | Gate B |

## 1. Purpose

[[WP-P4-IDM-012]]のテーブルを、組織管理者が管理できるようにする。利用者管理に部署・上長・役職の列とフィルタを足し、部署のツリー管理と部署長の設定画面を作る。上長・部署・部署長の変更は承認権限の付与と同格の特権操作([[ADR-0023_Relationship_Based_Approval_Authority]] §3)であり、変更権限・本人変更の禁止・監査・閲覧範囲(個人データ)をAPI層で実装する。

## 2. Requirement IDs

`FR-IDM-010`, `FR-IDM-011`, `FR-IDM-012`, `FR-IDM-013`, `FR-IDM-014`

## 3. Dependencies

[[WP-P4-IDM-012]](done。Migration `0037`)。ADR-0023 は `accepted`。2026-11-12 に利用者の決定(組織管理者の上長は常に未設定)を受けて `baseline` に実体化した。

**作業は2段階で行う**: (段階A)API・監査・security/unitテスト。使い捨てDBで検証する。(段階B)UI・ブラウザ確認・スクリーンショットとaxe。段階Bは、開発用DBへの Migration `0037` の適用について利用者の指示を得てから着手する。

## 4. Scope / Allowed Paths

- `services/api/src/modules/auth/user-admin.routes.ts`
- `services/api/src/modules/auth/user-admin.service.ts`
- `services/api/src/modules/auth/department.service.ts`
- `services/api/src/modules/auth/department.routes.ts`
- `services/api/src/main.ts`
- `services/api/src/common/audit/audit.ts`
- `apps/web/src/app/ops/users/page.tsx`
- `apps/web/src/app/ops/users/actions.ts`
- `apps/web/src/app/ops/departments/`
- `apps/web/src/lib/api.ts`
- `apps/web/src/lib/user-directory.ts`
- `apps/web/src/lib/navigation.ts`
- `tests/security/department-api.test.ts`
- `tests/unit/department-ui.test.ts`
- `tests/unit/user-directory.test.ts`
- `tests/unit/user-directory-read.test.ts`(一覧の応答に追加した項目へ期待値を合わせる変更だけ。2026-11-12 監督者が追加)
- `tests/security/department-api-concurrency.test.ts`(2026-11-12 監督者が追加)
- `tools/ui_department_check.mjs`
- `docs/planning/06_WorkPackages/P4_Approval_Automation/WP-P4-IDM-013.md`
- `evidence/WP-P4-IDM-013/`

## 5. Out of Scope

- スキーマ変更(あれば[[WP-P4-IDM-012]]へ戻す)。承認ルール・リゾルバ・経路([[WP-P4-APR-014]] / [[WP-P4-APR-015]])。
- 一括インポート(CSV)、IdP/SCIMからの同期、兼務、カスタムユーザーフィールド、コストセンター。
- 承認UI(申請・詳細・ルール管理・滞留一覧は[[WP-P4-APR-016]])。
- アクセスレビュー([[WP-P1-SEC-024]])画面への上長・部署長の変更履歴の統合。本WPは監査イベントの記録までとし、統合は**関係ベース承認を有効化する前**の条件として[[WP-P4-APR-015]]で扱う(本WPの時点では上長・部署長はまだ承認権限の根拠として使われない)。

## 6. Deliverables

- 部署API(作成・編集・無効化・ツリー取得・メンバー一覧)と、部署長API(設定・終了日付け)。変更は `org_admin` のみ。
- 組織プロフィールAPI(主部署・上長・役職・勤務地・社員番号の更新)。**本人による自分の上長・主部署の変更は、`org_admin` であっても拒否**する(主部署は別の `org_admin` が設定する)。上長候補は同組織の有効な所属(ADR-0023 §1)のみ。循環になる候補はAPIが拒否し、UIでは選択不可とし理由を表示する。
- **組織管理者の上長は常に未設定**(利用者の決定 2026-11-12、ADR-0023 §3): 当該組織で有効期間内の `org_admin` ロールを持つ利用者に上長を設定する要求は、誰が行っても拒否する(409。UIでは上長欄を無効にして理由を表示する)。上長が設定されている利用者へ `org_admin` を付与する要求(`grantRole` / `createUser`)は拒否し、「先に上長を外す」ことを求める(自動では外さない。暗黙の変更を作らない)。`org_admin` を上長の**候補にすること**は妨げない。この規則は同時実行でも破れないこと(監督者の検査による追加 2026-11-12): 「上長の設定」と「`org_admin` の付与」は、どちらも対象利用者の `org_member_profile` 行を `FOR UPDATE` でロックしてから検査する。
- 閲覧範囲の制限(API層): プロフィール全項目は `org_admin`・本人・その人の上長のみ。担当者(`agent`)には主部署名と表示名まで。それ以外のロールには返さない。他人のプロフィールを範囲外で指定した場合は404。
- 利用者管理(`/ops/users`)への部署・上長・役職の列とフィルタ、プロフィール充足率の表示(上長未設定・部署未設定・部署長不在の件数)。
- 部署管理画面(`/ops/departments`): ツリー表示・追加・編集・無効化・メンバー一覧・部署長の設定。
- 監査イベント([[02.17_Audit_Event_Catalog]]): `org.member.profile.updated`(before/after。社員番号は変更有無のみ)、`org.department.created|updated|deactivated`、`org.department.head.assigned|removed`。`AUDIT_EVENT_TYPES` へ追加する。書込みと同一トランザクション。監査書込みに失敗したら変更も失敗する。

## 7. Acceptance Criteria

- [ ] `org_admin` 以外(`agent`・`approver`・`requester`・`catalog_editor`)が、部署・部署長・プロフィールの変更APIを呼ぶと403(または404)になる(エンドポイント×ロールの総当りテスト)。
- [ ] 本人が自分の上長・主部署を変更するリクエストが拒否される。`org_admin` 本人でも自分の上長・主部署は変更できない。他人のそれは変更できる。
- [ ] 有効な `org_admin` ロールを持つ利用者への上長の設定が、別の `org_admin` からの要求でも409で拒否される。期限切れの `org_admin` ロールしか持たない利用者には設定できる。上長が設定済みの利用者への `org_admin` の付与が拒否され、ロールもプロフィールも変わらない。上長を外した後は付与できる。
- [ ] 上長候補に、他組織の利用者・無効な所属・本人が含まれない。循環になる候補はAPIが拒否し、UIでは選択不可で理由が表示される。
- [ ] 組織Aのセッションで組織Bの部署・プロフィールを指定すると404(越境テスト)。
- [ ] 閲覧範囲: `agent` が取得したプロフィールには主部署名と表示名だけが含まれ、役職・勤務地・社員番号・上長が含まれない。`requester` が他人のプロフィールを取得すると404。上長は部下のプロフィールを取得できる。
- [ ] 各変更で対応する監査イベントが同一トランザクションで1件ずつ記録され(before/after付き)、社員番号の値がイベントに含まれない。監査書込みを失敗させると変更もロールバックされる。
- [ ] 部署の無効化が、メンバー・子部署・部署長の残存で拒否され、理由が画面に表示される。
- [ ] `/ops/users` と `/ops/departments` がキーボードだけで操作でき、axeでserious/critical違反が0。1440px/375pxで横溢れがなく、画面のスクリーンショットをEvidenceに保存する。
- [ ] `check:all`・型・lint・既存の `tests/unit/user-directory*.test.ts` が通り、新規依存が0件である。

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-03(DTOホワイトリスト。`organization_id`・`approver` 等の混入拒否)
- TL-06(ロール×エンドポイント×組織の総当り、閲覧範囲)
- TL-13(アクセシビリティ)、TL-12(管理者が部署・上長を設定する通し)

### Evidence

- ロール別の拒否ログ、閲覧範囲のレスポンス例(合成データ)、監査イベントのサンプル
- スクリーンショット(1440/375)とaxe結果

`evidence/WP-P4-IDM-013/<YYYYMMDD-HHMM>/` へ保存する([[06.2_Evidence_Index]])。

## 9. Security and Audit

- 上長・部署長の設定は特権操作(ADR-0023 §3)。変更は `org_admin` のみで、本人変更は不可。変更は必ず監査イベントを伴い、アクセスレビューの対象になる。脅威 [[02.14_Threat_Model]] T-26、T-02、T-03。
- 個人データ(役職・勤務地・社員番号)は閲覧範囲をAPI層で制限する。RLSは組織単位までしか守らない。ログ・エラー応答・監査に社員番号を出さない。
- 入力IDを自由入力させない(部署・上長はプルダウン/検索選択で、サーバーが同組織の有効なレコードとして再検証する)。
- **Security Reviewer(人間)のレビュー必須**(認可・個人データ・監査)。

## 10. Rollback / 失敗時の扱い

スキーマ変更なし。APIとUIのrevertで戻せる。設定済みの上長・部署のデータは残り、承認ルーティング側が参照しない限り影響しない。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Packageのみを実装してください(baselineに実体化された後のみ)。

正本: AGENTS.md / 本WP / ADR-0023(§1・§3・§12) / 03.7 FR-IDM-010〜014 / 02.17(追加イベント) / 03.16(データ分類) /
services/api/src/modules/auth/user-admin.* / apps/web/src/app/ops/users。

手順:
1. 受入基準(§7)をテストに変換する。ロール×エンドポイント×組織の総当りと、閲覧範囲のテストを先に書く。
2. APIを実装する。認可 → 同組織・有効な所属の再検証 → 更新 → 監査(同一トランザクション)の順。
3. UIを実装し、キーボード操作・axe・スクリーンショットを確認する。

やってはいけないこと:
- 本人または非 org_admin による上長・部署の変更経路。IDの自由入力。
- 社員番号をログ・監査・エラーへ出すこと。agent への役職・上長の返却。
- スキーマ変更、新規依存、テストのskip・削除。
完了時に報告: 変更ファイル、Migrationなし、検証コマンドと結果、受入基準ごとの充足、セキュリティ影響、未解決事項、Evidence。
```

## 12. Definition of Done

- [ ] §7をすべて満たす / §8のテスト通過とEvidence保存(UIはスクリーンショットとaxe結果)
- [ ] Migrationなし(スキーマ互換への影響なしを説明)、ロールバック方針の記載
- [ ] 関連ドキュメント(02.17・RTMのStatus)の更新
- [ ] 未解決のCritical/Highがない
- [ ] Security Reviewer(人間)のsign-off
- [ ] Execution Logへ追記

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-11-12 | Codex(段階A) | 作業ツリー(未コミット / 基点 `8c7b27d`) | 段階A完了(API・監査・security/unitテスト)。UIは段階B | `evidence/WP-P4-IDM-013/20261112-2141/` | 開発用DBは SELECT のみ。検証は使い捨てDB `solvi_wp013_test` |
| 2026-11-12 | Codex(段階A・A2) | 作業ツリー(未コミット / 基点 `8c7b27d`) | 監督者の検査による1点修正(上長設定と `org_admin` 付与の同時実行)。関連テスト157件通過 | `evidence/WP-P4-IDM-013/20261112-2158/` | 行ロック(`FOR UPDATE`)で直列化。ロックなしで失敗することを確認して戻した |

### 13.1 段階Aの記録(2026-11-12)

**変更ファイル**

- `services/api/src/common/audit/audit.ts` — 02.17 §2.2 の6イベントを `AUDIT_EVENT_TYPES` へ追加
- `services/api/src/modules/auth/department.service.ts`(新規) — 部署ツリー・作成・編集・無効化・メンバー・部署長の設定/終了
- `services/api/src/modules/auth/department.routes.ts`(新規) — 上記のHTTP経路とDTOホワイトリスト
- `services/api/src/modules/auth/user-admin.service.ts` — プロフィール取得(閲覧範囲)・更新、一覧の部署/上長/役職/充足率、`org_admin` 付与時の上長検査
- `services/api/src/modules/auth/user-admin.routes.ts` — プロフィール経路、一覧フィルタの解析、更新DTO
- `services/api/src/main.ts` — 経路の登録
- `tests/security/department-api.test.ts`(新規) — ロール×エンドポイント、越境、閲覧範囲、組織管理者の上長、監査、無効化
- `tests/unit/user-directory.test.ts` — 部署ツリー・一覧フィルタ・プロフィールDTOの単体テスト
- `tests/unit/user-directory-read.test.ts` — 一覧レスポンスの追加項目と充足率の読み取りに合わせて期待値を更新(skip・削除なし)

**Migration**: なし(スキーマ変更なし)。`db/migrations/0037_department_and_member_profile.sql` をそのまま使う。ロールバックはAPIのrevertで戻せる。データは残る。

**検証(使い捨てDB `solvi_wp013_test`。開発用DBは未変更)**

| コマンド | 結果 |
|---|---|
| `vitest run tests/security/department-api.test.ts` | 39 passed |
| `vitest run tests/security/user-admin.test.ts` | 50 passed |
| `vitest run tests/security/department-profile.test.ts` | 27 passed |
| `vitest run tests/security/access-review.test.ts` | 10 passed |
| `vitest run tests/unit/user-directory.test.ts tests/unit/user-directory-read.test.ts` | 28 passed |
| 関連6ファイルの同時実行(上記) | 154 passed |
| `vitest run tests/security` | 654 passed / **1 failed** / 10 skipped。失敗は `approval-assertion.test.ts` の「DBに既存の申請がある」前提(新規DBには申請が無い)。同ファイルを合成申請ありのDBで単独実行すると 18 passed。読み込み不能6ファイルは変更前からの既知 |
| `npm run test:unit`(変更前/後) | 34 failed / 4309 passed → 34 failed / 4313 passed。**失敗したテスト名の集合は同一** |
| `npm run typecheck` / `npm run lint` | 成功 |
| `npm run check:all` | `check:traceability` のみ失敗。`FR-IDM-012` / `FR-IDM-014` / `NFR-SEC-006` の台帳Statusが導出値と不一致。RTM(`03.18`)は本WPの Allowed Paths 外のため未変更(下記「未解決事項」) |
| `npm run check:workpackages` | 成功 |

**受入基準(§7)の充足**

1. `org_admin` 以外の変更API拒否 — 充足。`tests/security/department-api.test.ts` の「役割×エンドポイントの総当り」(agent/approver/requester/catalog_editor/auditor)。
2. 本人の上長・主部署の変更拒否 — 充足。同「本人による自分の上長・主部署の変更禁止」。`org_admin` 本人を含む。
3. 組織管理者の上長は常に未設定 — 充足。同「組織管理者の上長は常に未設定」。期限切れ `org_admin` への設定可、上長付きへの付与拒否、上長を外した後の付与可を固定。`createUser` は新しい利用者を作るため「上長が設定済みの既存利用者」を対象にできず、拒否経路は `grantRole` のみ(未解決事項)。
4. 上長候補の検証・循環 — 充足。同「上長候補と部署の再検証」。他組織・無効な所属・本人を拒否し、循環は409(内部の `manager_cycle` を返さない)。UIの選択不可は段階B。
5. 越境404 — 充足。同「越境」。
6. 閲覧範囲 — 充足。同「閲覧範囲」。`agent` のレスポンスは表示名・主部署名・userId・visibility のみ。
7. 監査 — 充足。同「監査」。プロフィール/部署/部署長の各変更が before/after 付き1件。社員番号の値は含めず `employeeIdChanged` のみ。監査トリガを失敗させると変更が巻き戻る。
8. 無効化の拒否理由 — APIは充足(子部署・メンバー・部署長で409、日本語の理由)。**画面表示は段階B**。
9. UI・キーボード・axe・スクリーンショット — **段階B**。`/ops/users` の列・フィルタ・充足率の表示、`/ops/departments` は未実装。
10. `check:all`・型・lint・既存 `user-directory*`・新規依存0 — 型・lint・既存単体テスト・依存0は充足。`check:all` は上記の台帳Statusのみ未解決。

**セキュリティ影響**: 認可・個人データ・監査に影響する(AGENTS §1.16)。変更は `org_admin` に限定し、本人変更を拒否し、上長候補を毎回再検証し、閲覧範囲をAPI層で制限する。監査は同一トランザクション。**人間のSecurity Reviewerのレビューが必要**。

**未解決事項**

- `check:all` の `check:traceability` が、`FR-IDM-012` / `FR-IDM-014` / `NFR-SEC-006` の台帳Status更新を要求する。`docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md` は本WPの Allowed Paths 外のため変更していない。監督者の判断で `node tools/check_traceability.mjs --write` を実行するか、PRを分ける必要がある。
- `createUser` は常に新しい利用者を作るため、「上長が設定済みの利用者への `org_admin` 付与」を対象にできない。実効的な拒否は `grantRole` が担う。仕様上の意図と一致するか確認したい。
- `platform_admin`(組織スコープの `org_admin` を持たない)は、ADR-0023 §3 の `要確認` に従い、部署・プロフィールの**変更**を拒否している。一覧の閲覧は既存どおり許可。
- `approval-assertion.test.ts` は、新規に作ったDB(申請0件)では前提条件で1件失敗する。本WPの変更を通らない既存のデータ依存。合成申請を1件置いたDBでは18件すべて通る。
- 段階B(UI・axe・スクリーンショット)は未着手。開発用DBへの Migration 0037 の適用指示待ち。

**Evidence**: `evidence/WP-P4-IDM-013/20261112-2141/`

### 13.2 段階Aの修正(A2: 同時実行で「組織管理者の上長は常に未設定」が破れる)(2026-11-12)

**変更ファイル**

- `services/api/src/modules/auth/user-admin.service.ts` — 対象利用者の `org_member_profile` 行を `lockProfileRow`(`SELECT ... FOR UPDATE`)でロックしてから検査するよう変更。`updateProfile` は現在値・本人変更の検査・監査の before をロック後の値に統一し、`grantRole` は `org_admin` を付与する場合に同じ行をロックしてから上長の有無を検査する。ロック取得前の値で検査しない。ロック順序は両経路とも対象利用者のプロフィール行が先(トリガの advisory lock は後)。不要になった `hasManager` を削除。
- `tests/security/department-api-concurrency.test.ts`(新規) — 実PostgreSQLの2接続。DB名に `test` を含まなければ即失敗するガード。上長設定と `org_admin` 付与の同時実行(両順序)、同じプロフィールの同時更新(監査の before)を固定。

**Migration**: なし。スキーマ変更なし。APIのrevertで戻せる。

**検証(使い捨てDB `solvi_wp013_test`。開発用DBは SELECT のみ)**

| コマンド | 結果 |
|---|---|
| `vitest run tests/security/department-api-concurrency.test.ts` | 3 passed(修正後) |
| 関連7ファイル(department-api・同時実行・user-admin・department-profile・access-review・user-directory・user-directory-read) | 157 passed |
| `npm run typecheck` / `npm run lint` | 成功 |
| `npm run check:all` | 成功(RTM更新後) |
| `npm run test:unit` | 34 failed / 4313 passed(4347)。失敗したテスト名の集合は段階Aの基点と同一(差分0) |
| `vitest run tests/security` 全体 | 31 failed / 627 passed / 10 skipped。失敗は本WPのコードを通らない既知の環境依存(記憶域・スキャナ未起動、`evidence/WP-P3-KNWUI-054/...` の6ファイル読込不能、`approval-assertion` の申請0件前提、`user-directory-consistency` の専用DB名要求)。関連7ファイルは上記のとおり通過 |
| 開発用DB `solvi` の件数(作業前後) | app_user=15 / role_binding=21 / ticket=23 / local_service_request=12 / local_request_approval=17 / audit_event=1328 / session=291。作業前後で同一 |

**修正前(ロックなし)で失敗することの確認**

`lockProfileRow` の `FOR UPDATE` を一時的に外し(さらに修正前の順序に合わせて付与前の `ensureOrgMemberProfile` も外した状態で)、新規テストを実行した。両順序とも失敗し、特に「上長の設定が先行」では `上長付きの利用者に org_admin が付与された` で失敗した(最終状態が「有効な `org_admin` かつ上長あり」になる)。ファイルはバックアップから復元し、SHA-256 の一致を確認してから再実行して 3 passed。`git stash` / `git checkout` は使っていない。ログは `evidence/WP-P4-IDM-013/20261112-2158/raw/01_no_lock_run.log` / `02_no_lock_both_orders_run.log` / `03_concurrency_after_restore.log`。

**受入基準(§7)への影響**: 3番目(組織管理者の上長は常に未設定)を同時実行でも充足。他の項目に変更なし。1〜8・10は段階Aの記録どおり。9(UI・axe・スクリーンショット)は段階B。

**セキュリティ影響**: 認可・監査に影響する同時実行の穴を塞いだ(脅威 T-26)。権限の付与と上長の設定が同じ行で直列化され、後続は409で拒否される。エラー応答・監査イベントの内容は変えていない。**人間のSecurity Reviewerのレビューが必要**。

**未解決事項**

- 作業開始時点で、開発用DB `solvi` には Migration `0037` が適用済みだった(前回の記録では未適用)。件数は前回と同一で、本作業では開発用DBに書き込んでいない。監督者側の作業と思われるが、段階Bの前提に関わるため確認したい。
- `tests/security` 全体の31件の失敗は、記憶域・スキャナのサービスが起動していないこと等による環境依存(上表)。本WPの変更を通るテストではない。全件を通すには開発スタックの起動が必要だが、指示により起動していない。
- 同一組織で2人が互いを上長に設定する同時更新では、対象行の `FOR UPDATE`(先)と、トリガの advisory lock・外部キーの `FOR KEY SHARE`(後)の組み合わせにより、PostgreSQL がデッドロックを検出して片方を失敗させる可能性がある(fail closed。データは壊れない)。本修正の対象(同じ利用者への「上長設定」と「`org_admin` 付与」)は同じ行で直列化されるため該当しない。WP-P4-IDM-012 のトリガ設計に関わるため、必要なら別WPで扱う。

**Evidence**: `evidence/WP-P4-IDM-013/20261112-2158/`
