---
project: SOLVI
doc_id: "WP-P2-UIX-032"
title: "サポートポータルのFreshservice準拠レイアウト"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-11-10"
updated: "2026-11-10"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "ui", "portal"]
source_of_truth: true
implementation_status: "done"
story_points: 8
risk: "medium"
workstream: "UIX"
phase: "P2"
requirement_ids: ["BR-001", "NFR-UX-001", "NFR-UX-002", "NFR-UX-003", "NFR-UX-004"]
depends_on: ["WP-P2-UIX-025", "WP-P2-UIX-028"]
---

# WP-P2-UIX-032: サポートポータルのFreshservice準拠レイアウト

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | UIX |
| Risk | medium |
| Story Points | 8 |
| Suggested Owner | Frontend + Product Owner |
| Parallelizable | Yes |
| Gate | Gate A |

## 1. Purpose

Freshserviceのサポートポータル(`/support/home`)をREAで確認し、SOLVIの `/portal` を
同じ構造へ寄せる。エージェントUIの左レールを外し、写真ヒーロー・検索・2×2カード・
白いタブパネルを持つセルフサービス画面にする。

## 2. Requirement IDs

`BR-001`, `NFR-UX-001`, `NFR-UX-002`, `NFR-UX-003`, `NFR-UX-004`

## 3. Dependencies

[[WP-P2-UIX-025]], [[WP-P2-UIX-028]]

## 4. Scope / Allowed Paths

- `apps/web/src/app/portal/page.tsx`
- `apps/web/src/components/AppFrame.tsx`
- `apps/web/src/components/SupportFrame.tsx`
- `apps/web/src/app/freshservice.css`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-032.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-UIX-032/`

## 5. Out of Scope

- Freshworksの写真・ロゴ・アイコン素材の複製
- チケット・申請・カタログのAPI/DB変更
- 新しい横断検索API
- ジャーニー/登録解除などSOLVIに存在しない機能の追加

## 6. Deliverables

- `/portal` 専用のサポートヘッダー(左レールなし、ヒーロー上に重なる透過ヘッダー)
- ヒーロー: タイトル、ヘルプ検索、ブランドグラデーション背景
- 2×2のアクションカード
- 白いタブパネル: オープンなチケット / 申請の状況 / サービスを探す
- 既存のチケット・申請・カタログ・ナレッジ検索の機能維持
- モバイル幅の1列レイアウト
- スクリーンショットとaxe結果

## 7. Acceptance Criteria

- [ ] `/portal` でエージェント用の左レールが表示されない。
- [ ] ヒーローに「どういった事でお困りですか？」と検索欄が表示され、検索は `/knowledge?q=` へ送信される。
- [ ] 2×2のアクションカードが表示され、サービス申請・障害報告・ヘルプ記事・承認確認へ移動できる。
- [ ] 下部に「オープンなチケット」「申請の状況」「サービスを探す」のタブがあり、URLの`tab`で切り替わる。
- [ ] チケットタブで未解決/すべての切替、ページング、詳細への遷移が従来どおり動く。
- [ ] 申請タブで最近の申請が表示され、`/requests?view=mine` へ移動できる。
- [ ] サービスタブでサービス検索・サービス一覧・ナレッジ検索が使える。
- [ ] 800px以下でカードが1列、タブパネルが横スクロールしない。
- [ ] axeで `/portal` にserious/criticalの違反がない。
- [ ] `npm run typecheck`、`npm run lint`、`npm run check:all`が通る。
- [ ] API・DB・Migrationの変更がない。

## 8. Verification and Evidence

- REA: Freshservice `/support/home` のスクリーンショットとDOM/CSS値
  - ヘッダー64px、ヒーロー372px、タイトル40px/48、検索680×60
  - カード400×142、2×2、影 `rgba(32,33,39,.08) 0 6px 19px`
  - 背景 `#EBEFF3`、タブパネル白
- SOLVIの `/portal` デスクトップ/モバイル
- タブ切替、検索、カード遷移の確認
- axe結果

Evidence: `evidence/WP-P2-UIX-032/<YYYYMMDD-HHMM>/`

## 9. Security and Audit

- 表示層のみ。既存APIの認可範囲を越えない。
- Freshservice本番は読み取り専用。チケット作成・更新・削除・設定変更は行わない。
- Evidenceに実PII・Secretを含めない。Freshserviceの写真は複製しない。

## 10. Rollback / 失敗時の扱い

`portal/page.tsx`、`AppFrame.tsx`、`SupportFrame.tsx`、CSSの変更を戻す。Migrationなし。

## 11. Codex app Prompt

```text
WP-P2-UIX-032だけを実装してください。
- /portal をサポートポータル専用レイアウトにする(左レールなし)。
- ヒーロー、検索、2×2カード、白いタブパネルを作る。
- 既存のチケット/申請/カタログ/ナレッジ検索を壊さない。
- API/DBは変更しない。
- typecheck/lint/check:all/axeを実行しEvidenceを保存する。
```

## 12. Definition of Done

- [ ] §7をすべて満たす
- [ ] §8のEvidenceを保存した
- [ ] API/DB変更なしを確認した
- [ ] WP台帳・RTM・Dependency Map・MANIFESTを更新した
- [ ] Execution Logへ追記した

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-11-10 | Codex | - | Done | `evidence/WP-P2-UIX-032/20261110-1540/` | Freshservice `/support/home` をREAで分析。 |

### 2026-11-10 の実行結果

- 変更ファイル:
  - `apps/web/src/app/portal/page.tsx`
  - `apps/web/src/components/AppFrame.tsx`
  - `apps/web/src/components/SupportFrame.tsx`(新規)
  - `apps/web/src/app/freshservice.css`
- REA: `/support/home` を読み取り専用で分析(ヘッダー64px、ヒーロー372px、タイトル40/48、検索680×60、カード400×142の2×2、背景`#EBEFF3`、タブパネル白)。
- 実装: 左レールなしのサポート専用シェル、ヒーロー検索、2×2カード、3タブ(オープンなチケット/申請の状況/サービスを探す)。
- 検証:
  - `npm run typecheck` / `npm run lint` / `npm run check:all` 成功
  - `portal-catalog` 26件成功
  - axe: `/portal`、申請/サービスタブ、全15画面で違反0
  - モバイル: `bodyWidth=375`、カード1列、横スクロールなし
- セキュリティ影響: なし。Freshserviceは読み取り専用、写真・ロゴは複製していない。
- 未解決事項: サポート専用レイアウトは `/portal` のみ。横断検索、サブ画面の専用シェルは後続。
- Rollback: `portal/page.tsx`、`AppFrame.tsx`、`SupportFrame.tsx`、`freshservice.css` の変更を戻す。
