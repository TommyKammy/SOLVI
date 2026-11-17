# WP-P2-SEC-025 Evidence (2026-11-17)

ブラウザ向けセキュリティヘッダー([[ADR-0027_Browser_Security_Headers]]、[[ADR-0029_CSP_Attachment_Upload_Origin]])の実装の検証。

- Timestamp: 2026-11-17 16:06〜 JST
- Commit: `b9339cb`(main)に本WPの作業ツリーを加えたもの(ブランチ `wp/WP-P2-SEC-025`)
- Result: すべての実行が PASS(下表)。**強制モード(`Content-Security-Policy`)へ切り替えた。**

## 環境

- DB: 検証専用の使い捨てDB `solvi_wp043_evidence_test`(colima-solvi の Postgres、`tools/seed.mjs` の合成データ)。開発用DB `solvi` には接続していない。
- Object Storage: colima-solvi の SeaweedFS(`docker compose up -d --wait seaweedfs` と `tools/ensure_buckets.mjs`。`npm run dev:local` と同じ手順)。
- API: `services/api/src/main.ts`(`NODE_ENV=development`、ADR-0019 のローカル認証)。
- Web: 本番ビルド(`next build` → `next start`、`NODE_ENV=production`)と、開発サーバー(`next dev`、`NODE_ENV=development`)の2通り。起動は `run_stack.sh.txt` / `run_stack_dev.sh.txt`。
- ブラウザ: Chromium headless shell 1248(`SOLVI_UI_BROWSER_PATH`。Playwright 1.62 の既定の版は未取得のため、取得済みの版を使った)、WebKit 2336。
- 利用者: seed の合成ユーザー `org_admin@acme.example.test`。パスワードは seed ファイルから読み、出力していない。

## なぜ2通りのサーバーで検査したか

ADR-0029 §3 は、本番(`NODE_ENV=production`)ではストレージの接続先を `https:` に限る。ローカルの SeaweedFS は `http://127.0.0.1:9100` のため:

- **本番ビルド**では、web は添付のソースを加えない(fail closed)。これ自体が ADR-0029 の確認対象である(`SOLVI_UPLOAD_EXPECT=fail-closed`)。web のログに `attachment upload source not added to CSP connect-src` が1回出ることも確認した。
- **開発サーバー**では、ループバックの `http:` が許されるため、ソースが加わり、アップロードが成功することを確認した(`SOLVI_UPLOAD_EXPECT=allowed`、`SOLVI_UI_DEV=1`。`script-src` の `'unsafe-eval'` は開発時だけ許す。ADR-0027 §2)。

## 実画面の検査(`tools/ui_security_headers_check.mjs`)

| ディレクトリ | サーバー | CSP | 検査 | 主要導線の違反 | 添付のアップロード | 別のバケットへの PUT |
|---|---|---|---|---|---|---|
| `20261117-1606-prod-report-only/` | 本番ビルド | Report-Only | Chromium 16 / WebKit 16 PASS | 0 / 0 | ソースなし(fail closed)。`connect-src` 違反 2件(報告のみ) | (ソースなし) |
| `20261117-1606-dev-report-only/` | 開発 | Report-Only | Chromium 17 / WebKit 17 PASS | 0 / 0 | 成功、違反 0 | 違反 2件 |
| `20261117-1606-dev-enforce/` | 開発 | 強制 | Chromium 17 / WebKit 17 PASS | 0 / 0 | 成功、違反 0 | ブロック(違反 1件) |
| `20261117-1606-prod-enforce/` | 本番ビルド | 強制 | Chromium 16 / WebKit 16 PASS | 0 / 0 | ソースなし(fail closed)。ブラウザの外へ出ずにブロックされ、画面は再試行の案内を出した | (ソースなし) |

各実行で確認したこと(`summary.json` の `checks`):

- `/login`・`/portal`・`/ops`・`/inbox`・`/knowledge` の応答に、ADR-0027 §3 の固定値ヘッダーがすべて付く。HTTP では HSTS が付かない。
- 期待するモードのCSPヘッダーだけが付き、`script-src` にnonceがある。2回の `/login` でnonceが異なる。**すべての `<script>` のnonceが、同じ応答のCSPのnonceと一致する。**
- 本番ビルドの `script-src` に `'unsafe-inline'`・`'unsafe-eval'`・`*`・`https:` が無い。
- 主要導線: ログイン(Server Action)、組織の選択、ポータル、業務受信箱(チケット一覧)、承認の受信箱、ナレッジと検索、申請状況、チケットの起票(Server Action)、担当者のチケット詳細、添付のアップロード。違反は `securitypolicyviolation` イベントで Node 側へ即時に送り、画面の再読込で失われないようにした。
- 別のオリジン(`http://127.0.0.1:<任意のポート>`)のページから `iframe` で読み込むと、SOLVI は描画されない(`*-iframe-refused.png`)。
- 違反の記録には、ブロックされたURLの**オリジンだけ**を残す。署名付きURL(`X-Amz-Signature`)を Evidence に残さないためである(Evidence 全体を検索し、署名・パスワードが無いことを確認した)。

## 応答ヘッダーのダンプ(`20261117-1606-headers/`)

`prod_dump.sh.txt` で、本番ビルドを各モードで作り直し、`curl -sI /login` を3回(HTTP 2回、`X-Forwarded-Proto: https` 1回)取った。

- `headers-report-only.txt`: `Content-Security-Policy-Report-Only`。nonceは毎回異なる。HTTPS 扱いのときだけ `Strict-Transport-Security: max-age=300`。
- `headers-enforce.txt`: `Content-Security-Policy`。同上。`upgrade-insecure-requests` は HTTPS 扱いのときだけ付く(下記)。

## 強制モードへの切り替えの判断

- 判断: 2026-11-17、`CSP_MODE` を `'report-only'` から `'enforce'` へ切り替えた(ADR-0027 §4)。
- 根拠: Report-Only で、主要導線(添付のアップロードを含む)の違反が Chromium・WebKit とも0件だった(`dev-report-only`)。添付のアップロード先は ADR-0029 のソースで許可され、別のバケットへの送信は違反になった。切り替え後も、同じ検査が両ブラウザで通った(`dev-enforce`、`prod-enforce`)。
- 本番でのストレージの設定の誤りは、アップロードだけが失敗する形で現れる(fail closed、`prod-enforce`)。切り分けと切り戻しは [[08.1_Deployment_Runbook]] §2.2・§6.4。

## 実装中に見つけて直したこと

1. **添付のアップロードが `connect-src 'self'` に反する**(最初の Report-Only 検査)。ADR-0027 に無いオリジンは足せないため実装を止め、ADR-0029 を起票した。利用者の承認(2026-11-17)後に実装した。
2. **WebKit は `upgrade-insecure-requests` を localhost にも適用する**。強制モードで `http://127.0.0.1` のログイン後の遷移が `https://` へ書き換えられ、TLS エラーで止まった(Chromium は localhost を除外する)。HTTP のページではこの指定が守るものは無いため、**HTTPS の応答にだけ付ける**ようにした(HSTS と同じ扱い)。本番(HTTPS)の CSP は ADR-0027 §2 のとおりである。単体テストを追加した。
3. **検査ツールが違反を取りこぼす**: アップロードの成功で画面が再読込され、ページ内に溜めた違反が消えていた。違反を Node 側へ即時に送る形にした。
4. **`npm run check:all` の未接続検査が middleware を入口として数えていなかった**。`tools/check_unwired.mjs` に `apps/web/src/middleware.ts` を入口として加えた(WP の Allowed Paths に追加済み)。

なお、`*-report-only/` の2つは、上記2の修正の前に取った。Report-Only ではブラウザが `upgrade-insecure-requests` を無視するため、結果は変わらない。

## そのほかの検証

- `npm run test:unit`: 116ファイル、4775件成功、26件 skip(DEC-009 の期限付き skip。本WPと無関係)。うち `tests/unit/security-headers.test.ts` 18件。
- `npm run typecheck`、変更ファイルの `eslint --max-warnings=0`・`prettier --check`: 成功。
- `npm run check:all`: 成功。

## 実行していないこと

- HTTPS の本番相当環境での確認(ALB の背後、本物の S3)。HTTPS の判定は `X-Forwarded-Proto` での応答ヘッダーのダンプまで。
- 実機のブラウザ(Safari・Firefox)。WebKit と Chromium のエンジンで代用した。
