---
project: SOLVI
doc_id: "WP-P0-UX-006"
title: "UI/UX baselineとPrototype計画"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.2.0"
created: "2026-07-27"
updated: "2026-07-27"
owner: "SOLVI Product Team"
tags: ["workpackage", "p0"]
source_of_truth: true
implementation_status: "not-started"
requirement_ids: ["NFR-UX-001", "NFR-UX-002", "NFR-UX-003"]
---

# WP-P0-UX-006: UI/UX baselineとPrototype計画

| 項目 | 値 |
|---|---|
| Phase | P0 |
| Workstream | UX |
| Risk | low |
| Story Points | 5 |
| Suggested Owner | Designer / Product Owner |
| Parallelizable | Yes(REQ-004後) |
| Gate | Gate 0 |

## 1. Purpose

モックアップと要求の乖離を解消し、画面一覧・状態・アクセシビリティ基準を実装可能な仕様へ落とす。

## 2. Requirement IDs

`NFR-UX-001`, `NFR-UX-002`, `NFR-UX-003`

## 3. Dependencies

[[WP-P0-GOV-001]], [[WP-P0-REQ-004]]

## 4. Scope / Allowed Paths

- `11_UI_UX/`
- `assets/ui/`

## 5. Out of Scope

- フロントエンド実装(WP-P2-PORTAL-002)
- デザインシステムのコード実装

## 6. Deliverables

- 画面×ロール×状態のマトリクス([[11.2_Information_Architecture]])
- モックアップ正誤表(スコープ外メニュー・旧名称・Secret表示)
- WCAG 2.2 AAの検査手順とチェックリスト
- ユーザビリティテスト計画(Gate A用)

## 7. Acceptance Criteria

検証可能な条件のみ。すべて満たさない限りDoneにしない。

- [ ] [[11.2_Information_Architecture]]に全画面・ロール別可視性・主要状態(Loading/Empty/権限なし/エラー/競合)の一覧がある
- [ ] モックアップと要求の相違点が正誤表として11.7〜11.9に記載され、「実装は要求とテストが正」と明記されている
- [ ] WCAG 2.2 AAの自動検査(axe)と手動チェック項目が具体的な手順として文書化されている
- [ ] ユーザビリティテスト計画に、対象者・タスク・合格基準(5名中4名完了)が記載されている
- [ ] Portalの主要導線がモバイル幅375pxで成立する方針が[[11.3_Design_System]]に記載されている

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-13の手順定義(実行はPhase 2)

### Evidence

- 画面マトリクス
- 正誤表
- アクセシビリティチェックリスト

Evidenceは`evidence/WP-P0-UX-006/<YYYYMMDD-HHMM>/`へ保存し、Command・Environment・Commit SHA・Result・Timestampを含める([[06.2_Evidence_Index]])。

## 9. Security and Audit

- 管理設定画面のSecret/Token表示は「生成時のみ表示・再表示なし」を仕様として明記する(FR-IDM-009)

## 10. Rollback / 失敗時の扱い

モックアップの再生成が間に合わない場合は、正誤表を正としてPhase 2へ進む(画像の修正は必須ではない)。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Packageのみを実装してください。

正本(この順で読む):
1. AGENTS.md(絶対ルール)
2. 本WP(WP-P0-UX-006)
3. 参照設計: 11_UI_UX配下、03.13_UX_Accessibility_Requirements

制約:
- §4 Allowed Paths以外のファイルを変更しない。必要が生じたらPRを分けるか、WP追加を提案する。
- §5 Out of Scopeの内容を先取り実装しない。
- ADRの決定(特にAI advisory-only、Executor分離、RLS必須)を変更しない。変更が必要なら実装を止めて後継ADRを提案する。
- 依存WPが未完了なら実装せず、不足を報告する。
- 新規依存パッケージの追加は事前に理由と代替案を提示して承認を得る。
- Secret・実データ・PIIをコード、テスト、ログ、コミットに含めない。

完了時に報告すること:
- 変更ファイル一覧 / Migrationの有無と内容 / 実行した検証コマンドと結果
- §7 Acceptance Criteria の各項目に対する充足状況(証拠付き)
- セキュリティ影響 / 未解決事項 / Evidenceの保存先

作業内容:
1. 11_UI_UX配下の文書と assets/ui のモックアップを突き合わせ、要求との相違を一覧化する。
   既知の相違: サイドバーの「問題管理」「リリース管理」(スコープ外)、SCIM設定の旧名称、トークン表示ボタン。
2. 11.2_Information_Architectureへ画面×ロール×状態のマトリクスを作成する。
3. WCAG 2.2 AA の検査手順(axe実行方法+手動チェック項目)を文書化する。
4. ユーザビリティテスト計画を作成する。
※ 画像ファイル自体は生成できないため、正誤表とテキスト仕様で代替する。
```

## 12. Definition of Done

- [ ] §7 Acceptance Criteriaをすべて満たす
- [ ] §8のテストが通り、Evidenceを保存した
- [ ] DB変更にMigrationとロールバック方針、既存データ互換の説明がある
- [ ] 関連ドキュメント(API定義・Runbook・RTM)を更新した
- [ ] 未解決のCritical/Highがない
- [ ] Product Ownerの承認を得た
- [ ] Execution Logへ結果を追記した

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| - | - | - | Not started | - | - |
