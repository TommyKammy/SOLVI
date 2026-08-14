---
project: SOLVI
doc_id: "WP-P1-CI-006"
title: "CI Quality GateとClean-host"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.2.0"
created: "2026-07-27"
updated: "2026-07-27"
owner: "SOLVI Product Team"
tags: ["workpackage", "p1"]
source_of_truth: true
implementation_status: "in-progress"
story_points: 5
risk: "medium"
workstream: "CI"
phase: "P1"
requirement_ids: ["NFR-MNT-001", "NFR-SEC-004", "NFR-SEC-005", "NFR-SEC-008"]
---

# WP-P1-CI-006: CI Quality GateとClean-host

| 項目 | 値 |
|---|---|
| Phase | P1 |
| Workstream | CI |
| Risk | medium |
| Story Points | 5 |
| Suggested Owner | Tech Lead |
| Parallelizable | Yes(PLAT-001後) |
| Gate | Gate 1 |

## 1. Purpose

品質ゲートを自動化し、AGENTS.mdの規律(Secretコミット禁止・依存管理・禁止依存)を機械的に強制する。

## 2. Requirement IDs

`NFR-SEC-004`, `NFR-SEC-005`, `NFR-SEC-008`, `NFR-MNT-001`, `NFR-MNT-002`

## 3. Dependencies

[[WP-P1-PLAT-001]]

## 4. Scope / Allowed Paths

- `.github/workflows/`
- `tools/`
- `package.json`
- `Makefile`

## 5. Out of Scope

- 本番デプロイパイプライン(Phase 9)
- 負荷テストの実行(Phase 2以降)

## 6. Deliverables

- CI: lint / typecheck / unit / integration / migration / secret scan / 依存脆弱性scan / 禁止依存検査 / RLS検査 / 要求整合検査
- コンテナイメージのdigest固定検査
- クリーンホスト検証の自動化
- PRテンプレート

## 7. Acceptance Criteria

検証可能な条件のみ。すべて満たさない限りDoneにしない。

- [ ] PRごとにlint・typecheck・unit・integrationが実行され、失敗でマージがブロックされる
- [ ] secret scanが有効で、テスト用の疑似Secretをコミットした場合にCIが失敗する(実証テスト)
- [ ] 依存脆弱性scanでCritical/Highが検出された場合にCIが失敗する
- [ ] 禁止依存検査(WP-P0-ARCH-002の成果物)が動作し、違反時に失敗する
- [ ] `tools/check_rls.mjs`と`tools/check_requirements.py`がCIで実行される
- [ ] Dockerfileのイメージ参照がすべてdigest固定であることを検査する
- [ ] クリーンホスト検証がCIまたは手順書で再現でき、所要時間が記録されている

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-16(secret scan・依存scan・禁止依存)
- TL-01/TL-04/TL-05のCI実行

### Evidence

- CI設定ファイル
- 疑似Secretコミット時の失敗ログ
- 禁止依存違反時の失敗ログ

Evidenceは`evidence/WP-P1-CI-006/<YYYYMMDD-HHMM>/`へ保存し、Command・Environment・Commit SHA・Result・Timestampを含める([[06.2_Evidence_Index]])。

## 9. Security and Audit

- Gate 1のG1-6/G1-7の対象
- 失敗テストのskip/削除でゲートを通す行為を禁止する(AGENTS.md §4)。skipの追加はPRレビューで検出する

## 10. Rollback / 失敗時の扱い

CIの誤検知で開発が止まる場合も、検査の無効化ではなく例外の明示登録(理由・期限つき)で対応する。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Packageのみを実装してください。

正本(この順で読む):
1. AGENTS.md(絶対ルール)
2. 本WP(WP-P1-CI-006)
3. 参照設計: AGENTS.md、04.14_CI_CD_Quality_Gates、ADR-0018

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
1. GitHub ActionsでCIを構成する: lint / typecheck / unit / integration(Testcontainers) / migration up-down /
   secret scan(gitleaks等) / 依存脆弱性scan(npm audit + pip-audit) / 禁止依存検査 / RLS検査 / 要求整合検査。
2. Dockerfileのベースイメージがdigest固定であることを検査するスクリプトを作る。
3. 疑似Secretをコミットした場合にCIが失敗することを実際に検証する(検証後にブランチは破棄)。
4. PRテンプレート(WP ID、Acceptance充足、テスト結果、セキュリティ影響、Evidence)を作成する。

CIの各ジョブは失敗理由が一目でわかるようにする。警告のみで通過させるジョブを作らない。
```

## 12. Definition of Done

- [ ] §7 Acceptance Criteriaをすべて満たす
- [ ] §8のテストが通り、Evidenceを保存した
- [ ] DB変更にMigrationとロールバック方針、既存データ互換の説明がある
- [ ] 関連ドキュメント(API定義・Runbook・RTM)を更新した
- [ ] 未解決のCritical/Highがない
- [ ] Tech Leadのレビューを完了した
- [ ] Execution Logへ結果を追記した

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-07-27 | Claude (Codex) | `1b7002a` | Partially done | `evidence/WP-P1-CI-006/20260727-1023/verification.md` | ワークフロー5ジョブを定義し、禁止依存検査・skip検査を新規実装。意図的な違反を3種注入して検出を実証済み。**未完了**: GitHub Actions上での実行(リモートリポジトリ未作成)。Gate 1のG1-6判定前に実PRでの動作確認が必要。 |
