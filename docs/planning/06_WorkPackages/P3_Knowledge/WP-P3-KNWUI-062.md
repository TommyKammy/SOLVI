---
project: "SOLVI"
doc_id: "WP-P3-KNWUI-062"
title: "ナレッジ記事の構造化本文・版互換と読取API"
category: "06_WorkPackages"
type: "work-package"
status: "baseline"
version: "0.2.0"
created: "2026-11-21"
updated: "2026-11-21"
owner: "SOLVI Product Team"
tags: ["knowledge", "editor", "migration", "security"]
source_of_truth: true
implementation_status: "in-progress"
phase: "P3"
workstream: "KNWUI"
risk: "high"
story_points: 8
requirement_ids: ["FR-KNW-001", "FR-KNW-002", "FR-KNW-003", "NFR-SEC-005"]
depends_on: ["WP-P3-KNWUI-060"]
---

# WP-P3-KNWUI-062 ナレッジ記事の構造化本文・版互換と読取API

## 1. Purpose

既存のPostgreSQL記事版に形式を明示し、試作で利用者が受け入れた本文が下書き・レビュー・公開・復元を通じて保持されるようにする。ローカルSOLVIのWeb統合で、記事の作成・編集・閲覧をこの契約に接続する。

## 2. Requirement IDs

FR-KNW-001（記事版）、FR-KNW-002・003（閲覧・検索・引用）、NFR-SEC-005（入力防御）。

## 3. Dependencies

製品側の土台は [[WP-P3-KNWUI-060]] の記事管理画面。先行するローカル試作 WP-P3-KNWUI-061 で操作仕様を受入済み。採用した固定依存と境界は [[ADR-0030_Knowledge_Rich_Text_Editing]] にまとめた。人によるセキュリティ確認はマージ前に行う。

## 4. Scope / Allowed Paths

- `db/migrations/`（既存版テーブルへの追加型Migration）
- `packages/shared/src/`（本文型・許可リスト検証・検索用テキストの導出）
- `services/api/src/main.ts`（記事書込2経路のHTTP本文上限）
- `services/api/src/modules/knowledge/`（作成・更新・状態遷移・復元・一覧・詳細）
- `packages/shared/package.json`、`apps/web/package.json`、`package-lock.json`（試作と同じ版）
- `apps/web/src/`、`apps/web/public/`（ナレッジ編集、版の表示と固定引用）、`services/api/src/modules/ticket/collaboration.service.ts`（引用版の読取）
- `tests/unit/`、`tests/integration/`、`tests/security/`、`tests/support/knowledge/`（本文と記事版に関するケースのみ）
- `evidence/WP-P3-KNWUI-062/`
- `docs/planning/06_WorkPackages/P3_Knowledge/WP-P3-KNWUI-062.md`
- `docs/planning/MANIFEST.md`

## 5. Out of Scope

今回のローカル統合には段階3の編集画面と標準手順テンプレートを含む。組織別テンプレート管理と配布環境の更新は対象外。

## 6. Deliverables

Migrationと切戻し手順、形式を区別する本文の読取・書込契約、既存データ向けのテスト、PostgreSQLでのライフサイクル・権限検証記録。旧版を更新せず、新しい版へ構造化本文とサーバー導出テキストを同一トランザクションで保存する。

## 7. Acceptance Criteria

| ID | 操作 | 結果 |
|---|---|---|
| P1 | Migration前の旧記事に山括弧・改行を含むテキストを入れ、Migration後に既存クライアントで読む | 元の版・文字列・検索結果を保持。タグとして解釈しない |
| P2 | 太字、日本語の入れ子リスト、空白と改行を含むコード、見出し付き表をAPIから保存し、DB・詳細・一覧を照合する | 詳細の文書は期待JSONと一致。検索用本文はサーバー導出値に一致し、同じ記事版を指す |
| P3 | 同じ記事をレビュー・公開・改訂し、過去版から復元する。対象の公開版と引用先を読む | 各状態遷移の新しい版が元版の形式・本文を保持。未公開改訂は依頼者に見えず、旧版の固定引用を壊さない |
| P4 | 無効なノード・見出し・表・URL、本文上限超過、同一版への競合更新、構造化記事への旧形式更新を送る | 不正・競合や暗黙の書式消失を拒否。本文、版、監査の不整合を生じない。旧形式のみの記事では旧クライアントによる更新を維持 |
| P5 | 組織・役割・audienceの異なる主体で詳細・検索・書込・復元を実行 | API認可と既存RLSを満たす。既存の監査には本文やソースが混入しない |
| P6 | 読取を先行配布し、新形式の保存後に書込を停止して旧・新両形式を再表示する | 既存版を保ったまま切戻し可能。旧サーバーの書込みで書式を失う時間帯を作らない |

## 8. Verification and Evidence

既存のknowledge用DBフィクスチャでP1〜P6を実行する。送受信DTO・PostgreSQLの版・公開検索・引用先を合成記事で照合する。本WPは製品の実URLでChrome系・WebKitのHTML3往復、下書きの保存と再読込、レビュー・公開・依頼者表示、版競合、axeを検証する。試作の36ケースは比較元として利用する。

## 9. Security and Audit

サーバーがJSONを再検証し、許可した構造から読取用データを作る。管理画面の作業版と依頼者の公開版の分離、Organization境界、トランザクション内監査、既存の公開権限を適用する。セキュリティに関わる差分は人間がレビューする。

## 10. Rollback

新形式のデータを含む環境では、追加した列と読取互換コードを保持したままAPIに `KNOWLEDGE_RICH_WRITES=off` を設定して書式付き下書きの保存を休止する。配布時は全APIを読取対応版に揃えてから有効化する。列を削除するdownは、新形式が存在しないことを確認できる開発用DBで検証する。

## 11. Implementation References

[[ADR-0030_Knowledge_Rich_Text_Editing]]、[[ADR-0003_PostgreSQL_System_of_Record]]、[[ADR-0015_Organization_Isolation_and_RLS]]、[[ADR-0009_Append_Only_Audit]]、[[03.4_Knowledge_Requirements]]。形式は `bodyDocV1`。空段落・空セルだけの文書は保存不可。区切りの改行を含めUTF-16で20,000単位、JSONは160,000単位、ルート深さ0で最大32。構造化版への旧形式更新は409。

## 12. Definition of Done

P1〜P6を検証し、マージ前に人間がMigration・API・依存差分を確認する。

## 13. Execution Log

2026-11-21、製品組み込み依頼に基づき段階2のWP案を作成。製品ソースとDBは未変更。

2026-11-21、ローカルに統合した。変更ファイルはWebのknowledge画面・引用画面・編集部品・アイコン・API型、共有スキーマ、APIの記事・引用処理、依存manifestとlockfile、Migration 0043、本文・編集テスト。既存版への一括変換はない。

| 基準 | 確認した経路 |
|---|---|
| P1・P2 | 旧本文の山括弧と改行、新形式の保存、テキスト導出、公開検索と再読込 |
| P3 | 公開版3、固定引用、版1を復元した下書き版4の照合 |
| P4・P5 | 不正な本文、旧形式上書き、版競合、他組織・役割のアクセス、監査の版番号 |
| P6 | 書込休止時の読取、旧形式のみのdown/up、新形式保存後のdown拒否 |

Chromium・WebKitともHTML3往復、保存と再読込、公開・復元・引用を確認。セキュリティ影響はHTML・JSONの入力境界と依存追加。日本語IME実機は利用者指定で未判定。マージ前の人間レビューが残る。[結果・画像・実行コマンド](../../../../evidence/WP-P3-KNWUI-062/README.md)
