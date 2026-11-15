# WP-P4-APR-020 段階B の Evidence

- 日付: 2026-11-15
- ブランチ: `wp/WP-P4-APR-020`(未コミット)
- 検証用DB: `solvi_wp020_wp019_wp018_wp015_test`(検査用に残した)
- 開発用DB `solvi`: **SELECT のみ**。件数は `db/dev-before.json` と `db/dev-after.json`。Migration 42件(0042 適用済み。作業開始前から)。

## 重要な但し書き: 画面の証拠はハーネスである

`harness/` のスクリーンショットと axe は、**実画面のものではない**。
`apps/web/src/app/globals.css` と `apps/web/src/app/freshservice.css` をそのまま読み込み、
画面と同じクラス・同じ文言で組んだ静的HTML(`harness/*.html`)を Chromium と WebKit の
1440px / 375px で描画したものである(`harness/build-harness.mjs`)。

- 実画面は操作していない(開発環境の画面を操作しない指示のため)。
- 実画面の確認は、開発用DBへ 0042 を適用したあとに別の指示で行う。
- ハーネスは、委任の画面の 4状態(委任者・代理者・組織管理者・候補0人)と、
  代理の表示(承認待ちの一覧・申請の詳細・受信箱)を写している。
- 28 スキャン(7状態 × 2エンジン × 2幅)、axe の serious / critical は 0、
  375px の横はみ出しは 0。結果は `harness/axe-summary.json` と `harness/axe-*.json`。

## 内容

| パス | 内容 |
|---|---|
| `harness/*.html` | ハーネスのHTML(実CSSをインライン) |
| `harness/*.png` | Chromium / WebKit、1440px / 375px のスクリーンショット |
| `harness/axe-*.json` | 画面ごとの axe の結果 |
| `harness/axe-summary.json` | 28 スキャンのまとめ |
| `harness/build-harness.mjs.txt` | ハーネスの生成・撮影スクリプト(作業用の複製。リポジトリ直下で実行し、`WP020_OUT` で保存先を指定する) |
| `logs/security-approval.log` | `tests/security/approval-*.test.ts` |
| `logs/security-full.log` | `tests/security` 全体(既知の読み込み不能6ファイル) |
| `logs/unit-targeted.log` | 承認・カタログ・受信箱・通知の unit |
| `logs/unit.log` | `npm run test:unit`(基点照合) |
| `logs/typecheck.log` / `checkall.log` / `eslint.log` / `rls.log` | 各検査 |
| `db/dev-before.json` / `db/dev-after.json` | 開発用DBの件数(前後) |
| `git-status.txt` | 作業後の `git status --short` |
| `verification.md` | 実行したコマンドと結果の要約 |
