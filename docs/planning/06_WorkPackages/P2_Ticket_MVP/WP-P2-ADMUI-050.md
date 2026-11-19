---
project: "SOLVI"
doc_id: "WP-P2-ADMUI-050"
title: "管理ホーム・閲覧範囲・再ログイン復帰"
category: "06_WorkPackages"
type: "work-package"
status: "baseline"
version: "0.1.0"
created: "2026-11-19"
updated: "2026-11-19"
owner: "SOLVI Product Team"
tags: ["ui", "administration", "accessibility"]
source_of_truth: true
implementation_status: "review"
workstream: "ADMUI"
phase: "P2"
risk: "medium"
story_points: 8
requirement_ids: ["FR-IDM-010", "FR-IDM-014", "FR-TKT-003", "FR-CAT-016", "NFR-SEC-002", "NFR-UX-002", "NFR-UX-003", "NFR-UX-004"]
depends_on: ["WP-P1-SEC-024", "WP-P2-GRP-015", "WP-P2-NTF-005", "WP-P2-UISTATE-018", "WP-P2-UIX-029", "WP-P2-UIX-044", "WP-P4-IDM-013", "WP-P4-APR-016"]
---

# WP-P2-ADMUI-050 管理ホーム・閲覧範囲・再ログイン復帰

## 1. Purpose

第6段階。組織管理者が利用者・部署・担当グループ、承認ルール、通知、アクセスレビューを管理できる導線を整える。閲覧者は既存の監査担当者（auditor）とし、アクセスレビューの閲覧を既存APIの許可範囲で提供する。権限外の画面から管理ホームまたはポータルへ戻れるようにし、セッション失効後は再ログインと組織の選択を経て元の管理画面へ戻れるようにする。

## 2. Requirement IDs

`FR-IDM-010`、`FR-IDM-014`、`FR-TKT-003`、`FR-CAT-016`、`NFR-SEC-002`、`NFR-UX-002`〜`NFR-UX-004` の管理画面。

## 3. Dependencies

[[WP-P1-SEC-024]]、[[WP-P2-GRP-015]]、[[WP-P2-NTF-005]]、[[WP-P2-UISTATE-018]]、[[WP-P2-UIX-029]]、[[WP-P2-UIX-044]]、[[WP-P4-IDM-013]]、[[WP-P4-APR-016]] は baseline・done。基点は第5段階を含む `4ec2768`。現行APIの許可範囲を採用する。モックアップの閲覧者向け利用者・部署・担当グループの表示は、現行APIの auditor 権限に含まれない。現行のアクセスレビューAPIは管理者に開始・判断・完了、auditor に一覧・詳細の取得を許可している。

## 4. Scope / Allowed Paths

- `.github/CODEOWNERS`
- `apps/web/src/app/ops/admin/page.tsx`
- `apps/web/src/app/ops/users/page.tsx`
- `apps/web/src/app/ops/departments/page.tsx`
- `apps/web/src/app/ops/groups/page.tsx`
- `apps/web/src/app/ops/groups/[id]/page.tsx`
- `apps/web/src/app/ops/approvals/page.tsx`
- `apps/web/src/app/ops/notifications/page.tsx`
- `apps/web/src/app/ops/access-review/page.tsx`
- `apps/web/src/app/login/page.tsx`
- `apps/web/src/app/select-organization/page.tsx`
- `apps/web/src/app/freshservice.css`
- `apps/web/src/components/AdminWorkspace.tsx`
- `apps/web/src/lib/admin-recovery.ts`
- `apps/web/src/lib/api.ts`
- `apps/web/src/lib/navigation-groups.ts`
- `tests/unit/admin-recovery.test.ts`
- `tests/unit/require-session.test.ts`
- `tests/unit/navigation-ui.test.ts`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-ADMUI-050.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-ADMUI-050/`

## 5. Out of Scope

権限の追加、組織外のアクセス、API・DB・セッション検証・監査契約の変更、UIでのロール偽装、入力の自動復元、外部メール配達の検証。未保存の入力や操作確認モードをログイン先へ渡さない。

## 6. Deliverables

管理ホーム・管理機能の戻り先、監査担当者用のアクセスレビュー閲覧、共通の権限案内、管理画面だけの再ログイン復帰。ログインと組織選択の前後で、固定した管理パスと閲覧用の選択・絞り込みだけを受け付ける。実際のアカウントを切り替えて確認する。

## 7. Acceptance Criteria

- AC-1 組織管理者の管理ホームから6機能を開ける。部署と利用者プロフィールの保存、グループ作成とメンバー追加、承認ルールの作成・経路プレビュー、通知の絞り込み・手動再試行の受付、アクセスレビューの開始・維持判断・完了を確認する。
- AC-2 同じ組織の監査担当者は、管理ホームから同じレビューと保存済みの判断を閲覧でき、開始・判断・完了操作を表示しない。その他の管理機能の直接URLには権限案内を表示し、管理ホームまたはポータルに戻れる。既存APIの許否も確認する。
- AC-3 失効したセッションで対象の管理画面を開くと、再ログインの案内が出て、同じアカウントで認証後、選択やフィルターを保持した元の画面へ戻れる。別の役割で再ログインした場合は遷移先で権限を再判定する。外部・不明な戻り先、編集モード、エラーや編集中の値を引き継がない。
- AC-4 PC 1440pxとモバイル幅375pxの両方を実アカウントの別セッションで確認する。ライト・ダークのaxe検査と画面証拠を記録する。

## 8. Verification and Evidence

隔離PostgreSQL、合成アカウント、本番ビルド、実APIを使用する。受入項目、ユニット、型、lint、check:allを記録する。

## 9. Security and Audit

ログイン後の復帰先は管理画面の固定許可リストで検証する。認証・Cookie・認可・監査は既存の経路を使用する。監査担当者へ返す内容は既存の許可済みAPI応答から構成する。再ログインの導線と表示権限に関する変更は、人間のレビューを受ける。

## 10. Rollback

Migrationなし。差分をrevertすると従来の表示とログイン後の遷移に戻る。

## 11. References

[[03.7_Identity_OIDC_SCIM_Requirements]]、[[03.13_UX_Accessibility_Requirements]]、[[11.11_UI_State_and_Error_Model]]、[[11.3_Design_System]]、[[ADR-0015_Organization_Isolation_and_RLS]]、[[ADR-0023_Relationship_Based_Approval_Authority]]、[[WP-P1-SEC-024]]、[[WP-P2-UIX-029]]、[[WP-P4-IDM-013]]、[[WP-P4-APR-016]]。

## 12. Definition of Done

§7の判定と証拠を保存してレビューに提出する。

## 13. Execution Log

- 2026-11-19 第6段階の差分、既存ロール、復帰先の範囲と受入基準を確定。

### 2026-11-19 実装・ローカル検証

- Webでは `ops/admin`、`ops/users`、`ops/departments`、`ops/groups` とメンバー詳細、`ops/approvals`、`ops/notifications`、`ops/access-review` の画面を更新した。共通の権限案内は `AdminWorkspace.tsx`、共通スタイルは `freshservice.css`。利用者一覧の列幅とプロフィール見出しを調整した。
- `login/page.tsx`、`select-organization/page.tsx`、`lib/api.ts`、`lib/admin-recovery.ts`、`lib/navigation-groups.ts` に復帰先と表示の差分を実装した。復帰先、セッションの遷移、監査担当者メニューのユニット検査を更新した。台帳、依存関係、要求トレーサビリティ、Manifestを更新した。
- Migrationなし。差分をrevertすると従来の画面とログイン後の遷移に戻る。権限表示と再ログイン復帰にセキュリティ上のレビューが必要。認証情報、セッション検証、API認可、RLS、監査の契約を既存のまま使用した。
- AC-1 達成。二つの画面幅で、部署作成、プロフィール保存、同じ担当者のグループ追加、固定承認者のルールと経路確認、手動再試行予約1件、アクセスレビューの開始・維持・完了を確認した。
- AC-2 達成。監査担当者と組織管理者が同じレビューを開き、進行中の表示と完了後の判断を照合した。監査担当者へ変更フォームを出さず、他の管理機能の直接URLを開いた際は、権限案内から管理ホームへ戻れた。関連APIの拒否を確認した。
- AC-3 達成。隔離DBでブラウザのアイドル期限を過去にした。再ログインで利用者の検索語や選択を保持し、編集モードのパラメーターを除外した。別の監査担当者での再ログインでは組織選択を経て元URLに遷移し、現行権限に基づく案内から復帰した。許可範囲外の復帰先はユニット検査で除外した。
- AC-4 達成。ChromeのPC 1440pxとモバイル幅375pxで操作した。両テーマのaxe検査40回で違反・判定保留0件、ページの横はみ出し0px。PCの利用者一覧は全列を表示できた。
- Evidenceは `evidence/WP-P2-ADMUI-050/20261119-2112/` に保存した。操作の記録、両テーマのスクリーンショット、再現コマンド、検査ログを収録した。
- 人による受入とセキュリティレビュー待ち。再ログイン導線と復帰先のルールをCODEOWNERSのセキュリティレビュー対象にした。ルートlintが参照する別のローカルworktreeに自動生成ファイル由来の既存エラー4件がある。対象worktreeのlintは成功した。

```zsh
rtk proxy npm run test:unit -- --reporter=json --outputFile=/tmp/solvi-admui050.dp6U3f/unit-delivery.json
rtk proxy npm run typecheck
rtk proxy npm run lint
rtk proxy npm run lint -- --ignore-pattern '.claude/**'
rtk proxy npm run check:all
rtk proxy node --env-file=.env /tmp/solvi-admui050.dp6U3f/capture.mjs /tmp/solvi-admui050.dp6U3f/delivered solvi_admui050_1795090459_test 01
```

ユニット4,870件成功、失敗0件、既存skip 26件。型検査、本番ビルド、Prettier、`check:all` は成功。
