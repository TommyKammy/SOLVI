---
project: "SOLVI"
doc_id: "WP-P2-UIX-052"
title: "採用したSOLVIモックアップと画面表示の整合"
category: "06_WorkPackages"
type: "work-package"
status: "baseline"
version: "0.1.0"
created: "2026-11-19"
updated: "2026-11-19"
owner: "SOLVI Product Team"
tags: ["ui", "responsive", "design-system"]
source_of_truth: true
implementation_status: "review"
workstream: "UIX"
phase: "P2"
risk: "low"
story_points: 8
requirement_ids: ["NFR-UX-002", "NFR-UX-003", "NFR-UX-004"]
depends_on: ["WP-P2-UIX-044", "WP-P2-UIX-045", "WP-P2-UIX-046"]
---

# WP-P2-UIX-052 採用したSOLVIモックアップと画面表示の整合

## 1. Purpose

製品チームが採用した第1〜8段階の操作式HTMLをデザインの参照として保管し、SOLVI本体の書体、文字組み、シェル寸法、ページの見出し・操作列・パネルを揃える。

## 2. Requirement IDs

`NFR-UX-002`、`NFR-UX-003`、`NFR-UX-004`。

## 3. Dependencies

[[WP-P2-UIX-044]]、[[WP-P2-UIX-045]]、[[WP-P2-UIX-046]] は baseline・done。この変更は `e6cfb83` の表示を対象とし、先行する各機能の人間のレビューを維持する。

## 4. Scope / Allowed Paths

- `apps/web/src/app/freshservice.css`
- `apps/web/src/components/AppFrame.tsx`
- `apps/web/src/components/AppShell.tsx`
- `apps/web/src/components/SupportFrame.tsx`
- `apps/web/src/components/FreshserviceIcon.tsx`
- `apps/web/src/app/ops/overview/page.tsx`
- `apps/web/src/app/inbox/page.tsx`
- `apps/web/src/app/catalog/manage/page.tsx`
- `apps/web/src/app/catalog/page.tsx`
- `apps/web/src/app/knowledge/page.tsx`
- `apps/web/src/app/requests/page.tsx`
- `tests/unit/ui-contrast-and-focus.test.ts`
- `tests/unit/operations-overview.test.ts`
- `docs/planning/11_UI_UX/11.3_Design_System.md`
- `docs/planning/11_UI_UX/11.13_Mockup_Asset_Index.md`
- `docs/planning/assets/ui/SOLVI_Operations_Mockup.html`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-052.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-UIX-052/`

## 5. Out of Scope

API・画面の権限・業務状態・既存のデータ・遷移の変更、モック用のサンプルデータ・役割切替・時計の製品への持ち込み、外部フォント、Migration。

## 6. Deliverables

- モックアップの現物と設計正本。共通の書体、本文14px・行高1.65、ページ見出し32px／狭幅28px、サイドバー224px、上部バー64px、左右余白32／24／20px、ボタン・配色・パネルの共通ルールを記録する。
- 担当者・依頼者のシェル、運営状況、業務受信箱をモックアップの構成へ寄せる。チケット詳細、ポータル、カタログ・承認、ナレッジ、資産・変更、管理、レポート・監査、AI支援・模擬実行で共通の見出し、ボタン、操作列、パネルを適用する。
- 操作対象の判別、文字コントラスト、ラベル、フォーカス、既存のロール・検索・詳細への遷移・フォームの挙動を維持する。

## 7. Acceptance Criteria

- AC-1 モックアップと本体を同じブラウザ・PC 1440px・モバイル375pxで開き、担当者シェルの書体・見出しと本文のサイズと行高・コンテンツ左右・上部バーおよびPCサイドバーを実測して照合する。
- AC-2 運営状況はページ見出しの下に今日の対応を配置し、PCは作業列と状況列、モバイルは1列にする。業務受信箱の件数・絞り込み・一覧を同順で整える。チケットの詳細と元画面への移動、モバイルのメニューと検索を確認する。
- AC-3 依頼者ポータル・報告・詳細、カタログ・承認、ナレッジ、資産・変更、管理、レポート・監査、AI支援・模擬実行の代表画面で共通表現を比較し、実データの表示、操作の可視性、375pxでのページ横はみ出しとaxeを確認する。モックアップにない業務データ・操作がある箇所は記録する。
- AC-4 UIの検証Evidence、設計正本・台帳・Manifestを更新し、型検査、ユニット検査、ガバナンス検査を実行する。

## 8. Verification and Evidence

隔離DBの合成データと実セッションでPC・モバイル、両テーマを確認する。ポート3000の稼働画面でも主要寸法と遷移を検証する。

## 9. Security and Audit

既存の認証、認可、承認、監査処理を使用する。画面の操作領域やナビゲーションを変える場合も、既存のAPIと表示条件に従う。

## 10. Rollback

Migrationなし。CSS・表示構造・設計文書を同じコミット単位でrevertできる。

## 11. References

[[11.3_Design_System]]、[[11.13_Mockup_Asset_Index]]、[[03.13_UX_Accessibility_Requirements]]、[[WP-P2-UIX-044]]、[[WP-P2-UIX-045]]、[[WP-P2-UIX-046]]。

## 12. Definition of Done

§7の比較と検査結果を保存してレビューに提出する。

## 13. Execution Log

- 2026-11-19 第1〜8段階の表示を対象に、採用した操作式モックアップに合わせる差分を定義した。
- 2026-11-19 共通CSSと担当者・依頼者のシェル、運営状況・業務受信箱・カタログ（管理を含む）・ナレッジ・申請状況を更新。変更ファイルは§4の一覧のとおり。許可範囲にあるユニット検査2件、モックアップ現物、設計正本・索引・WP台帳・依存マップ・RTM・Manifest、Evidenceを更新した。
  - Migrationなし。前の表示に戻す場合は、この変更のコミットをrevertする。
  - AC-1合格。Chromeの1440pxと375pxで、運営状況の書体（Hiragino Sans W7）と太さ、見出し32px／28px、開始位置（左256px・上98px／左20px・上88px）、本文14px・行高23.1px、上部バー64px、左右余白32px／20px、PCサイドバー224pxが参照と一致した。
  - AC-2合格。運営状況の2列／1列、受信箱の件数・絞り込み・一覧、検索、モバイルメニュー、同じチケットへの公開返信と依頼者側での表示、一覧とフォーカスへの復帰を確認した。
  - AC-3合格。参照と13画面の見出しを両幅で照合し、ライト／ダーク計84条件でページの横方向のはみ出しとaxeの自動検出違反は各0件。コントラストはポータルのグラデーションとモバイルの横スクロール表の計5条件で自動判定保留。ポータル見出しは背景グラデーション両端の配色で4.5:1以上。モックアップのサンプル表示と実画面のロール別操作・日時・件数の差はEvidenceに記録した。
  - AC-4合格。型検査、ユニット検査（4,897件合格、既存のskip 26件、失敗なし）、作業領域のlint、ガバナンス検査、本番向けビルドが成功した。
  - セキュリティ影響なし。実際のログイン、権限・一覧フィルター・業務状態を使う。
  - 未解決事項はモバイル実機での表示確認と、モバイルの横スクロール表で自動判定が保留になった箇所の手動コントラスト確認。
  - Evidenceは `evidence/WP-P2-UIX-052/20261119-2233/`。再現手順は同梱のREADME、出力は `logs/` と `summary.json`、比較画像は `screens/`。

  ```sh
  rtk proxy npm run typecheck
  rtk proxy npm run lint -- --ignore-pattern '.claude/**'
  rtk proxy npm run test:unit -- --reporter=json --outputFile='/tmp/solvi-uix052.xhytv3s2/unit.json'
  rtk proxy npm run check:all
  rtk proxy node --env-file=.env '/tmp/solvi-uix052.xhytv3s2/stack.mjs' prepare 'solvi_uix052_1795095486_test'
  rtk proxy node --env-file=.env '/tmp/solvi-uix052.xhytv3s2/capture.mjs' '/tmp/solvi-uix052.xhytv3s2/release' 'solvi_uix052_1795095486_test' 01
  rtk proxy node '/tmp/solvi-uix052.xhytv3s2/live.mjs'
  ```
