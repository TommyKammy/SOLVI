# 検証のコマンドと結果(WP-P4-APR-019 段階C)

使い捨てDB `solvi_wp019_test`(名前に `wp019` を含む。Migration 41件・最大 `0041`)。
接続先は環境変数の上書きだけで切り替え、`.env` は書き換えていない。

```text
# 承認の通知のテスト(リンクの期待値を更新)
node --env-file=.env .local/tmp/run-wp019.mjs solvi_wp019_test \
  npx vitest run tests/security/approval-notice.test.ts tests/unit/approval-notice.test.ts
# → Test Files 2 passed / Tests 58 passed
#    tests/security/approval-notice.test.ts 45 tests
#    tests/unit/approval-notice.test.ts 13 tests

npm run typecheck                                  # exit 0
npm run check:all                                  # exit 0
npx eslint . --max-warnings=0 --ignore-pattern '.claude/**'   # exit 0
git status --short
#  M services/api/src/modules/notification/notification.service.ts
#  M tests/security/approval-notice.test.ts
#  ?? evidence/WP-P4-APR-019/20261115-0810/
```

実画面の確認は `.local/tmp/wp019-ui-check.mjs`(Chromium / WebKit × 1440px / 375px)。
`document.documentElement.scrollWidth <= clientWidth + 1` を全ページで確認した。
axe は 40 ページ(4 組み合わせ × 10 画面)で実行し、violations 0 / serious・critical 0。
