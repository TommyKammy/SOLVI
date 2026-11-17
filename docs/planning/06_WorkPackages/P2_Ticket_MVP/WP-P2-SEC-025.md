---
project: SOLVI
doc_id: "WP-P2-SEC-025"
title: "ブラウザ向けセキュリティヘッダー(CSP・HSTS等)の付与"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "1.1.0"
created: "2026-11-16"
updated: "2026-11-17"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "security", "csp", "hsts"]
source_of_truth: true
implementation_status: "done"
story_points: 5
risk: "high"
workstream: "SEC"
phase: "P2"
requirement_ids: ["NFR-SEC-011"]
depends_on: []
---

# WP-P2-SEC-025: ブラウザ向けセキュリティヘッダー(CSP・HSTS等)の付与

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | SEC |
| Risk | high |
| Story Points | 5 |
| Suggested Owner | Web開発者 + Security Reviewer |
| Parallelizable | Yes(`apps/web` のmiddlewareと設定に閉じる。他WPと同じファイルを触らない) |
| Gate | Gate A(限定パイロット前に満たす。[[04.22_Gate_Definitions]] のGA条件の追加は本WPでは行わない) / 脅威 T-27・T-28 |

> [[ADR-0027_Browser_Security_Headers]] は 2026-11-16 に `accepted`。本WPは同日に `baseline` とした。
> 2026-11-17、[[ADR-0029_CSP_Attachment_Upload_Origin]](`connect-src` に添付用バケットを加える amend)の `accepted` に伴い、範囲と受け入れ基準を更新した(version 1.1.0)。

## 1. Purpose

`apps/web` の応答に、[[ADR-0027_Browser_Security_Headers]] が決めるCSP(nonce方式)と固定値のヘッダー(HSTS、`nosniff`、Referrer-Policy、Permissions-Policy、COOP、`X-Frame-Options`)を付ける。XSSが入ったときの被害とクリックジャッキングを抑える。

[[WP-P2-UIX-043]] から分離した作業(同WPの「WP-F」)である。

## 2. Requirement IDs

`NFR-SEC-011`([[03.11_Security_Requirements]])。対応脅威は [[02.14_Threat_Model]] T-27・T-28。

## 3. Dependencies

- [[ADR-0027_Browser_Security_Headers]] が `accepted` であること(2026-11-16 充足)。
- `form-action` は `'self'` のみで実装する(2026-11-16 利用者決定)。本番IdPのオリジン追加は本WPに含めない(IdP接続時の後継ADR)。
- [[ADR-0029_CSP_Attachment_Upload_Origin]] が `accepted` であること(2026-11-17 充足)。`connect-src` の添付用バケットのソースは同ADRに従う。
- 先行WPはない。

## 4. Scope / Allowed Paths

- `apps/web/src/middleware.ts`(新規)
- `apps/web/src/lib/security-headers.ts`(新規。ヘッダー値の組み立て)
- `apps/web/next.config.mjs`
- `apps/web/src/app/layout.tsx`(nonceの受け渡しが必要な場合のみ)
- `tests/unit/security-headers.test.ts`(新規)
- `tools/ui_security_headers_check.mjs`(新規。既存の `tools/ui_*_check.mjs` と同じPlaywrightの実画面検査として、CSP違反0件とiframe拒否を確認する)
- `docs/planning/08_Runbooks/08.1_Deployment_Runbook.md`(切り戻し手順と、web へ渡すストレージ設定の追記)
- `tools/check_unwired.mjs`(Next.js がフレームワークから呼ぶ `apps/web/src/middleware.ts` を入口として数える。2026-11-17 追加)
- `evidence/WP-P2-SEC-025/`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-SEC-025.md`

## 5. Out of Scope

- インラインstyle(約136箇所)の解消と `style-src 'unsafe-inline'` の撤去(別WP。ADR-0027 Follow-up)。
- ALB側でのヘッダー付与(ADR-0018 の実装時に再判断)。
- 違反レポートの収集エンドポイント(ADR-0027 §5)。
- HSTSの `includeSubDomains` / `preload`。
- `apps/api` のCSP(JSON応答には付けない)。`apps/api` の `nosniff` は既に `services/api/src/common/http/server.ts` で付与済みのため、変更しない。
- 本番IdPのオリジンを `form-action` へ追加すること。

## 6. Deliverables

- `apps/web/src/middleware.ts`: リクエストごとにnonceを生成し、CSPヘッダー(初期はReport-Only)をレスポンスに付ける。
- `apps/web/src/lib/security-headers.ts`: 環境(`NODE_ENV`、HTTPSかどうか、IdPのオリジン)からヘッダー値を組み立てる純粋関数。
- `next.config.mjs` またはmiddlewareでの固定値ヘッダーの付与。
- 切り戻し手順(強制 → Report-Only)の Runbook 追記。
- 強制モードへの切り替えの判断記録(Evidence)。

## 7. Acceptance Criteria

- [x] 本番相当のビルド(`next build && next start`)で、HTML応答に ADR-0027 §3 の固定値ヘッダーがすべて付く。
- [x] 同じ応答に `Content-Security-Policy-Report-Only`(初期)が付き、その `script-src` に、リクエストごとに異なるnonceが入る。2回のリクエストでnonceが一致しない。
- [x] 描画されたHTMLのNext.jsのスクリプトタグのnonceが、同じ応答のCSPヘッダーのnonceと一致する。
- [x] `NODE_ENV=production` の設定で、`script-src` に `'unsafe-inline'`・`'unsafe-eval'`・`*`・`https:` が含まれない(単体テストで検査)。
- [x] `localhost`(HTTP)の応答に `Strict-Transport-Security` が付かない。
- [x] 外部オリジンのページから `iframe` で読み込むと、ブラウザが表示を拒否する(E2E)。
- [x] 主要な導線(ログイン、ポータル、チケット一覧・詳細、承認、ナレッジ、添付のアップロード)を操作して、CSP違反がコンソールに0件である(E2E。Report-Onlyでの観察結果)。
- [x] 上記を満たしたうえで強制モード(`Content-Security-Policy`)へ切り替え、同じE2Eが通る。切り替えの判断を Evidence に残す。
- [x] CSPを無効化・緩和する環境変数や機能フラグが本番の設定に存在しない。
- [x] `connect-src` に、ストレージの設定(`S3_PUBLIC_ENDPOINT` / `S3_ENDPOINT` と `S3_BUCKET_ATTACHMENTS`)から組み立てた `<オリジン>/<バケット名>/` のソースが1つだけ加わる。値が不正・未設定(本番の `http:`、ワイルドカード、不正なバケット名等)なら何も加えない(単体テスト。ADR-0029)。
- [x] 添付のアップロードを含む主要導線でCSP違反が0件であり、同じホストの別のバケットのパスへの `fetch` は `connect-src` 違反になる(実画面の検査。ADR-0029)。

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])
- 単体: `tests/unit/security-headers.test.ts`(ヘッダー値の組み立て、nonceの一意性、本番での禁止値)。
- 実画面検査(`tools/ui_security_headers_check.mjs`): 主要導線のCSP違反0件、`iframe` 埋め込みの拒否。
- 回帰: `npm run typecheck`、`npm run check:all`、既存のUI検査。

### Evidence
- `evidence/WP-P2-SEC-025/<YYYYMMDD-HHMM>/`: 応答ヘッダーのダンプ(Report-Only時と強制時)、E2Eの結果、コンソールの違反ログ、強制モードへの切り替えの判断記録。Command・Environment・Commit SHA・Result・Timestampを含める。

## 9. Security and Audit

- セキュリティ関連のPRとして、人間のレビューを必須とする(AGENTS.md §1.16)。自己レビューは代替にならない。
- nonceは暗号論的乱数(`crypto.getRandomValues` 等)で、リクエストごとに生成する。ログに出さない。
- 利用者由来の値からヘッダーを組み立てない。
- 監査イベントの追加はない。信頼境界・権限・RLS・Executor境界は変えない。
- 新しい依存パッケージを追加しない。

## 10. Rollback / 失敗時の扱い

- CSPの強制で障害が起きた場合は、Report-Onlyへ戻すデプロイで切り戻す(CSPそのものを外さない)。
- HSTSは、延ばしたmax-ageの間は利用者のブラウザから取り消せない。そのため短いmax-ageから段階的に延ばす(ADR-0027 §3)。
- Migrationなし。

## 11. Codex app Prompt

- 読む正本: 本WP、[[ADR-0027_Browser_Security_Headers]](`accepted` であることを最初に確認する。`draft` なら着手せず報告する)、[[ADR-0029_CSP_Attachment_Upload_Origin]]、[[ADR-0018_Deployment_Baseline]]、[[ADR-0004_External_Identity_OIDC]]、[[ADR-0019_Local_Authentication_For_Development]]。
- 手順:
  1. Next.js 15 のmiddlewareでのnonce付きCSPの扱いを、公式ドキュメントで確認する(推測で実装しない。AGENTS.md §4)。
  2. `security-headers.ts` に、環境からヘッダー値を組み立てる純粋関数を書き、単体テストを先に書く。
  3. middlewareでnonceを生成し、Report-OnlyのCSPと固定値のヘッダーを付ける。
  4. 本番相当のビルドで応答ヘッダーとnonceの一致を確認する。
  5. E2Eで主要導線の違反を確認し、0件になってから強制モードへ切り替える。
- やってはいけないこと:
  - ADR-0027 に無い外部オリジンをCSPへ足すこと。
  - テストを通すために `'unsafe-inline'`・`'unsafe-eval'` を本番設定に入れること。
  - CSPを無効化する環境変数・フラグを残すこと。
  - Allowed Paths 以外を変更すること(インラインstyleの書き換えを含む)。
- 完了時の報告: AGENTS.md §3 の項目、強制モードへの切り替えの有無とその根拠。

## 12. Definition of Done

- [x] §7をすべて満たす / §8のテスト通過とEvidence保存
- [x] Migrationなしの明記、切り戻し手順の Runbook 追記
- [x] 関連ドキュメント(RTM、要求の差し替え)の更新
- [x] 未解決のCritical/Highがない
- [x] Security Reviewer のsign-off
- [x] Execution Logへ追記

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-11-16 | Claude | - | Draft | - | ADR-0027 の下書きとあわせて起票。ADRの承認待ち。 |
| 2026-11-16 | Claude | - | Draft更新 | - | 利用者決定を反映: `form-action 'self'`、Referrer-Policy `strict-origin-when-cross-origin`、api の `nosniff` は既存を追認、要求を NFR-SEC-011 へ差し替え。 |
| 2026-11-16 | 利用者 / Claude | - | Baseline | - | ADR-0027 の accepted に伴い baseline 化。着手可能。 |
| 2026-11-17 | Claude | - | 実装中(Report-Only) | `evidence/WP-P2-SEC-025/` | middleware・ヘッダーの組み立て・単体テスト・実画面の検査ツールを作成(未コミット)。本番ビルドで固定値ヘッダーとReport-OnlyのCSP、nonceの一致・リクエストごとの変化、HTTPでHSTSなし、iframeの拒否を確認。主要導線の違反は**添付のアップロード(Object Storageへの直接PUT)の `connect-src` 違反だけ**。ADR-0027 に無いオリジンは足せないため、強制モードへの切り替えを止め、後継の [[ADR-0029_CSP_Attachment_Upload_Origin]](draft)を起票。 |
| 2026-11-17 | 利用者 / Claude | - | 範囲の更新(1.1.0) | - | 利用者が [[ADR-0029_CSP_Attachment_Upload_Origin]] を推奨どおり承認(`accepted`)。Allowed Paths に `tools/check_unwired.mjs`(middleware を入口として数える)と `evidence/WP-P2-SEC-025/` を追加し、受け入れ基準に ADR-0029 の2項目を追加。 |
| 2026-11-17 | Claude | (PR) | 実装完了・レビュー待ち | `evidence/WP-P2-SEC-025/` | 強制モードへ切り替え。詳細は下記。 |

### 2026-11-17 実装の記録(AGENTS.md §3)

- 変更ファイル:
  - 新規: `apps/web/src/middleware.ts`、`apps/web/src/lib/security-headers.ts`、`tests/unit/security-headers.test.ts`、`tools/ui_security_headers_check.mjs`、`evidence/WP-P2-SEC-025/`
  - 変更: `tools/check_unwired.mjs`(middleware を入口として数える)、`docs/planning/08_Runbooks/08.1_Deployment_Runbook.md`(§2.2 web へのストレージ設定、§6.4 CSP の切り戻し)、本WP
  - 文書: [[ADR-0029_CSP_Attachment_Upload_Origin]](新規、accepted)、[[ADR-0027_Browser_Security_Headers]](Status に Amended by を追記)、[[07.0_ADR_Index]]、MANIFEST
- Migration: なし。ロールバックは `CSP_MODE` を `'report-only'` に戻した版のデプロイ(Runbook §6.4)。CSPそのものは外さない。
- 検証コマンドと結果:
  - `npm run test:unit`: 116ファイル、4775件成功、26件 skip(DEC-009。本WPと無関係)。`tests/unit/security-headers.test.ts` は18件。
  - `npm run typecheck`、`npx eslint <変更ファイル> --max-warnings=0`、`npx prettier --check <変更ファイル>`、`npm run check:all`: 成功。
  - `SOLVI_CSP_EXPECT=<mode> SOLVI_UPLOAD_EXPECT=<allowed|fail-closed> [SOLVI_UI_DEV=1] SOLVI_UI_BROWSER=<chromium|webkit> node tools/ui_security_headers_check.mjs`: 本番ビルド/開発サーバー × Report-Only/強制 × Chromium/WebKit の8回すべて PASS。主要導線の違反0件。
- §7 の充足と証拠:
  - 固定値ヘッダー・nonce の一意性と一致・HTTP で HSTS なし: `evidence/WP-P2-SEC-025/20261117-1606-headers/` と各 `summary.json` の `headers-*`。
  - 本番の `script-src` の禁止値: 単体テストと実画面の検査。
  - `iframe` の拒否: 各 `*-iframe-refused.png` と `summary.json` の `iframe refused`。
  - 主要導線の違反0件(Report-Only での観察)と強制モードへの切り替え: `dev-report-only` → `dev-enforce` / `prod-enforce`。切り替えの判断は Evidence の README に記録。
  - CSPを緩める環境変数・フラグが無い: 展開段階は `CSP_MODE` / `HSTS_MAX_AGE_SECONDS` のコード定数。ストレージの設定は決まった形のソースを1つ加えるだけで、検査を通らなければ何も加えない(ADR-0029 §2・§3、単体テスト)。
  - ADR-0029 の2項目: 単体テスト(値の検査15通り、ソースの形)と、実画面の検査(`dev-*` で添付のアップロード成功・違反0、別のバケットへの PUT は違反。`prod-*` で fail closed)。
- 実装上の判断(レビューで確認してほしい点):
  - `upgrade-insecure-requests` は **HTTPS の応答にだけ**付ける。WebKit が localhost でも https へ書き換え、ローカルの強制モードでログイン後の遷移が壊れたため。HTTP のページでは守るものが無い。HTTPS の判定は `X-Forwarded-Proto`(ALB が上書き)または URL。本番(HTTPS)の CSP は ADR-0027 §2 の一覧どおりである。
  - middleware は `_next/static`・`_next/image`・`favicon.ico` を除く全経路に付ける(静的ファイルは文書ではなく、nonce も不要)。
  - 検査ツールに、取得済みのブラウザを使う `SOLVI_UI_BROWSER_PATH`(任意)を加えた。本番の設定ではない。
- セキュリティ影響: ブラウザ向けの防御を追加(T-27・T-28)。`connect-src` に添付用バケットのパスを1つ加える(ADR-0029)。信頼境界・権限・RLS・監査・Executor境界・Secretは変えない。新しい依存パッケージなし。nonce はログに出さない。違反の記録は署名付きURLを残さない。
- 未解決事項: HTTPS の本番相当環境(ALB・本物の S3)での確認は未実施。HSTS の max-age の延長は運用で段階的に行う(Runbook §6.4)。Security Reviewer の sign-off(人間のレビュー)待ち。
- Evidence: `evidence/WP-P2-SEC-025/`(README に一覧)。

#### 利用者の承認(2026-11-17)

- **2026-11-17、利用者(人間)が PR #21(ADR-0029)と PR #22(本WPの実装)をマージした**(main の `bcd7f3a`・`f74f7c3`)。これをセキュリティ関連の変更に対する人間のレビュー(AGENTS.md §1.16、Security Reviewer の sign-off)として扱い、`done` とする。
- §7 はすべて充足している。Evidence は `evidence/WP-P2-SEC-025/`。両PRの CI は5ジョブすべて成功した。
- レビュー事項だった「`upgrade-insecure-requests` を HTTPS の応答にだけ付ける」扱いは、PR #22 のマージにより、この形で受け入れられたものとする。
- 残り: HTTPS の本番相当環境(ALB、本物の S3)での確認と、HSTS の max-age の段階的な延長(Runbook §6.4)は、本番環境の構築時に行う。インライン style の解消と `style-src 'unsafe-inline'` の撤去は、ADR-0027 の Follow-up(別WP)。
