---
project: SOLVI
doc_id: "ASSETS-README"
title: "Assets README"
category: "assets"
type: "readme"
status: "baseline"
version: "0.2.0"
created: "2026-07-27"
updated: "2026-07-27"
owner: "SOLVI Product Team"
tags: ["assets"]
source_of_truth: true
implementation_status: "not-started"
---

# Assets

| ディレクトリ | 内容 | 扱い |
|---|---|---|
| `ui/` | SOLVIのUIモックアップ(4点) | 採用したコンセプト。**実装仕様の正本ではない**。相違点は[[11.13_Mockup_Asset_Index]]の正誤表を参照 |
| `brand/` | SOLVIロゴ(SVG) | 作業中のブランド資産 |
| `references/` | 参照画像 | SOLVIの仕様ではない。下記参照 |

## references/ の内訳

| ファイル | 由来 | 用途 |
|---|---|---|
| `Freshservice_Reference_Portal.png` | 現行Freshserviceの画面 | 移行対象機能の把握([[10.2_Freshservice_Function_Gap]]) |
| `Freshservice_Reference_Catalog.png` | 現行Freshserviceの画面 | 同上 |
| `Shirokuma_Vault_Structure.png` | **別プロジェクト(Shirokuma)のVault構造図** | SOLVIとは無関係。Vault構成の参考として残置。SOLVIの仕様と誤認しないこと。不要と判断した時点で削除してよい |

## 注意

- モックアップ内の日付・氏名・会社名・数値はすべてサンプルであり、実装要件ではない。
- 画像を差し替えた場合は`MANIFEST.md`を再生成すること。
