---
project: SOLVI
doc_id: "WP-P0-DEV-005"
title: "Repository・AGENTS・Issue規約"
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
---

# WP-P0-DEV-005: Repository・AGENTS・Issue規約

| 項目 | 値 |
|---|---|
| Phase | P0 |
| Workstream | DEV |
| Risk | medium |
| Story Points | 5 |
| Suggested Owner | Tech Lead |
| Parallelizable | No(ARCH/REQ後) |
| Gate | Gate 0 |

## 1. Purpose

実装の器を確定する。モノレポのディレクトリ構造(全WPのAllowed Pathsの前提)、ブランチ・PR規約、Issue変換規約、AGENTS.mdの配置を行う。

## 2. Requirement IDs

`NFR-MNT-002`

## 3. Dependencies

[[WP-P0-ARCH-002]], [[WP-P0-REQ-004]]

## 4. Scope / Allowed Paths

- `04_Development/`
- `06_WorkPackages/06.3_GitHub_Issue_Conversion_Guide.md`
- `AGENTS.md`
- `(新規repo) 直下の構成ファイル`

## 5. Out of Scope

- アプリケーションコードの実装(WP-P1-PLAT-001)
- CIパイプラインの実装(WP-P1-CI-006)

## 6. Deliverables

- private GitHub repository
- 確定したディレクトリ構造(下記)
- AGENTS.mdの配置
- ブランチ/PR/Issue規約
- Phase 0 Issue Pack(P0の6WP)

## 7. Acceptance Criteria

検証可能な条件のみ。すべて満たさない限りDoneにしない。

- [ ] リポジトリのディレクトリ構造が確定し、全WPの§4 Allowed Pathsが実在するパスを指している
- [ ] `docs/planning/`配下に本Vaultが配置され、AGENTS.mdがリポジトリ直下にある
- [ ] ブランチ命名(`wp/<WP-ID>`)、PRタイトル(`[WP-ID] title`)、1WP=1PRの規約が文書化されている
- [ ] P0の6WPがGitHub Issueとして起票され、Depends onが実Issue番号にリンクされている
- [ ] CODEOWNERSでセキュリティ関連パス(services/executor、認可、監査)にSecurity Reviewerが設定されている

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- リポジトリ構造とWPのAllowed Pathsの突合検査

### Evidence

- リポジトリURL(private)
- 作成されたIssue一覧
- ディレクトリ構造のtree出力

Evidenceは`evidence/WP-P0-DEV-005/<YYYYMMDD-HHMM>/`へ保存し、Command・Environment・Commit SHA・Result・Timestampを含める([[06.2_Evidence_Index]])。

## 9. Security and Audit

- リポジトリはprivate。Secret scanをリポジトリ設定で有効化する
- CODEOWNERSによりセキュリティ関連PRはSecurity Reviewerのapprove必須にする

## 10. Rollback / 失敗時の扱い

構造変更が必要になった場合は、影響するWPのAllowed Pathsを同じPRで更新する。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Packageのみを実装してください。

正本(この順で読む):
1. AGENTS.md(絶対ルール)
2. 本WP(WP-P0-DEV-005)
3. 参照設計: ADR-0001, ADR-0002, ADR-0018、02.3_Container_Architecture

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
1. ADR-0001/0002/0018に基づくモノレポ構造を提案し、確定後に作成する。想定:
   apps/web(Next.js) / services/api(NestJS) / services/worker / services/executor /
   services/ai-advisor(Python) / packages/shared / packages/connectors / db/migrations /
   tests/{unit,integration,security,e2e} / tools / docs/planning / infra
2. 06.0_WorkPackage_Registerの全WPのAllowed Pathsが、この構造の実在パスを指しているか検査し、不一致を報告する。
3. ブランチ・PR・Issue規約とCODEOWNERSを作成する。
4. P0の6WPをGitHub Issue用Markdownへ変換する(06.3のフォーマットに従う)。
※ アプリケーションコードは書かない。空のディレクトリ構造とREADME、設定ファイルまで。
```

## 12. Definition of Done

- [ ] §7 Acceptance Criteriaをすべて満たす
- [ ] §8のテストが通り、Evidenceを保存した
- [ ] DB変更にMigrationとロールバック方針、既存データ互換の説明がある
- [ ] 関連ドキュメント(API定義・Runbook・RTM)を更新した
- [ ] 未解決のCritical/Highがない
- [ ] Tech Leadの承認を得た
- [ ] Execution Logへ結果を追記した

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| - | - | - | Not started | - | - |
