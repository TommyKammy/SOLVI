---
project: SOLVI
doc_id: "WP-P4-IDM-013"
title: "利用者管理・部署管理のAPIとUI"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.2.0"
created: "2026-11-12"
updated: "2026-11-12"
owner: "SOLVI Product Team"
tags: ["workpackage", "p4", "identity", "organization", "ui"]
source_of_truth: true
implementation_status: "not-started"
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
- **組織管理者の上長は常に未設定**(利用者の決定 2026-11-12、ADR-0023 §3): 当該組織で有効期間内の `org_admin` ロールを持つ利用者に上長を設定する要求は、誰が行っても拒否する(409。UIでは上長欄を無効にして理由を表示する)。上長が設定されている利用者へ `org_admin` を付与する要求(`grantRole` / `createUser`)は拒否し、「先に上長を外す」ことを求める(自動では外さない。暗黙の変更を作らない)。`org_admin` を上長の**候補にすること**は妨げない。
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
| - | - | - | Not started | - | - |
