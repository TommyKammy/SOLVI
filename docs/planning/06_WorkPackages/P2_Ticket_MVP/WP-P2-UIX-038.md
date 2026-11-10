---
project: SOLVI
doc_id: "WP-P2-UIX-038"
title: "サポートポータルの業務導線と検索フォーカスの回帰修正"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-11-10"
updated: "2026-11-10"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "ui", "regression", "accessibility"]
source_of_truth: true
implementation_status: "review"
story_points: 3
risk: "medium"
workstream: "UIX"
phase: "P2"
requirement_ids: ["NFR-UX-001", "NFR-UX-002", "NFR-UX-003"]
depends_on: ["WP-P2-UIX-037"]
---

# WP-P2-UIX-038: サポートポータルの業務導線と検索フォーカスの回帰修正

## 1. Purpose

UIX-032〜037のレビューで確認した業務入口の欠落、承認カードの誤った絞り込み、検索送信ボタンの不可視フォーカスを表示層で修正し、再発を検出するテストを追加する。
利用者の修正・テスト追加依頼に基づく。対象ブラウザは最新版のChrome/Edge/Safari。`:has()`非対応環境は含めない。

## 2. Requirement IDs

`NFR-UX-001`, `NFR-UX-002`, `NFR-UX-003`

## 3. Dependencies

[[WP-P2-UIX-037]]: done。UIX-032〜037の実装・Evidenceとコミット562211dを確認済み。

## 4. Scope / Allowed Paths

- `apps/web/src/components/AppFrame.tsx`
- `apps/web/src/components/SupportFrame.tsx`
- `apps/web/src/app/portal/page.tsx`
- `apps/web/src/app/freshservice.css`
- `tests/unit/support-portal-ui.test.ts`
- `tools/ui_support_portal_check.mjs`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-038.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-UIX-038/`

## 5. Out of Scope

API・DB・Migration・ロールの権限定義・RLS・認証・監査・依存追加。既存のhas対応CSSやドーナツの設計変更。

## 6. Deliverables

- 既存のロール別ナビゲーションから受信箱・変更管理・資産の入口をサポートメニューへ引き継ぐ。
- 業務受信箱を利用できる利用者のカードは`/inbox`、その他は`/requests?view=mine`へ接続し、文言も一致させる。
- 検索送信ボタンを常時表示し、TabとEnterで操作できるようにする。
- ロール境界のコンポーネントテスト、ローカル実画面の遷移・キーボード・axe・375px回帰検査。

## 7. Acceptance Criteria

- [x] 依頼者には資産、承認者には受信箱・資産・変更管理、監査者には資産・変更管理がサポートメニューに表示され、遷移できる。
- [x] 非staffのまま監査者がサポートシェルを使用し、他組織だけのロールによって業務入口が増えない。
- [x] スタッフの通常画面は従来のレールを維持し、ポータルから担当業務へ戻れる。
- [x] カードの遷移先と文言が利用可能な業務に一致する。
- [x] 検索入力からTabで到達する送信ボタンが見え、フォーカスも見え、Enterで同じ検索条件が送信される。macOS WebKitの既定操作はOption-Tabで同じ条件を検査。
- [x] 375pxで横スクロールせず、対象画面のaxe違反0。
- [x] 追加テスト、関連回帰、型チェック、lint、check:all、本番ビルドが成功する。
- [x] API・DB・Migration・認可定義の変更なし。

## 8. Verification and Evidence

`tests/unit/support-portal-ui.test.ts`と`tools/ui_support_portal_check.mjs`で検証する。
ブラウザ検査はlocalhost限定、合成アカウントのログインと既存データの読取り・検索だけを行う。
Evidence: `evidence/WP-P2-UIX-038/`。資格情報は環境変数から渡し、出力しない。

## 9. Security and Audit

表示層だけを変更する。API認可の代替とせず、ロールの意味を変更しない。
テストに本番資格情報・実PIIを使用しない。

## 10. Rollback / 失敗時の扱い

上記4つの表示ファイルの変更を戻す。Migrationなし、保存済みデータの変更なし。

## 11. References

[[03.13_UX_Accessibility_Requirements]], [[WP-P2-UIX-032]], [[WP-P2-UIX-034]], [[WP-P2-UIX-037]]。
認可済み入口の定義は`navigationRoles`と`buildNavigationGroups`を維持する。

## 12. Definition of Done

§7の検証結果、実行コマンド、変更一覧、Evidence、ロールバック方針を§13へ記録する。

## 13. Execution Log

- 2026-11-10: 利用者がレビュー指摘3件の修正と追加テストを依頼。ブラウザ条件を確定。
- 変更ファイル: §4の表示層4ファイル、追加テスト・ブラウザ検査ツール各1ファイル、WPと台帳・Dependency Map・RTM・MANIFEST、Evidence。
- 表示修正: `SupportFrame`へ既存のロール別groupsを渡し、許可済みの受信箱・資産・変更管理を表示。カードは`navigationRoles(session).inbox`で個人業務と申請状況を選び、見出し・説明も一致。検索ボタンは常時表示し、中央配置とフォーカスを確認。
- 実行コマンドと結果:
  - `node node_modules/vitest/vitest.mjs run tests/unit/support-portal-ui.test.ts`: 修正前14失敗・7成功、修正後21成功。
  - `node node_modules/vitest/vitest.mjs run tests/unit/support-portal-ui.test.ts tests/unit/portal-catalog.test.ts tests/unit/operations-overview.test.ts tests/unit/ticket-queue.test.ts`: 119成功。
  - `node node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --module esnext --moduleResolution bundler --jsx react-jsx --esModuleInterop --skipLibCheck tests/unit/support-portal-ui.test.ts`: 成功。
  - `npm run typecheck` / `npm run lint`: 成功。
  - `node tools/check_traceability.mjs --write` / `npm run check:all`: 台帳の導出値を更新し成功。
  - `node tools/ui_support_portal_check.mjs`: Chrome / WebKitで各20検査・11回のaxe検査成功。資格情報は環境変数、ブラウザと出力先はEvidence READMEの設定を使用。
  - `NEXT_TELEMETRY_DISABLED=1 npm run build --workspace=@solvi/web`: 隔離コピーで成功。稼働中の開発サーバーの`.next`は変更しない。
  - `npm run test:unit`: 81ファイル成功・4ファイル失敗、3863成功・34失敗、別にfixture読込み時の1スイート失敗。
  - `node node_modules/vitest/vitest.mjs run --root .local/fix-038/baseline tests/unit/knowledge-list.test.ts tests/unit/knowledge-search-page.test.ts tests/unit/performance-runtime.test.ts tests/unit/performance-search-static-cli.test.ts`: 修正前562211dの隔離コピーで現行の失敗全件が再現。コピー先パスに依存する既存失敗1件も発生。
- §7の証拠: ロール・組織境界とカードは追加21ユニットテスト、実遷移・入力・フォーカス・幅・axeは`chrome/summary.json`と`webkit/summary.json`。スクリーンショット同梱。
- Migration: なし。Rollback: 表示層4ファイルの変更を戻す。保存済み業務データの変更なし。
- セキュリティ影響: 認可・権限・RLS・監査の変更なし。ブラウザ検証は合成ログイン・組織選択以外のPOSTと外部リクエストを禁止し、予定外リクエスト0。
- 未解決: 全体ユニットテストはスナップショットの不足fixture・過去コミット参照と旧UIの期待値で失敗する。テストの削除・skip・ガード無効化は行っていない。全体ゲート合格としてDoneにはしない。Safari/Edge製品実機は未実施。
- Evidence: `evidence/WP-P2-UIX-038/`。詳細実行ログはGit管理外の`.local/fix-038/`。
