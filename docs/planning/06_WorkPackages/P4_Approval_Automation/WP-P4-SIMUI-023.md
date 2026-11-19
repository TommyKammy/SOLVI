---
project: "SOLVI"
doc_id: "WP-P4-SIMUI-023"
title: "チケットからのAI支援プレビュー、承認、模擬実行の導線"
category: "06_WorkPackages"
type: "work-package"
status: "baseline"
version: "0.1.0"
created: "2026-11-19"
updated: "2026-11-19"
owner: "SOLVI Product Team"
tags: ["ui", "ai", "approval", "simulation", "audit"]
source_of_truth: true
implementation_status: "review"
workstream: "SIMUI"
phase: "P4"
risk: "medium"
story_points: 8
requirement_ids: ["FR-CAT-004", "NFR-UX-002", "NFR-UX-004", "NFR-UX-005", "AUD-001", "AUD-002"]
depends_on: ["WP-P1-AUD-018", "WP-P2-UIX-046", "WP-P4-APR-014", "WP-P4-APR-016"]
---

# WP-P4-SIMUI-023 チケットからのAI支援プレビュー、承認、模擬実行の導線

## 1. Purpose

第8段階の差分。カタログ申請から起票されたチケットで担当者が提案の内容と参照元を読み、採用または見送りを記録する。採用後、そのチケットに関連する既存申請を開き、承認者の判断後に担当者がローカル模擬実行を行う。運用担当者は証跡を確認し、監査担当者は同じ申請の判断・承認・模擬実行を監査ログで追う。

## 2. Requirement IDs

`FR-CAT-004`、`NFR-UX-002`、`NFR-UX-004`、`NFR-UX-005`、`AUD-001`、`AUD-002`。AI支援は表示と人間による判断のプレビューであり、実モデルによる分類・生成・RAGの受入判定は対象外。

## 3. Dependencies

[[WP-P1-AUD-018]]、[[WP-P2-UIX-046]]、[[WP-P4-APR-014]]、[[WP-P4-APR-016]] は baseline・done。第7段階を含む `8ddb640` を基点とし、組織スコープの監査画面を使用する。既存のセキュリティレビューを維持する。

## 4. Scope / Allowed Paths

- `services/api/src/modules/catalog/catalog.routes.ts`
- `services/api/src/modules/catalog/ticket-assistance.ts`
- `services/api/src/modules/audit/audit-events.routes.ts`
- `services/api/src/common/audit/audit.ts`
- `services/api/src/main.ts`
- `apps/web/src/lib/api.ts`
- `apps/web/src/lib/ops-insights.ts`
- `apps/web/src/app/ops/[id]/page.tsx`
- `apps/web/src/app/ops/audit/page.tsx`
- `apps/web/src/app/requests/[id]/page.tsx`
- `apps/web/src/app/requests/actions.ts`
- `apps/web/src/components/RequestForms.tsx`
- `apps/web/src/components/TicketAssistance.tsx`
- `apps/web/src/app/freshservice.css`
- `tests/unit/ticket-assistance.test.ts`
- `tests/unit/audit-events.test.ts`
- `docs/planning/02_Architecture/02.17_Audit_Event_Catalog.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/06_WorkPackages/P4_Approval_Automation/WP-P4-SIMUI-023.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P4-SIMUI-023/`

## 5. Out of Scope

実モデル、外部AI・ナレッジ検索の連携、承認ルーティングの変更、既存のサービス申請がないチケットへの承認追加、実行サービス・外部アカウント・権限の変更、Migration。

## 6. Deliverables

- ローカルカタログのチケット詳細にAI支援プレビュー。定型の確認項目と保存済みカタログ版を表示し、承認中の申請で担当者が採用・見送りを選ぶ。定型の項目が分かるように表示し、申請内容を外部へ送らない。
- 採否は対象申請・申請の版・定型提案の版を持つ担当者の監査イベントとして追記する。申請行をロックし、同じ版への同じ判断の再送は同じ結果を返し、異なる判断の再送と古い申請版は拒否する。採用から既存申請へ進む導線を表示する。申請時点で既存の承認依頼が作られ、提案の採否は承認状態に影響しない。
- 模擬実行は既存の承認検証、必須チェック、冪等な証跡を使用する。模擬実行の監査イベントに既存証跡の参照を付ける。監査担当者がAI支援・模擬実行を絞り、同一申請の承認・採否・実行の履歴を開ける。

## 7. Acceptance Criteria

- AC-1 PCとモバイル幅で、同じチケット上の定型提案と参照元を確認し、採用後に同じ申請へ移動する。別のチケットで見送り、導線を表示しないことと再読み込み後の判断の保持を確認する。
- AC-2 承認前の模擬実行を拒否する。承認者の実セッションで承認後、担当者が同じ申請の模擬実行を行う。証跡に外部変更0件を表示し、再送で証跡が増えず、同じ依頼チケットへ戻れる。
- AC-3 監査担当者が同じ申請の採用、承認、模擬実行を確認し、実行証跡と監査詳細のIDが一致する。別組織と非担当ロールの採否APIを拒否し、監査の閲覧ロールと既存範囲を維持する。
- AC-4 隔離DBと合成アカウント、Webの本番ビルドを用い、PC 1440pxとモバイル幅375pxで操作する。スクリーンショットとaxe結果を保存する。

## 8. Verification and Evidence

実セッションによる担当者・承認者・監査担当者の操作、DBの採否イベントと模擬証跡、APIの拒否と再送、ユニット・型検査・lint・check:all。

## 9. Security and Audit

アプリ層で担当ロールとチケットの閲覧権限を確認し、関連申請と監査イベントを選択組織に限定する。採否だけを追記するエンドポイントに実行能力はない。監査閲覧を監査担当ロールに制限し続ける。API認可・監査変更は人間のセキュリティレビュー対象。

## 10. Rollback

Migrationなし。画面・APIとイベントカタログの変更をrevertし、既存の申請・実行証跡・採否イベントを保持する。

## 11. References

[[03.10_AI_Requirements]]、[[03.5_Catalog_and_Approval_Requirements]]、[[03.13_UX_Accessibility_Requirements]]、[[02.17_Audit_Event_Catalog]]、[[ADR-0006_Privileged_Executor_Separation]]、[[ADR-0007_AI_Advisory_Only]]、[[ADR-0009_Append_Only_Audit]]、[[ADR-0015_Organization_Isolation_and_RLS]]。

## 12. Definition of Done

受入基準の操作結果とEvidenceを保存してレビューに提出する。

## 13. Execution Log

- 2026-11-19 第8段階の差分として、定型提案の採否と既存のローカル申請・模擬実行・監査の画面連携を定義。

- 2026-11-19 チケット詳細と申請結果・監査ログの連携を実装した。変更した製品コードは§4記載のチケット詳細、提案パネル、申請画面・サーバーアクション・フォーム、Web APIと監査表示・CSS、APIルート、提案処理、監査投影およびイベント登録。提案の版・採否、監査投影のユニットテストを追加した。Vaultのイベントカタログ、要件ツリー、WP台帳、依存図、Manifestを更新した。
- Migrationなし。ロールバックは差分をrevertし、既に保存された採否・既存の承認・模擬実行証跡は保持する。
- 検証コマンド
  - `rtk proxy npm run test:unit -- --reporter=json --outputFile=/tmp/solvi-simui023.zb51b7yy/unit.json` は122ファイル、4,897件成功、既存保留26件、失敗0件。
  - `rtk proxy npm run typecheck`、`rtk proxy npm run lint -- --ignore-pattern '.claude/**'`、`rtk proxy npm run check:all` は成功。
  - `rtk proxy node --env-file=.env /tmp/solvi-simui023.zb51b7yy/capture.mjs /tmp/solvi-simui023.zb51b7yy/final2 solvi_simui023_1795093500_test 02` は成功。隔離DBの構築とWebの本番ビルドはEvidenceの再現手順を参照。
- 受入判定
  - AC-1 充足。各幅でチケット上の定型提案・参照元の版を確認し、採用後に同じ申請へ遷移。別チケットの見送りと再読込後の保持、模擬実行への導線の非表示を確認。
  - AC-2 充足。承認前の模擬実行は409。業務受信箱から独立した承認者が判断し、担当者が外部変更0件の証跡を取得。模擬実行を再送しても同じ証跡を返し、元のチケットへ復帰。
  - AC-3 充足。同じ申請の採用・承認・模擬実行を監査で確認し、結果と証跡IDが一致。担当者のみ採否を記録でき、別組織の要求は404、別組織の監査記録は0件。監査資格を併せ持つ合成セッションで、同一の完了済みチケット・証跡・監査詳細を両画面幅で開き直した。
  - AC-4 充足。ChromeのPC 1440pxとモバイル375pxのタッチエミュレーションで実セッションを使用。ライトとダークのaxe検査計16回に違反・判定保留はなく、横はみ出し0px。
- セキュリティ影響あり。採否APIと監査の表示対象を追加し、既存のロール、組織境界、承認時の契約を維持した。CODEOWNERSの監査領域担当による人間のセキュリティレビュー待ち。
- 実モデル、外部AI連携、申請時の承認依頼生成の変更は対象外。模擬実行・承認の既存ローカル経路を使用した。
- Evidence `evidence/WP-P4-SIMUI-023/20261119-2156/`。
