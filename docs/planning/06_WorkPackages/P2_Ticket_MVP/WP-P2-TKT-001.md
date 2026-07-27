---
project: SOLVI
doc_id: "WP-P2-TKT-001"
title: "Ticket DomainとState Machine"
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
---

# WP-P2-TKT-001: Ticket DomainとState Machine

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | TKT |
| Risk | high |
| Story Points | 8 |
| Suggested Owner | Backend |
| Parallelizable | No(P2の起点。他のP2 WPが依存する) |
| Gate | Gate A |

## 1. Purpose

チケット(Incident / Service Request)のドメインモデルと状態機械を実装する。Phase 2 の他すべてのWPがこの上に載るため、状態遷移・採番・監査の型をここで固定する。

**このWPで確定させること**: 状態遷移が文字列更新ではなく明示的な遷移表として実装されること、全遷移が監査イベントを生成すること、Organization境界が新テーブルにも適用されること。

## 2. Requirement IDs

`FR-TKT-001`, `FR-TKT-002`, `FR-TKT-009`, `FR-TKT-012`, `NFR-SEC-001`, `NFR-SEC-006`, `AUD-001`

## 3. Dependencies

[[WP-P1-DATA-002]], [[WP-P1-AUD-004]]

いずれも完了済み(2026-07-27)。**[[WP-P1-IDM-003]](OIDC)は未完了**のため、HTTPレイヤの認証配線は本WPの対象外とする(§5)。

## 4. Scope / Allowed Paths

- `db/migrations/`
- `services/api/src/modules/ticket/`
- `packages/shared/src/ticket/`
- `tests/unit/`
- `tests/security/`

## 5. Out of Scope

- **認証されたHTTPエンドポイント** — [[WP-P1-IDM-003]] 完了まで着手しない。認証なしで動く暫定エンドポイントを作らない(後で消し忘れる経路を作らないため)。ドメイン層は `Principal` を引数で受け取る形にし、HTTP配線は後続WPで接続する
- コメント・内部メモ・添付([[WP-P2-COLLAB-004]])
- 担当割当・一覧UI([[WP-P2-OPS-003]])
- 通知([[WP-P2-NTF-005]])
- 検索・SLA([[WP-P2-SEARCH-006]])
- カタログ経由のRequest生成([[WP-P4-CAT-001]])。本WPでは種別としての Request を扱うが、フォーム定義は持たない

## 6. Deliverables

- `ticket` テーブルと Migration(organization_id + RLS、種別別採番)
- 状態機械の定義([[03.3_Ticket_Requirements]]の遷移表と1:1)と遷移サービス
- 優先度の決定論的導出(Impact × Urgency)
- Reopen の期限判定(14日)
- チケット関連の監査イベント(`ticket.created` / `ticket.transitioned`)
- 遷移表と1:1の状態機械テスト、越境テスト

## 7. Acceptance Criteria

- [ ] `ticket` テーブルが organization_id を持ち、`check_rls.mjs` が問題0件で通る
- [ ] チケット番号が種別別に採番される(`INC-YYYY-NNNNNN` / `REQ-YYYY-NNNNNN`)。**同時実行しても重複しない**
- [ ] 状態遷移が明示的な遷移表で定義され、表にない遷移がすべて拒否される(TL-02)
- [ ] 終端状態(`closed` / `merged` / `cancelled`)からの遷移がすべて拒否される
- [ ] `resolved` から `in_progress` への Reopen が14日以内は成功し、**15日目は拒否**される(FR-TKT-012)
- [ ] 優先度が Impact × Urgency から決定論的に導出される(同一入力で常に同一結果)
- [ ] 全ての状態遷移が `ticket.transitioned` 監査イベント(from/to/actor/理由)を生成する
- [ ] 監査イベントの記録に失敗した場合、チケットの状態変更も巻き戻る(同一トランザクション)
- [ ] 他組織のチケットが取得・更新できない(越境テスト、TL-06)
- [ ] 権限外のチケットへの直接ID指定アクセスが404を返す(NFR-SEC-006)

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-02(状態機械: 遷移表の全セルを網羅。許可・拒否の両方)
- TL-01(優先度導出の決定論性)
- TL-04(採番の同時実行、監査との同一トランザクション)
- TL-06(越境・オブジェクトレベル認可)

### Evidence

- 遷移表の全組み合わせに対するテスト結果(許可n件/拒否m件の網羅表)
- 同時採番テストの結果(重複0件)
- 監査イベント生成の確認(遷移1件あたり1イベント)

Evidenceは`evidence/WP-P2-TKT-001/<YYYYMMDD-HHMM>/`へ保存する([[06.2_Evidence_Index]])。

## 9. Security and Audit

- 新規テーブルには organization_id と RLS を必ず設ける(ADR-0015)。`check_rls.mjs` が検査する
- チケット本文は監査イベントに入れない。参照IDのみ(02.17 §4)
- 状態遷移の可否判定はアプリ層で行い、RLSを認可の代わりにしない
- 該当する脅威: T-01(越境)、T-02(IDOR)、T-03(mass assignment — 状態やorganization_idを入力から受け取らない)

## 10. Rollback / 失敗時の扱い

Migration の down でテーブルを削除できる。まだ利用者データが存在しないため、データ損失の懸念はない。状態機械の定義に誤りが見つかった場合は、遷移表の修正 + テストの更新を同一PRで行う(表とテストが乖離した状態を作らない)。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Package(WP-P2-TKT-001)のみを実装してください。

正本(この順で読む):
1. AGENTS.md(絶対ルール)
2. 本WP
3. docs/planning/03_Requirements/03.3_Ticket_Requirements.md(§状態機械が遷移の正本)
4. docs/planning/02_Architecture/02.17_Audit_Event_Catalog.md
5. docs/planning/02_Architecture/02.18_Organization_Data_Model_and_RLS.md

作業内容:
1. ticket テーブルの Migration を書く。organization_id + RLS(ENABLE + FORCE)を必ず設ける。
   種別別の採番は、同時実行で重複しない方式にすること(採番方式の選定理由を説明すること)。
2. 状態機械を **明示的な遷移表** として実装する。文字列比較の分岐で書かない。
   03.3 §状態機械 の表と1:1に対応させ、テストが表を参照する形にする。
3. 優先度を Impact × Urgency から決定論的に導出する。AIは関与させない(ADR-0007)。
4. 状態遷移サービスは Principal を引数で受け取る。**HTTPエンドポイントは作らない**
   (WP-P1-IDM-003 未完了のため。認証なしで動く経路を作らないこと)。
5. 全遷移で監査イベントを生成する。業務トランザクションと同一クライアントで書く
   (services/api/src/common/audit/audit.ts の recordAuditEvent を使う)。
6. 遷移表の全組み合わせ(許可・拒否の両方)を網羅するテストを書く。

やってはいけないこと:
- 認証なしで動くHTTPエンドポイントの追加
- 状態を文字列で直接UPDATEする経路の実装
- organization_id や status を入力DTOから受け取ること(mass assignment / 脅威 T-03)
- チケット本文を監査イベントへ入れること

完了時に報告すること:
- 変更ファイル、Migration の内容とロールバック方法
- 遷移表の全セルに対するテスト結果(許可n件/拒否m件)
- 同時採番テストの結果
- §7 Acceptance Criteria の各項目に対する充足状況
```

## 12. Definition of Done

- [ ] §7 Acceptance Criteriaをすべて満たす
- [ ] §8のテストが通り、Evidenceを保存した
- [ ] Migration に down があり、up→down→up が成功する
- [ ] `check_rls.mjs` と `check_architecture.mjs` が通る
- [ ] 未解決のCritical/Highがない
- [ ] Security Reviewer のレビューを完了した(監査・境界に関わるため)
- [ ] Execution Logへ結果を追記した

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-07-27 | Claude (Codex) | `1b8839e` | Done | `evidence/WP-P2-TKT-001/20260727-1124/verification.md` | 遷移表704組合せを全件検証(許可20/拒否684)。採番の並行20件で重複0件。全793テスト通過。**設計変更1件**: 拒否イベントは業務トランザクションがロールバックされると消えるため、`PoolDenialRecorder`で独立接続へ記録する構成に変更した。成功時の監査は同一トランザクションのまま。 |
