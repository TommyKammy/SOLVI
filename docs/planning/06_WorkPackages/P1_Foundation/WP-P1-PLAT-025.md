---
project: SOLVI
doc_id: "WP-P1-PLAT-025"
title: "ローカル開発のObject StorageをMinIOからSeaweedFSへ置き換える"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.2.0"
created: "2026-11-16"
updated: "2026-11-16"
owner: "SOLVI Product Team"
tags: ["workpackage", "p1"]
source_of_truth: true
implementation_status: "not-started"
story_points: 8
risk: "medium"
workstream: "PLAT"
phase: "P1"
requirement_ids: ["NFR-MNT-002", "NFR-SEC-008"]
---

# WP-P1-PLAT-025: ローカル開発のObject StorageをMinIOからSeaweedFSへ置き換える

| 項目 | 値 |
|---|---|
| Phase | P1 |
| Workstream | PLAT |
| Risk | medium |
| Story Points | 8 |
| Suggested Owner | Tech Lead |
| Parallelizable | Yes(Object Storage に触れる他のWPと同時に進めない) |
| Gate | Gate 1 |

> 2026-11-16 に利用者が §5 の判断(`dev:local` も SeaweedFS へ切り替える)を決め、`baseline` とした。

## 1. Purpose

[[ADR-0028_Local_Object_Storage_Replacement]] の決定を、ローカル開発の環境へ反映する。MinIO のオープンソース版は配布が終了し、`docker-compose.yml` が固定しているイメージは取得できない。このWPが完了すると、キャッシュの無いマシンでも `docker compose up` と `npm run dev:local` のどちらでも、同じ SeaweedFS を Object Storage として使え、バケットも自動で用意される。Node 製の代替ストレージ(`tools/dev_object_storage.mjs`)は無くなる。

CI の「DB・認可・監査」ジョブへの SeaweedFS と ClamAV の追加は、PR #6 で先に行った(ADR-0028 の Verification を兼ねる)。本WPはそれをローカルの手順と揃える。

## 2. Requirement IDs

`NFR-MNT-002`, `NFR-SEC-008`

## 3. Dependencies

[[WP-P1-PLAT-001]], [[WP-P1-CI-006]]

前提: [[ADR-0028_Local_Object_Storage_Replacement]] が `accepted`(2026-11-16 充足)。PR #6(CI への SeaweedFS 追加)がマージ済みであること。

## 4. Scope / Allowed Paths

- `docker-compose.yml`
- `.env.example`
- `.github/workflows/ci.yml`
- `tools/ensure_buckets.mjs`
- `tools/dev_local.mjs`
- `tools/dev_object_storage.mjs`(削除)
- `tools/local_restore_runtime.mjs`
- `.gitignore`(`.local/object-storage` の扱いを変える場合のみ)
- `README.md`、`docs/runbooks/`
- `docs/planning/02_Architecture/02.1_Architecture_Overview.md`
- `docs/planning/99_Project_Files/99.7_Environment_and_Integration_Inventory.md`
- `docs/planning/08_Runbooks/08.1_Deployment_Runbook.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P1-PLAT-025/`

## 5. Out of Scope

- 本番の Object Storage(AWS S3)と、その設定(バージョニング・暗号化・Object Lock)。ADR-0010 / ADR-0018 / ADR-0009 のまま。
- `packages/shared/src/storage/object-storage.ts` の実装の変更。コメント中の「MinIO」の表記の修正も本WPでは行わない(コードの変更を伴わない文書差分は別PRにする)。
- 過去の WP の Execution Log と `evidence/` に残る「MinIO」の記述。記録は書き換えない。
- 開発者の `miniodata` ボリュームのデータ移行(合成データのため作り直す)。

### 決定済みの判断(2026-11-16、利用者)

`npm run dev:local` は、Docker を使わず `tools/dev_object_storage.mjs`(Node 製の、署名付きURLの一部だけを受ける開発専用の代替)を起動していた。MinIO が取得できなくなった後の回避策と見られる。次の3案から、**案1: `dev:local` も SeaweedFS(Docker)へ切り替え、`dev_object_storage.mjs` を削除する**に決めた。ADR-0028 の「ローカルの Object Storage は SeaweedFS」に一致させ、本番の S3 と違う実装を2つ抱えないため。`dev:local` の利用に Docker が必須になることを受け入れる。

- 退けた案2: 代替を「Docker 無しの軽量手段」として残す — S3 の挙動を部分的に真似る自前の実装を保守し続けることになり、差異の源が増える。
- 退けた案3: 本WPでは触れない — `dev:local` だけが MinIO 以前と違う仕組みで動き続ける。

## 6. Deliverables

- `docker-compose.yml`: `minio` サービスを SeaweedFS(`chrislusf/seaweedfs`、digest 固定、PR #6 と同じ版)へ置き換える。サービス名・ボリューム名・`api` と `worker` の `S3_ENDPOINT`・`depends_on` を合わせる。ヘルスチェックを持たせる。
- バケットの自動作成: `tools/ensure_buckets.mjs` を SeaweedFS で動くようにし、Compose の起動手順に組み込む。CI(`.github/workflows/ci.yml`)のバケット作成も AWS CLI からこのスクリプトへ寄せ、添付用と監査アンカー用の両方を作る。
- `.env.example`: Object Storage の見出しと既定値(ポート、コンソール用ポートの削除)を更新する。
- `README.md` と `docs/runbooks/`: MinIO の記述と「取得できないイメージが含まれます」の注意書きを、新しい起動手順に置き換える。既存の `miniodata` ボリュームを破棄する手順を書く。
- `npm run dev:local`: `tools/dev_local.mjs` が `dev_object_storage.mjs` の代わりに SeaweedFS(Compose の同じサービス)を起動または利用し、`ensure_buckets.mjs` でバケットを用意してから API・Web を起動する。Docker が無い・起動していない場合は、原因が分かる日本語のエラーで止める。
- `tools/local_restore_runtime.mjs`: 復元先の隔離環境で使う Object Storage を SeaweedFS に切り替える(復元先ごとに別のポート・保存先を使う現在の隔離の性質は保つ)。
- `tools/dev_object_storage.mjs` を削除する。参照が残っていないことを確かめる。
- 計画文書: 02.1 の対応表、99.7 の環境一覧(本番 S3 との差異: Object Lock・バージョニング・暗号化の有無)、08.1 の起動コマンドを更新する。

## 7. Acceptance Criteria

- [ ] Docker イメージのキャッシュを消したマシンで `docker compose up -d --wait postgres seaweedfs` が成功し、Object Storage のサービスが healthy になる
- [ ] 上記の直後に `node tools/ensure_buckets.mjs` を2回続けて実行すると、1回目は2つのバケットを作り、2回目は何も変えずに成功する(冪等)
- [ ] Compose の環境で `npm run test:security -- tests/security/object-storage.test.ts tests/security/attachment-delete.test.ts tests/security/attachment-scan.test.ts` が全件通る
- [ ] CI の「DB・認可・監査」ジョブで、Object Storage を使うテストファイル(object-storage、attachment-delete、attachment-scan、collaboration、collaboration-routes、ticket-relation、relation-routes、ticket-filters、assignment-group、notification、user-admin)がすべて通る
- [ ] リポジトリ内のイメージ参照に `minio/minio` が残っておらず、`npm run check:images` が通る
- [ ] `README.md` と `docs/runbooks/` の起動手順に従うだけで、上の3項目を再現できる(手順にない手作業が要らない)
- [ ] Docker が動いているマシンで `npm run dev:local` を実行すると SeaweedFS が使われ、ブラウザから添付をアップロード・ダウンロードできる(ClamAV の検査完了後)
- [ ] Docker が止まっているマシンで `npm run dev:local` を実行すると、Docker が必要だと分かる日本語のエラーで止まり、API・Web は起動しない
- [ ] `tools/local_restore_runtime.mjs` による隔離復元で、復元先の添付本体を SeaweedFS から取得でき、内容が元と一致する
- [ ] `tools/dev_object_storage.mjs` が削除され、`git grep dev_object_storage` がコードと現行の手順書で0件(過去の Evidence を除く)
- [ ] 99.7 に「ローカルは SeaweedFS(Compose と dev:local の両方)」と、本番 S3 との差異が記載されている

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])
- TL-04(clean-host での再現: イメージのキャッシュを消してからの起動)
- TL-16(供給網: digest 固定の検査)
- 既存の Object Storage の Contract Test(`tests/security/object-storage.test.ts`)

### Evidence
- キャッシュを消してからの `docker compose up` とバケット作成の出力、対象テストの実行結果、CI の run ID
Evidenceは`evidence/WP-P1-PLAT-025/<YYYYMMDD-HHMM>/`へ。Command・Environment・Commit SHA・Result・Timestampを含める。

## 9. Security and Audit

- 新しいコンテナイメージの取り込みは供給網の変更である。digest で固定し、人間のレビューを受ける(AGENTS.md §1.14・§1.16)。
- ローカルの資格情報は `.env.example` の開発用の値だけを使う。実在の資格情報を書かない(AGENTS.md §1.8)。
- ローカルの監査アンカー用バケットに Object Lock は無い。**ローカルで改ざん防止が効いていると誤解させない**記述を 99.7 と `ensure_buckets.mjs` に残す(ADR-0009)。
- 期限切れの署名を拒否すること(T-16)を、Contract Test で確認し続ける。

## 10. Rollback / 失敗時の扱い

MinIO には戻せない(イメージが取得できない)。SeaweedFS で問題が出た場合は、ADR-0028 の次点(RustFS)へ切り替える後継 ADR を起こし、前進修復する。`docker-compose.yml` と CI の変更は PR 単位で revert できるが、revert しても MinIO は起動しない。

## 11. Codex app Prompt

- 読む正本: 本WP、[[ADR-0028_Local_Object_Storage_Replacement]]、[[ADR-0010_S3_Compatible_Attachments]]、[[ADR-0018_Deployment_Baseline]]、[[WP-P1-PLAT-001]]、`tools/ensure_buckets.mjs` の冒頭コメント。
- 手順:
  1. §5 の決定済みの判断(案1)を読む。
  2. PR #6 の CI 設定(SeaweedFS の版・digest・起動引数・環境変数による資格情報)を正として、`docker-compose.yml` の `minio` を置き換える。
  3. `ensure_buckets.mjs` を SeaweedFS で動かし、Compose と CI の両方から使う。
  4. キャッシュを消したうえで §7 を順に確かめ、Evidence を残す。
  5. `dev_local.mjs` と `local_restore_runtime.mjs` を SeaweedFS に切り替え、`dev_object_storage.mjs` を削除する。
  6. 文書(README、runbooks、02.1、99.7、08.1)を更新し、MANIFEST を再生成する。
- やってはいけないこと:
  - `object-storage.ts` の実装を変えて、SeaweedFS の差異を吸収すること(差異が見つかったら止めて報告する)
  - 失敗するテストを skip・削除すること
  - digest を付けずにイメージを参照すること、`latest` を使うこと
  - 過去の Execution Log と Evidence の「MinIO」を書き換えること
  - `dev_object_storage.mjs` を残したまま、別名で同等の代替を作ること
- 完了時の報告: 変更ファイル、§7 の各項目の結果と証拠、CI の run ID、未解決事項。

## 12. Definition of Done

- [ ] §7をすべて満たす / §8のテスト通過とEvidence保存
- [ ] Migration は無いこと、既存の `miniodata` を破棄する手順の説明
- [ ] 関連ドキュメント(README・runbooks・02.1・99.7・08.1)の更新
- [ ] 未解決のCritical/Highがない
- [ ] 人間のレビュー(コンテナイメージの追加のため)
- [ ] Execution Logへ追記

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| - | - | - | Not started | - | - |
