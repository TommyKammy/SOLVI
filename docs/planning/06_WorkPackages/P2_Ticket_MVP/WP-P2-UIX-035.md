---
project: SOLVI
doc_id: "WP-P2-UIX-035"
title: "左レールのナレッジ現在地判定を修正"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-11-10"
updated: "2026-11-10"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "ui", "navigation", "bugfix"]
source_of_truth: true
implementation_status: "done"
story_points: 2
risk: "low"
workstream: "UIX"
phase: "P2"
requirement_ids: ["BR-001", "NFR-UX-001", "NFR-UX-002", "NFR-UX-003", "NFR-UX-004"]
depends_on: ["WP-P2-UIX-034"]
---

# WP-P2-UIX-035: 左レールのナレッジ現在地判定を修正

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | UIX |
| Risk | low |
| Story Points | 2 |
| Suggested Owner | Frontend |
| Parallelizable | Yes |
| Gate | Gate A |

## 1. Purpose

左レールの「ナレッジ」フライアウトで、`/knowledge` を開くと
「ナレッジ検索」と「ナレッジ管理」の両方が選択中(青背景)になる。
現在地判定をパスだけで行い、`manage=1` を区別していないことが原因である。
URLのクエリまで見て、同時に1項目だけが選択中になるよう修正する。

## 2. Requirement IDs

`BR-001`, `NFR-UX-001`, `NFR-UX-002`, `NFR-UX-003`, `NFR-UX-004`

## 3. Dependencies

[[WP-P2-UIX-034]]

## 4. Scope / Allowed Paths

- `apps/web/src/components/AppFrame.tsx`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-035.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-UIX-035/`

## 5. Out of Scope

- ナレッジ画面自体のレイアウト・検索仕様の変更
- レールの項目構成・順序の変更
- API・DB・認可の変更

## 6. Deliverables

- 現在地判定を「パス + クエリ」で行う
- `matchPath` はパスの上書きだけに限定し、クエリは `href` から引き継ぐ
- 同一パスではクエリが多い項目を優先する
- フライアウトの選択中表示を、解決済みの現在項目と一致する1件だけに限定する

## 7. Acceptance Criteria

- [ ] `/knowledge` で「ナレッジ検索」だけが選択中になる。
- [ ] `/knowledge?manage=1` で「ナレッジ管理」だけが選択中になる。
- [ ] `/knowledge/{id}` で「ナレッジ検索」が選択中になる。
- [ ] `/knowledge/{id}?manage=1` で「ナレッジ管理」が選択中になる。
- [ ] `/knowledge/new` で「記事を作成」だけが選択中になる。
- [ ] 他グループ(チケット、カタログ、資産、変更、管理)の選択中表示が変わらない。
- [ ] axeで対象画面にserious/criticalの違反がない。
- [ ] `npm run typecheck`、`npm run lint`、`npm run check:all`が通る。
- [ ] API・DB・Migrationの変更がない。

## 8. Verification and Evidence

- org_admin で各ナレッジURLを開き、フライアウトの `aria-current="page"` と背景色を取得
- 他グループの代表画面(`/inbox`, `/catalog`, `/assets`, `/changes`, `/ops/admin`)の選択中表示
- axe結果
- Evidence: `evidence/WP-P2-UIX-035/<YYYYMMDD-HHMM>/`

## 9. Security and Audit

- 表示層のみ。認可・RLS・監査の変更なし。
- 現在地判定は表示だけに使い、リンク先や権限は変えない。
- Evidenceに実PII・Secretを含めない。

## 10. Rollback / 失敗時の扱い

`AppFrame.tsx` の現在地判定を戻す。Migrationなし。

## 11. Codex app Prompt

```text
WP-P2-UIX-035だけを実装してください。
- 左レールの現在地判定をパス+クエリで行う。
- /knowledge はナレッジ検索、/knowledge?manage=1 はナレッジ管理だけを選択中にする。
- 他グループの選択中表示を変えない。
- axe/typecheck/lint/check:allを実行する。
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
| 2026-11-10 | Codex | - | Done | `evidence/WP-P2-UIX-035/20261110-1830/` | 利用者報告: ナレッジ検索とナレッジ管理が同時に選択中になる。 |

### 2026-11-10 の実行結果

- 変更ファイル: `apps/web/src/components/AppFrame.tsx`
- 原因: 現在地判定がパスだけで、`?manage=1` を区別していなかった。
- 修正: `useSearchParams` を併用し、パス+クエリで判定。同一パスはクエリが多い項目を優先。
- 検証:
  - `/knowledge` → ナレッジ検索のみ
  - `/knowledge?manage=1` → ナレッジ管理のみ
  - `/knowledge/{id}` → ナレッジ検索のみ
  - `/knowledge/{id}?manage=1` → ナレッジ管理のみ
  - `/knowledge/new` → 記事を作成のみ
  - 他グループ8画面の選択中表示も従来どおり
  - axe: 13画面すべて違反0
  - モバイル375pxで横スクロールなし
  - `npm run typecheck` / `npm run lint` / `npm run check:all` 成功
- セキュリティ影響: なし。表示層のみ。
- Rollback: `AppFrame.tsx` の判定を戻す。
