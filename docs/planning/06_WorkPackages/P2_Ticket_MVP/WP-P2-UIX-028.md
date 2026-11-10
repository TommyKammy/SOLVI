---
project: SOLVI
doc_id: "WP-P2-UIX-028"
title: "ポータル・ナレッジ・カタログのFreshservice化"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-11-10"
updated: "2026-11-10"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "ui", "portal", "knowledge", "catalog"]
source_of_truth: true
implementation_status: "done"
story_points: 8
risk: "medium"
workstream: "UIX"
phase: "P2"
requirement_ids: ["BR-001", "FR-KNW-003", "FR-CAT-001", "NFR-UX-001", "NFR-UX-002", "NFR-UX-003", "NFR-UX-004"]
depends_on: ["WP-P2-UIX-025", "WP-P2-UIX-026"]
---

# WP-P2-UIX-028: ポータル・ナレッジ・カタログのFreshservice化

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | UIX |
| Risk | medium |
| Story Points | 8 |
| Suggested Owner | Frontend + Product Owner |
| Parallelizable | Yes(UIX-025/026完了後) |
| Gate | Gate A |

## 1. Purpose

Freshserviceの利用者ポータル(ヒーロー検索+アクションカード)、ナレッジ(左カテゴリ+表)、サービスカタログ(左カテゴリ+カード)に寄せる。
検索・公開範囲・申請・ページングの既存処理は変えない。

## 2. Requirement IDs

`BR-001`, `FR-KNW-003`, `FR-CAT-001`, `NFR-UX-001`, `NFR-UX-002`, `NFR-UX-003`, `NFR-UX-004`

## 3. Dependencies

[[WP-P2-UIX-025]], [[WP-P2-UIX-026]]

## 4. Scope / Allowed Paths

- `apps/web/src/app/portal/page.tsx`
- `apps/web/src/app/knowledge/page.tsx`
- `apps/web/src/app/catalog/page.tsx`
- `apps/web/src/app/freshservice.css`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-028.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-UIX-028/`

## 5. Out of Scope

- ナレッジのカテゴリ/フォルダを新設するDB変更
- カタログの人気順・閲覧数・評価の集計
- ポータルの横断検索API(チケット・サービス・記事を一度に検索)
- 新しい申請・承認・記事公開の業務ルール

## 6. Deliverables

- `/portal`: ヒーロー検索、4つのアクションカード、既存の問い合わせ/申請セクション
- `/knowledge`: 左のカテゴリ/タグツリー、検索、記事テーブル、ページング
- `/catalog`: 左の対象カテゴリ、検索、サービスカード、ページング
- モバイル幅の積み上げレイアウト
- スクリーンショットとaxe結果

## 7. Acceptance Criteria

- [ ] `/portal` の上部に「どういった事でお困りですか？」のヒーローと検索欄が表示され、検索は `/knowledge?q=` へ送信される。
- [ ] `/portal` に「サービスを申請する」「障害を報告する」「ヘルプ記事を閲覧する」「承認を確認する」の4カードが表示され、既存の遷移先へ移動できる。
- [ ] `/knowledge` の左に「すべての記事」「ナレッジ管理(権限がある場合)」「タグ」が表示され、タグは `q=` の検索へ移動できる。
- [ ] `/knowledge` の記事が表形式(タイトル/状態/公開範囲/版/更新日/タグ)で表示され、既存の検索・ページングが動く。
- [ ] `/catalog` の左に「すべてのアイテム」と対象カテゴリが表示され、選択で絞り込める。
- [ ] `/catalog` のサービスがカードグリッドで表示され、既存の検索・ページングが動く。
- [ ] 800px以下で左ナビが本文の上に積まれ、本文が横スクロールしない。
- [ ] axeで `/portal`, `/knowledge`, `/catalog` にserious/criticalの違反がない。
- [ ] `npm run typecheck`、`npm run lint`、`npm run check:all`が通る。
- [ ] API・DB・Migrationの変更がない。

## 8. Verification and Evidence

- 1440×900と375×812の `/portal`, `/knowledge`, `/catalog`
- 検索/タグ/カテゴリ適用後のスクリーンショット
- axe結果
- `summary.json` にタグ数、カテゴリ数、カード数を記録

Evidence: `evidence/WP-P2-UIX-028/<YYYYMMDD-HHMM>/`

## 9. Security and Audit

- 表示層のみ。既存APIの認可範囲を越えない。
- ナレッジの公開範囲(`audience`)と記事状態を、既存の値のまま表示する。
- Evidenceに実PII・Secretを含めない。

## 10. Rollback / 失敗時の扱い

Migrationなし。`portal/page.tsx`、`knowledge/page.tsx`、`catalog/page.tsx`、CSSの変更を戻す。

## 11. Codex app Prompt

```text
WP-P2-UIX-028だけを実装してください。API/DBは変更しない。
- /portal にヒーロー検索と4アクションカードを追加する。
- /knowledge に左カテゴリ/タグと記事テーブルを追加する。
- /catalog に左カテゴリとカードグリッドを追加する。
- 既存の検索・ページング・公開範囲を壊さない。
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
| 2026-11-10 | Codex | - | Done | `evidence/WP-P2-UIX-028/20261110-1350/` | Freshservice UI移植の第4段階。 |

### 2026-11-10 の実行結果

- 変更ファイル:
  - `apps/web/src/app/portal/page.tsx`
  - `apps/web/src/app/knowledge/page.tsx`
  - `apps/web/src/app/catalog/page.tsx`
  - `apps/web/src/app/freshservice.css`
- Migration: なし。API/DB/認可/監査の変更なし。
- 検証:
  - `npm run typecheck` 成功
  - `npm run lint` 成功
  - `npm run check:all` 成功
  - axe: `/portal`, `/knowledge`, `/catalog` 違反0
  - ナレッジ: タグ9件、VPN検索1件
  - カタログ: カテゴリ3件、カード3件、PC・周辺機器で1件
- 画面確認用の合成データ: ナレッジ3件、カタログ3件をローカルDBに作成(本番Freshserviceには書き込みなし)。
- セキュリティ影響: なし。
- 未解決事項: ナレッジのカテゴリDB、カタログ人気順、ポータル横断検索。
- Rollback: `portal/page.tsx`、`knowledge/page.tsx`、`catalog/page.tsx`、`freshservice.css` の変更を戻す。
