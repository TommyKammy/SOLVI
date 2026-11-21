# SOLVI ナレッジ記事のローカル統合

SOLVIのNext.js画面とServer Actions、HTTP API、使い捨てPostgreSQLを使用。合成の担当者・管理者・依頼者にはセッションサービスでセッションを発行し、通常の認証・認可・RLSを通した。

[ブラウザ別の結果](results.json) · [Chromiumの編集画面](chromium-editor.png) · [WebKitの編集画面](webkit-editor.png)

手順テンプレート、スラッシュコマンドによる表の作成、行列操作、選択書式、ドラッグ、HTMLの3往復を確認。公開プレビュー、下書き再読込、レビュー、公開、検索、復元、固定引用まで本文を照合した。旧記事の明示変換、版競合、書込休止、切戻しも検証した。axeの対象は編集部品。日本語IMEの実機確認はスキップした。

再実行時は開発中のNext.jsとビルド先を分ける。リポジトリ直下で実行する。

```sh
mkdir -p .local/knw062-build
rsync -a --exclude=.next --exclude=node_modules --exclude='*.tsbuildinfo' apps/web/ .local/knw062-build/
NEXT_TELEMETRY_DISABLED=1 node node_modules/next/dist/bin/next build .local/knw062-build
DOCKER_CONTEXT=colima-solvi node --import tsx evidence/WP-P3-KNWUI-062/verify-local.mts .local/knw062-build
npm run test:unit
npm run typecheck
npm run check:all
npm audit --omit=dev
```

ローカル開発DBは既存Migrationと照合後、`node --env-file=.env tools/migrate.mjs up` で0043のみ追加。ブラウザ検証の下書き、公開、復元、down/upは使い捨てDB内で実行した。

実行結果はユニット4,918件成功・既存skip 26件、使い捨てDBの既存ナレッジ検証17件成功。型検査・Webビルド・計画チェックは成功し、製品依存のnpm auditは指摘0件。
