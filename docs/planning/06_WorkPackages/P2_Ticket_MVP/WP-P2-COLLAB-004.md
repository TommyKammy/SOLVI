---
project: SOLVI
doc_id: "WP-P2-COLLAB-004"
title: "Comment・Internal Note・Attachment"
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
story_points: 8
risk: "high"
workstream: "COLLAB"
phase: "P2"
requirement_ids: ["FR-TKT-004", "FR-TKT-005", "NFR-SEC-005"]
---

# WP-P2-COLLAB-004: Comment・Internal Note・Attachment

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | COLLAB |
| Risk | high |
| Story Points | 8 |
| Suggested Owner | Backend + Security Reviewer |
| Parallelizable | Yes([[WP-P2-TKT-001]]完了後、OPS-003と並行可) |
| Gate | Gate A |

## 1. Purpose

チケット上のやり取り(公開コメント / 内部メモ)と添付ファイルを実装する。

このWPの本質は機能追加ではなく**2つの漏えい経路を塞ぐこと**である。

1. 内部メモが依頼者へ露出する経路(FR-TKT-004)。IT担当の調査メモには、他の利用者の情報や未確定の憶測が含まれる
2. 添付ファイルが権限外・他組織へ流出する経路(FR-TKT-005 / 脅威 T-15・T-16)

「表示しない」ではなく「取得できない」状態にする。

## 2. Requirement IDs

`FR-TKT-004`, `FR-TKT-005`, `NFR-SEC-001`, `NFR-SEC-005`, `NFR-SEC-006`, `AUD-001`

## 3. Dependencies

[[WP-P2-TKT-001]](完了済み)

## 4. Scope / Allowed Paths

- `db/migrations/`
- `services/api/src/modules/ticket/`
- `packages/shared/src/`
- `tests/unit/`
- `tests/security/`

## 5. Out of Scope

- **認証されたHTTPエンドポイント** — [[WP-P1-IDM-003]] 完了まで着手しない(WP-P2-TKT-001 と同じ理由)
- **ウイルススキャナ本体の統合** — 外部サービスの選定が未了。本WPでは**スキャン状態による配布制御の仕組み**を実装し、スキャナ接続は後続WPで差し込む。スキャン未完了の添付は配布されない状態を先に作る
- 通知([[WP-P2-NTF-005]])
- コメントの編集・削除。初期は追記のみ(履歴の完全性を優先)
- リッチテキスト・画像インライン表示

## 6. Deliverables

- `ticket_comment` テーブル(公開/内部の区分を持つ)と Migration
- `ticket_attachment` テーブル(メタデータのみ。本体はObject Storage / ADR-0010)
- コメントサービス(可視性フィルタを**クエリ側**で適用)
- 添付サービス(アップロード用/ダウンロード用の署名付きURL発行、スキャン状態による配布制御)
- 拡張子・MIME・サイズの検証(NFR-SEC-005)
- 監査イベント(`ticket.comment.added` / `ticket.attachment.added` / `ticket.attachment.downloaded`)

## 7. Acceptance Criteria

- [ ] `ticket_comment` `ticket_attachment` が organization_id を持ち、`check_rls.mjs` が問題0件で通る
- [ ] 依頼者が取得するコメント一覧に内部メモが**1件も含まれない**(可視性はクエリで絞る。取得後のフィルタにしない)
- [ ] 内部メモを直接ID指定で取得しようとしても404になる(NFR-SEC-006)
- [ ] 担当者(agent)は公開コメントと内部メモの両方を取得できる
- [ ] 添付のダウンロードURLは**有効期限10分以内**、単一オブジェクト限定で発行される
- [ ] スキャン状態が `clean` 以外の添付はダウンロードURLが発行されない(FR-TKT-005)
- [ ] 実行可能形式(`.exe` `.bat` `.sh` `.ps1` `.js` 等)のアップロードが拒否される
- [ ] サイズ上限(25MB)を超えるアップロードが拒否される
- [ ] 他組織の添付・コメントが取得できない(越境テスト、TL-06)
- [ ] コメント本文・添付ファイル名が監査イベントに含まれない(02.17 §4)
- [ ] 添付のダウンロードが監査イベントとして記録される

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-06(内部メモの可視性、越境、オブジェクトレベル認可)
- TL-16(実行可能形式・サイズ超過の拒否、署名URLの有効期限)
- TL-04(DBを含む結合)

### Evidence

- 依頼者視点でのコメント取得結果(内部メモ0件であることの出力)
- 拒否された拡張子・サイズの一覧と結果
- 署名付きURLの有効期限の実測

Evidenceは`evidence/WP-P2-COLLAB-004/<YYYYMMDD-HHMM>/`へ保存する([[06.2_Evidence_Index]])。

## 9. Security and Audit

- 内部メモの可視性は**SQLの条件**で表現する。アプリで取得後にフィルタする実装にしない(フィルタ漏れが即漏えいになるため)
- 署名付きURLに organization を推測させる情報を含めない(02.18 §4)
- 添付のオブジェクトキーは推測不能にする(連番・ファイル名をそのまま使わない / 脅威 T-16)
- アップロードは「オブジェクト保存 → メタデータ確定」の順(逆順は参照切れを生む / 02.1 §4)
- 該当する脅威: T-01(越境)、T-02(IDOR)、T-15(悪性添付)、T-16(署名URL漏えい)

## 10. Rollback / 失敗時の扱い

Migration の down でテーブルを削除できる。Object Storage 側に残った孤児オブジェクトは
[[08.11_Data_Reconciliation]] の棚卸しで回収する(メタデータのない実体は削除対象)。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Package(WP-P2-COLLAB-004)のみを実装してください。

正本(この順で読む):
1. AGENTS.md
2. 本WP
3. docs/planning/03_Requirements/03.3_Ticket_Requirements.md(FR-TKT-004 / FR-TKT-005)
4. docs/planning/02_Architecture/02.18_Organization_Data_Model_and_RLS.md §4(添付URL・境界)
5. docs/planning/02_Architecture/02.17_Audit_Event_Catalog.md
6. docs/planning/07_ADR/ADR-0010_S3_Compatible_Attachments.md

作業内容:
1. ticket_comment / ticket_attachment の Migration。organization_id + RLS 必須。
2. コメントの可視性を **SQLの条件**で表現する。取得後のフィルタにしない。
   依頼者視点のクエリが内部メモを1件も返さないことをテストで示すこと。
3. 添付は本体をObject Storage、メタデータをDBへ。
   - オブジェクトキーは推測不能にする(ランダム)
   - ダウンロードURLは有効期限10分以内、単一オブジェクト限定
   - scan_status が clean 以外はURLを発行しない
4. アップロード前検証: 拡張子・MIMEのallowlist、サイズ上限25MB。
   実行可能形式は拒否する。
5. 監査イベントを生成する。本文・ファイル名は監査へ入れない。
6. HTTPエンドポイントは作らない(WP-P1-IDM-003 未完了)。

やってはいけないこと:
- 可視性をアプリケーション側のフィルタだけで担保すること
- 署名付きURLの有効期限を10分より長くすること
- スキャン未完了の添付を配布できる経路を残すこと
- ファイル名をそのままオブジェクトキーに使うこと

完了時に報告すること:
- 変更ファイル、Migration とロールバック方法
- 依頼者視点で内部メモが0件であることの検証結果
- 拒否した拡張子・サイズの一覧
- §7 Acceptance Criteria の充足状況
```

## 12. Definition of Done

- [ ] §7 Acceptance Criteriaをすべて満たす
- [ ] §8のテストが通り、Evidenceを保存した
- [ ] Migration に down があり、up→down→up が成功する
- [ ] `check_rls.mjs` と `check_architecture.mjs` が通る
- [ ] **Security Reviewer のsign-offを得た**(漏えい経路に直結するため必須)
- [ ] Execution Logへ結果を追記した

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-07-27 | Claude (Codex) | `d5ef6fc` | Done | `evidence/WP-P2-COLLAB-004/20260727-1453/verification.md` | 全857テスト通過。内部メモの可視性をSQL条件で実装(取得後フィルタにしない)。添付は拡張子×MIMEの両方一致を要求し、SVG・二重拡張子・パス成分・サイズ超過を拒否。署名付きURLは実装側で600秒に切り詰め。scan_status が clean 以外はURLを発行しない。**スキャナ本体の統合は後続WP**(外部サービス未選定)。副次修正: 新しい外部キーで既存テストのクリーンアップ順序が壊れたため`tests/support/cleanup.ts`へ集約。 |
