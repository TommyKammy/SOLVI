# クリーンホスト検証手順

NFR-MNT-002 / Gate 1 G1-7 の証跡を取得する手順。**所要時間を必ず計測して記録する。**

## 前提

- Node.js 22以上、Docker(Compose v2)、git のみがインストールされた状態
- リポジトリのクローン以外に手作業の準備をしていないこと

## 手順

```bash
# 1. 取得
git clone <repo> solvi && cd solvi

# 2. 依存
npm ci

# 3. 環境変数(既定値は入っていない。未設定なら起動時に失敗する)
cp .env.example .env

# 4. 起動
npm run up

# 5. スキーマ適用と合成データ
npm run db:migrate
npm run db:seed

# 6. ヘルスチェック
curl -fsS http://localhost:3001/healthz
curl -fsS http://localhost:3001/readyz

# 7. テスト
npm run typecheck && npm run lint && npm test
npm run test:integration
npm run test:security
npm run check:rls
```

## 記録すること

| 項目                                              | 値  |
| ------------------------------------------------- | --- |
| 実施日時                                          |     |
| ホストOS / Node / Docker のバージョン             |     |
| `npm ci` 所要時間                                 |     |
| `npm run up` からヘルスチェック通過までの所要時間 |     |
| 全テスト通過までの合計所要時間                    |     |
| 失敗した手順と対処                                |     |

Evidenceは `evidence/WP-P1-PLAT-001/<YYYYMMDD-HHMM>/clean-host.md` へ保存する。
