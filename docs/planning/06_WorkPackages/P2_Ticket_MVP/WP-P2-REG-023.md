---
project: SOLVI
doc_id: "WP-P2-REG-023"
title: "WP台帳を実体と突き合わせ、件数の写しを無くす"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-08-13"
updated: "2026-08-13"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "maintainability", "governance"]
source_of_truth: true
implementation_status: "done"
phase: "P2"
workstream: "REG"
risk: "low"
story_points: 5
depends_on: ["WP-P2-RTM-022"]
requirement_ids: ["NFR-MNT-001"]
aliases: ["WP-P2-REG-023"]
---

# WP-P2-REG-023: WP台帳を実体と突き合わせ、件数の写しを無くす

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | REG |
| Risk | low |
| Story Points | 5 |
| Suggested Owner | Tech Lead |
| Parallelizable | No(台帳の行を書き換えるため) |
| Gate | Gate 1(進捗の把握そのもの) |

## 1. Purpose

**Work Package の件数が、5つある。**

| 数 | 出どころ | 何を数えたつもりか |
|---:|---|---|
| 59 | [[README\|README]] ×2 / [[04.1_Master_Roadmap]] / [[00.3_Project_Map]] / [[99.13_Vault_Validation_Report]] | 生成時(2026-07-27)のWP数 |
| 60 | [[06.0_WorkPackage_Register]] §集計 | 台帳の行数 |
| 66 | [[00.8_Status_Dashboard]] | 不明。どの時点とも一致しない |
| 85 | 実際のWPノート | 現在ある実体 |
| 51 | `check_allowed_paths` の出力 | `status: baseline` のWPノート(**導出値なので正しい**) |

同じものを 6 か所が別々に書き、**そのうち5か所が実体と違う**。

### 台帳が、完了した仕事の 25 件を知らない

[[06.0_WorkPackage_Register]] は自分を「全Work Packageの正本台帳」と呼び、
`1 WP = 1 GitHub Issue = 1 branch = 1 PR` を定めている。
その台帳に **25 件のWPが載っていない。**

**25 件すべてが `implementation_status: done` である。**
横断点検([[04.23_Wiring_Verification]])以降に作られた追補WP —
[[WP-P1-IDM-009]]〜[[WP-P1-IDM-017]]、[[WP-P2-OPSUI-010]]〜[[WP-P2-UISTATE-020]]、
[[WP-P1-AUD-018]] / [[WP-P1-AUD-019]] / [[WP-P2-RTM-019]] / [[WP-P2-RTM-022]] などが、
**やり終えているのに正本には存在しない。**

計画に無いものを実行したのではない。**実行したものを計画へ書き戻さなかった。**

### 数が分かれている理由は、数を配ったからである

台帳が数を持ち、README も Roadmap も Project Map も Dashboard も
**その数を書き写した**。写した時点から、それぞれ独立に古くなる。

[[99.4_Decision_Log|DL-050]] は「共有定数を配らず、答えを配る」と書いている。
ここで配られていたのは定数ですらなく、**手で写した数**である。

## 2. Requirement IDs

`NFR-MNT-001`

## 3. Dependencies

- [[WP-P2-RTM-022]](要求台帳を導出値へ寄せた直前のWP。同じ形の欠陥)

## 4. Scope / Allowed Paths

- `tools/check_workpackages.mjs`(新規)
- `package.json`(`check:all` へ追加)
- `docs/planning/06_WorkPackages/`
- `docs/planning/00_Index/00.3_Project_Map.md`
- `docs/planning/00_Index/00.8_Status_Dashboard.md`
- `docs/planning/04_Development/04.1_Master_Roadmap.md`
- `docs/planning/99_Project_Files/99.13_Vault_Validation_Report.md`
- `docs/planning/99_Project_Files/99.4_Decision_Log.md`
- `docs/planning/04_Development/04.23_Wiring_Verification.md`
- `docs/planning/README.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-REG-023/`

## 5. Out of Scope

- **[[06.1_Dependency_Map]] の更新。** 追補WPは既に完了しており依存の順序を決める役に立たない。
  図を実体に合わせる作業は分量が別物なので分ける
- **[[99.13_Vault_Validation_Report]] の再生成。** これは生成日つきの点検記録であり、
  古いこと自体は誤りではない。**現在値と読まれないよう1行を足すに留める**
- Story Point の見直し。数え直しではなく、**書いてある値を1か所へ集める**だけ
- [[06.4_Backlog]](`doc_id: WP-BACKLOG`)を WP として数えること。
  これは台帳であってWPではない

## 6. Deliverables

- `tools/check_workpackages.mjs` — WPノートと台帳の突き合わせ、集計の導出
- 26 件の行が追加された [[06.0_WorkPackage_Register]](本WP自身を含む)
- `phase` / `story_points` / `risk` が揃ったWPノート
- 件数の写しを持たなくなった README / Roadmap / Project Map / Dashboard

## 7. Acceptance Criteria

- [x] AC-1: 双方向で確かめる。WPノート **86 件すべてに台帳の行がある**
- [x] AC-2: 集計は導出値。**WP 86 件 / 592 ポイント**(以前の記載は 60 件 / 457)
- [x] AC-3: **26 件**の行を追加した(見積りは25件。本WP自身を数え忘れていた)
- [x] AC-4: 24 件のノートへ 96 項目を足した(`phase` / `workstream` / `risk` / `story_points`)
- [x] AC-5: 5 か所の写しを消し、台帳を指す形にした
- [x] AC-6: `check:workpackages` を `check:all` へ組み込んだ
- [x] AC-7: `npm run check:all` 緑。再実行 exit 0(冪等)

### 7.1 「写し」と「ある時点の記録」を分けた

写しを探す検査は、最初 `WPを28件完了し検査が1352件通っている時点でも`
([[04.23_Wiring_Verification]] §14 の記述)まで拾った。**あれは写しではない。**

古くなってよい記録(生成日つきの点検、過去形の記述)と、
古くなってはいけない総数を混ぜると、検査は**直しようのないものを指し続ける**。

機械にこの区別は付かないので、**総数を述べる形**だけを見ることにした —
表の欄・図のノード・語の直後に数が来る書き方の3つ。
助詞を挟む書き方(「WP は現在 85 個」)は捕まらない。
**網羅ではないことを検査の中に書いた。**

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

[[WP-P2-RTM-022]] と同じく、**該当するテストレイヤーは無い。**
検証は検査器自身の出力で行う。

### Evidence

`evidence/WP-P2-REG-023/<YYYYMMDD-HHMM>/` へ以下を保存する。

- 変更前の各文書の件数(5つの数がそれぞれ何と書いてあるか)
- `node tools/check_workpackages.mjs` の変更前後の出力
- 台帳の差分(`git diff`)
- `npm run check:all` の出力
- Command / Environment / Commit SHA / Result / Timestamp

## 9. Security and Audit

- **監査イベントは生成しない。** 権限・境界・Secret に触れない
- 該当する脅威ID([[02.14_Threat_Model]])は無い

## 10. Rollback / 失敗時の扱い

- Migration 無し。DB に触れない
- 台帳と frontmatter は `--write` で再生成できる。**手で書き戻さない**
- 突き合わせで**判断が要る食い違い**(台帳とノートで Points が違う等)が出た場合は、
  機械で寄せず**報告して止める**。どちらが正かは機械には決められない

## 11. Codex app Prompt

### 読む正本

- このWP / [[WP-P2-RTM-022]] / [[06.0_WorkPackage_Register]]
- [[99.4_Decision_Log|DL-050]](値を配らず、判定する側を1つにする)
- `AGENTS.md` §1.11(1 WP = 1 Issue = 1 branch = 1 PR)

### 手順

1. 変更前の 5 つの数を Evidence へ記録する
2. `tools/check_workpackages.mjs` を作る。突き合わせ・集計の導出・`--write`
3. `--write` で 25 件の行と、欠けている frontmatter を埋める
4. 写しを持つ 5 か所から数を消し、台帳を指す形にする
5. `check:all` へ組み込み、緑にする
6. [[04.23_Wiring_Verification]] と [[99.4_Decision_Log]](DL-061)へ記録する

### やってはいけないこと

- **数を「正しい数」に書き直して終わりにすること。**
  それは6か所目の写しを作り直すだけで、次の追補WPでまた古くなる
- Story Point を数え直すこと。**書いてある値を集めるだけ**である
- 台帳とノートで値が食い違うものを、機械が勝手にどちらかへ寄せること

### 完了時の報告

- 変更前後の件数と、消した写しの数
- 台帳へ追加した行数と、frontmatter を埋めたノート数
- 判断が要った食い違い(**無ければ「無し」と明記する**)

## 12. Definition of Done

- [x] §7 の AC-1〜AC-7 をすべて満たす
- [x] §8 の Evidence を保存した
- [x] Migration 無しであることを明記した(§10)
- [x] [[06.0_WorkPackage_Register]] / [[04.23_Wiring_Verification]] /
      [[99.4_Decision_Log]] / [[00.8_Status_Dashboard]] を更新した
- [x] `MANIFEST.md` を再生成した(279ファイル、全ハッシュ一致)
- [x] 未解決の Critical/High が無い
- [x] Security Reviewer の sign-off は**不要**(§9)
- [x] §13 Execution Log へ追記した

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-08-13 | Opus 5 | `wp/WP-P2-REG-023` | 完了 | `evidence/WP-P2-REG-023/20260813-0930/` | 台帳 60→86 行。**Vaultへの反映は未完**(§13.1) |

### 変更したファイル

| ファイル | 変更 |
|---|---|
| `tools/check_workpackages.mjs` | 新規。双方向の突き合わせ・集計の導出・写しの検出 |
| `package.json` | `check:workpackages` を追加し `check:all` へ組み込み |
| `06.0_WorkPackage_Register.md` | 26 行を追加。集計を導出値へ(60→86 件 / 457→592 ポイント) |
| WPノート 24 件 | `phase` / `workstream` / `risk` / `story_points` を 96 項目追記 |
| README / 04.1 / 00.3 / 00.8 | 件数の写しを削除し、台帳を指す形へ |
| `99.13_Vault_Validation_Report.md` | 生成日時点の記録であることを明示(数は残す) |
| `03.18_RTM` | 本WPの `requirement_ids` に合わせて `check_traceability --write` が更新 |

### Migration

**無し。** DB に触れていない。

### 検証

| 実行 | 結果 |
|---|---|
| `node tools/check_workpackages.mjs`(変更前) | A/B/D が NG(台帳に26件無し・24件が欄を持たない・写し5件) |
| 同(変更後) | A/B/C/D すべて OK、exit 0 |
| 再実行(`--write` 無し) | exit 0。冪等 |
| `npm run check:all` | 緑 |
| `npm run test:unit` | **886 passed** |
| `npm run test:security` | **走らせていない**(ローカルスタック未起動。[[WP-P2-RTM-022]] と同じ) |

判断が要った食い違い(台帳とノートで値が違うもの)は **無し**。
欠けていた欄を埋めただけで、上書きは発生していない。

### 13.1 未完了: Vault への反映

作業の途中から、Obsidian Vault(`~/Library/Mobile Documents/.../ObsidianVault/Dev/SOLVI`)
への読み書きが OS から拒否されるようになった(`Operation not permitted`)。
**repo 側の `docs/planning` だけが最新であり、Vault はこの変更を含んでいない。**

Vault には本WPノートの初版(`not-started`)だけが入っている。
アクセスが戻り次第、`docs/planning` の内容を Vault へ写し、
`diff -rq` が空になることを確かめる必要がある。

**「同期した」と書かない。** 二つの実体があるとき、
片方だけが正しい状態は、正しい状態ではない。

### セキュリティ影響

**無し。** 権限・境界・Secret・監査に触れていない。

### 未解決事項

- **Vault への反映が未完**(§13.1)
- [[06.1_Dependency_Map]] は当初60件のままで、追補WPの依存を含まない(§5 のとおり範囲外)
- README と [[00.1_Start_Here]] の「実装 | 未着手」「最初の実装対象 `WP-P0-GOV-001`」は
  **事実と違う**(38件が完了済み)。件数の写しとは別種の古さであり、本WPでは触れていない
- 写しの検出は総数を述べる3つの形だけを見る。網羅ではない(§7.1)

## 14. 関連

- [[06.0_WorkPackage_Register]] — 対象の台帳
- [[WP-P2-RTM-022]] / [[WP-P2-RTM-019]] — 要求台帳で同じことをした
- [[04.23_Wiring_Verification]] §14 / §28
