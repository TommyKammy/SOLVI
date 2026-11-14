# WP-P4-APR-016 段階B2 Evidence (2026-11-14 09:49–09:57 JST)

監督者の指示による再実行。段階Bで未完了だった次の2点を Chromium / WebKit で確認した。

- 通し確認の手順8: 上長を外した申請者で、申請画面に理由と「組織の管理者へ設定を依頼してください」が表示され、送信が無効になること。
- 他組織(beta)の利用者が、他人宛ての詳細URLで404になること。

あわせて、修正後の状態で変更画面のスクリーンショット(1440px / 375px)と axe を取り直した。

## Environment

- Web: `http://127.0.0.1:3000` / API: `http://127.0.0.1:3001` (loopback only)
- Database: development `solvi` (Migration 0039)。書込みは画面経由のみ。確認は `SELECT`。
- Base commit: `b3b4f4e020e719a938d1c00a11ec3fae70310086`。段階B/B2の変更は未コミット。
- Browsers: Chromium 157.0.8103.51 / WebKit 26.5 (Playwright headless)
- Node: v26.13.0 / darwin

## Commands

```sh
SOLVI_SMOKE_PASSWORD=<redacted> SOLVI_UI_BROWSER=chromium \
  SOLVI_UI_PHASE=b2 \
  SOLVI_UI_PREVIOUS=evidence/WP-P4-APR-016/20261114-0914/browser/chromium/summary.json \
  SOLVI_UI_OUT=evidence/WP-P4-APR-016/20261114-0949/browser/chromium \
  node tools/ui_approval_routing_check.mjs

SOLVI_SMOKE_PASSWORD=<redacted> SOLVI_UI_BROWSER=webkit \
  SOLVI_UI_PHASE=b2 \
  SOLVI_UI_PREVIOUS=evidence/WP-P4-APR-016/20261114-0914/browser/webkit-retry/summary.json \
  SOLVI_UI_OUT=evidence/WP-P4-APR-016/20261114-0949/browser/webkit \
  node tools/ui_approval_routing_check.mjs

# The first WebKit b2 attempt stopped on a test-script assertion after all writes
# and cleanup had completed. The remaining read-only checks and the detail
# screenshot retake used the same summary without creating another rule.
SOLVI_SMOKE_PASSWORD=<redacted> SOLVI_UI_BROWSER=webkit \
  SOLVI_UI_PHASE=b2readonly \
  SOLVI_UI_OUT=evidence/WP-P4-APR-016/20261114-0949/browser/webkit \
  node tools/ui_approval_routing_check.mjs

SOLVI_SMOKE_PASSWORD=<redacted> SOLVI_UI_BROWSER=<engine> \
  SOLVI_UI_PHASE=b2detail \
  SOLVI_UI_OUT=evidence/WP-P4-APR-016/20261114-0949/browser/<engine> \
  node tools/ui_approval_routing_check.mjs
```

`*_PASSWORD` was read from the environment; the value is not stored in this directory, the summaries or the report.

## Results

| Run | Result | Checks | axe scans | Screenshots | Cleanup |
|---|---|---:|---:|---:|---|
| Chromium B2 | PASS | 9 | 16 | 17 | complete |
| WebKit B2 (first attempt) | script assertion only (pending-list select text) | 7 | 12 | 12 | complete |
| WebKit B2 read-only completion | PASS | 9 | 14 | 15 | complete (no additional write) |
| Chromium / WebKit detail retake | PASS | 10 | 16 / 14 | 17 / 15 | unchanged |

The script assertion was in the check itself: WebKit's `innerText` for a `<select>` does not include the selected option text, so the empty pending list failed the text assertion. The application behaviour was correct (the non-approver saw the `自分が判断する承認待ち` filter and the empty state). No application change was needed.

## Covered checks

- 組織での使用の説明が「まだ有効にしていない組織では無効です」になっている。
- プレビューが解決できない理由(上長未設定)を表示する。
- 合成の承認ルールを1件だけ作り、既存の合成カタログ項目に結び付けて公開できる。
- 上長を設定すると、申請画面が2段の経路(上長 → 固定承認者)を表示し、承認者選択を出さない。
- 上長を外すと、申請画面に理由と管理者への依頼が表示され、送信が無効(`aria-describedby="request-route-blocked"`)。申請は作られない。
- 申請者が詳細で2段の承認の経過(承認者・決定日時・期限)を読める。
- `approver` ロールを持たない利用者にも「自分が判断する承認待ち」の絞り込みが見える。
- 他組織(beta)の利用者は他人宛ての詳細URLで404。

## Screenshots (each at 1440px and 375px)

- `approvals-routing-description-*`: `/ops/approvals` の「組織での使用」。
- `approvals-preview-unresolved-*`: 解決できないプレビュー。
- `approvals-preview-resolved-*`: 2段のプレビュー。
- `request-route-resolved-*`: 申請画面の2段の経路。
- `request-route-unresolved-*`: 解決できない申請画面。375px は無効な送信ボタンも写る。
- `request-detail-requester-completed-*`: 詳細の承認の経過(段1・段2)。
- `requests-approvals-manager-*`: `approver` ロールを持たない利用者の承認待ち一覧。
- `request-other-org-404-desktop-1440.png`: beta の404(変更対象外のため axe 対象外)。

## Notes / limitations

- 申請は新しく作っていない。合成の申請は段階Bで作った完了済みの1件を再利用した。
- 部署・部署長は今回作っていない(上長ステップの解決に主部署は不要)。既存の合成部署は無効・部署長は終了済みのまま。
- `requests-approvals-manager` は、新規申請を作らない制約と完了済み申請のため0件(空表示)。絞り込みの表示と選択値はDOMで確認し、axe も実行した。
- Chromium の B2 実行時だけ、固定承認者の承認待ち一覧も追加で撮っている(`requests-approvals-pending-*`)。こちらも有効期限切れのため0件。
- `request-route-resolved` / `request-route-unresolved` の 1440px は、経路セクションが画面下部に写る。送信ボタンの無効状態は375pxの画像とDOMのassertionで確認している。
- `browser/webkit/attempt-1-before-script-fix.png` は、上記のスクリプトassertionで停止した時点の画面。

## Final development-DB state

`app_user` 15、`role_binding` 21、`org_member_profile` 15、`ticket` 25、`local_catalog_item` 23、`local_service_request` 14、`local_request_revision` 19、`local_request_approval` 21、`department` 19、`department_head` 7、`local_simulation_receipt` 6 は前後で同じ。増分は `approval_rule` +2、`approval_rule_revision` +2、`audit_event` +39、`session` +19。新規ルールはエンジンごとに1件(すべて無効)。

検査後: 有効な組織の承認ルール使用 0件、有効な `ui016b-syn-` ルール 0件、有効な `UI016B-SYN-` 部署 0件、終了していない合成部署長 0件、主部署・上長に値の入ったプロフィール 0件。合成の申請2件は `completed`。
