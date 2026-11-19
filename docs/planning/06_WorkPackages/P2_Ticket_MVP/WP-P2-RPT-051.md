---
project: "SOLVI"
doc_id: "WP-P2-RPT-051"
title: "SLA・対応件数レポートと組織の監査ログ閲覧"
category: "06_WorkPackages"
type: "work-package"
status: "baseline"
version: "0.1.0"
created: "2026-11-19"
updated: "2026-11-19"
owner: "SOLVI Product Team"
tags: ["ui", "report", "sla", "audit"]
source_of_truth: true
implementation_status: "review"
workstream: "RPT"
phase: "P2"
risk: "medium"
story_points: 8
requirement_ids: ["FR-TKT-006", "FR-TKT-008", "AUD-001", "AUD-002", "NFR-UX-002", "NFR-UX-003", "NFR-UX-004"]
depends_on: ["WP-P1-AUD-018", "WP-P2-SLAUI-016", "WP-P2-SEARCH-017", "WP-P2-UIX-044", "WP-P4-APR-014"]
---

# WP-P2-RPT-051 SLA・対応件数レポートと組織の監査ログ閲覧

## 1. Purpose

第7段階。担当者は受付日と担当グループでチケットを絞り、受付・解決済み・未完了・稼働中の解決期限超過の件数から、同じ条件の対象一覧と詳細に進む。監査担当者は選択中の組織で、承認・権限変更・アクセスレビューの期間と種別を絞り込み、記録の詳細を読む。

## 2. Requirement IDs

`FR-TKT-006`、`FR-TKT-008`、`AUD-001`、`AUD-002`、`NFR-UX-002`〜`NFR-UX-004`。

## 3. Dependencies

[[WP-P1-AUD-018]]、[[WP-P2-SLAUI-016]]、[[WP-P2-SEARCH-017]]、[[WP-P2-UIX-044]]、[[WP-P4-APR-014]] は baseline・done。第6段階を含む `1daf2ae` を基点とする。レポートには既存のチケット検索、SLA判定、件数、担当グループの絞り込みを使う。監査閲覧には [[03.19_Migration_and_Audit_Requirements]] の AUD-002 と [[ADR-0009_Append_Only_Audit]] の権限・追記専用の方針を適用する。

## 4. Scope / Allowed Paths

- `services/api/src/common/audit/audit.ts`
- `services/api/src/modules/audit/audit-events.routes.ts`
- `services/api/src/main.ts`
- `apps/web/src/app/ops/reports/page.tsx`
- `apps/web/src/app/ops/audit/page.tsx`
- `apps/web/src/app/freshservice.css`
- `apps/web/src/lib/api.ts`
- `apps/web/src/lib/navigation.ts`
- `apps/web/src/lib/navigation-groups.ts`
- `apps/web/src/lib/ops-insights.ts`
- `tests/unit/ops-insights.test.ts`
- `tests/unit/audit-events.test.ts`
- `tests/unit/navigation-ui.test.ts`
- `docs/planning/02_Architecture/02.17_Audit_Event_Catalog.md`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-RPT-051.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-RPT-051/`

## 5. Out of Scope

大規模な時系列・SLA達成率の指標定義、グループ横断集計、書き出しの変更、組織横断の画面閲覧、個人情報・生の監査ペイロードの開示、AIと自動化の監査画面、Migration。

## 6. Deliverables

- 担当者向けのレポート、受付日と担当グループの条件、件数から詳細へ進む対象一覧と元の一覧への復帰。日付境界は既存のチケット検索と同じUTC、時刻は既存のJST表示を使う。停止中のチケットは稼働中の期限超過から除外する。
- 選択中の組織の監査ログを読む `GET /audit/events` と、期間・カテゴリ・選択した対象による絞り込み。監査イベントから表示に必要なフィールドのみ返す。既存の承認イベントと旧方式の承認判断を扱う。
- 監査ログの取得を `audit.viewed` として同じDBトランザクションに記録する。監査書込みに失敗した場合は結果を返さない。画面・APIとも監査担当者の許可範囲を確認する。

## 7. Acceptance Criteria

- AC-1 同じ期間・担当グループの受付、解決済み、未完了、稼働中の解決期限超過を集計する。件数と対象一覧が一致し、停止中の記録が稼働中の期限超過に混ざらない。対象チケットの詳細から選択済みの集計・一覧に戻る。
- AC-2 同じ組織の監査担当者が実操作で生成した承認と権限付与・取消のログを期間とカテゴリで絞れる。イベントの詳細と同一対象の記録を開ける。リストはページ単位で表示し、0件と取得失敗を区別する。
- AC-3 監査APIが監査担当者のみを許可し、他組織のイベントを一覧・詳細とも返さない。生の監査ペイロードを返さず、成功した閲覧を監査に記録する。
- AC-4 PC 1440pxとモバイル幅375pxで実セッションの一連の操作と役割差を確認し、両テーマのaxeとスクリーンショットを保存する。

## 8. Verification and Evidence

隔離PostgreSQL、合成アカウント、本番ビルドと現行APIを用いる。ユニット、型、lint、check:all、画面操作とAPI認可を確認する。

## 9. Security and Audit

監査担当者は既存の `auditor` / `platform_auditor` とする。新しい一覧は、選択している組織だけをRLSと明示する条件で検索する。権限の付与・取消や承認は既存の業務操作を通す。本WPの監査APIと関連するイベントの変更はセキュリティレビュー対象とする。

## 10. Rollback

Migrationなし。画面・API・イベントカタログの差分をrevertする。既に追加された閲覧記録と既存の監査記録を保持する。

## 11. References

[[03.3_Ticket_Requirements]]、[[03.13_UX_Accessibility_Requirements]]、[[03.19_Migration_and_Audit_Requirements]]、[[02.17_Audit_Event_Catalog]]、[[ADR-0009_Append_Only_Audit]]、[[ADR-0015_Organization_Isolation_and_RLS]]、[[11.3_Design_System]]。

## 12. Definition of Done

§7の判定と証拠を保存してレビューに提出する。

## 13. Execution Log

- 2026-11-19 第7段階の差分、集計条件、監査ログの閲覧範囲を確定。

- 2026-11-19 実装と画面確認を完了。§4のレポート・監査ログの画面、共通CSS、ナビゲーション、Web APIクライアントを追加・更新。APIの組織監査閲覧ルートと `audit.viewed` の監査イベントを追加。3本のユニットテスト、イベントカタログ、要件トレーサビリティ、WP台帳、依存図、Manifestを更新。画面の操作スクリプトと結果は下記Evidenceに保存。
- Migrationなし。差分をrevertして画面と閲覧APIを戻せる。既存分を含む監査記録は保持する。
- 検証コマンド
  - `rtk proxy npm run test:unit -- --reporter=json --outputFile=/tmp/solvi-rpt051.qhgVsW/unit.json`。121ファイル、4,888件成功、26件既存保留、失敗0件。
  - `rtk proxy npm run typecheck` と `rtk proxy npm run check:all` は成功。
  - `rtk proxy npm run lint` は `.claude/worktrees` 内の生成ファイル4件でエラー。対象を除く `rtk proxy npm run lint -- --ignore-pattern '.claude/**'` は成功。
  - `rtk proxy node --env-file=.env /tmp/solvi-rpt051.qhgVsW/capture.mjs /tmp/solvi-rpt051.qhgVsW/final-evidence solvi_rpt051_1795092490_test 01`。隔離DBの準備・Webの本番ビルドと起動はEvidenceの再現手順を参照。
  - `rtk proxy node --env-file=.env /tmp/solvi-rpt051.qhgVsW/audit-failure.mjs solvi_rpt051_1795092490_test`。隔離DBで監査書込みを失敗させ、APIは500、画面は取得失敗と再読み込みを表示した。
- 受入判定
  - AC-1 充足。PC・モバイル幅とも受付4・解決済み1・未完了3・解決期限超過1。SLA停止中のチケットを超過から除外。期限超過と解決済みの各チケット詳細を開き、集計条件を保持して対象一覧に復帰。
  - AC-2 充足。合成の申請で発生した承認と権限付与・取消を期間と種別で絞り、詳細から同一対象の履歴を表示。アクセスレビュー開始の絞り込み、0件・入力エラー・取得失敗・条件解除、25件と5件のページ間遷移を確認。
  - AC-3 充足。異なる組織で同じイベントと対象の可視性を比較し、組織管理者・担当者・依頼者・承認者の監査APIは403。レスポンスは表示用の項目のみ。閲覧の監査レコードを隔離DBで確認し、書込み失敗時の応答抑止とロールバックをユニットテストで確認。
  - AC-4 充足。Google ChromeのPC 1440px・モバイル幅375pxで実セッションの操作と権限を確認。ライト・ダークでaxeを計16回実行し違反と判定保留は0件、画面の横はみ出しは0px。
- セキュリティ影響あり。選択中の組織の監査イベントの読取りを、既存の監査担当ロール、APIの明示条件、RLSで制限する。閲覧記録は追記のみ。CODEOWNERSの監査モジュール担当による人間のセキュリティレビュー待ち。
- Evidence `evidence/WP-P2-RPT-051/20261119-2138/`。
