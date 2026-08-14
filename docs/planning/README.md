---
project: SOLVI
doc_id: "ROOT-README"
title: "SOLVI Obsidian Vault README"
category: "ROOT"
type: "readme"
status: "accepted"
version: "0.2.0"
created: "2026-07-27"
updated: "2026-07-27"
owner: "SOLVI Product Team"
tags: ["start-here"]
source_of_truth: true
implementation_status: "not-started"
---

# SOLVI Obsidian Vault README

SOLVI(ソルヴィ)は、社員が迷わず使える社内サポートポータルと、IT部門のチケット・ナレッジ・承認・資産・変更・自動化を統合する、AIネイティブなITサービス管理基盤です。

このVaultは**計画・設計の正本**です。会話履歴を参照しなくても、Codex appまたは人間の開発者がIssue化・実装・検証・運用設計へ進められる状態を目標としています。

## 文書のstatusを必ず確認してください

| status | 意味 |
|---|---|
| `accepted` / `baseline` | **実装根拠に使える**。変更にはADRまたはDecision Recordが必要 |
| `draft` | **骨子のみ。実装根拠に使えない**。該当Phase着手前に実体化する |

statusはfrontmatterで判定します。文書の見た目や分量で判断しないでください(AGENTS.md §0)。

## 最初に読むノート

1. [[00.1_Start_Here]] — 現在地と最初の成功条件
2. `AGENTS.md` — 実装時の絶対ルール
3. [[04.22_Gate_Definitions]] — 何をもって合格とするか
4. [[01.5_Scope_and_Non_Goals]] — 作るもの・作らないもの
5. [[02.1_Architecture_Overview]] — 全体構成と信頼境界
6. [[03.1_Requirements_Baseline]] — 要求レジストリ(101件)
7. [[06.0_WorkPackage_Register]] — 実行順序(件数とポイントはここが導出する)
8. [[07.0_ADR_Index]] — 変更してはいけない決定(18件)
9. [[99.12_Codex_First_Prompt]] — 実装への引き渡し

## 固定済みの中核原則

- PostgreSQLを業務状態の正本とする([[ADR-0003_PostgreSQL_System_of_Record]])
- AIは提案・検索・要約に限定し、特権操作を直接実行しない([[ADR-0007_AI_Advisory_Only]])
- Okta/Entra操作は分離したPrivileged Executorだけが実行する([[ADR-0006_Privileged_Executor_Separation]])
- 承認・実行・通知・監査を一つの追跡可能な流れとして扱う
- すべての特権操作は冪等で、Execution Receiptを残す([[02.16_Executor_Command_Contract]])
- Organization境界はAPI認可とRLSの二層で守る([[ADR-0015_Organization_Isolation_and_RLS]])
- 監査はappend-onlyとし、日次の外部アンカーで改ざんを検知する([[02.17_Audit_Event_Catalog]])
- 初期アーキテクチャはモジュラーモノリスとし、不要な分割を行わない([[ADR-0001_Modular_Monolith_First]])
- ユーザーポータルは「リクエスト」と「インシデント報告」の二導線を中心にする

## Vault構成

```text
SOLVI/
├── 00_Index/          索引・用語・決定・未決事項
├── 01_Product/        製品定義・スコープ・成功指標
├── 02_Architecture/   アーキテクチャと中核設計(Executor契約・監査・RLS・脅威モデル)
├── 03_Requirements/   要求レジストリ・カテゴリ別要求・RTM
├── 04_Development/    ロードマップ・Phase計画・Gate定義・テスト戦略
├── 05_Modules/        モジュール別設計
├── 06_WorkPackages/   WP台帳・依存マップ・各WP
├── 07_ADR/            アーキテクチャ決定記録(18件)
├── 08_Runbooks/       運用手順
├── 09_Templates/      各種テンプレート
├── 10_Research/       外部仕様の調査(実装前に再検証が必要)
├── 11_UI_UX/          画面仕様・状態・アクセシビリティ
├── 99_Project_Files/  リスク・移行・体制・引き渡し
└── assets/            モックアップ・ロゴ・参照画像([[assets/README|assets/README]])
```

## 現在の状態

| 項目 | 状態 |
|---|---|
| 設計正本 | Phase 0/1の実装に必要な範囲を確立済み |
| ADR | 18件 accepted |
| 要求 | 101件(孤立0件) |
| Work Package | [[06.0_WorkPackage_Register]] を参照(件数・ポイントは台帳が導出する) |
| 実装 | 未着手 |
| 最初の実装対象 | `WP-P0-GOV-001` |
| 最初の縦切りPoC | Oktaテストグループへのアクセス申請 → 承認 → 自動追加 → 証跡保存 |

## 注意

期間、外部API権限、Freshserviceのエクスポート仕様は**未検証の計画値**です([[99.7_Environment_and_Integration_Inventory]])。実装着手時に公式仕様と開発テナントで再検証し、変更はADRへ記録してください。未検証事項を確定事項として扱わないでください(AGENTS.md §4)。

## ファイル台帳

全ファイルのサイズとSHA-256は[MANIFEST.md](MANIFEST.md)にあります。ファイルを変更したら必ず再生成してください(手順はMANIFEST.md内に記載)。
