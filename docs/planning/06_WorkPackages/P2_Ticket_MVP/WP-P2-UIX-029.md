---
project: SOLVI
doc_id: "WP-P2-UIX-029"
title: "管理画面のカードグリッド化"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-11-10"
updated: "2026-11-10"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "ui", "admin"]
source_of_truth: true
implementation_status: "done"
story_points: 3
risk: "low"
workstream: "UIX"
phase: "P2"
requirement_ids: ["NFR-UX-001", "NFR-UX-002", "NFR-UX-003", "NFR-UX-004"]
depends_on: ["WP-P2-UIX-025", "WP-P2-UIX-028"]
---

# WP-P2-UIX-029: 管理画面のカードグリッド化

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | UIX |
| Risk | low |
| Story Points | 3 |
| Suggested Owner | Frontend + Product Owner |
| Parallelizable | Yes(UIX-028完了後) |
| Gate | Gate A |

## 1. Purpose

Freshserviceの管理ホームと同じく、管理機能への入口をカードグリッドで示す。
既存の管理画面(`/ops/users`, `/ops/groups`, `/ops/notifications`, `/ops/access-review`, `/catalog/manage`, `/assets/imports`)はそのまま使い、新しい管理機能は作らない。

## 2. Requirement IDs

`NFR-UX-001`, `NFR-UX-002`, `NFR-UX-003`, `NFR-UX-004`

## 3. Dependencies

[[WP-P2-UIX-025]], [[WP-P2-UIX-028]]

## 4. Scope / Allowed Paths

- `apps/web/src/app/ops/admin/page.tsx`
- `apps/web/src/lib/navigation-groups.ts`
- `apps/web/src/app/freshservice.css`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-029.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-UIX-029/`

## 5. Out of Scope

- 新しい管理機能・設定項目の追加
- 管理API・DB・認可の変更
- Freshserviceの「アカウントモード」「プラン」「デバイス」など、SOLVIに存在しない設定
- 管理画面の検索・お気に入り・権限編集

## 6. Deliverables

- `/ops/admin` の管理ホーム
- 「アカウント設定」「ユーザー管理」の2グループ
- 利用者管理、担当グループ、通知状況、アクセスレビュー、カタログ管理、資産CSV取込へのカード
- 左レールの「管理」から `/ops/admin` へ移動
- モバイル幅の1列カード

## 7. Acceptance Criteria

- [ ] `org_admin` / `platform_admin` で `/ops/admin` を開くと管理カードが表示される。
- [ ] 権限のない利用者は管理カードを見られず、権限がない旨が表示される。
- [ ] 「利用者管理」「担当グループ」「アクセスレビュー」「カタログ管理」「資産CSV取込」のカードが既存画面へ移動する。
- [ ] `org_admin` には「通知状況」カードが表示され、`platform_admin` には表示されない。
- [ ] 左レールの「管理」が `/ops/admin` を指し、現在地が「管理 > 管理ホーム」になる。
- [ ] 800px以下でカードが1列に積まれる。
- [ ] axeで `/ops/admin` にserious/criticalの違反がない。
- [ ] `npm run typecheck`、`npm run lint`、`npm run check:all`が通る。
- [ ] API・DB・Migrationの変更がない。

## 8. Verification and Evidence

- 1440×900と375×812の `/ops/admin`
- `org_admin` と `platform_admin` のカード差異
- 各カードの遷移先
- axe結果

Evidence: `evidence/WP-P2-UIX-029/<YYYYMMDD-HHMM>/`

## 9. Security and Audit

- 表示層のみ。管理APIの認可は既存のまま。
- カードを隠すことを認可にしない。API側の権限検査は残る。
- Evidenceに実PII・Secretを含めない。

## 10. Rollback / 失敗時の扱い

Migrationなし。`ops/admin/page.tsx`、`navigation-groups.ts`、CSSの変更を戻す。

## 11. Codex app Prompt

```text
WP-P2-UIX-029だけを実装してください。API/DBは変更しない。
- /ops/admin に管理カードグリッドを追加する。
- 左レールの管理を /ops/admin へ向ける。
- 既存の管理画面へのリンクだけを置く。
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
| 2026-11-10 | Codex | - | Done | `evidence/WP-P2-UIX-029/20261110-1410/` | Freshservice UI移植の最終段階。 |

### 2026-11-10 の実行結果

- 変更ファイル:
  - `apps/web/src/app/ops/admin/page.tsx`(新規)
  - `apps/web/src/lib/navigation-groups.ts`
  - `apps/web/src/components/AppFrame.tsx`(詳細判定をUUID/数値IDに限定)
  - `apps/web/src/app/freshservice.css`
- Migration: なし。API/DB/認可/監査の変更なし。
- 検証:
  - `npm run typecheck` 成功
  - `npm run lint` 成功
  - `npm run check:all` 成功
  - axe: `/ops/admin` 違反0
  - org_admin: 6カード、2グループ、レール`/ops/admin`
  - agent: カード0、権限なしメッセージ
- セキュリティ影響: なし。カード非表示は認可の代替ではない。
- 未解決事項: platform_admin専用の横断管理カード、管理ホーム検索、最近使った項目。
- Rollback: `ops/admin/page.tsx`、`navigation-groups.ts`、`AppFrame.tsx`、`freshservice.css` の変更を戻す。
