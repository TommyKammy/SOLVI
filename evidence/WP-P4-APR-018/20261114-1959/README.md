# WP-P4-APR-018 段階B の実施記録

日時: 2026-11-14 19:17〜20:00 (JST)
対象: WP-P4-APR-018 段階B(段階Aの修正2点・再割当APIの経路登録・画面)

## この記録に含むもの

- 段階Aの修正: `POST /service-requests/:id/reassignments` の登録と、
  `invalidateApprovalSteps` の全行 `invalidated` 分岐を遷移表に通す変更。
- 画面: `/ops/approvals` の「承認者不在の申請」の再割当フォーム、申請詳細の
  「承認の経過」の再割当の記録と「承認の記録」の表示。
- 詳細APIの加算的な応答(`effectiveSteps`、`routeGenerations` の
  `newApproverName` / `invalidatedApproverName`、`history` の `stepNo` /
  `invalidatedByReassign`)。
- 再割当の 409 に理由コードを付与(画面はコードから利用者向けの文を作る)。

## ブラウザ確認は未実施

ブリーフの指示に従い、スクリーンショット・axe・
`tools/ui_approval_routing_check.mjs` は実行していない。画面は
`tests/unit/approval-reassign-ui.test.ts` の実レンダリングで固定した。

**事実の相違**: 作業時点の開発用DB `solvi` には Migration 0040 が**既に適用済み**
だった(`schema_migration` 40件・最大 `0040`、`local_request_route_generation` は
0行)。ブリーフの「まだ適用されていない」という前提とは異なる。ただし今回は
指示どおりブラウザ確認を行わず、開発用DBへの書込みも行っていない。

## 検証コマンドと結果

使い捨てDB `solvi_wp018_wp015_test`(名前に `wp018` と `wp015` と `test` を含む、
Migration 40件・seed 済み)で実行。接続文字列は記録しない。

```text
npm run typecheck                                         # exit 0
npm run lint                                              # exit 0
npm run check:all                                         # exit 0
node tools/check_rls.mjs                                  # 問題 0 件 / OK

npx vitest run tests/unit/approval-reassign-ui.test.ts \
  tests/unit/approval-reassign.test.ts tests/unit/approval-state.test.ts \
  tests/unit/approval-assertion.test.ts tests/unit/approval-resolver.test.ts \
  tests/unit/approval-route-ui.test.ts tests/unit/requests-ui.test.ts \
  tests/unit/request-detail-recovery-ui.test.ts \
  tests/unit/catalog-flexible.test.ts tests/unit/catalog-operations.test.ts
# 10 files / 391 passed / 0 failed

npx vitest run tests/security/approval-reassign.test.ts
# 38 passed / 0 failed

npx vitest run tests/security/approval-assertion.test.ts \
  tests/security/approval-migration-compat.test.ts \
  tests/security/approval-routing.test.ts tests/security/approval-rule.test.ts \
  tests/security/approval-steps.test.ts tests/security/approval-reassign.test.ts \
  tests/security/department-api.test.ts tests/security/department-profile.test.ts \
  tests/security/relationship-change.test.ts tests/security/user-admin.test.ts
# 10 files / 285 passed / 0 failed

npx vitest run tests/security
# Test Files 9 failed | 33 passed (42)
# Tests 30 failed | 779 passed | 10 skipped (819)
# 内訳: 既知の読み込み不能6ファイル + オブジェクトストレージに接続できない3ファイル
#       (attachment-delete / attachment-scan / object-storage。すべて S3 403)

npm run test:unit
# 34 failed / 4500 passed (4534)
# 基点(34 failed / 4455 passed / 4489)と失敗名35行が完全一致(新規失敗0)
```

補足: ローカルの S3 端点(127.0.0.1:9100)が 403 を返し、MinIO が稼働していない
ため、`attachment-delete`・`attachment-scan`・`object-storage` の 30 件が失敗した。
これは本WPの変更に依存しない環境要因である(作業中に開発スタックの起動・停止・
再起動は行っていない。Docker は起動していない)。

## 開発用DBの件数

`solvi` に対して実行したのは `SELECT count(*)` のみ。作業前後で完全一致。
Migration は 40件・最大 `0040`(作業開始時点で既に適用済み)。

| テーブル | 作業前 | 作業後 |
|---|---:|---:|
| `app_user` | 15 | 15 |
| `role_binding` | 21 | 21 |
| `local_catalog_item` | 23 | 23 |
| `local_service_request` | 14 | 14 |
| `local_request_revision` | 19 | 19 |
| `local_request_approval` | 21 | 21 |
| `department` | 19 | 19 |
| `department_head` | 7 | 7 |
| `approval_rule` | 11 | 11 |
| `approval_rule_revision` | 17 | 17 |
| `org_member_profile` | 15 | 15 |
| `schema_migration` | 40件・最大 `0040` | 40件・最大 `0040` |

## raw/

- `typecheck.txt` / `lint.txt` / `check-all.txt` / `check-rls.txt`
- `unit-approval.txt`(対象の unit)
- `security-approval-reassign.txt`
- `security-approval-set.txt`
- `security-all.txt`(全体。既知の失敗を含む)
- `unit-all.txt` / `unit-after-failures.txt` / `unit-baseline-failures.txt`
- `dev-counts-before.txt` / `dev-counts-after.txt`
- `git-status.txt`
