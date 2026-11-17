---
project: SOLVI
doc_id: "ADR-0028"
title: "ローカル開発・CIのS3互換Object StorageをMinIOから置き換える"
category: "07_ADR"
type: "adr"
status: "accepted"
version: "1.0.0"
created: "2026-11-16"
updated: "2026-11-16"
owner: "SOLVI Product Team"
tags: ["adr", "object-storage", "attachments", "local", "ci", "supply-chain"]
source_of_truth: true
implementation_status: "not-started"
---

# ADR-0028: ローカル開発・CIのS3互換Object StorageをMinIOから置き換える

## Status

`accepted`(2026-11-16 起票、同日に利用者(人間)が承認。方向性と、第一候補を SeaweedFS として下記「Verification」で採否を決める進め方を承認)。

本ADRは、[[ADR-0010_S3_Compatible_Attachments]] の「ローカル開発はMinIOを使う」と、[[ADR-0018_Deployment_Baseline]] の「ローカルは Docker Compose(PostgreSQL + MinIO + 各サービス)」のうち **MinIO の部分だけ**を Supersede する。両ADRのその他の決定(本番は AWS S3、署名付きURL、バージョニング、サーバサイド暗号化、Compose を基準とすること等)は変えない。

## Context

### MinIO のオープンソース版が配布終了した

2026-11-16 に CI へ MinIO を追加しようとして(PR #6)、次を確認した。

- Docker Hub の `minio/minio` リポジトリが存在しない(`hub.docker.com/v2/repositories/minio/minio/` が 404、`docker pull` は `repository does not exist`)。`docker-compose.yml` が digest で固定している `minio/minio:RELEASE.2024-11-07T00-52-20Z@sha256:ac5918…` も取得できない。
- `quay.io/minio/minio` は匿名で取得できない(401)。
- 公式バイナリ配布 `dl.min.io` は HTTP 410 を返し、オープンソース版の MinIO Server・MinIO Client(mc)・KES はアーカイブされ保守されない、セキュリティ更新も脆弱性報告の受付もしない、と案内している。

その結果、次の2つが壊れている。

1. **CI**: 「DB・認可・監査」ジョブの `object-storage` / `attachment-delete` / `attachment-scan` は、Object Storage が無いため失敗し続けている。
2. **ローカル開発**: イメージのキャッシュが無い環境では `docker compose up` が MinIO を取得できず、環境を新しく作れない。

### SOLVI が Object Storage に求めること

本番は AWS S3 のまま([[ADR-0018_Deployment_Baseline]])。ローカルと CI の置き換え先は、`packages/shared/src/storage/object-storage.ts` が使う次の機能を、本番の S3 と同じ意味で満たす必要がある。

- AWS Signature V4 のクエリ署名(署名付きURL)で GET / PUT / DELETE ができる
- `X-Amz-Expires` を過ぎた署名を拒否する(T-16。期限切れの署名で取得できないことをテストしている)
- 署名付き GET の `response-content-disposition` と `response-content-type` による応答ヘッダーの上書き(添付を常にダウンロードさせる)
- パス形式の URL(`endpoint/bucket/key`)
- 日本語・空白・括弧などを含むファイル名でも署名が一致する

ADR-0010 のバージョニングとサーバサイド暗号化は本番バケットの設定であり、ローカルでの再現は必須としない(差異は [[99.7_Environment_and_Integration_Inventory]] で管理する)。

## Decision

**ローカル開発と CI の Object Storage を SeaweedFS(S3 API)に置き換える。** ただし、下記「Verification」をすべて満たすことを採用の条件とする。満たさなければ、次点の RustFS で同じ検証を行う。

- イメージは digest で固定する(AGENTS.md §1.14)。
- バケットの作成を手作業にせず、Compose と CI の起動手順に含める(現状は MinIO のバケットを手で作っていた)。
- アプリケーションのコード(`S3CompatibleStorage`)は変えない。S3 互換の範囲で差し替える。

### 候補の比較(2026-11-16 時点)

| 候補 | ライセンス | 保守状況 | SOLVI の要件との適合 | 評価 |
|---|---|---|---|---|
| **SeaweedFS** | Apache-2.0 | GitHub で活発(2026-11-16 に push)、Docker Hub `chrislusf/seaweedfs` も同日更新。長い運用実績 | ソースに `response-content-disposition` の処理がある(`weed/s3api`)。単一コンテナで S3 API を起動できる | **第一候補** |
| RustFS | Apache-2.0 | 活発(1.0 GA は 2026-09、Docker Hub `rustfs/rustfs` 1.0.6 は 2026-11-15) | MinIO に近い置き換えを目指している。応答ヘッダー上書きの実装はソース上で未確認 | 次点。1.0 からの日が浅い |
| Versity S3 Gateway | Apache-2.0 | 活発(v1.11.0 は 2026-11-10) | ローカルディレクトリを S3 として公開する軽量な実装。GET での上書きはソースに処理がある | 候補。利用者の規模が小さい |
| Garage | AGPL-3.0 | 活発 | 応答ヘッダー上書きは機能要望として issue がある(実装状況は未確認) | 不採用寄り |

保守状況は Docker Hub と GitHub の API で確認した。機能の対応は**ソースコードの検索で当たりを付けただけ**で、動作は確認していない。採否は下記の検証で決める。

## Consequences

### 得られるもの

- 保守されていて、セキュリティ更新を受け取れる実装に戻る
- CI の Object Storage を使うテスト(3ファイル)を、スキップせずに実行できるようになる
- ローカル環境を新しく作れるようになる。バケット作成も自動になる

### 受け入れるコスト

- 本番の S3 との差異の源が MinIO から別の実装に変わる。差異は Contract Test(既存の `tests/security/object-storage.test.ts` ほか)で検出する
- 開発者のローカルにある MinIO のデータ(`miniodata` ボリューム)は引き継がない。開発用の合成データなので作り直す
- MinIO の管理コンソール(9101)は無くなる

## Rejected Alternatives

- **アーカイブ済みの MinIO をソースからビルドして使い続ける** — ADR の変更は不要だが、セキュリティ更新も脆弱性の受付も無いソフトウェアを開発・CI に残すことになる。ビルド手順を自前で保守する負担もある。
- **LocalStack** — 2026-03 以降、最新版の利用にアカウントと認証トークンが必要になった。CI に外部サービスの資格情報を置くことになり、Object Storage 以外の機能は不要。
- **CI だけモックで済ませる** — 署名・期限切れ・応答ヘッダーの上書きという、守りたい性質そのものを検証できなくなる。
- **CI で本物の AWS S3 を使う** — CI に AWS の資格情報が必要になり、PR ごとに外部へ書き込むことになる。

## Security Impact

- 対象はローカル開発と CI のみ。本番の Object Storage(AWS S3)と、その権限・暗号化・署名付きURLの方針は変わらない。
- 新しいコンテナイメージを取り込むため、供給網の変更として人間のレビューを要する(AGENTS.md §1.16)。digest で固定し、更新はレビュー対象の PR で行う。
- CI の資格情報はジョブ内だけの使い捨ての値とし、Secret として扱う実値を置かない。
- 期限切れ署名の拒否(T-16)を置き換え先でも検証できることを、採用の条件に含める。

## Migration Impact

- 業務データの移行は無い(本番は S3 のまま)。
- 変更対象: `docker-compose.yml`、`.env.example`(`S3_PORT` 等の既定値)、`.github/workflows/ci.yml`、[[99.7_Environment_and_Integration_Inventory]]、[[02.1_Architecture_Overview]] の対応表。
- 開発者は `miniodata` ボリュームを破棄し、新しいサービスで環境を作り直す。手順は実装 WP の Execution Log と README に書く。

## Rollback

置き換え先に問題が見つかった場合、MinIO には戻れない(取得できないため)。次点の候補へ切り替える後継 ADR を起こす。CI の変更は PR 単位で revert できる。

## Verification

採用の条件。第一候補で、次をすべて CI 上で確認する。

1. `tests/security/object-storage.test.ts` が全件通る(署名付き GET/PUT、日本語・空白・括弧・アポストロフィ・アスタリスクを含むファイル名、常に添付としてダウンロードさせる、期限切れの署名で取得できない、サーバ側からの読込)
2. `tests/security/attachment-delete.test.ts` と `tests/security/attachment-scan.test.ts` が、Object Storage 起因で失敗しない
3. Object Storage を使う他のテスト(`collaboration`、`ticket-relation` ほか)が、MinIO の時と同じ結果になる
4. イメージが digest で固定され、`npm run check:images` が通る

### 検証結果(2026-11-16、SeaweedFS 4.52)

PR #6 の CI(run 43871899428、commit `c8a9285`)で、上記4条件をすべて満たした。**SeaweedFS を採用する。**

1. `object-storage.test.ts` 11件すべて通過
2. `attachment-delete.test.ts` 14件、`attachment-scan.test.ts` 8件すべて通過
3. `collaboration`、`collaboration-routes`、`ticket-relation`、`relation-routes`、`ticket-filters`、`assignment-group`、`notification`、`user-admin` も全件通過
4. `chrislusf/seaweedfs:4.52@sha256:57877e…` で `check:images` 通過

## Follow-up

- 実装 WP を起票する(Compose・CI・`.env.example`・文書の更新)。PR #6 の MinIO 部分はこの WP で差し替える。ClamAV 部分はそのまま使える。
- ADR-0010 と ADR-0018 の Status に「ローカルの MinIO は ADR-0028 が Supersede」と追記した(決定本文は書き換えていない)。
