# WP-P4-APR-019 段階C Evidence (2026-11-15 08:06–08:20 JST)

稼働中の開発環境(API `127.0.0.1:3001` / Web `127.0.0.1:3000` / DB `solvi`)を使った。
書き込みは画面の操作だけ(申請1件)。DBへは管理者接続の `SELECT` だけを行った。
接続文字列・パスワードは保存していない。

## 構成

- `browser/<engine>/<width>/` — スクリーンショット(Chromium 1248 / WebKit 2336、1440px / 375px)
- `axe/<engine>-<width>-<page>.json` — axe の結果(ページごと)
- `axe-summary.json` — serious / critical の集計
- `db/counts-before.json` — 作業前の件数(2026-11-15 07:55 JST)
- `db/counts-after-read.json` — 期限切れの確認後(08:07 JST。定期処理1周目の13分後)
- `db/counts-after.json` — 申請の完了後(08:09 JST)
- `db/sweep-state.txt` — 定期処理の結果(状態・監査・送信の記録・Outbox・通知)
- `db/created-request.json` — 作成した申請1件(REQ-2026-000165)の事実
- `ui-read.json` / `ui-notice.json` / `ui-approve.json` / `ui-post.json` — 画面確認の記録
- `ui-create.json` — 申請作成の記録。**作成とスクリーンショットは成功したが、最後のDB確認だけが失敗した**
  (スクリプトに `--env-file` を付け忘れ、管理者接続の設定が読めなかった。メッセージが空の接続エラー)。
  作成した申請の事実は `db/created-request.json` にある(再実行はしていない)。

## 画面

| ファイル | 内容 |
|---|---|
| `01-expired-list` | 申請者: `/requests?state=expired`。6件(REQ-6 は org_admin の申請なので出ない)。 |
| `02-expired-detail` | 申請者: REQ-2026-000017 の詳細。「期限切れ。変更・再承認が必要です」。承認の操作なし。 |
| `03-approver-inbox` | 承認者: `/inbox`。「自分への承認 0件」。期限切れの申請は出ない。 |
| `04-approver-pending-list` | 承認者: `/requests?view=approvals`。期限切れは出ない。 |
| `05-approvals-unavailable` | 組織管理者: `/ops/approvals` の「承認者不在の申請」。空。期限切れは出ない。 |
| `05b-expired-detail-owner` | 組織管理者(REQ-2026-000006 の申請者): 期限切れの詳細。 |
| `06-notifications-before` | 組織管理者: `/ops/notifications`。承認期限の切れ7件。 |
| `07-before-submit` | 申請者: 申請フォームの入力(UI019)。 |
| `09-notifications-requested` | 組織管理者: 通知の一覧。承認の依頼1件と承認期限の切れ7件。 |
| `10-approver-inbox-requested` | 承認者: 受信箱。自分への承認1件。 |
| `11-request-from-notice-link` | 承認者: 通知のリンク `/requests/<id>` から開いた詳細。承認の操作あり。 |
| `12-requester-list-requested` | 申請者: `/requests`。REQ-2026-000165 が承認待ち。 |
| `13-approved-detail` | 承認後(Chromium 1440 のみ)。 |
| `14-completed-detail` | 模擬実行で完了(Chromium 1440 のみ)。 |
| `15-requester-list-completed` / `16-completed-detail` | 完了後の申請者画面。 |
| `17-approver-inbox-after` | 承認後の受信箱。0件。 |
| `defect-approved-but-expired` | 見つけた不具合の参考: 承認済み(期限内に決定)なのに「期限切れ」と表示される REQ-2026-000011。 |

375px の全ページで、`document.documentElement.scrollWidth` が `clientWidth` を超えないことを確認した
(`ui-*.json` の `pages[].overflow`)。

## 使用した合成アカウント

`requester@acme.example.test` / `approver@acme.example.test` / `org_admin@acme.example.test` /
`agent@acme.example.test`(seed の合成アカウントのみ)。パスワードは保存していない。
