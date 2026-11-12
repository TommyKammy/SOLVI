---
project: SOLVI
doc_id: "WP-P4-APR-010"
title: "承認ルーティングの要求・設計基準とADR-0023"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-11-12"
updated: "2026-11-12"
owner: "SOLVI Product Team"
tags: ["workpackage", "p4", "approval", "adr", "documentation"]
source_of_truth: true
implementation_status: "review"
story_points: 3
risk: "medium"
workstream: "APR"
phase: "P4"
requirement_ids: ["FR-CAT-012", "FR-CAT-013", "FR-CAT-014", "FR-CAT-015", "FR-CAT-016", "FR-CAT-017", "FR-IDM-010", "FR-IDM-011", "FR-IDM-012", "FR-IDM-013", "FR-IDM-014"]
depends_on: ["WP-P2-UIX-040", "WP-P2-UIX-041", "WP-P2-UIX-042"]
---

# WP-P4-APR-010: 承認ルーティングの要求・設計基準とADR-0023

| 項目 | 値 |
|---|---|
| Phase | P4 |
| Workstream | APR |
| Risk | medium |
| Story Points | 3 |
| Suggested Owner | Product Owner + Security Reviewer |
| Parallelizable | No(後続の WP-P4-APR-011 / WP-P4-IDM-012 の前提) |
| Gate | Gate B(承認統制の設計基準) |

## 1. Purpose

SOLVIに「部署・上長・承認ルーティング」を追加する計画(利用者承認済み)を、Vaultの正本文書へ落とす**文書だけの**WP。計画書はVault外(`.local/`)にあり、AGENTS §0 により実装根拠にできないため、要求・設計・ADR・WP台帳を改訂して、後続の実装WP([[WP-P4-APR-011]]〜[[WP-P4-APR-017]])が `status: baseline` の文書だけを根拠に着手できる状態にする。あわせて、[[WP-P4-APR-002]]を後継WPへ分割して `superseded` にする。コード・Migration・テスト・設定は変更しない。

## 2. Requirement IDs

本WPが新設する要求ID: `FR-CAT-012`〜`FR-CAT-017`([[03.5_Catalog_and_Approval_Requirements]])、`FR-IDM-010`〜`FR-IDM-014`([[03.7_Identity_OIDC_SCIM_Requirements]])。既存の要求IDの意味は変えない(ただしFR-CAT-011の既定期限の記載を、実装の72時間に合わせて改訂した)。

## 3. Dependencies

[[WP-P2-UIX-040]]、[[WP-P2-UIX-041]]、[[WP-P2-UIX-042]](承認ルーティングの前提となるカタログ定義の拡張。計画の前提条件)。3件は `review` であり、本WPの文書作業はそれらの完了を要しない。実装WPの着手可否は各WPの§3で判断する。

## 4. Scope / Allowed Paths

- `docs/planning/07_ADR/ADR-0023_Relationship_Based_Approval_Authority.md`
- `docs/planning/07_ADR/07.0_ADR_Index.md`
- `docs/planning/03_Requirements/03.5_Catalog_and_Approval_Requirements.md`
- `docs/planning/03_Requirements/03.7_Identity_OIDC_SCIM_Requirements.md`
- `docs/planning/03_Requirements/03.16_Data_Retention_and_Privacy.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/02_Architecture/02.14_Threat_Model.md`
- `docs/planning/02_Architecture/02.17_Audit_Event_Catalog.md`
- `docs/planning/02_Architecture/02.18_Organization_Data_Model_and_RLS.md`
- `docs/planning/00_Index/00.7_Open_Questions.md`
- `docs/planning/04_Development/04.6_Phase_4_Plan.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/06_WorkPackages/P4_Approval_Automation/WP-P4-APR-002.md`
- `docs/planning/06_WorkPackages/P4_Approval_Automation/WP-P4-APR-010.md`
- `docs/planning/06_WorkPackages/P4_Approval_Automation/WP-P4-APR-011.md`
- `docs/planning/06_WorkPackages/P4_Approval_Automation/WP-P4-IDM-012.md`
- `docs/planning/06_WorkPackages/P4_Approval_Automation/WP-P4-IDM-013.md`
- `docs/planning/06_WorkPackages/P4_Approval_Automation/WP-P4-APR-014.md`
- `docs/planning/06_WorkPackages/P4_Approval_Automation/WP-P4-APR-015.md`
- `docs/planning/06_WorkPackages/P4_Approval_Automation/WP-P4-APR-016.md`
- `docs/planning/06_WorkPackages/P4_Approval_Automation/WP-P4-APR-017.md`
- `docs/planning/06_WorkPackages/P4_Approval_Automation/WP-P4-WF-003.md`
- `docs/planning/06_WorkPackages/P4_Approval_Automation/WP-P4-GATE-007.md`
- `docs/planning/06_WorkPackages/P7_Change/WP-P7-APR-002.md`
- `docs/planning/MANIFEST.md`

## 5. Out of Scope

- コード・Migration・テスト・設定・依存の変更(すべて後続の実装WP)。`.local/` の変更。
- ADR-0023を `accepted` にすること(人間のレビュー後に監督者が切り替える)。既存ADRの決定の書き換え。
- 実装WP(011以降)の実装。draft WPの実体化(§3の条件を満たしてから)。
- [[02.16_Executor_Command_Contract]]の改訂(Executor接続は[[WP-P4-EXEC-004]])。

## 6. Deliverables

- [[ADR-0023_Relationship_Based_Approval_Authority]](`draft`): 有効な所属の定義、関係ベースの権限根拠と決定時の検証、上長・部署長設定の特権性、高リスクは固定承認者必須、一覧・詳細の可視性、再割当を経路変更の唯一の遷移とすること、承認済みステップの承認者が後から無効になった場合の扱い(現行からの挙動変更)、模擬テーブルの拡張、`ruleId` 版属性、`btree_gist`、却下した代替案、Consequences と Rollback。
- 03.5(承認者の決定方式・再割当・期限72時間・初期の対象外・多段での状態機械の読み方・FR-CAT-012〜017)、03.7(FR-IDM-010〜014、IdP/SCIM同期は対象外)、02.18(§2.1 組織プロフィール・部署・部署長とRLS)、02.17(§2.1 `request.*` → `approval.*` 移行方針、§2.2 新イベント)、02.14(T-26、RA-04)、03.16(§3.6 組織プロフィールの分類)の改訂。
- 07.0・00.7(OQ-014 を Closed)・04.6・RTM・06.0・06.1・MANIFEST の同期。
- WP-P4-APR-010(本書)、011、IDM-012(以上 `baseline`)、IDM-013、APR-014〜017(以上 `draft`)の新設。WP-P4-APR-002 を `superseded` にし、依存元(WP-P4-WF-003、WP-P7-APR-002、WP-P4-GATE-007)を後継WPへ付け替える。

## 7. Acceptance Criteria

- [ ] `docs/planning/` 以外のファイルが変更されていない(`git status --short` と `git diff --stat` で確認)。コード・Migration・テスト・設定の変更が0件。
- [ ] ADR-0023 が [[09.1_ADR_Template]] の全節(Status・Context・Decision・Consequences・Rejected Alternatives・Security Impact・Operational Impact・Migration Impact・Follow-up・Verification)と Rollback を持ち、`status: "draft"` で、計画の §5・§3.4〜3.7・§11 の決定をすべて決定事項として含む。判断が必要な箇所に `要確認` が明記されている。
- [ ] 07.0 に ADR-0023 の行があり、既存のADR(0001〜0022)の決定内容が変更されていない(`git diff` で ADR-0001〜0022 の変更が0件)。
- [ ] 03.5・03.7・02.14・02.17・02.18・03.16 に §6 の改訂が反映され、既存の要求ID・脅威ID・イベント名の意味が変わっていない(FR-CAT-011 の既定期限の改訂を除く)。新設した要求ID・脅威ID・イベント名が一覧できる(§13)。
- [ ] 新設の8つのWPノートがテンプレート([[09.2_WorkPackage_Template]])の全節を持ち、固有の成果物・受入基準・依存・Allowed Paths・検証方法・Codex prompt を持つ。`baseline` のWPのAllowed Pathsがすべて実在する(`npm run check:paths`)。WP-P4-APR-002 は `superseded` で本文が残り、後継が明記されている。
- [ ] `node tools/check_workpackages.mjs`、`node tools/check_traceability.mjs`、`npm run check:all` が成功する。RTM の要求とWPの主張が双方向で一致する。
- [ ] WP-P4-APR-010 の `implementation_status` が `review` であり、`done` になっていない。

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

文書WPのため実行コードのテストはない。検査は次のツールで行う: `node tools/check_workpackages.mjs`(台帳とノートの一致)、`node tools/check_traceability.mjs`(要求とWPの双方向一致)、`npm run check:all`(Allowed Paths・アーキテクチャ・イメージ固定・skip・配線・RTM・台帳)。

### Evidence

- 上記コマンドの出力、`git status --short` と `git diff --stat`(変更が `docs/planning/` に限ること)
- §13 のExecution Log

## 9. Security and Audit

- ADR-0023 は認可・Identity・監査・承認統制の変更を含むため、AGENTS §1.9・§1.16 により**人間のSecurity Reviewerのレビューが必須**(`proposed` → `accepted` の前提)。自己レビューは代替にならない。
- 本WPはSecret・実データ・実PII・本番テナントの名称やURLを文書へ含めない。計画の調査Evidence(本番テナントのトークン類を含むファイル)は参照していない。

## 10. Rollback / 失敗時の扱い

文書のみの変更であり、PRのrevertで戻せる。WP-P4-APR-002 の `superseded` 化を戻す場合は、台帳・RTM・依存元の付け替えも同時に戻す(`node tools/check_workpackages.mjs` と `node tools/check_traceability.mjs` が整合を確認する)。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Packageのみを実装してください。このWPは文書だけを変更します。

正本(この順で読む):
1. AGENTS.md(絶対ルール)
2. 本WP(WP-P4-APR-010)
3. 00.4_Document_Governance、09.1_ADR_Template、09.2_WorkPackage_Template
4. 改訂対象の文書(§4 Allowed Paths)と tools/check_workpackages.mjs・tools/check_traceability.mjs

手順:
1. ADR-0023 を draft で書く。計画に無い仕様を足さず、判断が必要な点は 要確認 として最も安全側に書く。
2. 要求(03.5・03.7)、アーキテクチャ(02.14・02.17・02.18)、データ分類(03.16)を改訂する。既存の要求ID・脅威ID・イベント名の意味を変えない。
3. 後継WP(011〜017)を新設し、WP-P4-APR-002 を superseded にする。依存元を付け替える。
4. 台帳は node tools/check_workpackages.mjs --write で導出し、手で数を書かない。RTM は check_traceability.mjs で導出値を確認する。
5. 検証コマンドを実行して出力を確認し、Execution Log(§13)へ記録する。

やってはいけないこと:
- docs/planning/ 以外の変更。.local/ の変更。コミット・push・ブランチ切替。
- 既存ADRの決定の書き換え。ADR-0023 を accepted にすること。draft の文書を実装根拠にすること。
- 本番テナントのトークン・URL・名称の転記。
- 失敗するチェックの無効化・skip。

完了時に報告すること:
- 変更ファイル一覧 / Migrationなし / 検証コマンドと結果(そのまま)
- §7 の各項目の充足と証拠 / セキュリティ影響 / 未解決事項(監督者への確認事項)
```

## 12. Definition of Done

- [ ] §7をすべて満たす / §8の検査が通り、出力をExecution Logへ記録した
- [ ] Migrationなし(スキーマ・既存データへの影響なし)、ロールバック方針の記載
- [ ] 関連ドキュメント(RTM・台帳・依存関係・MANIFEST・ADR Index)を同じ変更で更新した
- [ ] 未解決のCritical/Highがない(`要確認` は監督者への確認事項として列挙)
- [ ] ADR-0023 の人間のSecurity Reviewerのレビュー(`accepted` への切替の前提。本WPの完了条件ではなく後続WPの着手条件)
- [ ] Execution Logへ追記

## 13. Execution Log

- 2026-11-12: 利用者承認済みの計画(Vault外の計画書v2)と、未決事項11点の「すべて推奨どおり」の決定をVaultの正本へ落とした。ブランチ `wp/WP-P4-APR-010`。コミット・push・ブランチ切替なし。`.local/` は読むだけで変更していない。調査Evidence(本番テナントのトークン類を含むファイル)は開いていない。
- **変更ファイル(すべて `docs/planning/` 配下)**: 新規9件 = ADR-0023、WP-P4-APR-010 / 011 / 014 / 015 / 016 / 017、WP-P4-IDM-012 / 013。改訂 = 07.0_ADR_Index、03.5、03.7、03.16、03.18(RTM)、02.14、02.17、02.18、00.7、04.6、06.0(台帳。`--write` で導出)、06.1、WP-P4-APR-002(`superseded`。本文は保持)、WP-P4-WF-003 / WP-P4-GATE-007 / WP-P7-APR-002(依存の付け替え)、MANIFEST。
- **新設ID**: 要求 FR-CAT-012〜017、FR-IDM-010〜014。脅威 T-26(リスク受容 RA-04)。監査イベント(命名の基準。確定は各WPが `AUDIT_EVENT_TYPES` へ追加する時点)= `approval.route.resolved`、`approval.reassigned`、`approval.rule.created|revised|deactivated`、`org.member.profile.updated`、`org.department.created|updated|deactivated`、`org.department.head.assigned|removed`。
- **Migration**: なし(文書のみ)。ロールバックはPRのrevert。既存データ互換への影響なし。
- **検証コマンドと結果**:
  - `node tools/check_workpackages.mjs --write` → 台帳へ8件を追加し、集計を導出(WP 113件 / 756ポイント、P4 145)。再実行で `OK: WP台帳は実体と一致しています`。
  - `node tools/check_traceability.mjs --write` → 20行のWork Package欄へ46件を追記(WPの主張を台帳へ写した)。再実行で `OK: 要求と実装・検査の対応は台帳と一致しています`(要求112件。新設11件は `未着手`)。
  - `npm run check:all` → exit 0。`checked 73 baseline work packages, 512 allowed paths` / `OK: 禁止依存はありません。` / `checked 26 image references` / `OK: 未注釈・期限切れの skip はありません。` / `OK: 「定義したが動いていない」箇所は見つかりませんでした(注記 5 件)` / `OK: 要求と実装・検査の対応は台帳と一致しています` / `OK: WP台帳は実体と一致しています`。
  - `tools/check_requirements.py` は存在しないため実行していない。
  - 変更ファイルの wikilink がすべて既存ノートを指すことを確認した。`git status --short` と `git diff --stat` で、変更が `docs/planning/` 配下に限ることを確認した。
  - 作業前のHEADで同じチェックは通っていた(既存の失敗なし)。
- **§7 Acceptance Criteria**: (1) `docs/planning/` 以外の変更なし = 充足(`git status --short`)。(2) ADR-0023 は全節とRollbackを持ち `draft`、計画 §5・§3.4〜3.7・§11 の決定を含み、判断が必要な箇所は `要確認` = 充足。(3) 07.0 に行あり、ADR-0001〜0022 の変更0件 = 充足(`git diff` に07_ADRは07.0とADR-0023のみ)。(4) 03.5・03.7・02.14・02.17・02.18・03.16 へ反映、既存ID・イベント名の意味は不変(FR-CAT-011 の既定期限のみ改訂)= 充足。(5) 新設WP8件が全節を持つ。`check:paths` が通る = 充足。WP-P4-APR-002 は `superseded` で本文が残る = 充足。(6) 3つの検査が成功 = 充足。(7) `implementation_status: "review"` = 充足。
- **セキュリティ影響**: 文書のみで実行時の影響なし。ADR-0023(認可・Identity・監査・承認統制)は `draft` であり、人間のSecurity Reviewerのレビュー後に `accepted` へ切り替える。それまで依存する実装(WP-P4-APR-011 の §7 挙動変更部分、WP-P4-IDM-012 のMigration取込み)に着手しない。
- **未解決事項(`要確認`)**: ADR-0023 とWP内に `要確認` として残した点 = (a) 高リスク申請の判定基準、(b) 承認ルールの最大段数、(c) `request.changed` / `request.revoked` の `approval.*` への対応と `approval.expired` の記録契機、(d) org_admin 本人による自分の上長・主部署の変更の扱い、platform_admin の組織切替下の扱い、(e) 組織プロフィール行の作成経路(`role_binding` を作る他経路があるか)と社員番号の分類、(f) 承認ルール有効化の組織単位設定の置き場所、(g) 承認済みステップの期限(現行は承認後も期限で実行を止める)と §7 のExecutor適用可否。詳細は監督者への最終報告に列挙した。
- Evidence: 本Execution Log。コマンド出力は上記に転記した(`evidence/WP-P4-APR-010/` は作成していない。文書のみのため)。
- 2026-11-12(監督者による追記): 利用者(Product Owner)がADR-0023とリスク受容RA-04を確認して承認した。これを受けてADR-0023のstatusを `draft` → `accepted` に切り替え、07.0_ADR_Index と 03.5 の記載を合わせた。上のログ中の「`draft`」は切替前の時点の記録である。`要確認` の各点は未確定のまま残る。
