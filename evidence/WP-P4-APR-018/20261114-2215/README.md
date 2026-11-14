# WP-P4-APR-018 B3 実画面の撮り直し(2026-11-14)

修正C後の再割当の画面を、開発環境(`solvi`)の実画面で確認した記録。
合成データは承認ルール1・部署1・カタログ項目1・申請1・プロフィール変更1人。
再割当の成功は0回。ロールの一時変更は1回だけ。

## ロールの一時変更(DBの実測)

- 対象: `auditor@acme.example.test` / `auditor`(org、期限なし)
- 外した: `2026-11-14T13:23:16.263Z`(`valid_until`)
- 戻した: `2026-11-14T13:23:28.756Z`(`valid_from`)
- 戻す方法: 画面と同じ認証済みの管理API `POST /users/:id/roles`(204)
- 直接のSQL変更なし。`raw/role-after.txt` に有効1件の `SELECT` 結果。

## 実画面(開発用DB)

| ファイル | 内容 |
|---|---|
| `chromium/approvals-unavailable-open-desktop-1440.png` | 承認者不在の一覧 + 再割当の欄(開)、1440px |
| `chromium/approvals-unavailable-open-mobile-375.png` | 同上、375px |
| `chromium/reassign-failure-desktop-1440.png` | 上長Aのままの再割当の失敗、1440px |
| `chromium/reassign-failure-mobile-375.png` | 同上、375px |
| `webkit/...` | 同じ4枚を WebKit で撮影 |
| `*/reassigned-success-*` | B2 の `REQ-2026-000162` の `?reassigned=<ID>` の成功表示(読み取りのみ) |
| `*/reassigned-absent-*` | 再割当の記録が無い `REQ-2026-000161` では表示されないこと |
| `*/request-completed-desktop-1440.png` | 今回の申請 `REQ-2026-000164` の完了表示 |

実測(両エンジン共通): 理由の欄 672px(1440px)/ 301px(375px)。申請行 64px、
欄を閉じた行 56px、開いた行 306px(1440px)。375px は申請行 317px、開いた行 375px。
確認のチェック欄は 24×24px、ラベルと同じ行。375px はラベルが2行になり、
チェック欄は1行目に揃う。横溢れなし。

axe: 実画面12 scans(欄を開いた状態・失敗 × 両エンジン × 1440/375 の8、
成功の表示の4)、violations 0(serious / critical 0)。

## ハーネス(書込みなし)

- `raw/confirm-row-*.png` / `raw/confirm-row-harness.json`: 実画面の
  `globals.css` と同じシェルに、修正後の確認の行を描画して測ったもの。
  WebKit の 1440px の「欄を開いた」実画面は下端が切れたため、同じDOMの
  ハーネス(`raw/confirm-row-webkit-desktop-1440.png`)で全体を補完した。
- `raw/dry-run-*.png` / `raw/dry-run.json`: ロールを外す前の下見。
- `raw/unit.log`、`raw/check-all.log`、`raw/typecheck.log`、`raw/lint.log`。

## 開発用DBの件数

`raw/before.json`(B3の合成データを作る前)と `raw/after.json`(検査後)。
`raw/verify-final.txt` に最終の検査結果。`app_user` 15、`role_binding` 25 → 26、
増分は合成データと付け直しの1行で説明できる。

## 注意

- 接続文字列・パスワードは記録していない。
- `raw/capture.log` は実行結果のJSON。`raw/*.log` に秘密情報は含まれない。
