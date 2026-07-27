# SOLVI

社内向けITサービス管理基盤。ユーザーポータル、チケット、ナレッジ、申請承認、Okta/Entra自動化、資産、変更、AI支援を扱う。

計画・設計の正本は [`docs/planning/`](docs/planning/README.md)、実装時の絶対ルールは [`AGENTS.md`](AGENTS.md)。

## 前提

- Node.js 22以上(`.nvmrc`)
- Docker / Docker Compose
- Python 3.11以上(`services/ai-advisor` をコンテナ外で動かす場合のみ)

## クリーンホストからの起動

```bash
npm ci
cp .env.example .env
npm run up
npm run db:migrate
npm run db:seed
```

各サービスのヘルスチェックが通ることを確認する。

```bash
curl -fsS http://localhost:3001/healthz
curl -fsS http://localhost:3001/readyz
```

詳細な手順と所要時間の計測方法は [`docs/runbooks/clean-host.md`](docs/runbooks/clean-host.md)。

## 主なコマンド

| コマンド | 内容 |
|---|---|
| `npm run up` / `npm run down` | ローカルスタックの起動 / 破棄 |
| `npm run db:migrate` / `db:rollback` / `db:status` | マイグレーション |
| `npm run db:seed` | 開発用の合成データ投入 |
| `npm run typecheck` / `lint` / `test` | 静的検査とテスト |
| `npm run test:security` | 越境・認可・監査の防御テスト |
| `npm run check:rls` | 全テーブルのRLS設定と接続ロール権限の検査 |
| `npm run check:requirements` | 計画文書の要求⇔WP⇔ADR整合検査 |
| `npm run check:images` | コンテナイメージのdigest固定検査 |

## 構成

| パス | 内容 |
|---|---|
| `apps/web` | SOLVI Portal / Ops(Next.js) |
| `services/api` | Core API(NestJS)。業務ロジックと認可 |
| `services/worker` | Outbox配送とWorkflow |
| `services/executor` | SOLVI Run。特権操作のみを実行する分離サービス |
| `services/ai-advisor` | SOLVI Assist(FastAPI)。advisory-only |
| `packages/shared` | 共有の型・スキーマ・ユーティリティ |
| `packages/connectors` | Okta / Microsoft Graph アダプタ |
| `db/migrations` | SQLマイグレーション |
| `tests/` | unit / integration / security / e2e |
| `tools/` | マイグレーション、検査スクリプト |
| `infra/` | 監視・バックアップ・デプロイ定義 |
| `docs/planning/` | 計画の正本(Obsidian Vault) |

## 開発の進め方

1つの承認済みWork Package = 1つのブランチ = 1つのPR。詳細は [`AGENTS.md`](AGENTS.md) と [`docs/planning/06_WorkPackages/06.3_GitHub_Issue_Conversion_Guide.md`](docs/planning/06_WorkPackages/06.3_GitHub_Issue_Conversion_Guide.md)。

```bash
git worktree add ../worktree/WP-P1-DATA-002 -b wp/WP-P1-DATA-002
```

## セキュリティ上の不変条件

実装時に必ず守る(詳細は `AGENTS.md` §1)。

- 業務状態の正本はPostgreSQL。他は派生。
- AIは提案のみ。承認・実行・状態変更を行わない。特権資格情報を持たない。
- 特権操作は `services/executor` のみが実行し、承認状態を実行直前に再検証する。
- Organization境界はAPI認可とRLSの二層で守る。
- 監査はappend-only。アプリケーションロールからのUPDATE/DELETE経路を作らない。
- Secretをコミットしない。ログ・プロンプト・トレースにも出さない。
