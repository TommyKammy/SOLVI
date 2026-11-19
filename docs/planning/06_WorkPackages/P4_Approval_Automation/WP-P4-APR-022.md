---
project: "SOLVI"
doc_id: "WP-P4-APR-022"
title: "カタログの設定・公開と申請・承認の画面連携"
category: "06_WorkPackages"
type: "work-package"
status: "baseline"
version: "0.1.0"
created: "2026-11-19"
updated: "2026-11-19"
owner: "SOLVI Product Team"
tags: ["ui", "catalog", "approval"]
source_of_truth: true
implementation_status: "review"
workstream: "APR"
phase: "P4"
risk: "low"
story_points: 5
requirement_ids: ["FR-CAT-001", "FR-CAT-002", "FR-CAT-003", "FR-CAT-005", "FR-CAT-012", "FR-CAT-013", "NFR-UX-001", "NFR-UX-002", "NFR-UX-003", "NFR-UX-004"]
depends_on: ["WP-P2-UIX-028", "WP-P2-UIX-044", "WP-P4-APR-016", "WP-P4-APR-021"]
---

# WP-P4-APR-022 カタログの設定・公開と申請・承認の画面連携

| 項目 | 値 |
|---|---|
| Phase | P4 |
| Workstream | APR |
| Risk | low |
| Story Points | 5 |
| Suggested Owner | Frontend |
| Parallelizable | No |
| Gate | Gate B |

## 1. Purpose

第3段階。管理者が質問と表示条件、承認ルールを設定し、保存した版を入力試験して公開する。依頼者がその版から申請し、承認者が同じ申請を判断し、依頼者が判断結果を確認する。

## 2. Requirement IDs

`FR-CAT-001`、`FR-CAT-002`、`FR-CAT-003`、`FR-CAT-005`、`FR-CAT-012`、`FR-CAT-013`、`NFR-UX-001`〜`NFR-UX-004`。

## 3. Dependencies

[[WP-P2-UIX-028]]、[[WP-P2-UIX-044]]、[[WP-P4-APR-016]]、[[WP-P4-APR-021]] は `done` を確認。条件の契約は accepted の [[ADR-0020_Catalog_Form_Definition_Extensions]]、承認経路は accepted の [[ADR-0023_Relationship_Based_Approval_Authority]] を参照する。条件入力と検証はmainに存在する契約を利用する。[[WP-P2-UIX-040]]／[[WP-P2-UIX-042]] のreviewは維持し、その未完了項目や契約変更を本WPに取り込まない。第2段階を含むローカル基点は `499f628`。

## 4. Scope / Allowed Paths

- `apps/web/src/app/freshservice.css`
- `apps/web/src/app/catalog/manage/new/page.tsx`
- `apps/web/src/app/catalog/manage/[id]/page.tsx`
- `apps/web/src/app/catalog/[itemId]/page.tsx`
- `apps/web/src/app/ops/approvals/page.tsx`
- `apps/web/src/app/requests/[id]/page.tsx`
- `apps/web/src/app/requests/actions.ts`
- `apps/web/src/lib/api.ts`（申請詳細の受付番号の型）
- `services/api/src/modules/catalog/catalog.routes.ts`（認可済み申請詳細へ既存の受付番号を返す読取投影）
- `apps/web/src/components/SupportFrame.tsx`
- `apps/web/src/components/CatalogAdminForm.tsx`
- `apps/web/src/components/CatalogAdminForm.module.css`
- `apps/web/src/components/CatalogLivePreview.tsx`
- `apps/web/src/components/RequestForms.tsx`
- `tests/unit/catalog-authoring-ui.test.ts`
- `tests/unit/catalog-edit-ui.test.ts`
- `tests/unit/approval-assertion.test.ts`
- `tests/unit/request-detail-recovery-ui.test.ts`
- `tests/unit/catalog-request-entry-recovery-ui.test.ts`
- `docs/planning/06_WorkPackages/P4_Approval_Automation/WP-P4-APR-022.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P4-APR-022/`

## 5. Out of Scope

永続化・承認権限・通知・実行、承認ルールの新規種類、デモ専用の役割切替、既存版・申請の更新。既存の詳細APIに追加できるのは、同じ閲覧対象に対して一覧と受信箱がすでに返す受付番号の読取投影とする。

## 6. Deliverables

- カタログ管理から承認ルール管理への導線、保存済み下書きの条件付き表示と入力試験、公開版の入口。
- 公開フォームでは公開版と既存ルート解決結果を表示。申請受付で申請番号と確認先を案内する。
- 申請詳細では担当ロールに応じた判断と、保存された承認経過・結果を前面に配置する。

## 7. Acceptance Criteria

- AC-1 管理者が選択質問、必須の条件付き質問、組織の承認ルールを登録できる。下書きのプレビューで条件の両分岐と必須検査を試し、同じ保存版を公開する。下書きは依頼者のカタログに出ず、試験では申請が生成されない。
- AC-2 公開フォームから依頼者が条件を選び、表示された回答と公開版で申請する。表示されなくなった回答はスナップショットに含まれない。受付番号と事前経路を示し、依頼者は自分の申請一覧から開き直せる。
- AC-3 承認者が自分の受信箱から同じ申請を開き、承認または理由付き却下を行う。依頼者が同じ申請番号・結果・判断理由を確認できる。自己承認の操作を出さず、既存のスナップショット・権限・期限・委任の判定を保持する。
- AC-4 1440pxのキーボードと375pxのタップで、役割別実セッションを用いて一連の操作を検証する。両端末で同じ申請IDを再確認する。対象画面の横はみ出し、両テーマのaxe、スクリーンショットを記録する。

## 8. Verification and Evidence

既存の隔離DBと合成ユーザーを使用して実際のWeb/APIを通す。ユニット、型検査、lint、check:all、本番ビルドを実施する。

## 9. Security and Audit

既存の認可、版固定、監査、承認時の検証を利用する。プレビューは読み取りまたはブラウザ内の入力試験。実行・CSPの経路を変更しない。

## 10. Rollback

Migrationなし。本WPの差分をrevertする。既存の定義・申請・承認結果はそのまま利用できる。

## 11. References

[[11.3_Design_System]]、[[03.5_Catalog_and_Approval_Requirements]]、[[03.13_UX_Accessibility_Requirements]]、[[ADR-0020_Catalog_Form_Definition_Extensions]]、[[ADR-0023_Relationship_Based_Approval_Authority]]、[[ADR-0024_Approval_Route_Generations_And_High_Risk_Criterion]]、[[WP-P4-APR-016]]。

## 12. Definition of Done

§7の判定と証跡を記録し、レビューへ提出する。

## 13. Execution Log

- 2026-11-19  第3段階の範囲、現行版から再利用する契約、受入基準をベースライン化。
- Webではカタログの作成・編集・保存後プレビュー、公開フォーム、承認ルールとの導線、申請の受付と詳細を更新。該当ページと `CatalogAdminForm`、`CatalogLivePreview`、`RequestForms`、`SupportFrame`、`freshservice.css` を変更した。既存の詳細APIに受付番号の読取投影を追加し、型と回帰検査を更新した。作業台帳・依存図・要求マトリクス・Manifestも同期。
- AC-1充足。管理者がPCとモバイルの両方で承認ルールと質問を設定し、申請者を指定して承認経路を確認。保存済みの下書きで両分岐と必須検査を試し、POSTは0件。公開前は依頼者に非表示で、公開後の版は試した保存版と一致。
- AC-2充足。依頼者はポータルから公開フォームを開き、承認経路を見て申請した。PCでは条件から外れた回答が保存されず、モバイルでは表示対象の回答が保存された。受付画面から「自分の申請」に移動できた。
- AC-3充足。受信箱から同じ申請番号を開き、PCは承認、モバイルは理由付き却下。依頼者が同じ理由・結果を確認し、自己承認操作は表示されなかった。両結果で申請時のスナップショットハッシュが変わらないことをAPIで照合した。
- AC-4充足。Chromeの1440pxと375pxで主要操作をEnterとタップで検証。両申請を反対側の端末でも再表示した。2幅×2テーマ×5画面のaxeで違反0件、判定保留0件、横はみ出し0px。
- `rtk proxy npm run test:unit` は4,857件成功、失敗0件、既存skip 26件。`rtk proxy npm run typecheck`、`rtk proxy npm run check:all`、本番ビルド成功。全体lintには別worktreeの生成ファイル4件の既存指摘があり、`rtk proxy npm run lint -- --ignore-pattern '.claude/**'` は成功。ブラウザの再現手順はEvidenceのREADMEに記録。
- Migrationなし。詳細APIの受付番号は既存の閲覧判定後、同じ組織内の関連チケットから取得する。認可・監査・CSP・状態機械・実行経路の変更なし。レビュー待ち。
- Evidenceは `evidence/WP-P4-APR-022/20261119-2007/README.md`、`summary.json`、`screens/`、`logs/`。
