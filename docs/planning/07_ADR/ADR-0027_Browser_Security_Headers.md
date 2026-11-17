---
project: SOLVI
doc_id: "ADR-0027"
title: "ブラウザ向けセキュリティヘッダー(CSP・HSTS等)の付与場所と方針"
category: "07_ADR"
type: "adr"
status: "accepted"
version: "1.0.0"
created: "2026-11-16"
updated: "2026-11-17"
owner: "SOLVI Product Team"
tags: ["adr", "security", "csp", "hsts", "web"]
source_of_truth: true
implementation_status: "not-started"
---

# ADR-0027: ブラウザ向けセキュリティヘッダー(CSP・HSTS等)の付与場所と方針

## Status

**ACCEPTED**(2026-11-16 起票、同日に利用者(人間)が承認 / Owner: SOLVI Product Team)

- Supersedes: なし
- Superseded by: なし
- **Amended by: [[ADR-0029_CSP_Attachment_Upload_Origin]]**(2026-11-17。§2 の `connect-src` に、添付用バケットのパスに限ったソースを加える)
- 2026-11-16 に利用者(人間)が、下書きの判断事項を次のとおり決定した: `form-action` は `'self'` のみで進める / Referrer-Policy は `strict-origin-when-cross-origin` / `apps/api` の `nosniff` は既存の実装を本ADRの決定として追認する / 要求 NFR-SEC-011 と脅威 T-27・T-28 を新設する。同日、ADR全体を `accepted` とした。

## Context

- [[WP-P2-UIX-043]] の作業で、CSP(Content-Security-Policy)・HSTS・Referrer-Policy・Permissions-Policy 等のブラウザ向けヘッダーを入れる案が出た。セキュリティ境界の変更にあたるため(AGENTS.md §1.9)、ADRが無いまま実装せず、同WPから分離した。
- 2026-11-16 時点の事実:
  - `apps/web`(Next.js 15.5、App Router、`output: 'standalone'`)は、セキュリティヘッダーを一切付けていない。`next.config.mjs` に `headers()` は無く、`middleware.ts` も無い。
  - [[ADR-0018_Deployment_Baseline]] は「ALB(public) → api/web(private subnet)」までを決めており、ブラウザ向けヘッダーをどの層で付けるかは決めていない。
  - `apps/web/src` に `dangerouslySetInnerHTML` と `next/script` の利用は無い。インラインの `style={{...}}` は約136箇所ある。
  - 画面はほぼすべて認証後の動的ページで、ログインはServer Actionのフォーム送信([[ADR-0019_Local_Authentication_For_Development]])。本番では外部IdPのOIDCへ委譲する([[ADR-0004_External_Identity_OIDC]])。
  - 承認・特権操作の起点になるボタンを持つ業務アプリである(承認は [[ADR-0023_Relationship_Based_Approval_Authority]] 以降)。
- [[02.14_Threat_Model]] と [[03.11_Security_Requirements]] には、XSSの被害を抑える仕組みとクリックジャッキング(透明に重ねた画面で意図しない操作をさせる攻撃)を扱う脅威・要求が無い。
- 制約: 本番のSSO・外部連携を壊さないこと。依存パッケージを増やさないこと(§1.13)。検証可能であること(リポジトリ内のテストで確認できること)。

## Decision

### 1. 付与する場所

- **CSPは `apps/web` のmiddlewareで、リクエストごとのnonce方式で付ける。** nonceは描画と同じ層で作る必要があるため、ALBやingressでは持たない。
- **固定値のヘッダー(§3)も `apps/web` 側(`next.config.mjs` の `headers()` またはmiddleware)に一本化する。** 付与場所が2つあると、食い違いを検知しにくくなるためである。
- ALB側でのヘッダー付与は、本ADRでは行わない。多重防御として加えるかは Follow-up で再判断する。
- `apps/api` が返すJSONには、本ADRのCSPを適用しない(ブラウザが描画する文書ではない)。`X-Content-Type-Options: nosniff` は、`apps/api` が既に全応答に付けている(`services/api/src/common/http/server.ts`、`Cache-Control: no-store` と併せて)。これを本ADRの決定として追認し、付与場所は api 側のままとする。

### 2. CSPの内容(初期値)

```
default-src 'self';
script-src 'self' 'nonce-{per-request}' 'strict-dynamic';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self';
connect-src 'self';
form-action 'self';
frame-ancestors 'none';
base-uri 'none';
object-src 'none';
upgrade-insecure-requests
```

- `script-src` はnonce + `'strict-dynamic'` とし、`'unsafe-inline'` と `'unsafe-eval'` を本番で許さない。開発時の `next dev` が必要とする `'unsafe-eval'` は、`NODE_ENV=development` に限る。
- `style-src 'unsafe-inline'` は、インラインstyleが約136箇所あるため当面許す。スクリプトの実行は防げるため、XSS対策としての効果は主に `script-src` で確保する。インラインstyleの解消は Follow-up とする。
- `form-action` は `'self'` のみとする(2026-11-16 利用者決定)。検証段階のログインは自オリジンへのServer Action送信である([[ADR-0019_Local_Authentication_For_Development]])。本番のIdP([[ADR-0004_External_Identity_OIDC]])を接続するときに、そのオリジンを追加する後継ADR(またはamend)を起こす。ワイルドカードは使わない。
- 外部オリジン(CDN、解析ツール等)は許可しない。必要になったときは、本ADRの後継ADRで追加する。

### 3. 固定値のヘッダー

| ヘッダー | 値 | 備考 |
|---|---|---|
| `Strict-Transport-Security` | 段階的に `max-age=300` → `604800` → `31536000` | **`includeSubDomains` と `preload` は付けない**(ドメイン管理方針の確定後に後継ADRで判断する)。HTTPSで提供される本番・検証環境にだけ付け、`localhost` には付けない。 |
| `X-Content-Type-Options` | `nosniff` | |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | URLにチケットID等が載るため、外部へフルパスを送らない。同一オリジン内のRefererは残し、遷移元の判定やログ調査に使えるようにする(`no-referrer` は不採用。2026-11-16 利用者決定)。 |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=()` | 使う機能が出たら個別に許可する。 |
| `Cross-Origin-Opener-Policy` | `same-origin` | IdPのポップアップを使わない前提。ポップアップ方式を採るなら見直す。 |
| `X-Frame-Options` | `DENY` | `frame-ancestors 'none'` に対応しない古いブラウザ向けの保険。 |

### 4. 展開の手順

1. まず `Content-Security-Policy-Report-Only` で付け、ブロックはせず違反を観察する。固定値のヘッダーは最初から有効にする(HSTSは短いmax-ageから)。
2. 検証環境で、主要な導線(ログイン、ポータル、チケット、承認、ナレッジ、添付)の違反がゼロであることを確認してから、`Content-Security-Policy` へ切り替える。
3. 切り替えの判断と記録は、実装WPのEvidenceに残す。

### 5. 違反レポートの送り先

- **初期は `report-to` / `Reporting-Endpoints` を設定しない。** 違反はReport-Only期間中にブラウザのコンソールとE2Eテストで確認する。
- 理由: 違反レポートにはページのURL(チケットID等)が含まれる。外部SaaSへ送ると、データの外部送信として別の論点が増える。
- 収集が必要になった場合は、`apps/web` 内の自前エンドポイント(認証不要・レート制限・サイズ上限・URLのクエリ除去)として、後継ADRで決める。

### 6. 禁止事項

- 本番で `script-src` に `'unsafe-inline'`・`'unsafe-eval'`・`*`・`https:` を入れない。
- CSPを無効化・緩和する環境変数や機能フラグを本番に残さない(AGENTS.md §4 の「検証を省略するための一時的な例外」に当たる)。
- 利用者由来の値(チケット本文等)からCSPやヘッダーの値を組み立てない。

## Consequences

### 得られるもの

- XSSの不具合が入っても、外部スクリプトの読み込みとインラインスクリプトの実行を防げる。
- 承認画面などを外部サイトの `iframe` へ埋め込んでクリックさせる攻撃(クリックジャッキング)を防げる。
- ヘッダーがアプリ内のコードにあるため、ローカル・CI・本番で同じものを検証できる。

### 受け入れるコスト

- nonce方式のCSPでは、Next.jsのページが静的生成できなくなる(全ページが動的描画になる)。現在ほぼ全ページが認証後の動的ページのため影響は小さいが、公開ページを静的配信したくなった場合は再検討が必要になる。
- 外部のスクリプト・画像・フォントを足すたびに、ADRの更新とCSPの変更が必要になる。
- `style-src 'unsafe-inline'` を当面残すため、CSSを使った情報の抜き取り(CSSインジェクション)は防げない。
- Report-Only期間中の確認は人手と画面テストに頼る(レポートの収集基盤を持たないため)。
- HSTSを延ばしたあとでHTTPSをやめると、利用者のブラウザが最大1年アクセスできなくなる。

## Rejected Alternatives

- **ALB(またはingress)でCSPを付ける** — リクエストごとのnonceを作れず、`'unsafe-inline'` を許すか、ハッシュを手で管理するしかなくなる。Next.jsが生成するインラインスクリプトに追従できない。
- **CSPを付けず、固定値のヘッダーだけ入れる** — XSSが起きたときの被害を抑える仕組みが無いまま残る。
- **最初から強制モードのCSPを入れる** — インラインスクリプトやSSOの見落としで本番を壊すおそれがある。Report-Onlyで観察してから切り替えれば、同じ到達点に安全に行ける。
- **ハッシュ方式のCSP(`'sha256-...'`)** — ビルドごとに変わるNext.jsのインラインスクリプトのハッシュ管理が必要になり、運用で破綻しやすい。
- **外部SaaSへ違反レポートを送る** — URL(チケットID等)の外部送信になり、データの扱いを別途決める必要がある。現時点で収集の必要性が実証されていない。
- **HSTSで最初から `includeSubDomains; preload`** — preloadリストからの削除は数か月かかり、事実上元に戻せない。ドメインの管理方針が決まっていない。

## Security Impact

- 新たに扱う脅威([[02.14_Threat_Model]] へ追加済み):
  - T-27: XSSによるセッションの悪用・情報の抜き取り(T/I)。
  - T-28: クリックジャッキングによる承認・特権操作の誘発(T-08 の経路の一つ)、および通信のダウングレード(HSTSで緩和)。
- 対応する要求: [[03.11_Security_Requirements]] NFR-SEC-011。
- 信頼境界・権限・RLS・監査・Executor境界・Secretの扱いは変えない。
- CSPは多重防御であり、出力のエスケープ(Reactの既定)とサーバ側の入力検証(NFR-SEC-005)の代わりにしない。
- 新しい依存パッケージを追加しない。

## Operational Impact

- CSP違反でページの一部が動かない障害が起き得る。切り分けは、ブラウザのコンソールでの違反表示と、Report-Onlyへの切り戻しで行う。
- 切り戻しはReport-Onlyへ戻すデプロイで行う(CSPを外すのではなく、観察モードに戻す)。手順は実装WPで [[08.1_Deployment_Runbook]] に追記する。
- 本番のIdPを接続するときは、`form-action` へオリジンを追加する後継ADRとデプロイが必要になる。接続前に追加しないと、ログインのリダイレクトがブロックされる。

## Migration Impact

なし(スキーマ・データ・Freshservice移行に影響しない)。

## Follow-up

- [[WP-P2-SEC-025]]: 本ADRの実装(2026-11-16 に baseline 化)。
- 要求 NFR-SEC-011 と脅威 T-27・T-28 は 2026-11-16 に追加済み。WPの `requirement_ids` も差し替え済み。
- 本番IdPの接続時: `form-action` へIdPのオリジンを追加する後継ADR(またはamend)。
- インラインstyleの解消と `style-src 'unsafe-inline'` の撤去: 別WPとして起票する(再判断の時期: P2の完了前)。
- HSTSの `includeSubDomains` / `preload`: 本番ドメインの管理方針が決まった時点で後継ADRで判断する。
- 違反レポートの収集: 強制モードへの切り替え後に、見落としの報告が利用者から上がった場合に再判断する。
- ALB側での多重付与: [[ADR-0018_Deployment_Baseline]] の実装時に再判断する。

## Verification

- 単体テスト: middlewareが、リクエストごとに異なるnonceを生成し、CSPヘッダーと描画されたスクリプトのnonceが一致すること。本番設定で `script-src` に `'unsafe-inline'` / `'unsafe-eval'` が含まれないこと。
- E2Eテスト: 主要な導線で、CSP違反がコンソールに出ないこと。外部オリジンから `iframe` で読み込んだときに表示されないこと。
- ヘッダー検査: 本番相当のビルド(`next build && next start`)の応答に、§3のヘッダーがすべて付くこと。`localhost` でHSTSが付かないこと。
- PRレビュー: セキュリティ関連のPRとして人間のレビューを必須とする(AGENTS.md §1.16)。
