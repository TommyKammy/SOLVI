# WP-P3-KNWUI-059 検証記録(2026-11-17 04:30 UTC)

`evidence/WP-P3-KNWUI-054/20261007/` の補助モジュール3つ(`751d6ae` で失われた)を、テストが要求する性質から `tests/support/knowledge/` に作り直した変更の検証。

## 環境

- macOS(Apple Silicon)、Colima の Docker、Node.js 26.13.0
- CI と同じ構成を使い捨てで用意した。
  - PostgreSQL 16.6(`127.0.0.1:5432`、DB `solvi_wp021_wp020_wp019_wp018_wp015_test`)
  - SeaweedFS 4.52(`127.0.0.1:9100`)
  - ClamAV は既存の開発スタックのもの(`127.0.0.1:3310`)を読取りだけで使った。
- 環境変数は CI の「DB・認可・監査」ジョブと同じ(`CI=true GITHUB_ACTIONS=true`、ジョブ内の使い捨ての資格情報)。
- 前処理: `ensure_buckets` → `db:migrate` → `bootstrap_roles` → `db:seed`。
- 検証後にコンテナを削除した。

## 結果

| 確認 | 結果 |
|---|---|
| `npx vitest run tests/unit/knowledge-list.test.ts` | 78件成功 |
| `npx vitest run tests/security/knowledge-pagination.test.ts`(CI 経路) | 17件成功 |
| 通知4ファイル(CI 経路、まとめて実行) | 223件中222件成功。失敗1件は下記の時計差 |
| `npm run test:security -- --exclude tests/security/user-directory-consistency.test.ts`(CI 経路) | 44ファイル中42ファイル、1181件中1179件成功。失敗2件は下記の時計差 |
| `notification-list`(ローカルのコンテナ経路、`CI` を外して実行) | 37件成功。ラベル `solvi.work-package=WP-P3-KNWUI-054` のコンテナは残らなかった |
| 実行後の `solvi_wp054_test_%` のDB | 0件 |
| 通知テストが書く `database-lifecycle*.json` | `.gitignore` で除外され、追跡されるのは `.gitkeep` だけ |

### 時計差による失敗(ローカルだけ)

Colima の VM の時計が、Mac の時計より約40ミリ秒進んでいた(`clock_timestamp()` と Node の `Date.now()` の差を3回測り、いずれも 40.4〜40.5ms)。

次の2件は、PostgreSQL が付けた時刻と Node が付けた時刻を比べるため、この差で失敗した。

- `notification-retry`「committed failure is retried …」
  - 期待は 20000ms 以上の待ち時間で、実測は 19987ms だった。
  - `available_at` は Node の時刻から計算し、`created_at` は DB の `now()` で付く。
- `notification-manual-retry`「rechecks actual time when an org-admin grant expires …」
  - 役割の期限は DB の時計で切れ、アプリは Node の時計で確かめる。
  - 通知4ファイルをまとめて実行したときは通過した。

CI ではテストと PostgreSQL が同じホストの時計を使うので、この差は生じない。CI の結果で確定する。

## 実行したコマンド

```bash
npx vitest run tests/unit/knowledge-list.test.ts
npx vitest run tests/security/knowledge-pagination.test.ts
npx vitest run tests/security/notification-list.test.ts tests/security/notification-manual-retry.test.ts tests/security/notification-preference.test.ts tests/security/notification-retry.test.ts
npm run test:security -- --exclude tests/security/user-directory-consistency.test.ts
env -u CI -u GITHUB_ACTIONS npx vitest run tests/security/notification-list.test.ts
docker ps -a --filter label=solvi.work-package=WP-P3-KNWUI-054
psql -c "SELECT datname FROM pg_database WHERE datname LIKE 'solvi_wp054%'"
```
