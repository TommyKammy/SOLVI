# SOLVI

社内向けITサービス管理基盤。ユーザーポータル、チケット、ナレッジ、申請承認、Okta/Entra自動化、資産、変更、AI支援を扱う。

計画・設計の正本は [`docs/planning/`](docs/planning/README.md)、実装時の絶対ルールは [`AGENTS.md`](AGENTS.md)。

## 2026-10-03 のローカル試用

申告 → 担当者の引き受け → 対応 → 公開返信と解決 → 利用者の確認・再開を試せます。
起動・開発アカウント・制限は [チケット業務の試用手順](docs/runbooks/local-ticket-flow.md) を参照してください。
`npm run dev:local` で API・Web・開発専用ストレージ・添付検査をまとめて起動します。添付は ClamAV の検査完了後に開けます。`/knowledge` で記事検索、担当者の下書き・レビュー、管理者による組織内公開、返信への記事版引用も試せます。`/catalog` → `/requests` では申請・承認・却下・変更時の再承認・ローカル模擬実行を試せます。模擬結果はPGへ保存し、依頼チケットを解決します（外部変更0件）。`/assets` は手入力の資産登録・検索・状態と利用者の管理・変更履歴を備え、チケット画面と双方向にたどれます。`/assets/imports` では合成CSVの列対応・差分・不正行を確認して正常行だけを確定できます。同じ取込元と外部IDで再取込しても重複せず、省略資産を削除しません。`/changes` とTicket/Asset詳細からは、通常変更の計画→別担当者承認/却下→予定→合成実施結果/PIRを試せます。計画/対象が変われば再承認となり、外部変更は0件です。MinIO の公式配布変更により、以下の旧フルスタック起動には取得できないイメージが含まれます。現在は上記の試用手順を使ってください。

## 入口とフォームの復帰

ログイン後の `/` は、担当者・承認者なら `/inbox`、一般利用者なら `/portal`、監査者なら `/changes` に案内します。ヘッダーで「担当業務」と「相談・申請」を分け、選択組織と現在地を表示します。検索一覧から詳細・編集へ進んでも「元の画面へ戻る」で条件を保って戻れます。主要フォームは項目直下に日本語のエラーを表示し、修正・再送まで入力と選択値を保持します。[代表確認と残課題](evidence/WP-P2-UX-028/20261003/README.md)を参照してください。

## ローカル試作の現在地

ポータルとチケット対応、検査付き添付、記事の公開・検索・版引用、サービスカタログの管理/申請/独立承認/模擬結果、資産台帳・CSV差分取込・チケット関連、通常変更の承認/予定/合成結果/PIR、役割別受信箱まで永続化して試せます。Next.jsは15系保守版15.5.27、Reactは19.0.4に固定しました。主要補助フォームも失敗後の入力保持と再送へ接続済みです。[安定化の確認記録](evidence/WP-P2-STAB-029/20261003/README.md)を参照してください。

このMacでの主要な合成フローを確認済みです。起票と申請作成/再申請は、明示操作でこのタブに2時間一時保存し、再読込や同一利用者の再ログイン後に差分を見て復元できます。共有PC・機微情報には使わないでください。隔離した合成DBのbackup/restoreも確認済みです（現行DB/資格情報は持ち出しません）。RECOVER-031で、同一Macの別DB/ポート/保存先へ合成データと添付本体を復元し、API/WebのHTTP表示とダウンロード一致も確認しました。続くREFINE-032では、本人返信による対応/SLA再開、内部/公開本文の分離、発言者表示、申請検索と自分の承認待ち一覧を改善しました。[改善前/後と確認記録](evidence/WP-P2-REFINE-032/20261003/README.md)を参照してください。既存環境では0033の追加Migrationだけ適用し、seedは再実行しません。SSO/SCIM、実通知、実権限操作、実端末収集、公開/本番ストレージと運用移行は外部環境・人間判断を要する別段階です。現在の自動化は模擬記録であり、本番の特権操作やAI運用自動化の完成を意味しません。

[下書き復元・隔離Restoreの確認記録](evidence/WP-P2-DRAFT-030/20261003/README.md)と[試用手順](docs/runbooks/local-ticket-flow.md)を参照してください。

[開発サマリー](docs/development-summary.md)に実装範囲・チェック・起動・既知の制限と次段階の判断をまとめました。[復元先API/Web・添付本体の証跡](evidence/WP-P2-RECOVER-031/20261003/README.md)も参照できます。

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

| コマンド                                           | 内容                                      |
| -------------------------------------------------- | ----------------------------------------- |
| `npm run up` / `npm run down`                      | ローカルスタックの起動 / 破棄             |
| `npm run db:migrate` / `db:rollback` / `db:status` | マイグレーション                          |
| `npm run db:seed`                                  | 開発用の合成データ投入                    |
| `npm run typecheck` / `lint` / `test`              | 静的検査とテスト                          |
| `npm run test:security`                            | 越境・認可・監査の防御テスト              |
| `npm run check:rls`                                | 全テーブルのRLS設定と接続ロール権限の検査 |
| `npm run check:requirements`                       | 計画文書の要求⇔WP⇔ADR整合検査             |
| `npm run check:images`                             | コンテナイメージのdigest固定検査          |

## 構成

| パス                  | 内容                                          |
| --------------------- | --------------------------------------------- |
| `apps/web`            | SOLVI Portal / Ops(Next.js)                   |
| `services/api`        | Core API(TypeScript)。業務ロジックと認可      |
| `services/worker`     | Outbox配送とWorkflow                          |
| `services/executor`   | SOLVI Run。特権操作のみを実行する分離サービス |
| `services/ai-advisor` | SOLVI Assist(FastAPI)。advisory-only          |
| `packages/shared`     | 共有の型・スキーマ・ユーティリティ            |
| `packages/connectors` | Okta / Microsoft Graph アダプタ               |
| `db/migrations`       | SQLマイグレーション                           |
| `tests/`              | unit / integration / security / e2e           |
| `tools/`              | マイグレーション、検査スクリプト              |
| `infra/`              | 監視・バックアップ・デプロイ定義              |
| `docs/planning/`      | 計画の正本(Obsidian Vault)                    |

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

## ローカル業務受信箱

`npm run dev:local` の `/inbox` から、自分の担当チケット、指名されたカタログ/Change承認、変更予定とPIRを確認できます。検索・期限表示・新しい更新・既読の保存まで接続しています。既読にしても作業は残り、判断/完了/担当変更で現在の一覧を更新します。既存環境はMigration0031を追加適用（seed再実行/初期化不要）。[試用手順](docs/runbooks/local-ticket-flow.md)と[確認記録](evidence/WP-P2-INBOX-027/20261003/README.md)を参照してください。

## カタログを管理する

組織管理者の `/catalog/manage` で、下書き作成・編集・保存プレビュー・公開/非公開と固定承認者を設定できます。短文/長文/選択/確認チェックを追加し、公開版からの利用者申請・独立承認・模擬結果へ接続します。設定変更は新規申請へ適用し、既存申請の定義・入力・承認は保持します。既存環境の追加Migrationは0032。[試用手順](docs/runbooks/local-ticket-flow.md)と[確認記録](evidence/WP-P4-CAT-001/20261003/README.md)を参照してください。
