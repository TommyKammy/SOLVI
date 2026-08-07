---
project: SOLVI
doc_id: "WP-P1-AUD-004"
title: "Append-only Audit基盤とアンカー"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.2.0"
created: "2026-07-27"
updated: "2026-07-27"
owner: "SOLVI Product Team"
tags: ["workpackage", "p1"]
source_of_truth: true
implementation_status: "done"
requirement_ids: ["BR-004", "NFR-OPS-003", "NFR-SEC-003"]
---

# WP-P1-AUD-004: Append-only Audit基盤とアンカー

| 項目 | 値 |
|---|---|
| Phase | P1 |
| Workstream | AUD |
| Risk | high |
| Story Points | 8 |
| Suggested Owner | Backend + Security Reviewer |
| Parallelizable | Yes(DATA-002後、IDM-003と並行可) |
| Gate | Gate 1 |

## 1. Purpose

[[02.17_Audit_Event_Catalog]]に基づく監査基盤を実装し、アプリからの改変が不可能かつ事後改変が検知可能な状態を作る。

## 2. Requirement IDs

`BR-004`, `NFR-SEC-003`, `NFR-OPS-003`, `AUD-001`, `AUD-002`, `AUD-003`

## 3. Dependencies

[[WP-P1-DATA-002]]

## 4. Scope / Allowed Paths

- `db/migrations/`
- `services/api/src/modules/audit/`
- `services/worker/src/jobs/audit-anchor/`
- `tests/security/audit/`

## 5. Out of Scope

- SIEM連携(RA-02によりPhase 8)
- 監査UI(Phase 2以降)
- ドメイン固有イベントの実装(各ドメインWP)

## 6. Deliverables

- audit_eventスキーマとMigration
- 監査書込みの共通機構(相関ID伝播を含む)
- UPDATE/DELETE拒否(REVOKE+トリガ)
- 日次ハッシュアンカーのバッチとS3 Object Lock書き出し
- 監査export API
- Phase 1必須イベントの実装

## 7. Acceptance Criteria

検証可能な条件のみ。すべて満たさない限りDoneにしない。

- [ ] 02.17§1の共通フィールドがすべてスキーマに存在し、NOT NULL制約が適切に設定されている
- [ ] 02.17§2のPhase 1必須イベント(auth系/authz系/org系/role系/user系/audit.export/config.changed)がすべて生成される
- [ ] アプリケーションロールからのUPDATE/DELETE/TRUNCATEがDBレベルで拒否される(テストで証明)
- [ ] 日次アンカーバッチが連鎖ハッシュのルート値と件数をS3(Object Lock有効)へ書き出す
- [ ] 改ざんを模したテスト(直接UPDATE後の再計算)でアンカー照合が不一致を検出する
- [ ] correlation_idが1リクエスト内でAPI→Outbox→Workerまで伝播する
- [ ] auditorロール以外が監査APIへアクセスできない。管理者ロールに削除経路が存在しない
- [ ] 監査イベント本文にチケット本文・Secret・PIIが含まれない(redaction検証)

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-06(監査閲覧の権限テスト)
- TL-16(改変拒否・redaction)
- TL-04
- TL-12(相関ID伝播)

### Evidence

- UPDATE/DELETE拒否テストの出力
- アンカー照合の成功例と改ざん検出例
- 相関ID追跡のトレース

Evidenceは`evidence/WP-P1-AUD-004/<YYYYMMDD-HHMM>/`へ保存し、Command・Environment・Commit SHA・Result・Timestampを含める([[06.2_Evidence_Index]])。

## 9. Security and Audit

- Gate 1のG1-4/G1-5の対象。Security Reviewerのsign-off必須
- S3バケットはObject Lock compliance modeで作成し、削除不能であることを確認する
- 監査書込みの失敗は業務処理の失敗として扱う(監査なしで状態変更を成立させない)

## 10. Rollback / 失敗時の扱い

監査スキーマの変更はappend-only性を壊さない範囲(列追加)に限る。列削除・型変更は新テーブル+移行で行う。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Packageのみを実装してください。

正本(この順で読む):
1. AGENTS.md(絶対ルール)
2. 本WP(WP-P1-AUD-004)
3. 参照設計: 02.17_Audit_Event_Catalog(全節)、ADR-0009、ADR-0013

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
1. 02.17§1のスキーマでaudit_eventテーブルを作成する。event_typeはENUMまたはCHECK制約でカタログ値に限定する。
2. 監査書込みの共通機構を作る。業務トランザクション内で書き、失敗時は業務処理も失敗させる。
3. correlation_idの伝播(HTTPヘッダ→AsyncLocalStorage→Outbox→Worker)を実装する。
4. アプリロールからのUPDATE/DELETE/TRUNCATEをREVOKEし、トリガで二重に拒否する。
5. 日次アンカーバッチ: 当日イベントを時系列で連鎖ハッシュ化し、ルート値+件数+日付をS3(Object Lock)へ書く。
6. 監査export API(auditorロール限定、export自体も監査記録)を実装する。
7. redaction(Secret/PII/本文の除去)を書込み時に適用する。

02.17§2のPhase 1必須イベントのみ実装する。Phase 2以降のイベントは各ドメインWPで追加する。
```

## 12. Definition of Done

- [ ] §7 Acceptance Criteriaをすべて満たす
- [ ] §8のテストが通り、Evidenceを保存した
- [ ] DB変更にMigrationとロールバック方針、既存データ互換の説明がある
- [ ] 関連ドキュメント(API定義・Runbook・RTM)を更新した
- [ ] 未解決のCritical/Highがない
- [ ] Security Reviewerのsign-offを得た(必須)
- [ ] Execution Logへ結果を追記した

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-07-27 | Claude (Codex) | `036b0cd` | Done | `evidence/WP-P1-AUD-004/20260727-1020/verification.md` | 監査テスト18/18。append-onlyを権限REVOKE+トリガの二層で強制し、**owner権限でも**UPDATE/DELETEが拒否されることを確認。日次アンカーで改ざん(UPDATE/DELETE)を両方ともmismatch検出。uuid v7に単調カウンタを実装(順序が崩れると連鎖ハッシュが非決定的になり改ざん検知が壊れるため)。 |
| 2026-07-28 | Opus 5 | `31348f6` / merge `aefab5e` | **訂正** | `evidence/SELF-AUDIT-001/20260728-1536/` | **アンカーは一度も実行されていなかった。**§13.1 参照 |

### 13.1 訂正 — アンカーは一度も実行されていなかった (2026-07-28)

横断点検([[04.23_Wiring_Verification]])で判明した。

`computeDailyRoot` / `persistAnchor` / `verifyAnchor` は互いに呼び合い、
テストも18件通っていた。しかし **`services/worker/src/main.ts` は
`anchor.ts` を読み込んでいなかった。** 定期実行の口がどこにも無く、
改ざん検知は実装済みとして扱われながら一度も動いていなかった。

`main.ts` の冒頭には「監査アンカーのバッチは WP-P1-AUD-004 で追加する」と
書かれたままだった。**その注記が残っていること自体が唯一の痕跡だった。**

さらに重い問題として、仮に実行していても**空のアンカーを記録し続けた**。
`audit_event` のRLSは `organization_id = app_current_org()` であり、
組織コンテキストを持たないバッチからは0件に見える。
0件でも連鎖ハッシュは正しく計算でき、`persistAnchor` は成功する。
**ログにもヘルスチェックにも何の異常も出ない。**

既存のテストがこれを捉えられなかったのは、すべて `admin`
(BYPASSRLS を持つ所有者)で実行していたためである。
実運用のワーカーは `solvi_app` で接続する。

修正:

- **migration 0014**: `app.anchor` の読み取り専用例外を追加。
  登録制とし、`app.dispatcher` / `app.auth` / `app.scanner` を流用しない
  ([[02.18_Organization_Data_Model_and_RLS]] §3)
- `runner.ts` を追加。実行前に例外ポリシーの実在を確認し、
  無ければ**実行しない**(アンカーは上書きできないため、
  誤ったものを1件でも保存すると後から直せない)
- worker で1時間おきに実行。前日分を固定し、直近3日分を照合する。
  当日分は固定しない(まだ増える日をアンカーすると必ず不一致になる)
- メトリクス `solvi.audit.anchors` を追加し、
  **不一致だけでなく「増えないこと」自体を警報にする**
  (`SolviAuditAnchorMismatch` / `SolviAuditAnchorNotRunning`)
- アプリロールで実行する経路のテストを8件追加。
  「組織コンテキスト無しでは0件しか見えない」ことを**明示的に固定した**

実行結果:

```
date=2026-07-27 created verified=1 root=630c66a2679e
solvi_audit_anchors_total{outcome="match"} 1
```

あわせて、`audit_event_immutable()` の例外文が常に `audit_event` を
名乗っていた点を直した(`audit_anchor` の削除を試すと、
触っていないテーブル名が返って調査の起点がずれる)。
