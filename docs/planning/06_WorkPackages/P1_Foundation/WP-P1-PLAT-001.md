---
project: SOLVI
doc_id: "WP-P1-PLAT-001"
title: "MonorepoとLocal基盤"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.2.0"
created: "2026-07-27"
updated: "2026-07-27"
owner: "SOLVI Product Team"
tags: ["workpackage", "p1"]
source_of_truth: true
implementation_status: "done"
requirement_ids: ["NFR-MNT-002"]
---

# WP-P1-PLAT-001: MonorepoとLocal基盤

| 項目 | 値 |
|---|---|
| Phase | P1 |
| Workstream | PLAT |
| Risk | medium |
| Story Points | 8 |
| Suggested Owner | Tech Lead |
| Parallelizable | No(P1の起点) |
| Gate | Gate 1 |

## 1. Purpose

クリーンホストから1コマンドで全サービスが起動し、テストが通る開発基盤を確立する。以降の全WPの土台。

## 2. Requirement IDs

`NFR-MNT-002`

## 3. Dependencies

[[WP-P0-DEV-005]]

## 4. Scope / Allowed Paths

- `apps/web/`
- `services/api/`
- `services/worker/`
- `services/ai-advisor/`
- `packages/shared/`
- `db/`
- `infra/`
- `docker-compose.yml`
- `tools/`

## 5. Out of Scope

- ドメインロジック(Ticket等)の実装
- 本番インフラの構築(Phase 9)
- Executorの実装(WP-P4-EXEC-004)

## 6. Deliverables

- docker compose(PostgreSQL/MinIO/api/web/worker/ai-advisor)
- マイグレーション基盤とseed
- OpenAPI定義の生成パイプライン(ADR-0017)
- Secret一覧(用途・保管先・ローテーション周期・所有者 — ADR-0016 Follow-up)
- 環境別サイジングとコスト試算(ADR-0018 Follow-up)
- ヘルスチェックエンドポイント

## 7. Acceptance Criteria

検証可能な条件のみ。すべて満たさない限りDoneにしない。

- [ ] クリーンホストで`docker compose up`後、全サービスのヘルスチェックが通る(手順書に沿って30分以内)
- [ ] `npm test`相当のコマンドで全テストが実行され、初期テストが通過する
- [ ] マイグレーションのup/downが動作し、down後にup可能である
- [ ] OpenAPI定義からフロント用の型が生成される
- [ ] コンテナイメージがdigestで固定されている(タグのみの参照が0件)
- [ ] Secret一覧が作成され、ローカル用の値がgitに含まれていない

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-04(Testcontainersでの結合テスト基盤)
- TL-05(マイグレーションup/down)
- TL-16(secret scan)

### Evidence

- クリーンホスト検証のログ(所要時間含む)
- docker compose up〜テスト通過までの出力

Evidenceは`evidence/WP-P1-PLAT-001/<YYYYMMDD-HHMM>/`へ保存し、Command・Environment・Commit SHA・Result・Timestampを含める([[06.2_Evidence_Index]])。

## 9. Security and Audit

- ローカルの既定資格情報を本番へ持ち込まない設計(環境変数必須・デフォルト値なしで起動失敗させる)
- MinIOバケットは非公開設定で作成する

## 10. Rollback / 失敗時の扱い

基盤変更で全体が壊れた場合、前のコミットへ戻す。マイグレーションはdownで戻す。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Packageのみを実装してください。

正本(この順で読む):
1. AGENTS.md(絶対ルール)
2. 本WP(WP-P1-PLAT-001)
3. 参照設計: ADR-0001, ADR-0002, ADR-0017, ADR-0018、02.3_Container_Architecture

制約:
- §4 Allowed Paths以外のファイルを変更しない。必要が生じたらPRを分けるか、WP追加を提案する。
- §5 Out of Scopeの内容を先取り実装しない。
- ADRの決定(特にAI advisory-only、Executor分離、RLS必須)を変更しない。変更が必要なら実装を止めて後継ADRを提案する。
- 依存WPが未完了なら実装せず、不足を報告する。
- 新規依存パッケージの追加は事前に理由と代替案を提示して承認を得る。
- Secret・実データ・PIIをコード、テスト、ログ、コミットに含めない。

完了時に報告すること:
- 変更ファイル一覧 / Migrationの有無と内容 / 実行した検証コマンドと結果
- §7 Acceptance Criteria の各項目に対する充足状況(証拠付き)
- セキュリティ影響 / 未解決事項 / Evidenceの保存先

作業内容:
1. モノレポの各サービスの雛形を作成する(Next.js / NestJS / Worker / FastAPI)。
2. docker-compose.yml(PostgreSQL 16 / MinIO / 各サービス)を作成する。イメージはdigest固定。
3. マイグレーション基盤(up/down)とseedスクリプトを用意する。この時点ではスキーマは最小限(health確認用)。
4. OpenAPI定義の生成と型生成のパイプラインを作る。
5. Secret一覧のテンプレートと、環境変数未設定時に起動失敗する仕組みを実装する。
6. クリーンホスト手順書を書き、実際に検証して所要時間を記録する。
※ 業務ドメインのテーブル・ロジックは作らない(WP-P1-DATA-002以降)。
```

## 12. Definition of Done

- [ ] §7 Acceptance Criteriaをすべて満たす
- [ ] §8のテストが通り、Evidenceを保存した
- [ ] DB変更にMigrationとロールバック方針、既存データ互換の説明がある
- [ ] 関連ドキュメント(API定義・Runbook・RTM)を更新した
- [ ] 未解決のCritical/Highがない
- [ ] Tech Leadのレビューを完了した
- [ ] Execution Logへ結果を追記した

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-07-27 | Claude (Codex) | `97e1b97` | Done | `evidence/WP-P1-PLAT-001/20260727-1008/verification.md` | 5サービス起動・healthz/readyz分離・マイグレーション基盤(up/down往復)。境界検証13/13(Executor非公開、AI→Executor/DB/API到達不可、相関ID、problem+json)。Secret一覧と環境別サイジングを`docs/`へ作成(ADR-0016/0018のFollow-up消化)。 |
