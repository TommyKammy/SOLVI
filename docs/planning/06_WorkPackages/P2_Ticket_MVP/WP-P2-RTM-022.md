---
project: SOLVI
doc_id: "WP-P2-RTM-022"
title: "台帳の導出範囲を要求IDの全種別へ広げる"
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
workstream: "RTM"
risk: "low"
story_points: 3
depends_on: ["WP-P2-RTM-019"]
requirement_ids: ["NFR-MNT-001"]
aliases: ["WP-P2-RTM-022"]
---

# WP-P2-RTM-022: 台帳の導出範囲を要求IDの全種別へ広げる

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | RTM |
| Risk | low |
| Story Points | 3 |
| Suggested Owner | Tech Lead |
| Parallelizable | Yes(他WPと衝突するのは台帳の Status 欄のみ) |
| Gate | Gate 1(AUD-001〜003 の追跡性) |

## 1. Purpose

[[WP-P2-RTM-019]] で [[03.18_Requirements_Traceability_Matrix]] の Status を導出値にした。
**しかし導出器が読む行の条件に、要求IDの種別が直接書かれている。**

```js
tools/check_traceability.mjs:41  const REQ_ID = /\b(?:BR|FR|NFR|CON)-[A-Z]*-?\d+\b/g;
tools/check_traceability.mjs:81  if (!/^(?:BR|FR|NFR|CON)-[A-Z]*-?\d+$/.test(cells[0])) return;
```

`AUD-` と `MIG-` がここに無い。台帳には 101 行あるが、**導出器は 93 行しか見ていない。**

```text
$ node tools/check_traceability.mjs
A. 要求の状態(導出値と台帳の突き合わせ)
  OK   要求 93 件の内訳
  OK   台帳の Status は導出値と一致している
```

**検査は緑である。** 見ていない 8 件について、何も言わないからである。

その 8 件(台帳 146〜153 行)は、導出値へ切り替わらず
`Not tested` という**旧い手書きの値のまま**残っている。
`Not tested` は導出器の語彙([[03.18_Requirements_Traceability_Matrix]]の凡例)に無い。
**書き換えられなかったことが、値そのものに残っている。**

| 事実 | 確認方法 |
|---|---|
| AUD-001 / AUD-002 / AUD-003 を名指しする検査は実在する | `tests/security/audit-append-only.test.ts` ほか5ファイル |
| [[WP-P1-AUD-018]] / [[WP-P1-AUD-019]] は `requirement_ids` に AUD-002 / AUD-003 を宣言済み | 各WPの frontmatter |
| それでも台帳は `Not tested` | 台帳 151〜153 行 |

**AUD-001〜003 は Gate 1 の要求である。** Gate 1 の達成状況を台帳から読めない。

さらに双方向の突き合わせ(§5)も同じ条件で行を選ぶため、
[[WP-P1-AUD-004]] の `requirement_ids` に AUD-001〜003 が無いという片側欠落も
**報告されていない**([[06.0_WorkPackage_Register]]では同WPが AUD-001/002/003 を担うと書かれている)。

これは [[04.23_Wiring_Verification]] §16「検査は、探しているものだけを見つけるわけではない」と
同じ形が、**その対策として作った検査器自身の中で再発しているもの**である。

## 2. Requirement IDs

`NFR-MNT-001`

## 3. Dependencies

- [[WP-P2-RTM-019]](導出の仕組みそのもの。完了済み)

## 4. Scope / Allowed Paths

- `tools/check_traceability.mjs`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/06_WorkPackages/`(WPノートの `requirement_ids` 追記、本WPの Execution Log)
- `docs/planning/00_Index/00.8_Status_Dashboard.md`
- `docs/planning/04_Development/04.23_Wiring_Verification.md`
- `docs/planning/99_Project_Files/99.4_Decision_Log.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-RTM-022/`

## 5. Out of Scope

- **AUD-001〜005 / MIG-001〜005 そのものの実装・検査の追加。**
  このWPは「台帳が実態を映すこと」だけを担う。
  映した結果が `未着手` であるなら、それが正しい値である
- RTM の Test 欄(TL-xx)と Evidence URI の手書き(Backlog D-3)。**次に腐る候補だが別WP**
- [[06.0_WorkPackage_Register]]に追補WP(IDM-014 以降など)が載っていないこと。
  台帳どうしのずれであり、扱う対象が違う
- `package.json` の `check:requirements` が存在しないファイル
  (`tools/check_requirements.py`)を指していること。**このWPの調査で見つけたが別Issue**

## 6. Deliverables

- 種別のホワイトリストを持たない `tools/check_traceability.mjs`
- 8 行(AUD-001〜003 / MIG-001〜005)の Status が導出値へ置き換わった
  [[03.18_Requirements_Traceability_Matrix]]
- 台帳の行を黙って読み飛ばさないことを保証する検査(§7 AC-5)
- [[04.23_Wiring_Verification]] への追記と、決定の記録(DL-060)

## 7. Acceptance Criteria

- [x] AC-1: `node tools/check_traceability.mjs` の A 節が **要求 101 件**の内訳を出す(以前 93 件)
- [x] AC-2: 台帳から `Not tested` が **0 件**になった(以前 8 件)
- [x] AC-3: AUD-001 / AUD-002 / AUD-003 が `検査あり (4/2/3ファイル)` になり、
      根拠のファイル一覧を Evidence(`naming_evidence.txt`)に列挙した
- [x] AC-4: ソースに種別のホワイトリストが無い。既知IDの集合は台帳の表から作る
- [x] AC-5: 表に在って要求として読めない行は `ng` として報告する(`unreadable`)
- [x] AC-6: B 節が AUD/MIG も対象となり、17 件の片側だけの主張を報告した。`--write` で解消
- [x] AC-7: C 節は `OK`。**広げた直後は 2 件出た** — §7.1 に判断を記録した
- [x] AC-8: `npm run check:all` 緑。`--write` 無しの再実行は exit 0(冪等)

### 7.1 幽霊ID 2 件の判断(AC-7)

条件を広げた直後、C 節が `AUD-019` と `AUD-018` を
「台帳に無い要求ID」として報告した。出どころは
`tests/security/audit-anchor-external.test.ts` の
**`WP-P1-AUD-018` / `WP-P1-AUD-019` という WP ID の一部**である。

`AUD` は要求の種別でもあり、WP の workstream 名でもある。
形だけで探すと、`WP-P9-MIG-001` の中の `MIG-001` も拾う。

**握り潰さず、拾い方を直した。** 直前が `-` か語中なら別のものの一部と見なす。
放置していたら壊れたのは C 節だけではない — **WPを話題にしただけの検査が
「要求を名指しした」ことになり、台帳に嘘の `検査あり` が入っていた。**
広げたことが、広げる前から在った拾い方の誤りを見せた。

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

**該当するテストレイヤーが無い。** 台帳の NFR-MNT-001 の行は TL-16 を記録しているが、
TL-16 は Security(Replay/IDOR/依存脆弱性scan)であって、検査器そのものの検証ではない。
[[04.16_Test_Strategy]] に「検査器を検証するレイヤー」は存在しない。

このWPの検証は**検査器自身の出力**で行う(§7 AC-1・AC-2・AC-5)。
無いレイヤーの名前を借りて、検証したことにしない。

### Evidence

`evidence/WP-P2-RTM-022/<YYYYMMDD-HHMM>/` へ以下を保存する。

- 変更前の `node tools/check_traceability.mjs` 全出力(93 件と表示されること)
- 変更後の全出力(101 件と表示されること)
- 台帳の 8 行の差分(`git diff` そのもの)
- AC-3 の根拠: AUD-001〜003 を名指ししている検査ファイルの一覧と、その行
- `npm run check:all` の出力
- Command / Environment / Commit SHA / Result / Timestamp

## 9. Security and Audit

- **このWPが生成する監査イベントは無い。** 権限・境界・Secret に触れない
- ただし対象には **AUD-001〜003(監査の追跡性)**が含まれる。
  台帳が実態を映していないことは、監査要求の**達成状況を誤って読ませる**。
  台帳の値が上がることを目的にしない — **導出の結果として動くに任せる**
- 該当する脅威ID([[02.14_Threat_Model]])は無い

## 10. Rollback / 失敗時の扱い

- Migration 無し。DB に触れない
- 検査器の変更は revert で戻る
- 台帳の 8 行は `node tools/check_traceability.mjs --write` で再生成できる。
  **手で書き戻さない**(手で書いた値が腐ったことが、このWPの出発点である)
- 広げたことで大量の幽霊ID(C節)が出た場合は、**条件を狭めて通さない**。
  出た分を一件ずつ判断し、判断できないものが残るなら報告して止める

## 11. Codex app Prompt

### 読む正本

- このWP / [[WP-P2-RTM-019]] / [[03.18_Requirements_Traceability_Matrix]]
- [[04.23_Wiring_Verification]] §14・§16
- `AGENTS.md` §1.12(Evidence の無いものは完了ではない)

### 手順

0. このWPノートを `docs/planning/06_WorkPackages/P2_Ticket_MVP/` へ写す。
   写した直後は B 節が `ng` になる — このWPが `requirement_ids: ["NFR-MNT-001"]` を
   宣言するのに台帳の該当行がまだ本WPを挙げていないためである。
   **これは正しい振る舞いであり、直すのは手順 3 の `--write` である**
1. 変更前の `node tools/check_traceability.mjs` の出力を Evidence へ保存する。
   **「93 件」と表示されることを、直す前に記録しておく**
2. `tools/check_traceability.mjs` を次の形へ変える。
   - 台帳の**要求表の行そのもの**を要求の集合とする。
     ID の種別を列挙して選別しない
   - 検査ファイル・WPノートを走査するときの参照検出は、
     **台帳から作った既知IDの集合**で照合する
   - 幽霊ID(§6)の検出だけは一般形(`[A-Z]{2,5}(-[A-Z]{2,6})?-\d+`)を使う。
     **既知集合に無いものを見つけるのが目的だからである**
3. `--write` で台帳の Status を導出値へ揃える
4. B 節が報告する片側欠落(AUD-001〜003 と [[WP-P1-AUD-004]])を解消する
5. `npm run check:all` を通す
6. [[04.23_Wiring_Verification]] へ追記し、[[99.4_Decision_Log]] へ DL-060 を採番して記録する
7. [[00.8_Status_Dashboard]] へ結果を反映する

### やってはいけないこと

- **`AUD|MIG` をホワイトリストへ足して終わりにすること。**
  それは同じ欠陥を、次の種別が増えるまで先送りするだけである(AC-4)
- 台帳の値を良く見せるために、検査へ要求IDを名指しさせること。
  **名指しは、その検査が実際にその要求を確かめているときだけ書く**([[WP-P2-RTM-019]] §5)
- 出力の語彙を変えること。`検査あり` は「名指しがある」であって「満たしている」ではない
- 幽霊IDが出たときに、条件を狭めて隠すこと

### 完了時の報告

- 変更前後の件数(93 → いくつか)
- 8 行それぞれの導出値と、その根拠
- B 節・C 節で新たに見つかったもの(**無ければ「無し」と明記する**)
- 未解決事項

## 12. Definition of Done

- [x] §7 の AC-1〜AC-8 をすべて満たす
- [x] §8 の Evidence を保存した
- [x] Migration 無しであることを明記した(§10)
- [x] [[03.18_Requirements_Traceability_Matrix]] / [[04.23_Wiring_Verification]] /
      [[99.4_Decision_Log]] / [[00.8_Status_Dashboard]] を更新した
- [x] `MANIFEST.md` を再生成した
- [x] 未解決の Critical/High が無い
- [x] Security Reviewer の sign-off は**不要**(§9 のとおり境界に触れない)
- [x] §13 Execution Log へ追記した

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-08-13 | Opus 5 | `f91d3e7` / merge `a212bb7` | 完了 | `evidence/WP-P2-RTM-022/20260813-0800/` | 93→101 件。幽霊ID 2 件は拾い方の誤りだった(§7.1) |

### 変更したファイル

| ファイル | 変更 |
|---|---|
| `tools/check_traceability.mjs` | 種別のホワイトリストを削除。表の範囲で行を読み、既知IDと種別を台帳から導出 |
| `03.18_Requirements_Traceability_Matrix.md` | 8 行の Status(`Not tested` → 導出値)、3 行の Work Package 欄へ 4 件追記 |
| WPノート 5 件 | `requirement_ids` へ 13 件追記(AUD-001〜003 / MIG-001〜005 の担い手) |

`WP-P1-AUD-004` / `WP-P3-MIG-005` / `WP-P9-MIG-001` / `WP-P9-OPS-003` / `WP-P9-PAR-002`。
いずれも**台帳が既に「担う」と書いていたもの**であり、新たな割当ではない。

### Migration

**無し。** DB に触れていない。ロールバックは revert で足りる。

### 検証

| 実行 | 結果 |
|---|---|
| `node tools/check_traceability.mjs`(変更前) | 要求 **93 件**・全項目 OK。**8 件を見ないまま緑だった** |
| `node tools/check_traceability.mjs`(変更後) | 要求 **101 件**。A/B/C とも OK、exit 0 |
| 再実行(`--write` 無し) | exit 0。冪等 |
| `npm run check:all` | 緑(NG 0 件) |
| `npm run test:unit` | **886 passed** / 10 files |
| `npm run test:security` | **走らせていない。** このcheckoutにローカルスタックが無く `DATABASE_URL` が未設定 |

`test:security` は変更前から同じ理由で走らない(`node_modules` すら未導入だった)。
本WPは検査スクリプトと markdown のみを変更しており、実行時コードに触れていない。
**走らせていないものを「通った」と書かない。**

### セキュリティ影響

**無し。** 権限・境界・Secret・監査の書き込み経路に触れていない。

### 未解決事項

- **台帳に一行も無い種別の要求は、この検査からは依然として見えない。**
  種別は台帳の行から取り出すため、行が無ければ種別も無い。
  新しい種別は、まず台帳に行を作ることで見えるようになる
- Test 欄(TL-xx)と Evidence URI は手書きのまま([[06.4_Backlog]] D-3)
- `package.json` の `check:requirements` が存在しないファイルを指している(§5 のとおり範囲外)

## 14. 関連

- [[WP-P2-RTM-019]] — Status を導出値にした最初のWP
- [[03.18_Requirements_Traceability_Matrix]]
- [[04.23_Wiring_Verification]] §14 / §16
- [[06.4_Backlog]] D-3 — Test 欄と Evidence URI は手書きのまま
