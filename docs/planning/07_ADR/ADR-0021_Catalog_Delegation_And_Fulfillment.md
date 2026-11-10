---
project: SOLVI
doc_id: "ADR-0021"
title: "Catalog Delegation And Fulfillment"
category: "07_ADR"
type: "adr"
status: "baseline"
version: "0.1.0"
created: "2026-11-10"
updated: "2026-11-11"
owner: "SOLVI Product Team"
tags: ["adr", "catalog", "authorization", "fulfillment"]
source_of_truth: true
implementation_status: "review"
security_review_status: "pending"
---

# ADR-0021: Catalog Delegation And Fulfillment

## Decision

- 組織ロールcatalog_editorは、自身が保存済みownerである下書きの作成・編集だけを行う。全体staff、公開権限、UserAdmin、共有セット管理、チェック進捗更新へ昇格しない。委任は既存の管理者限定・理由/期限/監査付きgrant/revokeで扱う。
- 実測でDB/ホストの時計差による取消直後の誤許可を検出したため、保護APIのauthenticateでDBのclock_timestampをAuthzContext.nowとして渡し、DB日時で保存するRoleBindingの期限を同じ時計で評価する。役割は毎回DBから読み直す既存規則を維持し、セッション有効期間の契約は変更しない。
- catalog版へownerId/fulfillmentGroupId/checklistを任意属性として追加する。owner/groupを指定した場合は組織と有効性をサーバーで確認する。旧owner欠落のサービスは管理者だけが編集でき、旧APIの再送/公開契約を維持する。責任者未設定は公開前確認の注意として表示する。
- 管理一覧・詳細はAPIがcapabilityを返す。編集者の検索/一覧/detailは保存済みownerで絞り、他者は404。owner変更・公開・共有セット更新は管理者限定。UIの表示は認可の代替ではない。
- 共有質問セットは同組織のimmutable版として保存し、編集者は明示された版のコピーを挿入する。質問/セクション/条件キーを同時に再採番し、将来のセット更新を既存サービス・申請へ伝播させない。
- チケットの初期担当グループは、公開されたカタログ定義からサーバーが解決・再検証する。requesterへagent権限を偽装せず、TicketServiceの内部専用経路で初期属性として保存する。stateはnew。実際の作成者でticket.createdを監査し、catalog由来とgroupIdをmetadataへ記録する。手動割当変更ではないためticket_assignmentへ手動操作として記録しない。
- チェックリストの定義は申請snapshotの一部。進捗は組織・request・revision別の表と独立versionで保存し、進捗変更ではsnapshot/hash/申請version/承認を変更しない。approved時のagent/adminだけが更新し、必須未完了ではsimulateを拒否する。新しい申請revisionでは進捗を初期化し、旧進捗は保持する。
- 共有セット版はUPDATE/DELETE不可、進捗は楽観競合制御と監査付き。新表は組織FK・RLS FORCEを必須とする。既存の自己承認禁止・approval/hash gate・組織認可を緩和しない。

## Migration and Review

0036でロール制約・固定ロール・共有セット版・チェック進捗を追加する。新データのあるunsafe downは拒否し、readerとデータを保持してUI/書込みを戻す。人間のセキュリティレビューはpending。本ADRはローカル実装と検証の基準であり、レビュー完了や本番/main反映の承認を示さない。

## Verification

[[WP-P2-UIX-041]]で、編集者/他者/別組織/期限切れ/取消/公開/委任の拒否、共有版コピーの独立性、初期routing、必須チェックとhash不変、RLS、PC/375pxの実操作を検証する。
