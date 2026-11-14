# WP-P4-APR-019 段階A の実施記録

日時: 2026-11-15 06:47〜06:52 (JST)
対象: WP-P4-APR-019 段階A(API側。Migration 0041・通知・依頼時の通知・組織1つ分の定期処理・期限切れ・`expired` の追従)

## この記録に含むもの

- `db/migrations/0041_local_request_approval_notice.sql`(通知の送信の記録。append-only / RLS)
- 承認の通知の4種類(`approval.notice.requested` / `.expiring` / `.expired` / `.approver_unavailable`)と配送
- 依頼の通知を、ステップを作る1か所(`insertPendingApprovalStep`)から積む変更
- 組織1つ分の定期処理 `ApprovalNoticeSweeper.runOnce({ organizationId, now })`
- 期限切れの遷移(`expire`)・`approval.expired`・申請者への通知
- 状態 `expired` の行への追従(決定・再割当・実行前検証・一覧・詳細・受信箱・承認者不在の一覧・申請内容の変更)

段階B(画面)と、定期処理の開始・停止・組織の一覧の取得は**含まない**。

## 使い捨てDB

- `solvi_wp019_test`(Migration 41件・seed 済み。`approval-notice.test.ts` の実行に使用)
- `solvi_wp019_wp018_wp015_test`(Migration 41件・seed 済み。WP-015/018 の既存テストがDB名を要求するため、
  `wp019` を含む名前にした。既存テストを含む一式の実行に使用)

開発用DB `solvi` に対して実行したのは `SELECT count(*)` のみ。作業前後で件数は同じ(すべて 0 行)。
Migration は 40件・最大 `0040` のまま(0041 は適用していない)。

## 検証コマンドと結果

```text
npm run typecheck                                         # exit 0
npm run lint                                              # exit 1(追跡外の .claude/ worktree の1件。
                                                          #   apps/web/next-env.d.ts の triple-slash。本WPの変更ではない)
npx eslint . --max-warnings=0 --ignore-pattern '.claude/**'  # exit 0
npm run check:all                                         # exit 1(check:unwired が
                                                          #   ApprovalNoticeSweeper / runOnce を「テストからしか
                                                          #   呼ばれていない」とする。定期処理の登録は段階Aの対象外)
npm run check:paths / check:architecture / check:skips / check:traceability / check:workpackages  # すべて OK
node tools/check_rls.mjs(使い捨てDB)                    # OK(問題 0 件)

npx vitest run tests/security/approval-*.test.ts          # 7 files / 189 passed / 0 failed
  approval-notice.test.ts                                 # 32 passed(新規)
  approval-assertion / migration-compat / reassign /
  routing / rule / steps                                  # 157 passed
npx vitest run tests/security                              # 43 files: 9 failed / 34 passed
                                                          # 851 tests: 30 failed / 811 passed / 10 skipped
                                                          # 既知の読み込み不能6ファイル + S3 403 の3ファイルのみ
npx vitest run tests/unit/approval-notice.test.ts          # 10 passed(新規)
npm run test:unit                                          # 34 failed / 4515 passed(4549)
                                                          # 失敗名の集合は基点(34件)と完全一致。新規失敗 0
```

`check:all` の失敗は意図どおりである。`check_unwired` は「本番経路から呼ばれない公開関数」を検出する検査であり、
段階Aでは定期処理の開始・停止を `main.ts` に登録しない指示のため、`ApprovalNoticeSweeper` が未接続として出る。
`tools/check_unwired.mjs` は WP §4 の Allowed Paths ではないため、検査側に例外を追加していない。

`npm run lint` の1件は `.claude/worktrees/musing-chatterjee-914c99/apps/web/next-env.d.ts`(未追跡の作業ツリー)。
リポジトリの追跡ファイルには違反が無い(`--ignore-pattern '.claude/**'` で exit 0)。

## raw/

- `typecheck.txt` / `lint.txt` / `lint-excluding-claude-worktree.txt` / `check-all.txt`
- `check-rls.txt` / `migrate-status-wp019.txt`
- `security-approval-set.txt`(承認の security 7ファイル)
- `security-approval-notice-wp019_test.txt`(新規テストを `solvi_wp019_test` で実行)
- `security-all.txt` / `security-all-failing-files.txt`
- `unit-after.log` / `unit-after-failures.txt` / `unit-baseline-failures.txt`
- `dev-counts-before.json` / `dev-counts-after.json`
- `git-status.txt`
