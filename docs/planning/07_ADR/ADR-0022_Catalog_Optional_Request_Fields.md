---
project: SOLVI
doc_id: "ADR-0022"
title: "サービス別の共通項目表示と複数選択による質問分岐"
category: "07_ADR"
type: "adr"
status: "baseline"
version: "0.1.0"
created: "2026-11-11"
updated: "2026-11-11"
owner: "SOLVI Product Team"
tags: ["adr", "catalog", "forms"]
source_of_truth: true
implementation_status: "review"
---

# ADR-0022: サービス別の共通項目表示と複数選択による質問分岐

## Context

常に理由・利用日数を要求するフォームは、機器の一括手配や内容別の受付に適さない。[[ADR-0020_Catalog_Form_Definition_Extensions]]の任意属性・固定版・共有検証方針を維持し、条件ソースの制約部分だけを拡張する。既存の決定は書き換えない。

## Decision

1. 定義へ任意の`requestFields?: {reason?: boolean; duration?: boolean}`を追加する。各値省略はtrueと解釈し、schema parseでdefaultを挿入しない。ON時は従来の必須・候補・長さ制約を維持し、OFF時は入力を収集せず新snapshot.inputsから除去する。残るallowedDurations/maxReasonLengthは互換性とON復帰用に維持する。
2. create/edit DTOのreason/durationDaysを任意にし、保存済み定義を解決した後、共通の純粋関数で必須判定と正規化を行う。OFF値へ仮の文字列・日数を注入しない。冪等再送は元のsnapshot定義で正規化し、現在の公開版の変更と切り離す。
3. visibleWhenは既存の`{field,equals:string|boolean}`と新しい`{field,contains:string}`の排他的なunionとする。containsはmultiselectの既知候補だけ、equalsは従来のselect/checkboxだけに許可する。親が非表示なら子も非表示とし、循環拒否と隠れた回答の除去を継続する。AND/ORや任意式は導入しない。
4. プレビュー・申請・APIで`@solvi/shared/catalog`の解釈と検証を共用し、詳細/履歴/チケット/模擬結果は存在する共通値だけを出力する。旧snapshot/hash/承認を変更しない。
5. 条件は表示制御であり、権限・固定承認・特権操作の対象決定を代替しない。新規依存、認可/監査/RLSの変更はない。

## Consequences and Rollback

DDL/Migrationなし。JSONの任意属性とinputsの省略で拡張する。旧定義は従来動作を維持し、新形式保存後のrollbackは新形式readerを維持する。新規作成の合成例で柔軟なフォームを示し、既存公開サービスは自動上書きしない。

## Verification

[[WP-P2-UIX-042]]の4組合せ・直接API・条件DAG・snapshot固定/再送・Chrome/WebKitとaxeで検証する。
