---
project: SOLVI
doc_id: "WP-P2-UIX-043"
title: "フォーム復元力・モバイルナビ・テーブル・入力境界のアクセシビリティ修正"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-11-15"
updated: "2026-11-17"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "ui", "accessibility", "regression"]
source_of_truth: true
implementation_status: "review"
story_points: 8
risk: "medium"
workstream: "UIX"
phase: "P2"
requirement_ids: ["NFR-UX-001", "NFR-UX-002", "NFR-UX-004"]
depends_on: ["WP-P2-UIX-038", "WP-P2-UIX-042", "WP-P1-SEC-024"]
---

# WP-P2-UIX-043: フォーム復元力・モバイルナビ・テーブル・入力境界のアクセシビリティ修正

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | UIX |
| Risk | medium |
| Story Points | 8 |
| Suggested Owner | Frontend |
| Parallelizable | No(共通シェルと共通フォームに触れる) |
| Gate | Gate A |

## 1. Purpose

modern-web-guidance の点検で見つかった、画面を使えなくする/見えなくする欠陥を修正する。

- SSR直後のフォームが `inert` になり、JS無効・失敗時に全フォームが操作不能
- モバイルの閉じたレールがTab順に残り、開閉時のフォーカス管理も不足
- ポータル検索のフォーカス表示消失と、入力境界のコントラスト不足
- テーブルのキーボードスクロール領域と caption の不足
- iOSの入力ズーム、タッチターゲット、px固定の文字サイズ
- サーバTZ依存の日時表示と「今日」の算出

## 2. Requirement IDs

`NFR-UX-001`, `NFR-UX-002`, `NFR-UX-004`

## 3. Dependencies

[[WP-P2-UIX-038]]: review。サポートポータルの検索フォーカス修正の残りを扱う。
[[WP-P2-UIX-042]]: カタログ質問分岐の共通フォーム利用箇所。
[[WP-P1-SEC-024]]: アクセスレビュー画面の日時表示。

## 4. Scope / Allowed Paths

- `apps/web/src/components/FeedbackForm.tsx`
- `apps/web/src/components/AppFrame.tsx`
- `apps/web/src/components/TableRegion.tsx`
- `apps/web/src/components/FormDraftRecovery.tsx`
- `apps/web/src/components/AssetCsvForms.tsx`
- `apps/web/src/components/AssetRevisionChanges.tsx`
- `apps/web/src/components/CatalogAdminForm.module.css`
- `apps/web/src/components/CatalogFieldInputs.module.css`
- `apps/web/src/components/CatalogLivePreview.module.css`
- `apps/web/src/app/freshservice.css`
- `apps/web/src/app/globals.css`
- `apps/web/src/app/knowledge/page.tsx`
- `apps/web/src/app/layout.tsx`
- `apps/web/src/app/ops/[id]/merge/page.tsx`
- `apps/web/src/app/ops/access-review/page.tsx`
- `apps/web/src/app/ops/approvals/changes/page.tsx`
- `apps/web/src/app/ops/approvals/page.tsx`
- `apps/web/src/app/ops/users/page.tsx`
- `apps/web/src/app/settings/delegations/page.tsx`
- `apps/web/src/lib/approval-route.ts`
- `apps/web/src/lib/labels.ts`
- `tests/unit/form-feedback-progressive.test.ts`
- `tests/unit/jst-format.test.ts`
- `tests/unit/table-regions.test.ts`
- `tests/unit/ui-contrast-and-focus.test.ts`
- `tests/unit/support-portal-ui.test.ts`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-043.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-UIX-043/`

## 5. Out of Scope

- API・DB・Migration・認可・RLS・監査の変更
- CSP/HSTS等のセキュリティヘッダー(ADRが必要。WP-Fとして分離)
- ダークモードの追加
- 既存のナビゲーション項目・権限の変更

## 6. Deliverables

- SSR時から操作可能なフォーム(no-JSのServer Action経路を塞がない)
- 閉じたモバイルレールの非表示・フォーカス移動/復帰・背景inert
- ポータル検索のフォーカスリングと3:1以上の入力境界
- 全テーブルの `TableRegion` + caption
- 16px以上の入力文字、coarse pointerの44pxターゲット、rem typography
- JST固定の日付表示と「今日」

## 7. Acceptance Criteria

- [x] SSR HTMLに `inert` が無く、フォームの操作要素が初期HTMLに含まれる。
- [x] モバイルの閉じたレールはTab順/アクセシビリティツリーから外れ、開くと閉じるボタンへフォーカスし、閉じると開閉ボタンへ戻る。
- [x] レールの開閉ボタンの `aria-controls` がレール自身を指す。
- [x] ポータル検索に入力フォーカスがあるとき、3pxのアウトラインが見える。
- [x] 入力・select・textarea・secondaryボタンの境界が白背景に対して3:1以上。
- [x] `apps/web/src` の全テーブルが `TableRegion` で囲まれ、captionを持つ。
- [x] 入力文字が `max(1rem, 1em)` 以上。`pointer: coarse` で主要操作が44px以上。`text-scale` をopt-inし、root font-sizeは上書きしない。
- [x] 日付表示と「今日」がサーバTZに依存せずJSTで算出される。
- [x] 追加テスト、型チェック、対象ファイルのlintが成功する。
- [x] API・DB・Migration・認可の変更がない。

## 8. Verification and Evidence

- `node node_modules/vitest/vitest.mjs run tests/unit/form-feedback-progressive.test.ts tests/unit/table-regions.test.ts tests/unit/ui-contrast-and-focus.test.ts tests/unit/jst-format.test.ts tests/unit/support-portal-ui.test.ts`
- `npm run typecheck --workspace=@solvi/web`
- `npx eslint <変更ファイル> --max-warnings=0`
- 全体 `npm run test:unit` は既知のfixture/過去コミット依存の失敗を除き成功。失敗は本WPの変更前から存在するものとして切り分ける。
- Evidence: `evidence/WP-P2-UIX-043/`

## 9. Security and Audit

- 表示層とテストのみ。認可・RLS・監査の変更なし。
- フォームの `inert` 除去は、サーバ側検証を弱めない。Server Actionの検証は従来どおり。
- Evidenceに実PII・Secretを含めない。

## 10. Rollback / 失敗時の扱い

各変更ファイルを戻す。Migrationなし、保存済みデータの変更なし。
CSP/セキュリティヘッダーは本WPに含めない。

## 11. References

[[03.13_UX_Accessibility_Requirements]], [[03.18_Requirements_Traceability_Matrix]], [[WP-P2-UIX-025]], [[WP-P2-UIX-030]], [[WP-P2-UIX-038]]。

## 12. Definition of Done

- [x] §7をすべて満たす
- [x] §8のEvidenceを保存した
- [x] API/DB変更なしを確認した
- [x] WP台帳・RTM・Dependency Map・MANIFESTを更新した
- [x] Execution Logへ追記した

## 13. Execution Log

### 2026-11-15 点検からの着手

- 変更ファイル: §4の表示層・テスト・WP/台帳。
- 修正:
  - `FeedbackForm` の `ready` 状態とSSR `inert` を削除。`aria-busy` は送信中だけtrue。
  - `AppFrame` にレールのref/id、開閉時のフォーカス移動/復帰、Tabトラップ、背景 `inert`、Escape/外側クリック、`matchMedia` でのデスクトップ復帰、body scroll lockを追加。
  - モバイルCSSで閉じたレールを `visibility: hidden` にし、開閉時のみvisible。
  - `TableRegion` に `className` を追加し、全25テーブルを `TableRegion` + captionへ統一。
  - `--fs-control-border: #8490a2` を追加し、入力/select/textarea/secondaryボタン/検索の境界を3:1以上に。
  - `.support-search:focus-within` に3pxのアウトラインを追加。
  - 入力文字を `max(1rem, 1em)`、`pointer: coarse` の44pxターゲット、`forced-colors` のフォーカスを追加。
  - `freshservice.css` と各module CSSのfont-sizeをremへ変換し、`layout.tsx` で `text-scale: scale` をopt-in。
  - `formatDate` / `jstToday` を追加し、access-review・承認変更履歴・下書き時刻をJST固定に。
- 検証:
  - `node node_modules/vitest/vitest.mjs run tests/unit/form-feedback-progressive.test.ts tests/unit/table-regions.test.ts tests/unit/ui-contrast-and-focus.test.ts tests/unit/jst-format.test.ts tests/unit/support-portal-ui.test.ts`: 53成功。
  - `npm run typecheck --workspace=@solvi/web`: 成功。
  - `npx eslint <変更ファイル> --max-warnings=0`: 成功。
  - `npm run check:all`: 成功(Allowed Paths / Architecture / Images / Skips / Unwired / Traceability / WorkPackages)。
  - `npm run test:unit`: 4ファイル・34失敗。内訳は既知の `knowledge-list` fixture欠落、`performance-runtime` の過去コミット参照、`performance-search-static-cli`、`knowledge-search-page` の既存期待値。本WPの追加テストはすべて成功。
- セキュリティ影響: なし。認可・RLS・監査・APIは変更していない。
- 未解決: 全体ユニットテストの既知失敗。CSP/HSTS等はADR/WP-Fとして分離。実ブラウザのaxeは合成ログインが401のため未実行。
- Evidence: `evidence/WP-P2-UIX-043/`。

### 2026-11-17 実画面の axe・スクリーンショット(PR #19)

- 実行環境: Web の本番ビルド、API のローカル認証、使い捨てDB `solvi_wp043_evidence_test`(seed の合成データのみ)。開発用DB `solvi` には接続していない。
- 401 の原因: `.env` の `SYNTHETIC_ORG` が空で、検査対象のDBに合成ユーザーがいなかった。使い捨てDBに seed を入れ、organizationId を明示してログインした。
- 結果: 15画面 × Chromium/WebKit × 1440/375px の60スキャンで、axe の違反は0件。375pxの横はみ出しは0、コンソールエラーは0。
- 見つけた欠陥: 閉じたモバイルレールのリンクに Tab でフォーカスが入っていた(§7 の2番目の基準に反する)。原因は、モバイルの `.fs-flyout` が `visibility: visible` を明示し、`visibility: hidden` のレールを子孫側で上書きしていたこと。
  - 修正: `freshservice.css` で `visibility: inherit` にした。
  - 回帰テスト: `tests/unit/ui-contrast-and-focus.test.ts` に検査を追加した。修正前のCSSで失敗し、修正後に成功することを確認した。
  - 修正後に再ビルドして撮り直した。Tab がレールに入らないこと、開閉時のフォーカス移動と背景の `inert` を確認した。
- 変更ファイル: `apps/web/src/app/freshservice.css`、`tests/unit/ui-contrast-and-focus.test.ts`、本WP、MANIFEST、`evidence/WP-P2-UIX-043/20261117-1513-browser/`。
- Migration: なし。セキュリティ影響: なし。
- 未実施: WebKit のスクリーンショット(axe は WebKit でも実行)、実機の iOS/Android。
- Evidence: `evidence/WP-P2-UIX-043/20261117-1513-browser/`
