---
project: SOLVI
doc_id: "WP-P3-KNWUI-059"
title: "ナレッジ・通知のセキュリティテスト用補助モジュールを作り直す"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-11-17"
updated: "2026-11-17"
owner: "SOLVI Product Team"
tags: ["workpackage", "p3"]
source_of_truth: true
implementation_status: "done"
story_points: 8
risk: "high"
workstream: "KNWUI"
phase: "P3"
requirement_ids: ["FR-KNW-002", "FR-KNW-003", "NFR-SEC-001", "NFR-SEC-006"]
---

# WP-P3-KNWUI-059: ナレッジ・通知のセキュリティテスト用補助モジュールを作り直す

| 項目 | 値 |
|---|---|
| Phase | P3 |
| Workstream | KNWUI |
| Risk | high(CI のテスト用DBを作って消す。人のセキュリティレビューが必要) |
| Story Points | 8 |
| Suggested Owner | Tech Lead + Security Reviewer |
| Parallelizable | Yes(`tests/support/knowledge/` と対象の6テストに触れる他のWPと同時に進めない) |
| Gate | Gate 1 |

> 2026-11-17 に利用者が「作り直しとskipの扱いで進めてください」と承認した([[00.6_Decision_Register]] DEC-009)。それに基づき `baseline` として起票した。

## 1. Purpose

公開リポジトリは `751d6ae`(Publish current SOLVI development snapshot、2026-11-10)で 2026-10-03〜11-10 の履歴を1コミットに潰している。そのとき `evidence/WP-P3-KNWUI-054/20261007/` の補助モジュール3つ(`knowledge-fixture.mjs`、`ci-knowledge-db.mjs`、`isolated-knowledge-db.mjs`)と型が失われた。これらを読み込む6つのテストファイル(単体 `knowledge-list`、DB `knowledge-pagination`、`notification-{list,manual-retry,preference,retry}`)は、読込みに失敗して1件も実行されていなかった。

このWPは、テストが要求する性質から3つのモジュールを作り直し、6ファイルを実行できる状態に戻す。元の作業環境・WP文書は見つかっていない(全オブジェクト、作業フォルダ、`.local/`、GitHub の全ブランチ、手元の他クローンを確認済み)。

## 2. Requirement IDs

`FR-KNW-002`, `FR-KNW-003`, `NFR-SEC-001`, `NFR-SEC-006`

## 3. Dependencies

なし。

## 4. Scope / Allowed Paths

- `tests/support/knowledge/`
- `tests/unit/knowledge-list.test.ts`
- `tests/security/knowledge-pagination.test.ts`
- `tests/security/notification-list.test.ts`
- `tests/security/notification-manual-retry.test.ts`
- `tests/security/notification-preference.test.ts`
- `tests/security/notification-retry.test.ts`
- `evidence/WP-P2-NTF-055/`
- `evidence/WP-P2-NTFUI-056/`
- `evidence/WP-P2-NTFPREF-057/`
- `evidence/WP-P2-NTFRETRY-058/`
- `evidence/WP-P3-KNWUI-059/`
- `.gitignore`
- `docs/planning/06_WorkPackages/P3_Knowledge/WP-P3-KNWUI-059.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/MANIFEST.md`

## 5. Out of Scope

- 製品コード(`services/`、`apps/`、`packages/`)と Migration の変更。
- 6つのテストの検査内容の変更(読み込み先のパスだけを変える)。
- CI の設定(`.github/workflows/ci.yml`)の変更。
- 失われた元のモジュールとバイト単位で同じものを再現すること(要求される性質を満たすものを作る)。

## 6. Deliverables

| ファイル | 役割 |
|---|---|
| `tests/support/knowledge/knowledge-fixture.ts` | 合成データ(2組織、依頼者・担当者・組織管理者・役割切れ・別組織の5人、記事216件)の投入と読出し。使い捨てDB以外には書かない |
| `tests/support/knowledge/ci-knowledge-db.ts` | CI で、サービスDBと同じサーバーに使い捨てDBを作り、マイグレーションと合成データを入れて渡し、テスト後に消す |
| `tests/support/knowledge/isolated-knowledge-db.ts` | ローカルで、使い捨ての PostgreSQL コンテナ(tmpfs、127.0.0.1 だけに公開)を作って消す |
| 6テストファイル | 読込み先を `evidence/WP-P3-KNWUI-054/20261007/*.mjs` から `tests/support/knowledge/*.js` に変える |
| `evidence/WP-P2-{NTF-055,NTFUI-056,NTFPREF-057,NTFRETRY-058}/…/.gitkeep` | 通知テストが実行記録を書くフォルダ。記録そのものは `.gitignore` で除外する |

モジュールを `evidence/` ではなく `tests/support/` に置くのは、`evidence/` が lint・prettier・skip 検査の対象外で、テストの基盤を置く場所として不適切なためである。TypeScript で書き、型を別に持たない。

## 7. Acceptance Criteria

1. 6つのテストファイルが読み込める(読込み失敗による0件が無い)。
2. `knowledge-list` が全件通る。
3. CI の「DB・認可・監査」で、`knowledge-pagination` と通知4ファイルが通る。
4. 使い捨てDBの作成・削除は fail closed である。
   - CI の接続先が、明示した契約(`localhost:5432`、`solvi_app` / `solvi_owner`、ジョブのサービスDB)以外なら、接続する前に拒否する。
   - DROP するのは、名前・OID・所有者・コメントの印が一致するDBだけ。
   - CREATE の結果が分からないDBは消さない。
   - これらは `knowledge-list` の単体テストで検査される。
5. テスト後に、使い捨てDB・コンテナが残らない。
6. エラーに接続文字列・パスワード・SQL の詳細を含めない。

## 8. Verification and Evidence

- `npx vitest run tests/unit/knowledge-list.test.ts`
- CI と同じ構成(Postgres 16.6、SeaweedFS 4.52、`CI=true GITHUB_ACTIONS=true`)での `npm run test:security -- --exclude tests/security/user-directory-consistency.test.ts`
- ローカルのコンテナ経路(`CI` を外して実行)
- 実行後に `solvi_wp054_test_%` のDBと、ラベル `solvi.work-package=WP-P3-KNWUI-054` のコンテナが残っていないこと

Evidence: `evidence/WP-P3-KNWUI-059/<YYYYMMDD-HHMM>/`

## 9. Security and Audit

- **セキュリティ関連の変更として人のレビューが必要**(AGENTS.md §1.16)。CI のテスト用DBを作って消し、ローカルではコンテナを作って消す。
- CI では、ジョブのサービスDBの所有者(`solvi_owner`)で `CREATE DATABASE` / `COMMENT ON DATABASE` / `DROP DATABASE` を実行する。DB 名は `solvi_wp054_test_<数字>_<8桁16進>` に限り、識別子へ埋め込む前に形を検査する。
- 合成データは書込みの前に、接続先の実際のDB名とロールを確かめる。サービスDB(`solvi` など)には書かない。
- アプリ接続(`solvi_app`)が superuser でなく、RLS を迂回できず、ナレッジの表に FORCE RLS が掛かっていることを、渡す前に確かめる。
- パスワードはローカルのコンテナだけの使い捨てで、ログ・エラーに出さない。マイグレーションなどの子プロセスの出力は捨てる。
- 合成データのメールアドレスは `example.test` の下だけ。実在の人物・組織は含まない。

## 10. Rollback / 失敗時の扱い

Migration なし。変更を戻すと、6ファイルが読込みに失敗する状態に戻る。業務データへの影響は無い。

## 11. Codex app Prompt

```text
WP-P3-KNWUI-059だけを実装してください。製品コードと検査内容は変更しない。
- tests/support/knowledge/ に knowledge-fixture / ci-knowledge-db / isolated-knowledge-db を作る。
- 6テストの読込み先を変え、通知テストの記録フォルダを用意する。
- CI と同じ構成で test:security を流し、DB・コンテナが残らないことを確かめる。
```

## 12. Definition of Done

- [x] §7をすべて満たす(3 は CI で確認)
- [x] §8のEvidenceを保存した
- [x] WP台帳・RTM・MANIFESTを更新した
- [x] Execution Logへ追記した
- [ ] 人のセキュリティレビュー

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-11-17 | Claude | PR を参照 | Done(レビュー待ち) | `evidence/WP-P3-KNWUI-059/20261117-0430/` | DEC-009 の「作り直し」側 |

### 2026-11-17 の実行結果

- 変更ファイル: §6 のとおり。製品コード・Migration・CI 設定の変更なし。
- Migration: なし。Rollback: 上記 §10。
- 検証(詳細は Evidence):
  - `npx vitest run tests/unit/knowledge-list.test.ts`: 78件成功。
  - CI と同じ構成で `npm run test:security -- --exclude tests/security/user-directory-consistency.test.ts`: 44ファイル中42ファイル、1181件中1179件が成功した。
    - 失敗した2件は、どちらも Node の時計(Mac)と PostgreSQL の時計(Colima の VM)の差によるもの。VM の時計が約40ミリ秒進んでいた。
    - 1件目(notification-retry の再試行の待ち時間): 期待 ≥20000ms に対し 19987ms。
    - 2件目(notification-manual-retry の役割切れの再確認): 単独の実行では通過した。
    - CI ではテストと PostgreSQL が同じホストの時計を使う。
  - ローカルのコンテナ経路: `notification-list` が 37件成功した。コンテナは残らなかった。
  - 実行後、`solvi_wp054_test_%` のDBは0件だった。
- §7 の充足:
  - 1・2・4・5・6: 満たす。
  - 3: ローカルでは上記の時計差の2件を除き満たす。CI の結果で確定する。
- セキュリティ影響: §9 のとおり。人のレビューが必要。
- 未解決事項: 元の作業環境が見つかった場合は、元のモジュールとの差を確認する。
