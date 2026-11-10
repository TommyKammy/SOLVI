---
project: SOLVI
doc_id: "WP-P2-UIX-033"
title: "サポートポータル配下のサブ画面を専用シェルへ展開"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-11-10"
updated: "2026-11-10"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "ui", "portal", "support"]
source_of_truth: true
implementation_status: "done"
story_points: 5
risk: "medium"
workstream: "UIX"
phase: "P2"
requirement_ids: ["BR-001", "NFR-UX-001", "NFR-UX-002", "NFR-UX-003", "NFR-UX-004"]
depends_on: ["WP-P2-UIX-032", "WP-P2-UIX-028"]
---

# WP-P2-UIX-033: サポートポータル配下のサブ画面を専用シェルへ展開

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | UIX |
| Risk | medium |
| Story Points | 5 |
| Suggested Owner | Frontend |
| Parallelizable | Yes |
| Gate | Gate A |

## 1. Purpose

WP-P2-UIX-032で `/portal` だけに適用したサポート専用シェルを、
利用者がポータルから遷移するサブ画面にも広げる。
左レールを外し、白いサブページヘッダー+淡い背景+既存の白いパネルで統一する。

## 2. Requirement IDs

`BR-001`, `NFR-UX-001`, `NFR-UX-002`, `NFR-UX-003`, `NFR-UX-004`

## 3. Dependencies

[[WP-P2-UIX-032]], [[WP-P2-UIX-028]]

## 4. Scope / Allowed Paths

- `apps/web/src/components/AppFrame.tsx`
- `apps/web/src/components/SupportFrame.tsx`
- `apps/web/src/app/freshservice.css`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-033.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-UIX-033/`

## 5. Out of Scope

- 管理・編集画面(`/catalog/manage`, `/knowledge/new`)のサポート化
- エージェント業務画面(`/inbox`, `/ops`, `/assets`, `/changes`)の変更
- API・DB・認可・検索の変更
- サポートポータルの情報設計そのものの変更

## 6. Deliverables

- サポートシェルの対象ルート判定
  - `/catalog` 配下(`/catalog/manage` を除く)
  - `/knowledge` 配下(`/knowledge/new` を除く)
  - `/tickets` 配下
  - `/requests` 配下
  - `/settings` 配下
- サブページ用の白いヘッダー(ダークテキスト)と淡い背景
- サブページの白いコンテンツパネル/カードの統一
- デスクトップ/モバイルのスクリーンショットとaxe結果

## 7. Acceptance Criteria

- [ ] `/catalog`, `/catalog/{id}`, `/knowledge`, `/knowledge/{id}`, `/tickets/new`, `/tickets/{id}`, `/requests`, `/requests/{id}`, `/settings/notifications` で左レールが表示されない。
- [ ] サブページのヘッダーは白背景・ダークテキストで、ロゴ、メニュー、通知、ユーザーメニューが動く。
- [ ] `/catalog/manage` と `/knowledge/new` は従来のエージェントシェルのまま。
- [ ] `/inbox`, `/ops`, `/assets`, `/changes` は従来のエージェントシェルのまま。
- [ ] ポータルのアクションカードから遷移してもサポートシェルが維持される。
- [ ] 既存の検索・申請・チケット詳細・承認操作が変わらず動作する。
- [ ] 800px以下で横スクロールせず、既存のレスポンシブが維持される。
- [ ] axeで対象画面にserious/criticalの違反がない。
- [ ] `npm run typecheck`、`npm run lint`、`npm run check:all`が通る。
- [ ] API・DB・Migrationの変更がない。

## 8. Verification and Evidence

- 各対象画面のデスクトップ(1440×900)・モバイル(375×812)
- 左レール0件、サポートヘッダー1件、サブページクラスの確認
- 管理・編集画面がエージェントシェルのままであること
- axe結果
- Evidence: `evidence/WP-P2-UIX-033/<YYYYMMDD-HHMM>/`

## 9. Security and Audit

- 表示層のみ。認可・RLS・監査の変更なし。
- 管理画面をサポートシェルにしないことで、管理操作の誤認を避ける。
- Evidenceに実PII・Secretを含めない。

## 10. Rollback / 失敗時の扱い

`AppFrame.tsx`、`SupportFrame.tsx`、`freshservice.css` の変更を戻す。Migrationなし。

## 11. Codex app Prompt

```text
WP-P2-UIX-033だけを実装してください。
- /catalog, /knowledge, /tickets, /requests, /settings 配下をサポートシェルへ。
- /catalog/manage と /knowledge/new は除外。
- サブページは白いヘッダー+淡い背景+既存の白いパネル。
- 既存機能を壊さない。
- typecheck/lint/check:all/axeを実行する。
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
| 2026-11-10 | Codex | - | Done | `evidence/WP-P2-UIX-033/20261110-1615/` | WP-032の残課題。サブ画面へサポートシェルを展開。 |

### 2026-11-10 の実行結果

- 変更ファイル:
  - `apps/web/src/components/AppFrame.tsx`
  - `apps/web/src/components/SupportFrame.tsx`
  - `apps/web/src/app/freshservice.css`
- 対象: `/catalog`, `/knowledge`, `/tickets`, `/requests`, `/settings` 配下。
- 除外: `/catalog/manage`, `/knowledge/new`, `/inbox`, `/ops`, `/assets`, `/changes`。
- サブページは白い固定ヘッダー+`#EBEFF3`背景。一覧は白いパネル、詳細/フォームは白いカード。
- 検証:
  - 対象9画面: `rail=0`, `supportHeader=1`, `subpage=1`, axe違反0
  - 除外4画面: `rail=1`, `supportHeader=0`
  - モバイル: `bodyWidth=375`
  - 全15画面のaxe違反0
  - `npm run typecheck` / `npm run lint` / `npm run check:all` 成功
- 補足: `--fs-text-muted` を `#596b7d` へ変更(グレー背景上のコントラスト確保)。
- セキュリティ影響: なし。表示層のみ。
- 未解決事項: `/assets` はサポートシェル対象外。管理・編集画面はエージェントシェルのまま。
- Rollback: `AppFrame.tsx`、`SupportFrame.tsx`、`freshservice.css` の変更を戻す。
