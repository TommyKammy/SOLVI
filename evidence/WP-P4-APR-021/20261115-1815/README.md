# WP-P4-APR-021 段階B(画面)の Evidence

- 日付: 2026-11-15
- ブランチ: `wp/WP-P4-APR-021`(未コミット)
- 検証用DB: `solvi_wp021_wp020_wp019_wp018_wp015_test`(段階Aから残している。削除しない)
- 開発用DB `solvi`: **SELECT のみ**。件数は `db/dev-before.json` と `db/dev-after.json`。Migration 42件(0042 適用済み。作業開始前から)。

## 重要な但し書き: 画面の証拠はハーネスである

`harness/` のスクリーンショットと axe は、**実画面のものではない**。
`apps/web/src/app/globals.css` と `apps/web/src/app/freshservice.css` をそのまま読み込み、
画面と同じクラス・同じ文言で組んだ静的HTML(`harness/*.html`)を Chromium と WebKit の
1440px / 375px で描画したものである(`harness/build-harness.mjs.txt`、`harness/shoot-harness.mjs.txt`)。

- 実画面は操作していない(開発環境の画面を操作しない指示のため)。
- 実画面の確認(§7-10)は段階C。開発用DBへ段階Cのデータを用意したあとに別の指示で行う。
- 写している状態: 管理者の指定(未指定・指定あり)、委任された編集者の表示だけ、
  公開の失敗、申請画面、申請の詳細、ルール画面の拒否。
- 28 スキャン(7状態 × 2エンジン × 2幅)、axe の serious / critical は 0、
  375px の横はみ出しは 0。結果は `harness/axe-summary.json` と `harness/axe-*.json`。

## 内容

| パス | 内容 |
|---|---|
| `harness/*.html` | ハーネスのHTML(実CSSをインライン) |
| `harness/*.png` | Chromium / WebKit、1440px / 375px のスクリーンショット |
| `harness/axe-*.json` | 画面ごとの axe の結果 |
| `harness/axe-summary.json` | 28 スキャンのまとめ |
| `harness/build-harness.mjs.txt` / `shoot-harness.mjs.txt` | ハーネスの生成・撮影スクリプト(作業用の複製) |
| `logs/security-approval.txt` | `tests/security/approval-*` |
| `logs/security-all.txt` | `tests/security` 全体(既知の読み込み不能6ファイル) |
| `logs/unit-targeted.txt` | 承認・カタログ・申請の unit(28ファイル・1008件) |
| `logs/test-unit.txt` | `npm run test:unit`(基点照合。34 failed / 4637 passed) |
| `logs/unit-baseline-failures.txt` / `unit-current-failures.txt` | 失敗名の集合(差分なし) |
| `logs/typecheck.txt` / `check-all.txt` / `eslint.txt` / `check-rls.txt` | 各検査 |
| `db/dev-before.json` / `dev-after.json` | 開発用DBの件数(前後で一致) |
| `git-status.txt` | 作業後の `git status --short` |

## 実行していない検証

- `tools/ui_approval_routing_check.mjs` の `wp021` 段階は**未実行**。`node --check` と eslint だけを実行した。
  実行には、組織での承認ルールの使用の有効化、別人の固定承認者2段のルール、
  2人目の固定承認者への `approver` ロールの一時付与(利用者の承認)が必要である。
