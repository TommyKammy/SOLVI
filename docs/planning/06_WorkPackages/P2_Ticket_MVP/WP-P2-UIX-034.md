---
project: SOLVI
doc_id: "WP-P2-UIX-034"
title: "サポートシェルの適用をロール基準に修正"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-11-10"
updated: "2026-11-10"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "ui", "portal", "bugfix"]
source_of_truth: true
implementation_status: "done"
story_points: 3
risk: "medium"
workstream: "UIX"
phase: "P2"
requirement_ids: ["BR-001", "NFR-UX-001", "NFR-UX-002", "NFR-UX-003", "NFR-UX-004"]
depends_on: ["WP-P2-UIX-033"]
---

# WP-P2-UIX-034: サポートシェルの適用をロール基準に修正

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | UIX |
| Risk | medium |
| Story Points | 3 |
| Suggested Owner | Frontend |
| Parallelizable | Yes |
| Gate | Gate A |

## 1. Purpose

WP-P2-UIX-033でサポートシェルをサブ画面へ広げた結果、
`org_admin` が管理者ダッシュボードの左レールから `/knowledge` や `/catalog` を開いても
サポートポータル風の画面になった。管理者の操作導線を元のエージェントUIへ戻す。

**同じURLでも、スタッフにはエージェントUI、依頼者にはサポートUI**を出す。
`/portal` はどちらもサポートポータルのホームとして残す。

## 2. Requirement IDs

`BR-001`, `NFR-UX-001`, `NFR-UX-002`, `NFR-UX-003`, `NFR-UX-004`

## 3. Dependencies

[[WP-P2-UIX-033]]

## 4. Scope / Allowed Paths

- `apps/web/src/components/AppFrame.tsx`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-034.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-UIX-034/`

## 5. Out of Scope

- サポートポータルのデザイン変更
- 新しいロールや権限の追加
- API・DB・認可の変更
- `/portal` 自体のレイアウト変更

## 6. Deliverables

- サポートシェルの適用条件を `isSupportPath && !staff` に変更
- `/portal` はスタッフ・依頼者ともサポートホーム
- 管理者の左レールから `/knowledge` / `/catalog` を開いたときのエージェントUI復帰
- 依頼者のサブ画面はサポートUIのまま
- 両ロールのスクリーンショットとaxe結果

## 7. Acceptance Criteria

- [ ] `org_admin` で `/inbox` の左レールから「ナレッジ」を開くと、エージェントUIの `/knowledge` が表示される。
- [ ] `org_admin` で左レールから「サービスカタログ」を開くと、エージェントUIの `/catalog` が表示される。
- [ ] `org_admin` の `/tickets/new`, `/tickets/{id}`, `/requests`, `/settings/notifications` もエージェントUIになる。
- [ ] `requester` の `/knowledge`, `/catalog`, `/tickets/new`, `/tickets/{id}`, `/requests`, `/settings/notifications` はサポートUIのまま。
- [ ] `/portal` は両ロールともサポートポータルホーム。
- [ ] `/catalog/manage`, `/knowledge/new`, `/inbox`, `/ops` は従来どおりエージェントUI。
- [ ] axeで対象画面にserious/criticalの違反がない。
- [ ] `npm run typecheck`、`npm run lint`、`npm run check:all`が通る。
- [ ] API・DB・Migrationの変更がない。

## 8. Verification and Evidence

- org_admin: `/knowledge`, `/catalog`, `/tickets/new`, `/tickets/{id}`, `/requests`, `/settings` のレール/サポートヘッダー
- requester: 同じ画面のレール/サポートヘッダー
- 左レールからナレッジ/カタログを開いた直後のスクリーンショット
- axe結果
- Evidence: `evidence/WP-P2-UIX-034/<YYYYMMDD-HHMM>/`

## 9. Security and Audit

- 表示層のみ。認可・RLS・監査の変更なし。
- ロール判定は既存の `navigationRoles` の `staff` を使う。
- Evidenceに実PII・Secretを含めない。

## 10. Rollback / 失敗時の扱い

`AppFrame.tsx` の条件を戻す。Migrationなし。

## 11. Codex app Prompt

```text
WP-P2-UIX-034だけを実装してください。
- サポートシェルは「依頼者」だけに適用する。
- スタッフは /knowledge, /catalog, /tickets, /requests, /settings でエージェントUI。
- /portal は両ロールともサポートホーム。
- 両ロールで確認し、axe/typecheck/lint/check:allを実行する。
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
| 2026-11-10 | Codex | - | Done | `evidence/WP-P2-UIX-034/20261110-1710/` | 利用者報告: org_adminの左レールからナレッジ/カタログを開くとサポートUIになる。 |

### 2026-11-10 の実行結果

- 変更ファイル: `apps/web/src/components/AppFrame.tsx`
- 原因: サポートシェルをURLパスだけで判定していた。
- 修正: `pathname === '/portal' || (isSupportPath(pathname) && !staff)` に変更。
- 検証:
  - org_admin: `/knowledge`, `/catalog`, `/tickets/new`, `/tickets/{id}`, `/requests`, `/settings` は `rail=1` / `supportHeader=0`
  - 左レール「ナレッジ」「サービスカタログ」からの実操作も `rail=1`
  - requester: 同じ画面は `rail=0` / `supportHeader=1`
  - `/portal` は両ロールともサポートホーム
  - axe: 上記すべて違反0
  - `npm run typecheck` / `npm run lint` / `npm run check:all` 成功
- セキュリティ影響: なし。表示層のみ。
- Rollback: `AppFrame.tsx` の条件を戻す。
