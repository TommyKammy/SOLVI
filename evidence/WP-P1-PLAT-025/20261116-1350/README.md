# WP-P1-PLAT-025 検証記録(2026-11-16 13:50 UTC)

ローカル開発の Object Storage を MinIO から SeaweedFS 4.52 へ置き換えた変更の検証。

## 環境

- macOS(Apple Silicon)、Colima の Docker 29.2.0、Node.js 26.13.0
- 基準コミット: `48c18b4`(main)+ 本ブランチの未コミット変更(コミット後の SHA は PR を参照)
- 既存の開発スタック(`solvi` プロジェクト)と混ざらないよう、Compose のプロジェクト名を `solvi-wp025`、ポートを PostgreSQL 55533 / Object Storage 19200 / API 3401 / Web 3400 に変えた使い捨ての環境で確かめた。`.env.example` を元にポートだけを書き換えた環境変数ファイルを使った(資格情報は `.env.example` の開発用の値のみ)。
- ClamAV は既存の開発スタックのもの(127.0.0.1:3310)を読取りだけで使った。
- 検証後、`docker compose -p solvi-wp025 down -v` でコンテナとボリュームを削除した。

## 結果(§7 Acceptance Criteria)

| # | 基準 | 結果 | 証拠 |
|---|---|---|---|
| 1 | キャッシュの無い状態で `docker compose up -d --wait postgres seaweedfs` が成功し healthy になる | 満たす。`chrislusf/seaweedfs:4.52` は未取得の状態から取得し、13秒で両方 healthy | `compose-up.txt` |
| 2 | `tools/ensure_buckets.mjs` を2回実行すると、1回目は2つ作成、2回目は変更なしで成功 | 満たす | `ensure-buckets.txt` |
| 3 | Compose の環境で object-storage / attachment-delete / attachment-scan が全件通る | 満たす。3ファイル33件通過(期限切れ署名の拒否を含む) | `storage-tests.txt` |
| 4 | CI の「DB・認可・監査」で Object Storage を使う11ファイルがすべて通る | PR の CI で確認する | PR を参照 |
| 5 | `minio/minio` のイメージ参照が無く `check:images` が通る | 満たす。`git grep minio/minio` は計画文書の説明文のみ、`check:images` 通過 | 下記コマンド |
| 6 | README と runbooks の手順だけで 1〜3 を再現できる | 満たす。README と `docs/runbooks/clean-host.md` に `node --env-file=.env tools/ensure_buckets.mjs` を追加 | 差分 |
| 7 | Docker 稼働時、`npm run dev:local` で SeaweedFS が使われ添付をアップロード・ダウンロードできる | 満たす。API 経由で、署名付き PUT 200 → ClamAV clean → 署名付き GET 200、内容一致、`Content-Disposition: attachment` | `dev-local-attachment.txt` |
| 8 | Docker 停止時、`dev:local` が日本語のエラーで止まり API・Web は起動しない | 満たす(Docker の接続先を存在しないソケットにして確認) | `dev-local-no-docker.txt` |
| 9 | `local_restore_runtime.mjs` の隔離復元で添付本体を SeaweedFS から取得でき内容が一致 | 満たす。復元元と復元先は別の SeaweedFS コンテナ | `restore-drill.txt` |
| 10 | `dev_object_storage.mjs` を削除し、参照がコードと現行手順書で0件 | 満たす。残る参照は本WPのノートのみ | 下記コマンド |
| 11 | 99.7 に「ローカルは SeaweedFS」と本番 S3 との差異を記載 | 満たす | 差分 |

ブラウザ画面での手動操作(基準7)は行っていない。同じ API(Web の添付操作が呼ぶもの)で、アップロードからダウンロードまでを確かめた。

## 実行したコマンド

```bash
docker compose -p solvi-wp025 --env-file <wp025.env> up -d --wait postgres seaweedfs
node --env-file=<wp025.env> tools/ensure_buckets.mjs   # 2回
node tools/migrate.mjs up && node tools/bootstrap_roles.mjs && npm run db:seed
npx vitest run tests/security/object-storage.test.ts tests/security/attachment-delete.test.ts tests/security/attachment-scan.test.ts
node --env-file=<wp025.env> tools/dev_local.mjs        # 起動後に API 経由で添付の往復を確認
DOCKER_HOST=unix:///nonexistent/docker.sock node --env-file=<wp025.env> tools/dev_local.mjs
npm run build -w packages/shared && node tools/local_restore_drill.mjs --runtime
npm run lint && npm run typecheck && npm run check:images && npm run check:all
git grep -n "minio/minio"; git grep -n "dev_object_storage"
docker compose -p solvi-wp025 --env-file <wp025.env> down -v
```

## 気づいた点(本WPの範囲外)

- `tools/local_restore_drill.mjs` は、実行後に復元用の PostgreSQL コンテナ(`solvi-restore-drill-<時刻>`)を停止したまま残す。検証後に手で削除した。
- `tools/local_restore_runtime.mjs` の結果の `workingDirectory` は相対パスにするつもりの処理だが、絶対パスのまま出力される(`root` の末尾の `/` の扱い)。本記録では伏せた。
- `packages/shared/src/storage/object-storage.ts` などのコメントに「MinIO」の記述が残る(WP §5 のとおり本WPでは変えない)。
