# WP-P2-UIX-039 検証記録

2026-11-10 / ローカル開発ホスト / `wp/WP-P2-UIX-039`

改善優先順位の第1段階として、既存の短文・長文・選択・確認チェックを使うカタログ作成を改善した。

- 基本情報、申請フォーム、承認と検証設定、確認・保存へ移動できる手順を追加。全入力は同じ保存フォーム内に保持する。
- 管理コードを作成意図ごとのUUIDから自動生成。質問の保存キーも自動生成し、表示名編集や並べ替えでは変更しない。
- 保存フォームと独立した編集中プレビューを追加。必須・文字数・候補・チェックをローカルに試験できる。
- 項目の並べ替えでは試験入力を維持し、種類変更・候補削除・項目削除では非互換の試験値を除く。画面表示と検証が同じ値を使う。
- 保存済みのプレビュー、dirty時の公開禁止、保存・公開中の排他制御は既存経路を維持。
- 375pxの実ブラウザ検証で発見した共通ヘッダーの作成リンクに読み上げ名を追加。

## コードとテスト

Node 24をPATH先頭にして実行。詳細ログはGit管理外の`.local/fix-039/`。

| コマンド | 結果 |
|---|---|
| `rtk proxy npx vitest run tests/unit/catalog-*.test.ts` | 7ファイル / 304テスト成功 |
| `rtk proxy npx vitest run tests/unit/support-portal-ui.test.ts` | 21テスト成功 |
| `rtk npm run typecheck` | 全workspace成功 |
| `rtk npm run lint` | 成功 |
| `rtk proxy npx prettier --check`（変更したソース・テスト・検証ツール） | 成功 |
| `rtk npm run check:all` | 成功 |
| `rtk npm run build` | 成功。開発サーバーと同じ`.next`を並行利用しない状態で実行 |
| `rtk npm run test:unit -- --reporter=json --outputFile=.local/fix-039/unit.json` | 3937成功 / 34失敗、ほかに1ファイルの収集エラー |

全体ユニットの失敗は、既存の不足fixture、固定された過去コミット参照、旧Knowledge画面の期待値による。前回の基準記録と失敗名を比較し、新規失敗0・解消0を確認した。詳細は[unit-summary.json](unit-summary.json)、基準は`evidence/WP-P2-UIX-038/baseline-unit-failures.json`。全体ゲート成功とは扱わない。

独立レビューで発見した型変更時の旧試験値の不整合は修正し、pure helperと実コンポーネントのイベント経路を合わせて7件の回帰テストを追加した。再レビューの追加指摘はなし。

## 実ブラウザ

実ChromeとWebKitで、PC貸与テンプレート、新規の非公開合成下書き、1440px / 375px、キーボード、axe、保存payloadを確認した。資格情報は環境変数で渡し、記録しない。

| 実行環境 | 動作確認 | axe | 結果 |
|---|---|---|---|
| Chrome 157.0.8103.39 | 11項目、Tab操作 | 新規desktop・375px・保存済み編集の3画面すべて違反0 | 成功 |
| WebKit 26.5 | 11項目、macOSのAlt+Tab操作 | 同3画面すべて違反0 | 成功 |

入力試験には保存・公開・申請のAPI呼び出しがない。検証ツールは未許可の業務書込みを遮断し、検証専用の新規合成下書きだけを保存対象とする。

両方で試験入力中の業務書込み0、保存payloadと全編集値の一致、試験値の除外、保存キーの維持、保存中の編集・入力試験・公開禁止、dirty時の公開禁止、再読込後の保存内容を確認。375pxの横溢れ0、編集フォームと各プレビューのID重複0。

実行は`rtk proxy node tools/ui_catalog_authoring_check.mjs`。`SOLVI_SMOKE_PASSWORD`を設定し、WebKitには`SOLVI_UI_BROWSER=webkit`を指定する。Chromeは実Chrome channelを既定とする。

Chromeの最初の保存後、検証ツールのwireキー解析が失敗したため、作成結果を読み取り照合した。同じ下書きの更新1回と読み取りのみのdirty検証再開で完了し、重複作成はしていない。診断probeは送信前に中断した。Chromeの作成数1、WebKitの作成数1、どちらも非公開。既存サービスの変更・公開・申請送信なし。

検証下書きID: Chrome `01a1c59a-3398-7000-b0ed-33f21dea18c7`、WebKit `01a1c5a1-f483-7000-bd0b-41f148396318`。

詳細は[Chrome結果](browser/chromium/summary.json)と[WebKit結果](browser/webkit/summary.json)。スクリーンショットも同じディレクトリに保存。

## 変更境界と残課題

Migration、API、DB、認可、既存サービス、既存申請の変更なし。コードを戻すことでロールバックできる。検証下書きは非公開で保持する。

日付・ユーザー参照などの新しい入力型、カテゴリ、共有項目、条件付き表示、編集権限は後続段階。Safari製品とEdge製品の直接実行は行っていない。全体ユニットの既存失敗が残るためWPはreviewで引き渡す。
