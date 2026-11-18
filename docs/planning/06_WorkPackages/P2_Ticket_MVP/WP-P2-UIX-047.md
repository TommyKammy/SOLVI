---
project: SOLVI
doc_id: "WP-P2-UIX-047"
title: "UI v2のトークンとテーマ切替を依頼者向けポータルへ広げる"
category: "06_WorkPackages"
type: "workpackage"
status: "draft"
version: "0.1.0"
created: "2026-11-18"
updated: "2026-11-18"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "ui"]
source_of_truth: true
implementation_status: "not-started"
story_points: 5
risk: "low"
workstream: "UIX"
phase: "P2"
requirement_ids: ["NFR-UX-002", "NFR-UX-003", "NFR-UX-004"]
depends_on: ["WP-P2-UIX-044", "WP-P2-UIX-032"]
---

# WP-P2-UIX-047: UI v2のトークンとテーマ切替を依頼者向けポータルへ広げる

> [!warning] status: draft
> 2026-11-18 Product Owner の決定([[WP-P2-UIX-044]] §15)を受けて起票した案。§14の未決事項を決めてbaselineにするまで、実装の根拠にしない。

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | UIX |
| Risk | low |
| Story Points | 5 |
| Suggested Owner | Frontend + Product Owner |
| Parallelizable | Yes(staff向けの画面には触れない) |
| Gate | Gate A |

## 1. Purpose

[[WP-P2-UIX-044]] はstaff向けのアプリシェル(`AppShell`)だけをUI v2にした。依頼者向けのポータル(`SupportFrame` で表示する画面)は旧来の見た目のままで、テーマ切替もない。
本WPは、ポータルのシェルを [[11.3_Design_System]] のトークンへ揃え、テーマ切替を付ける。

**ポータルの導線と構成は変えない。** [[WP-P2-UIX-032]] の決定どおり、ポータルにはstaff向けの左サイドバーを出さず、ヒーローの上の透過ヘッダーを保つ。API・認可・状態機械・監査も変えない。

対象の画面は、`AppFrame` が `SupportFrame` を使う画面である(`/portal`、および依頼者が開いた `/catalog` `/knowledge` `/tickets` `/requests` `/settings` 配下。管理・編集画面を除く)。

## 2. Requirement IDs

`NFR-UX-002`, `NFR-UX-003`, `NFR-UX-004`

## 3. Dependencies

[[WP-P2-UIX-044]](トークンと `ThemeToggle`)、[[WP-P2-UIX-032]](ポータル専用シェル)

## 4. Scope / Allowed Paths

- `apps/web/src/components/SupportFrame.tsx`
- `apps/web/src/app/freshservice.css`(`fs-support-*` `fs-portal-*` `portal-*` の規則だけ)
- `tests/unit/support-portal-ui.test.ts`
- `tests/unit/ui-contrast-and-focus.test.ts`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-047.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-UIX-047/`

`ThemeToggle.tsx` は [[WP-P2-UIX-044]] のものをそのまま使い、変更しない。

## 5. Out of Scope

- ポータルへのstaff向け左サイドバーの導入
- 各画面のCSS Modulesに残る固定色のトークン化(画面ごとの後続WPで扱う)
- クラス名 `fs-rail` の整理
- API・DB・認可・監査の変更
- 新規npm依存、外部フォント・外部CSSの読込み

## 6. Deliverables

- `SupportFrame` のヘッダー・メニュー・フッターを [[11.3_Design_System]] のトークンで表す
- ヘッダーにテーマ切替を置く(`ThemeToggle` の再利用)
- 両テーマのスクリーンショットとaxeの結果

## 7. Acceptance Criteria

- [ ] ポータルのシェル(ヘッダー・メニュー・フッター)の色が、固定色ではなく [[11.3_Design_System]] §4 のトークンで表される。
- [ ] ポータルのヘッダーにテーマ切替があり、staff向けの画面と同じ保存先(ブラウザ)・同じ初期値(OS設定)で動く。片方で選んだテーマがもう片方にも効く。
- [ ] ポータルの導線(メニューの項目・ロールによる絞り込み・検索の送信先 `/knowledge?q=`)が変わらない。staff向けの左サイドバーは出ない。
- [ ] ポータルのシェルの文字は、両テーマでWCAG 2.2 AAのコントラスト比(4.5:1)を満たす。
- [ ] [[WP-P2-SEC-025]] のCSPを緩めない。
- [ ] `npm run typecheck`、`npm run lint`、`npm run check:all`、§4のテストが通る。
- [ ] axeで `/portal`・`/catalog`・`/knowledge` を両テーマ・1440×900と375×812で検査し、serious/criticalの違反がない。

## 8. Verification and Evidence

- TL-13: axe(両テーマ)
- `evidence/WP-P2-UIX-047/<YYYYMMDD-HHMM>/` に、変更前後のスクリーンショット、検証コマンドと結果、axeの結果を保存する。

## 9. Security and Audit

- 表示層だけの変更。認可・監査・CSPを変えない。
- テーマの選択はブラウザにだけ保存し、サーバーへ送らない。
- Evidenceには実データ・実PIIを含めない。

## 10. Rollback / 失敗時の扱い

Migrationはない。§4のファイルを [[WP-P2-UIX-044]] 完了時点に戻せばよい。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。WP-P2-UIX-047だけを実装してください。
正本: AGENTS.md、本WP、docs/planning/11_UI_UX/11.3_Design_System.md、WP-P2-UIX-032、WP-P2-UIX-044、既存の SupportFrame 実装。
ポータルの導線と構成は変えず、色をトークンに置き換え、既存の ThemeToggle をヘッダーに置くこと。
staff向けの左サイドバーをポータルに出さないこと。CSPを緩めないこと。新規npm依存を追加しないこと。
完了時は、変更ファイル・検証コマンドと結果・§7の充足状況・セキュリティ影響・未解決事項・Evidenceの保存先を報告すること。
```

## 12. Definition of Done

- [ ] §7をすべて満たす
- [ ] §8のテストが通り、Evidenceを保存した
- [ ] 関連ドキュメントを更新した
- [ ] Product Ownerの承認を得た
- [ ] Execution Logへ結果を追記した

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-11-18 | Claude | - | Draft | - | [[WP-P2-UIX-044]] §15 の決定を受けて起票した。 |

## 14. 未決事項(baseline前に決める)

- **ポータルのヒーロー画像・背景**: ダークテーマで、ヒーローの画像や背景色をどう扱うか(暗くする/そのまま/単色に置き換える)。
- **ポータル本文の範囲**: `/portal` の本文(`fs-portal-*` `portal-*` の規則。ヒーロー・検索欄・依頼の一覧)まで本WPでトークンに置き換えるか、シェル(`fs-support-*`)だけにして本文は後続WPへ回すか。
