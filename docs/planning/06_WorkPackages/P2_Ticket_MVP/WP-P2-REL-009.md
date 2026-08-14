---
project: SOLVI
doc_id: "WP-P2-REL-009"
title: "Ticket関連付けとMerge"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.2.0"
created: "2026-07-27"
updated: "2026-07-27"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2"]
source_of_truth: true
implementation_status: "done"
story_points: 5
risk: "medium"
workstream: "REL"
phase: "P2"
requirement_ids: ["FR-TKT-010", "FR-TKT-011"]
---

# WP-P2-REL-009: Ticket関連付けとMerge

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | REL |
| Risk | medium |
| Story Points | 5 |
| Suggested Owner | Backend |
| Parallelizable | No([[WP-P2-OPS-003]]後) |
| Gate | Gate A |

> **分割の経緯**: [[WP-P2-OPS-003]] が13ポイントで単一PRに収まらなかったため分離した(DL-006)。

## 1. Purpose

チケット同士の関連付け(Related / Parent-Child)と、重複チケットのMergeを実装する。

同じ障害について複数人が起票することは日常的に起きる。放置すると同じ調査が重複し、依頼者ごとに異なる回答が返る。Mergeはその収束手段だが、**元チケットの履歴を失わせない**ことが条件になる。依頼者から見れば自分の起票が消えたように見えてはならないし、監査から見れば「なぜ統合したか」を辿れなければならない。

## 2. Requirement IDs

`FR-TKT-010`, `FR-TKT-011`, `NFR-SEC-001`, `NFR-SEC-006`, `AUD-001`

## 3. Dependencies

[[WP-P2-OPS-003]](完了済み)

## 4. Scope / Allowed Paths

- `db/migrations/`
- `services/api/src/modules/ticket/`
- `packages/shared/src/`
- `tests/unit/`
- `tests/security/`

## 5. Out of Scope

- **認証されたHTTPエンドポイント** — [[WP-P1-IDM-003]] 完了まで着手しない
- **Merge時の通知** — [[WP-P2-NTF-005]]。本WPでは監査イベントのみ生成し、通知はNTF-005が拾う
- Merge の取り消し(unmerge)。統合は不可逆とし、誤統合は新規起票で対応する
- 多階層のParent/Child(1階層のみ。[[01.5_Scope_and_Non_Goals]]で対象外)
- 関連チケットの自動提案(重複候補の検出)。Phase 8のAI支援で扱う

## 6. 設計判断(draft時の保留事項を確定)

| 論点 | 決定 | 理由 |
|---|---|---|
| Merge時のコメント・添付 | **移さない。元チケットに残し、統合先から参照する** | 移すと元チケットの履歴が空洞化し、「何が起きたか」を辿れなくなる。依頼者が自分の起票を開いたときに中身が消えている状態も避ける |
| Merge元の状態 | `merged`(終端)。`merged_into_id` に統合先を保持 | 終端にすることで以降の状態変更を state machine が拒否する |
| Merge元の依頼者への通知 | 本WPでは行わない(監査イベントのみ) | 通知基盤が[[WP-P2-NTF-005]]で未実装。イベントは残すので後から拾える |
| 循環参照の検出 | Parent/Childは1階層制約で構造的に防ぐ。Relatedは自己参照のみ禁止 | Relatedは無向の相互参照であり循環の概念がない。1階層ならParent-Childの循環も起こり得ない |
| Parent解決時にChildが未解決 | **警告を返す。拒否しない** | 拒否すると運用が詰まる(子が別チームの担当で長期化する場合がある)。判断は人間に残す |
| Merge先が既にMerge済み | **拒否する** | 統合の連鎖を許すと、最終的な統合先を辿る処理が必要になり、表示も監査も複雑になる |

## 7. Acceptance Criteria

- [ ] `ticket_relation` が organization_id を持ち、`check_rls.mjs` が問題0件で通る
- [ ] 自分自身との関連付けが拒否される
- [ ] 同じ組合せの重複した関連付けが作られない(A→B と B→A を同一視する)
- [ ] **子を持つチケットを別のチケットの子にできない**(1階層の強制)
- [ ] **親を持つチケットに子を付けられない**(同上)
- [ ] 他組織のチケットとの関連付けが拒否される
- [ ] Merge後、元チケットが `merged` 状態になり `merged_into_id` が設定される
- [ ] **Merge後も元チケットのコメント・添付が取得できる**(移動しない)
- [ ] Merge済みチケットへのMergeが拒否される(統合の連鎖を作らない)
- [ ] Merge元の状態変更が state machine により拒否される(終端状態)
- [ ] Parent解決時にChildが未解決なら警告が返る(遷移自体は成功する)
- [ ] `ticket.linked` `ticket.unlinked` `ticket.merged` の監査イベントが生成される

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-02(Merge後の状態遷移が終端として拒否される)
- TL-04(関連付けの制約、Merge後の履歴保持)
- TL-06(越境、権限)

### Evidence

- 1階層制約の検証結果(親を持つ子に孫を付ける試行が拒否される)
- Merge後に元チケットのコメント・添付が取得できることの確認
- 監査イベントの生成確認

Evidenceは`evidence/WP-P2-REL-009/<YYYYMMDD-HHMM>/`へ保存する。

## 9. Security and Audit

- 関連付けは両側のチケットに対する閲覧権限を要求する。片側だけ見える状態で関連付けると、**関連チケットの件名から権限外の情報が推測できる**
- 他組織のチケットIDを指定した関連付けは404で拒否する(存在秘匿 / NFR-SEC-006)
- Merge は不可逆であり、実行者・理由・両チケットIDを監査に残す
- 該当する脅威: T-01(越境)、T-02(IDOR — 関連付け経由での存在推測)

## 10. Rollback / 失敗時の扱い

Migration の down で `ticket_relation` を削除する。`ticket.merged_into_id` は
[[WP-P2-TKT-001]] の資産のため削除せず、down では NULL に戻し、`merged` 状態のチケットを
`cancelled` へ倒す(終端のまま残す。復元はしない)。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Package(WP-P2-REL-009)のみを実装してください。

正本: AGENTS.md → 本WP(特に §6 設計判断)
     → docs/planning/03_Requirements/03.3_Ticket_Requirements.md(FR-TKT-010 / FR-TKT-011)

作業内容:
1. ticket_relation の Migration。organization_id + RLS 必須。
   - related は無向。A-B と B-A を重複登録できないようにする
     (least/greatest による正規化キーで一意制約)
   - parent_of は有向。1階層のみを構造的に強制する
2. 関連付けサービス。**両側のチケットに対する閲覧権限**を確認する。
   片側だけ見える状態で関連付けると、件名から権限外の情報が推測できる。
3. Merge を実装する。§6の決定に従うこと:
   - コメント・添付は移さない(元チケットに残す)
   - 元チケットは merged 終端 + merged_into_id
   - Merge済みチケットへのMergeは拒否
4. Parent解決時にChildが未解決なら警告を返す(拒否しない)。
5. 監査イベント(ticket.linked / ticket.unlinked / ticket.merged)を生成する。

やってはいけないこと:
- Merge時にコメント・添付を移動すること(元の履歴が空洞化する)
- 多階層のParent/Childを許すこと
- 片側だけの権限で関連付けを許すこと
- HTTPエンドポイントの追加(WP-P1-IDM-003 未完了)

完了時に報告すること:
- 1階層制約の検証結果
- Merge後に元チケットの履歴が残ることの確認
- §7 Acceptance Criteria の充足状況
```

## 12. Definition of Done

- [ ] §7 Acceptance Criteriaをすべて満たす
- [ ] §8のテストが通り、Evidenceを保存した
- [ ] Migration に down があり、up→down→up が成功する
- [ ] `check_rls.mjs` と `check_architecture.mjs` が通る
- [ ] Execution Logへ結果を追記した

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-07-27 | Claude (Codex) | `2b214d6` | Done | `evidence/WP-P2-REL-009/20260727-1520/verification.md` | 全900テスト通過。1階層制約をアプリ層・部分一意索引・トリガの3層で表明し、SQL直接INSERTでも拒否されることを確認。Merge後もコメント・添付が元チケットに残ることを実測(retained: comments 1 / attachments 1、統合先は0件)。統合の連鎖と理由なし統合を拒否。 |
| 2026-07-28 | Opus 5 | — | **訂正** | `evidence/SELF-AUDIT-001/20260728-1536/` | **利用者からは到達できない。**§13.1 参照 |

### 13.1 訂正 — サービスはあるが誰も呼べない (2026-07-28)

横断点検([[04.23_Wiring_Verification]])で判明した。

`RelationService`(`link` / `unlink` / `listRelations` / `merge` /
`unresolvedChildren`)には**HTTPエンドポイントも画面も無い。**
テストからしか呼ばれておらず、利用者はチケットを関連付けることも
統合することもできない。

`implementation_status` を `partial` に改めた。
サービス層とスキーマ(migration 0007)は完成しており、
1階層制約の3層防御も検証済みである。**欠けているのは経路だけ**だが、
経路が無い機能は存在しないのと同じである。

繋ぐまでは `tools/check_unwired.mjs` の `ACCEPTED_UNWIRED` に
理由付きで載せ、毎回の検査出力に現れ続けるようにした。

残作業は [[WP-P2-RELUI-012]] で実施し、2026-07-28 に完了した。
`implementation_status` を `done` へ戻す。

### 13.2 追補で見つかった欠陥 (2026-07-28)

[[WP-P2-RELUI-012]] の通し確認で、本WPの `merge` に欠陥が見つかった。

**「先に関連付けてから統合する」と必ず 500 になっていた。**

統合先から元チケットを辿る関連を挿入する際、一意制約違反(23505)を
JavaScript の `catch` で握り潰していた。
**PostgreSQL では文がエラーになった時点でトランザクション全体が中断する。**
例外を捕まえても中断は解けず、以降のクエリはすべて
`current transaction is aborted` で失敗する。

担当者が「関連していそうだ」と気付いて先に関連付け、
そのあと「やはり重複だ」と統合する — これは異常な操作順ではなく自然な流れである。

本WPのテストが緑だったのは、統合の前に関連付ける手順を踏んでいなかったからにすぎない。
**単一の操作だけを試すテストでは、操作の順序が作る状態を踏めない。**

修正は部分一意索引に合わせた `ON CONFLICT ... DO NOTHING`。回帰テストを追加した。
