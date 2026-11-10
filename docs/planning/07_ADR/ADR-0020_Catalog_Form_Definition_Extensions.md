---
project: SOLVI
doc_id: "ADR-0020"
title: "Catalog Form Definition Extensions"
category: "07_ADR"
type: "adr"
status: "accepted"
version: "0.1.0"
created: "2026-11-10"
updated: "2026-11-10"
owner: "SOLVI Product Team"
tags: ["adr", "catalog", "forms", "compatibility"]
source_of_truth: true
implementation_status: "in-progress"
---

# ADR-0020: Catalog Form Definition Extensions

## Context

[[WP-P2-UIX-040]]で日付・数値・複数選択、補足・条件・セクション・業務カテゴリを扱う。既存カタログ版と申請版はJSONBに保存され、申請時点の定義・値・hashを凍結している。既存版を補完更新する移行は行わない。

## Decision

1. `definition`の既存契約を維持し、`category?`（1〜80字）と`sections?`（最大10、key/title/任意description）を追加する。欠落した旧属性へdefaultを挿入しない。未設定カテゴリは表示時だけ「未分類」とする。
2. 質問は既存4型へdate（YYYY-MM-DDと任意minDate/maxDate）、number（有限数と任意min/max）、multiselect（2〜10の候補）を追加する。最大質問数10を維持する。共通のhelpTextは任意500字、sectionは定義のkey参照。
3. `visibleWhen?: { field, equals }`は同一定義内のselect/checkboxに対する単一一致。順序に依存しない有向非巡回参照に限定し、未知参照・自己参照・循環・型/候補不一致を拒否する。参照元が非表示なら子も非表示。
4. 申請値はstring/boolean/number/string[]。日付は実在日を厳密検証し、数値の空を0にしない。複数選択は未知値・重複を拒否して候補順へ正規化する。非表示値は検証・snapshotから除き、定義にないキーは拒否する。
5. `packages/shared/src/catalog.ts`をNode依存のない専用subpath `@solvi/shared/catalog`で公開し、APIとWebプレビューで同じ定義・検証を使う。既存shared barrelのNode機能をclient bundleへ入れない。依存の追加はしない。
6. カテゴリは版の一部として保存・公開し、模擬対象targetLabelから推測しない。新category queryで絞り込み、旧target queryは互換用に模擬対象での絞込みを維持する。表示・候補は既存認可を通った公開アイテムからだけ生成する。
7. 新セクションは定義順、未所属質問は先頭、各所属内の質問はfields順で表示する。条件は表示のためであり、権限やExecutor制御を代替しない。

## Consequences and Rollback

新テーブル・カラム・Migrationは不要。認可/RLS・監査・固定承認・既存hash規則を変えない。旧定義と旧申請は無変更で保持する。新形式保存後のrollbackは新形式を読めるコードを残し、編集UIのみ戻す。旧strict schemaのバイナリへの単純rollbackはできない。

## Verification

[[WP-P2-UIX-040]]のunit、実API/PGの保存・公開・申請・版固定・異組織拒否、Chrome/WebKitの操作とアクセシビリティで確認する。旧snapshot互換と非表示値の除去を独立して検証する。
