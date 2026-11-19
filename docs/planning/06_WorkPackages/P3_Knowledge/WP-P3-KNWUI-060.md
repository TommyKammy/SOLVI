---
project: "SOLVI"
doc_id: "WP-P3-KNWUI-060"
title: "ナレッジの下書き・レビュー・公開と依頼者検索"
category: "06_WorkPackages"
type: "work-package"
status: "baseline"
version: "0.1.0"
created: "2026-11-19"
updated: "2026-11-19"
owner: "SOLVI Product Team"
tags: ["ui", "knowledge", "accessibility"]
source_of_truth: true
implementation_status: "review"
workstream: "KNWUI"
phase: "P3"
risk: "low"
story_points: 5
requirement_ids: ["FR-KNW-001", "FR-KNW-002", "FR-KNW-003", "NFR-UX-001", "NFR-UX-002", "NFR-UX-003", "NFR-UX-004"]
depends_on: ["WP-P2-UIX-028", "WP-P2-UIX-043", "WP-P2-UIX-044", "WP-P3-KNWUI-059"]
---

# WP-P3-KNWUI-060 ナレッジの下書き・レビュー・公開と依頼者検索

| 項目 | 値 |
|---|---|
| Phase | P3 |
| Workstream | KNWUI |
| Risk | low |
| Story Points | 5 |
| Suggested Owner | Frontend |
| Parallelizable | No |
| Gate | Gate 3 |

## 1. Purpose

第4段階。担当者が下書きを保存してレビューへ送り、公開権限を持つ管理者が内容と閲覧範囲を確認して公開する。依頼者はポータルの検索から同じ記事の公開版を読む。組織内・担当者限定の公開範囲で見える違いと検索結果0件を確認する。

## 2. Requirement IDs

`FR-KNW-001`〜`FR-KNW-003`、`NFR-UX-001`〜`NFR-UX-004`。

## 3. Dependencies

[[WP-P2-UIX-028]]、[[WP-P2-UIX-043]]、[[WP-P2-UIX-044]]、[[WP-P3-KNWUI-059]] が `done` であることを確認。mainの現行Web/APIにある版固定、編集・レビュー・管理者公開、検索・閲覧を利用する。[[WP-P3-KNW-001]] と [[WP-P3-SRCH-002]] はdraftであり、新たなライフサイクルや検索方式は取り込まない。要求の正本は [[03.4_Knowledge_Requirements]]。作業ブランチの基点は第3段階を含む `93026a1`。

## 4. Scope / Allowed Paths

- `apps/web/src/app/knowledge/page.tsx`
- `apps/web/src/app/knowledge/[id]/page.tsx`
- `apps/web/src/app/knowledge/new/page.tsx`
- `apps/web/src/app/freshservice.css`
- `apps/web/src/components/KnowledgeEditor.tsx`
- `apps/web/src/components/KnowledgeEditor.module.css`
- `apps/web/src/components/SupportFrame.tsx`
- `tests/unit/knowledge-edit-ui.test.ts`
- `tests/unit/knowledge-detail-recovery-ui.test.ts`
- `tests/unit/knowledge-search-page.test.ts`
- `tools/ui_knowledge_detail_recovery_check.mjs`
- `docs/planning/06_WorkPackages/P3_Knowledge/WP-P3-KNWUI-060.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P3-KNWUI-060/`

## 5. Out of Scope

API、検索方式、永続化、公開権限、監査、全文検索の精度評価、記事評価、外部公開、役割切替デモ。既存の取り下げ・版の復元、チケットとの連携を維持する。

## 6. Deliverables

- 管理・作成画面に下書き・レビュー・公開の順と、作業版・公開版・閲覧範囲を示す。レビュー中は保存した内容を明示する。
- ポータルの公開検索は本文抜粋と版・閲覧範囲を表示する。0件では検索語の変更・条件解除・障害報告へ進める。
- 記事詳細は公開版の本文と版・閲覧範囲・公開日時・タグを示す。検索語・取得位置を保って一覧へ戻る。
- 既存の本文幅と余白を使い、モバイルで読める配置にする。

## 7. Acceptance Criteria

- AC-1 担当者が記事を下書き保存してレビューへ送り、公開管理者が同じ記事IDの保存内容と閲覧範囲を確認して公開できる。担当者に公開操作を表示しない。未保存時は既存の版操作ガードが働く。
- AC-2 組織内向けに公開した同じ記事を依頼者がポータルで検索し、同じタイトル・本文・版を確認できる。担当者限定で再公開した版は担当者の検索と直接URLで閲覧でき、依頼者の検索は0件、直接URLは404になる。再公開前は旧公開版を保持する。
- AC-3 0件と取得失敗を区別し、0件の検索語を保持する。条件を解除でき、記事詳細から戻ると元の検索条件を保持する。
- AC-4 PCのEnterと375pxのタップで役割別の実セッションを使って一連の操作を確認する。PCとモバイルは互いの記事IDと公開結果も照合する。両テーマのaxe・横はみ出し・スクリーンショットを記録する。

## 8. Verification and Evidence

ローカルの合成ユーザーと隔離DBで通常のWeb/APIを通し、型・lint・check:all・本番ビルド・ユニットを確認する。

## 9. Security and Audit

現行の公開範囲、RLS、API認可、版管理、監査を利用する。依頼者に管理用本文を渡さない。新しいロールや権限を作らない。

## 10. Rollback

Migrationなし。本WP差分をrevertする。

## 11. References

[[03.4_Knowledge_Requirements]]、[[03.13_UX_Accessibility_Requirements]]、[[11.3_Design_System]]、[[ADR-0011_Postgres_FTS_then_pgvector]]、[[ADR-0015_Organization_Isolation_and_RLS]]、[[WP-P2-UIX-028]]、[[WP-P3-KNWUI-059]]。

## 12. Definition of Done

§7の判定と証拠を記録してレビューに提出する。

## 13. Execution Log

- 2026-11-19 第4段階の差分、既存契約の範囲と受入基準をベースライン化。

### 2026-11-19 実装・ローカル検証

- Webでは `knowledge/page.tsx`、`knowledge/[id]/page.tsx`、`knowledge/new/page.tsx`、`freshservice.css`、`KnowledgeEditor.tsx`、`KnowledgeEditor.module.css`、`SupportFrame.tsx` を変更。表示回帰の検査を `tests/unit/knowledge-detail-recovery-ui.test.ts`、`tests/unit/knowledge-search-page.test.ts`、`tools/ui_knowledge_detail_recovery_check.mjs` に反映。WP台帳、依存関係、要求トレーサビリティ、Manifestを更新。
- Migrationの追加はなし。Webの差分をrevertして戻す。既存の版はPostgreSQLに保持される。
- セキュリティ影響はなし。選択組織における担当者・管理者の判定は共通の `navigationRoles` を使用。依頼者は公開・閲覧範囲に応じて既存APIが返す版を描画する。
- AC-1 達成。PCと375pxで担当者が下書き・レビュー、組織管理者が同じIDの保存内容と公開範囲を確認して公開した。公開操作の役割差、未保存時の送信ガードを確認した。
- AC-2 達成。各記事を組織内の版3から担当者限定の版6へ再公開した。版4と5の間は依頼者に旧公開版を表示した。再公開後は担当者に版6を表示し、依頼者の検索は0件、直接URLは404、管理APIは403を確認した。
- AC-3 達成。検索語の保持、条件解除、記事詳細から検索結果への復帰と不正な取得位置からの復帰を確認した。記事に関係しない検索語も0件を確認した。
- AC-4 達成。ローカル本番ビルドのChromeで実セッションを使用し、2件の記事をそれぞれ1440pxのEnterと375pxのタップで作成から再公開まで操作した。反対側の画面幅で同じIDの閲覧結果を照合した。両テーマでaxe計24回、違反・判定保留0件、横はみ出し0px。PC・モバイルの画面を記録した。
- Evidenceは `evidence/WP-P3-KNWUI-060/20261119-2028/` に保存した。再現コマンド、記事ID・版、両テーマの画面、検査ログを収録。
- 人による受入レビュー待ち。ルートlintに含まれる別のローカルworktree由来の4件は、対象外ディレクトリを除いた実行結果と併記した。

```zsh
rtk proxy npm run test:unit -- --reporter=json --outputFile=/tmp/solvi-knwui060.ztezK6/unit-verified.json
rtk proxy npm run typecheck
rtk proxy npm run lint
rtk proxy npm run lint -- --ignore-pattern '.claude/**'
rtk proxy npm run check:all
rtk proxy node /tmp/solvi-knwui060.ztezK6/capture.mjs /tmp/solvi-knwui060.ztezK6/verified 01
```

ユニットは4,857件成功、失敗0件、既存skip 26件。作業ツリーの型検査・lint・Prettier・`check:all`、Web本番ビルドは成功。ルートlintは別worktreeの自動生成 `next-env.d.ts` 4件で既存のエラーを報告した。
