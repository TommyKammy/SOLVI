# WP-P4-IDM-013 段階B 仕上げ(B2) 検証記録

2026-11-13。ブランチ `wp/WP-P4-IDM-013`、基点 `a63e4924c72aeb206c93588a44a78909f778f10c`(段階B)。変更は作業ツリーにあり、コミット・pushはしていない。

B2 の3点(管理メニューの導線、見出しの視覚的な重複、入れ子ツリーの証拠と Chromium の通し)を確認した記録。開発スタックは停止・再起動・追加起動していない。`next build` も実行していない。

## 環境

- Node.js v26.13.0 / Darwin arm64
- 稼働中の開発スタック: Web `http://127.0.0.1:3000`、API `http://127.0.0.1:3001`
- ブラウザ: Chromium 157.0.8103.51 (channel `chrome`)、WebKit 26.5
- 開発用DB `solvi`(Migration 0037 適用済み)。書込みは画面経由だけ。`SELECT` のみで件数を確認
- 合成アカウント: `org_admin@acme.example.test` / `agent@acme.example.test`(パスワードは `SOLVI_SMOKE_PASSWORD` から渡し、値は記録しない)

## 実行したコマンド

```bash
# password は tools/seed.mjs の開発用固定値をコマンド実行時の環境変数へ渡した(値は記録しない)
SOLVI_SMOKE_PASSWORD=<redacted> SOLVI_UI_BROWSER=<engine> \
  SOLVI_UI_OUT=evidence/WP-P4-IDM-013/20261113-0856/browser/<engine> \
  node tools/ui_department_check.mjs
```

| 実行 | 目的 | 結果 |
|---|---|---|
| WebKit(通常) | 通し(作成→子部署→プロフィール→部署長→拒否3種→375px→非org_admin) | 16 checks / axe 11回・違反0 / 画像11枚。`SOLVI_UI_PHASE=hold` で片付けだけ保留 |
| Chromium(1回目) | 通し | 8 checks まで成功。`sr-only` クラス未定義の検査で停止。片付けは完了(部署3件を無効化、プロフィール復元、部署長終了) |
| Chromium(再開) | 読み取り照合と残りの実操作 | `SOLVI_UI_PHASE=verify`。WebKit が保留した有効な合成データに対し、拒否3種と「現在の部署長」を実操作で確認。新規部署は作っていない。19 checks / axe 15回・違反0 / 画像15枚 |
| WebKit(片付け) | 保留した合成データの片付け | `SOLVI_UI_PHASE=cleanup`。部署長終了 → プロフィール復元 → 子部署を最上位へ → 3件を無効化。17 checks / axe 12回・違反0 / 画像12枚 |
| 両エンジン(管理導線) | 管理ホームのカードと左レールの導線 | `SOLVI_UI_PHASE=menu`。`admin-home-desktop-1440.png` を追加。書込みなし |

`summary.json` は `browser/chromium/summary.json` と `browser/webkit/summary.json`。Chromium の1回目の記録は同じ `summary.json` に残り、`failure` は再開成功時に消去している。停止時の画面は `browser/chromium/failure.png`。

## 結果

| 項目 | Chromium | WebKit |
|---|---|---|
| checks | 19 | 17 |
| axe スキャン | 15回 / serious・critical 0 | 12回 / serious・critical 0 |
| スクリーンショット | 15枚 | 12枚 |
| 1440px / 375px の横溢れ | なし(`documentElement.scrollWidth <= innerWidth`) | なし |
| 重複ID | なし | なし |
| 外部オリジンへの通信 | 0件(`blocked: []`) | 0件 |
| 書込み | 部署3・部署長1・プロフィール1・無効化3 | 部署3・部署長1・プロフィール1・無効化3 |
| 拒否された無効化 | 3(子部署・メンバー・部署長) | 3(子部署・メンバー・部署長) |
| 片付け | 完了 | 完了 |

### B2 の確認点

- **入れ子ツリー**: 片付け前の `UI013-SYN-...-ROOT` の下に `...-CHILD` が入れ子で表示され、`子部署 1 件` が写る画像を、両エンジンで 1440px と 375px に保存した(`departments-tree-nested-desktop-1440.png` / `departments-tree-nested-mobile-375.png`)。
- **Chromium の実操作**: `departments-head-desktop-1440-resume.png` に「現在の部署長」、`departments-reject-{child,member,head}-desktop-1440-resume.png` に拒否理由を保存した。拒否操作は API が拒否するためデータは変わらない。
- **見出しの重複**: 部署の編集フォームとプロフィールのフォームの `legend` を、既存の `.visually-hidden` で視覚的に隠した。`部署を編集` の見出しは1つ、`組織プロフィール` の見出しは1つ。スクリーンショットで確認。
- **管理メニュー**: 左レールの「管理」に `/ops/departments` を追加し、`/ops/admin` のユーザー管理カードにも「部署管理」を追加した。表示は選択中の組織で有効な `org_admin` のときだけ。`admin-home-desktop-1440.png` とキーボード操作で確認。

## 開発用DBの件数

`raw/dev-db-before.json` / `raw/dev-db-after.json` / `raw/dev-db-delta.json`。書込みは画面経由のみ。

| テーブル | 前 | 後 | 差 |
|---|---:|---:|---:|
| app_user | 15 | 15 | 0 |
| role_binding | 21 | 21 | 0 |
| ticket | 23 | 23 | 0 |
| local_service_request | 12 | 12 | 0 |
| local_request_approval | 17 | 17 | 0 |
| org_member_profile | 15 | 15 | 0 |
| department | 11 | 17 | +6 |
| department_head | 3 | 5 | +2 |
| audit_event | 1384 | 1419 | +35 |
| session | 307 | 318 | +11 |

検査後の状態: 有効な部署 0 件、終了していない部署長 0 件、値の入ったプロフィール 0 件。合成部署は17件すべて `UI013-SYN-` で無効、合成の部署長5件はすべて終了済み。

## 残した合成データ(今回追加分)

- `UI013-SYN-1794527812967-chromium-ROOT` / `-CHILD` / `-HEAD`(すべて無効)
- `UI013-SYN-1794528017742-webkit-ROOT` / `-CHILD` / `-HEAD`(すべて無効)
- 部署長: 上記 `-HEAD` に各1件(終了済み)

前回(B)の11件もすべて無効のまま。有効な部署は0件。

## 未解決事項

- 左レールの「管理」メニューを開いた状態の axe スキャンでは、既存の `.fs-flyout-title`(グループ名)に `color-contrast`(serious)が出る。今回の変更はメニュー項目の追加だけで、スタイル(`globals.css`)は Allowed Paths 外のため変更していない。変更した画面(利用者一覧・部署管理・管理ホーム)のスキャンは違反0。メニューを開いた状態は画像を撮らず、項目の存在とキーボード遷移だけを確認した。
- Chromium の通しは、1回目が `.sr-only` の検査で停止したため、片付け後の読み取り照合と、WebKit が保留した有効な合成データに対する実操作で完了した。B2 の上限(累計9件)を超えないための措置で、新規の Chromium 部署は追加していない。

## 画面画像

`browser/chromium/` と `browser/webkit/` の `*.png`。主なもの:

- `departments-tree-nested-desktop-1440.png` / `departments-tree-nested-mobile-375.png`
- `departments-head-desktop-1440-resume.png`(Chromium)
- `departments-reject-child-desktop-1440-resume.png` ほか2枚(Chromium)
- `departments-reject-*` / `departments-error-desktop-1440.png`(WebKit)
- `admin-home-desktop-1440.png`
- `users-self-disabled-desktop-1440*.png`

実在の個人情報は写していない。合成アカウントと合成部署だけ。

## raw

- `raw/dev-db-before.json` / `raw/dev-db-after.json` / `raw/dev-db-delta.json`
- `raw/unit-after.json` / `raw/unit-after-console.log` / `raw/unit-compare.json`
- `raw/check-all.log`
