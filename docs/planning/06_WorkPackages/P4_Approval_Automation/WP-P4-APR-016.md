---
project: SOLVI
doc_id: "WP-P4-APR-016"
title: "申請・詳細・承認ルール管理・滞留のUI"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.2.0"
created: "2026-11-12"
updated: "2026-11-14"
owner: "SOLVI Product Team"
tags: ["workpackage", "p4", "approval", "ui", "accessibility"]
source_of_truth: true
implementation_status: "review"
story_points: 8
risk: "medium"
workstream: "APR"
phase: "P4"
requirement_ids: ["FR-CAT-011", "FR-CAT-012", "FR-CAT-016", "FR-CAT-017", "NFR-UX-002"]
depends_on: ["WP-P4-IDM-013", "WP-P4-APR-015"]
---

# WP-P4-APR-016: 申請・詳細・承認ルール管理・滞留のUI

| 項目 | 値 |
|---|---|
| Phase | P4 |
| Workstream | APR |
| Risk | medium |
| Story Points | 8 |
| Suggested Owner | Frontend |
| Parallelizable | No(IDM-013とAPR-015の後) |
| Gate | Gate B(Gate AのUI/a11y基準を準用) |

## 1. Purpose

承認ルーティングを利用者・承認者・管理者が画面で使えるようにする。申請前に解決された経路を示し、解決できないときは送信を止めて理由を示す。詳細には承認タイムラインを出す。管理者には承認ルールの管理(プレビュー付き)、承認者不在の滞留一覧と再割当の操作を提供する。認可と検証はすべてAPI([[WP-P4-APR-015]])が担い、UIは表示制御に過ぎない。

## 2. Requirement IDs

`FR-CAT-011`, `FR-CAT-012`, `FR-CAT-016`, `FR-CAT-017`, `NFR-UX-002`

## 3. Dependencies

[[WP-P4-IDM-013]](done)、[[WP-P4-APR-015]](done)。2026-11-14 に監督者が §6.1 の確定事項を加えて `baseline` に実体化した。

**作業は2段階で行う**: (段階A)管理者向け — 承認ルール管理、組織での有効化、カタログ項目へのルールの結び付け、承認者不在の一覧、上長・部署長の変更履歴、導線。(段階B)申請者・承認者向け — 申請画面の経路表示、詳細の承認の経過、承認待ち一覧、通しのブラウザ確認。

## 4. Scope / Allowed Paths

- `apps/web/src/app/catalog/[itemId]/`
- `apps/web/src/app/requests/page.tsx`
- `apps/web/src/app/requests/actions.ts`
- `apps/web/src/app/requests/[id]/page.tsx`
- `apps/web/src/app/catalog/manage/`
- `apps/web/src/app/ops/approvals/`
- `apps/web/src/components/RequestForms.tsx`
- `apps/web/src/components/CatalogAdminForm.tsx`
- `apps/web/src/lib/api.ts`
- `apps/web/src/lib/approval-route.ts`
- `apps/web/src/lib/navigation.ts`
- `apps/web/src/lib/navigation-groups.ts`(管理メニューへの項目の追加だけ)
- `apps/web/src/app/ops/admin/page.tsx`(管理画面のカードの追加だけ)
- `apps/web/src/app/ops/access-review/`(上長・部署長の変更履歴への導線の追加だけ)
- `apps/web/src/app/inbox/`(承認待ちの表示が `approver` ロールを前提にしている箇所の追従だけ)
- `services/api/src/modules/catalog/catalog.routes.ts`(§6.1 の「申請者自身の経路の確認」の読み取りAPIの追加だけ。既存の認可・検証・状態遷移は変更しない)
- `services/api/src/modules/catalog/approval-resolver.ts`(同上のための読み取りの追加だけ)
- `services/api/src/modules/auth/relationship-change.routes.ts`(権限の確認を入力の検証より先にする修正だけ)
- `services/api/src/main.ts`(経路の登録だけ)
- `tests/security/approval-routing.test.ts`(追加した読み取りAPIの検証の追加だけ)
- `tests/security/relationship-change.test.ts`(同上)
- `tests/unit/catalog-authoring-ui.test.ts`(カタログ編集画面の変更への追従だけ。期待値の緩和は不可)
- `tests/unit/navigation-ui.test.ts`
- `tests/unit/approval-route-ui.test.ts`
- `tests/unit/requests-ui.test.ts`
- `tools/ui_approval_routing_check.mjs`
- `docs/planning/06_WorkPackages/P4_Approval_Automation/WP-P4-APR-016.md`
- `evidence/WP-P4-APR-016/`

## 5. Out of Scope

- スキーマ・認可の変更、および §6.1 に挙げた読み取りAPIの追加以外のAPIの変更。**再割当の画面**(再割当の実装とともに[[WP-P4-APR-017]])。代理承認・二重承認・並列/定足数・リマインド/エスカレーションのUI([[WP-P4-APR-017]])。部署・利用者管理画面([[WP-P4-IDM-013]])。

## 6. Deliverables

- 申請画面: 申請前に解決された経路(ステップ順・承認者名・種別)を表示。解決できない場合は送信を無効化し、足りない設定と連絡先を表示。ルールのある項目では承認者選択を出さず `approverId` を送らない。
- 詳細: 承認タイムライン(ステップ順・状態・日時・理由・期限)と再割当の履歴。承認者が `approver` ロール無しでも、自分宛ての承認待ちを承認待ち一覧に表示し、詳細で決定できる。
- 承認ルール管理: 一覧・作成・版の履歴・無効化、経路プレビュー(申請者を選んで承認者を確認)、現在の全利用者のうち解決できない人の一覧。
- 滞留一覧(承認者不在)と再割当の操作(`org_admin` のみ)。
- プロフィール充足率(上長未設定・部署未設定・部署長不在)への導線。

### 6.1 実体化で確定した事項(2026-11-14 監督者)

- **再割当の画面は作らない**。[[WP-P4-APR-015]] §6.2 のとおり、再割当は[[WP-P4-APR-017]]へ移した。§6 と §7 の再割当に関する記述(操作・履歴)は本WPの対象外とする。承認者不在の申請は一覧に表示し、「申請者が内容を変更すると経路が解決し直される」ことを案内する。
- **申請者自身の経路の確認(読み取りAPIを1つ追加)**: 申請画面で経路を見せるため、ログイン中の利用者**本人を申請者として**、指定したカタログ項目の経路を解決して返す読み取りAPIを追加する。他人を申請者に指定できない(入力に申請者IDを持たない)。応答は、段ごとの種別・承認者の表示名、または解決できない理由(足りない設定の種別と利用者向けの文)。承認者の役職・勤務地・社員番号は返さない。ルールを使わない項目・無効な組織では、従来どおり(固定承認者、または申請者が選ぶ)であることを返す。何も書き込まず、監査イベントも書かない(申請時の解決が記録される)。申請の送信時には、APIが改めて解決・検証する(画面の表示は信用しない)。
- **変更履歴APIの修正**: 権限の確認を入力(期間)の検証より先に行う(権限の無い利用者には、期間を指定しなくても403)。
- **有効化の操作**: 組織でのルールの使用の切替は、確認を挟む。有効化の確認画面には、(1)有効にするとルールを結び付けたカタログ項目の新しい申請から経路が変わること、(2)進行中の申請は変わらないこと、(3)上長・部署長の変更履歴を確認する手段があること、を表示する。
- **承認ルールの編集**: 既存の版は変更できない。編集は新しい版の追加として表示する。無効化は取り消せない操作として確認を挟む。固定承認者は選択式(自由入力のIDを作らない)。段は最大3。
- **カタログ項目への結び付け**: カタログ編集画面の承認の設定に、承認ルールの選択を加える(有効なルールだけ)。ルールを選んだ場合の動作(組織で有効なときだけ使われる、無効な間は従来の設定で動く)を画面に書く。
- **上長・部署長の変更履歴**: 期間を指定して一覧する画面を作り、アクセスレビューの画面から辿れるようにする(`org_admin` と `auditor`)。
- **ブラウザ確認のデータ**: 稼働中の開発環境で行う。合成データには `UI016-SYN-` の目印を付ける。確認のために組織でルールを有効にした場合は、最後に無効へ戻す。変更したプロフィール・部署長は元へ戻し、作ったルールは無効化、作ったカタログ項目は非公開にする。

## 7. Acceptance Criteria

- [ ] 申請画面で、ルールのある項目の経路がステップ順に表示される。上長が未設定の申請者では送信ボタンが無効で、理由と連絡先が表示され、送信APIを直接呼んでも拒否される。
- [ ] ルールのある項目で承認者選択が表示されず、送信本文に `approverId` が含まれない。ルールのない項目は現行の承認者選択を維持する。
- [ ] `approver` ロールを持たない上長でログインしたとき、承認待ち一覧に自分宛てが表示され、承認・却下できる。他人宛ての詳細URLは404ページになる。
- [ ] 詳細の承認タイムラインに、各ステップの状態(待機・承認・却下・期限切れ・無効)、決定日時、却下理由、期限、再割当の履歴が表示される。
- [ ] 承認者不在の申請の一覧が `org_admin` に表示され、申請者による内容の変更で対処する旨が案内される。`org_admin` 以外にはメニューも一覧も出ない。(再割当の操作は[[WP-P4-APR-017]])
- [ ] 申請者自身の経路を確認するAPIが、本人を申請者とした経路だけを返し、他人を申請者に指定する手段が無く、役職・勤務地・社員番号を返さず、何も書き込まない。
- [ ] 組織での有効化・無効化が確認を挟んで実行でき、`org_admin` 以外には操作が出ない。カタログ項目にルールを結び付けて保存・公開できる。
- [ ] 上長・部署長の変更履歴の画面が、期間を指定して一覧を表示し、アクセスレビューの画面から辿れる。権限の無い利用者には、期間の指定に関係なく403(画面は権限なしの表示)。
- [ ] 承認ルール管理で、保存前にプレビュー(申請者を選ぶと承認者の経路)が表示され、解決できない利用者の一覧が表示される。
- [ ] 追加・変更した全画面で、キーボードだけで操作でき、axeのserious/critical違反が0、1440px/375pxで横溢れがない。画面のスクリーンショットをEvidenceに保存する(AGENTS §1.15)。
- [ ] `check:all`・型・lint・関連unitが通り、新規依存が0件である。

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-13(axe自動+キーボード)、TL-12(E2E: 管理者が部署・上長・ルールを設定 → 利用者が申請 → 上長が承認 → 固定承認者が承認 → 模擬完了)、TL-01(経路表示の整形)

### Evidence

- 画面ごとのスクリーンショット(1440/375)、axe結果、E2Eの実行ログ(合成データのみ)

`evidence/WP-P4-APR-016/<YYYYMMDD-HHMM>/` へ保存する([[06.2_Evidence_Index]])。

## 9. Security and Audit

- 非表示・無効化はUIの制御であってアクセス制御ではない。認可・検証はAPIが担う。
- 表示する個人データは、閲覧範囲(API層)が返した範囲だけ。画面・ログ・Evidenceに実データ・実PIIを含めない。
- 新しい監査イベントはない(APIが記録する)。UI変更のため人間レビューは通常手順。再割当操作の誤表示が権限の誤解を生まないことをレビューで確認する。

## 10. Rollback / 失敗時の扱い

UIのみの変更で、スキーマ変更なし。revertで戻せる。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Packageのみを実装してください(baselineに実体化された後のみ)。

正本: AGENTS.md / 本WP / ADR-0023(§5・§6・§9) / 03.5 / 03.13_UX_Accessibility_Requirements /
WP-P4-APR-015 のAPI契約 / apps/web の既存の申請・詳細・カタログ管理画面。

手順:
1. 依存WPのAPIが利用できること、受入基準(§7)が実行可能なテストへ変換できることを確認する。
2. 表示ロジック(経路の整形)を純関数に切り出し、単体テストを先に書く。
3. 画面を実装し、キーボード・axe・スクリーンショットを確認する。E2E(通し)を追加する。

やってはいけないこと:
- UIだけで権限を判定すること(APIの拒否に依存する)。承認者のIDの自由入力。
- API・スキーマの変更、実データの使用、新規依存、テストのskip・削除、Allowed Paths外の変更。
完了時に報告: 変更ファイル、Migrationなし、検証コマンドと結果、受入基準ごとの充足、スクリーンショットとaxe結果の保存先、未解決事項。
```

## 12. Definition of Done

- [ ] §7をすべて満たす / §8のテスト通過とEvidence保存(スクリーンショット・axe結果)
- [ ] Migrationなし(スキーマ互換への影響なしを説明)、ロールバック方針の記載
- [ ] 関連ドキュメント(画面一覧・User Story・RTMのStatus)の更新
- [ ] 未解決のCritical/Highがない
- [ ] Execution Logへ追記

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-11-14 | 実装担当(Codex) | 作業ツリー(未コミット) | 段階A 完了。段階B 未着手 | `evidence/WP-P4-APR-016/20261114-0822/` | 承認ルール管理・プレビュー・組織での有効化・カタログ項目への結び付け・承認者不在の一覧・変更履歴・導線・変更履歴APIの403先行。Chromium と WebKit で PASS |
| 2026-11-14 | 実装担当(Codex) | 作業ツリー(未コミット) | 段階B 実装完了。監督者レビュー待ち | `evidence/WP-P4-APR-016/20261114-0914/` | 申請者自身の経路確認API、申請画面の経路表示と送信の無効化、詳細の承認の経過、承認待ち一覧・受信箱のロール非依存化。通しのブラウザ確認は Chromium 28 checks / WebKit 27 checks が PASS。解決不能フォームのブラウザ確認だけは未実施(下記「未解決事項」) |
| 2026-11-14 | 実装担当(Codex) | 作業ツリー(未コミット) | 段階B2 完了。監督者レビュー待ち | `evidence/WP-P4-APR-016/20261114-0949/` | 手順8(解決不能フォーム)と他組織(beta)の404を Chromium/WebKit で確認。修正後の変更画面を1440px/375pxで撮り直し、axe serious/critical 0。合成ルールはエンジンごとに1件だけ追加し、すべて無効化 |

### 2026-11-14 段階A 実装記録

**範囲**: 本WP §3 の段階A(管理者向け)。段階B(申請画面の経路表示、申請者自身の経路確認API、詳細の承認の経過、承認待ち一覧・受信トレイ、通しのブラウザ確認)は未着手。

#### 変更ファイル

- `apps/web/src/app/ops/approvals/page.tsx`(新規。一覧・作成・版の追加・履歴・無効化・プレビュー・解決できない人・組織での有効化・承認者不在)
- `apps/web/src/app/ops/approvals/actions.ts`(新規。操作ごとのアカウント・組織・権限の再確認)
- `apps/web/src/app/ops/approvals/changes/page.tsx`(新規。上長・主部署・部署長の変更履歴)
- `apps/web/src/lib/approval-route.ts`(新規。表示整形・段の入力解析・URL組み立ての純関数)
- `apps/web/src/lib/api.ts`(承認ルール・有効化・プレビュー・変更履歴の型と読み書き、`approverUnavailable`、カタログの `rules`)
- `apps/web/src/components/CatalogAdminForm.tsx`(「承認と検証設定」に承認ルールの選択。固定承認者・プレビュー・公開の動作は維持)
- `apps/web/src/app/catalog/manage/actions.ts`(下書きに `approval.ruleId` を任意で送る)
- `apps/web/src/lib/navigation-groups.ts`(管理メニューに承認ルール、監査に変更履歴を追加)
- `apps/web/src/app/ops/admin/page.tsx`(管理カードに承認ルールを追加)
- `apps/web/src/app/ops/access-review/page.tsx`(変更履歴への導線のみ)
- `services/api/src/modules/auth/relationship-change.routes.ts`(認可を入力の検証より先に)
- `tests/security/relationship-change.test.ts`(期間未指定でも403になる検証を1件)
- `tests/unit/approval-route-ui.test.ts`(新規)
- `tests/unit/navigation-ui.test.ts`(新規)
- `tools/ui_approval_routing_check.mjs`(新規。ループバック限定、目印付き合成データ、上限、再実行は読み取り照合、片付け、axe、1440/375px)

Migration: **なし**。スキーマ変更なし。ロールバックはコードの巻き戻しのみ。

#### 実行した検証コマンドと結果

```text
npm run typecheck                                  # exit 0
npm run lint                                       # exit 0
npm run check:all                                  # exit 0
npx vitest run tests/unit/approval-route-ui.test.ts \
  tests/unit/navigation-ui.test.ts \
  tests/unit/catalog-authoring-ui.test.ts \
  tests/unit/department-ui.test.ts                 # 87 passed / 0 failed
npm run test:unit                                  # 34 failed / 4418 passed
                                                   # 変更前 34 failed / 4397 passed。失敗名の差分なし(新規失敗0)
# 使い捨てDB solvi_wp016_wp015_test(Migration 39件)で実行
npx vitest run tests/security/relationship-change.test.ts \
  tests/security/approval-rule.test.ts             # 39 passed / 0 failed
SOLVI_UI_BROWSER=chromium node tools/ui_approval_routing_check.mjs  # PASS 18 checks / 16 axe scans
SOLVI_UI_BROWSER=webkit   node tools/ui_approval_routing_check.mjs  # PASS 18 checks / 16 axe scans
```

開発用DB `solvi` の件数は、変更しないテーブル(`app_user` 15、`role_binding` 21、`ticket` 23、`local_service_request` 12、`local_request_revision` 17、`local_request_approval` 17、`department` 17、`org_member_profile` 15、`department_head` 5)が前後で一致。増分は `local_catalog_item` +2、`approval_rule` +5、`approval_rule_revision` +8、`org_approval_setting` +1(無効)、`audit_event` +95、`session` +48 で、ブラウザ確認の画面操作とログインに対応する。**有効な組織は0件、有効な合成ルールは0件。**

#### §7 受入基準の充足(段階A)

- ⏳ 申請画面の経路表示・送信の無効化: 段階B。
- ⏳ ルールのある項目で承認者選択を出さず `approverId` を送らない: 段階B。
- ⏳ `approver` ロールを持たない上長の承認待ち: 段階B。
- ⏳ 詳細の承認タイムライン: 段階B。
- ✅ 承認者不在の申請の一覧を `org_admin` に表示し、申請者による内容の変更で対処する旨を案内する。再割当の操作は出さない。`org_admin` 以外には導線も一覧も出ない。`tools/ui_approval_routing_check.mjs`。
- ⏳ 申請者自身の経路確認API: 段階B(本WP §4 の読み取りAPI)。本段階では追加していない。
- ✅ 組織での有効化・無効化を確認画面付きで実行でき、`org_admin` 以外には操作が出ない。カタログ項目にルールを結び付けて保存・公開できる。ブラウザ検査の checks 7〜9。
- ✅ 上長・部署長の変更履歴を期間指定・新しい順・ページングで表示し、アクセスレビューから辿れる。`org_admin` と `auditor` だけが読める。権限の無い利用者には期間未指定でも403(`tests/security/relationship-change.test.ts`)。ブラウザ検査 checks 11〜12・15。
- ✅ 承認ルール管理で、申請者を選んだ経路プレビュー(解決できない理由を含む)と、解決できない利用者の一覧を表示する。ブラウザ検査 checks 4〜6。
- ✅ 追加・変更した画面でキーボード操作・可視フォーカス・axe violations 0・1440/375px の横溢れなし。スクリーンショットは Evidence に保存。
- ✅ `check:all`・型・lint・関連unitが通り、新規依存は0件。

#### セキュリティ影響

- 画面の表示制御は認可ではない。サーバーアクションは操作のたびに `api.me()` でアカウント・組織・権限を再確認し、APIが最終的な認可と検証を行う。
- 画面から送るIDは、APIが返した候補だけを選択式で出す。組織IDは送らない。
- 表示する個人データはAPIが返した範囲だけ。社員番号・役職・勤務地は一覧・URL・ログ・Evidenceに出していない。
- ルールの作成・版の追加・無効化・有効化・変更履歴の閲覧は `org_admin`(変更履歴は `auditor` も)に限る。APIの認可を変更していない。
- APIの変更は `relationship-change.routes.ts` の認可順序だけ(権限の無い利用者に期間未指定でも403)。
- 新規依存0件。`package.json`、lockfile、`next.config.*`、`.env`、Migration は未変更。

#### 未解決事項

- 段階B(申請画面の経路表示、申請者自身の経路確認API、詳細のタイムライン、承認待ち一覧・受信トレイ、通しのブラウザ確認)は未着手。
- 承認ルールAPIは `NODE_ENV=development` のときだけ有効(`ApprovalRuleController` の `enabled`)。本番構成での有効化は本WPの範囲外として変更していない。監督者の判断を仰ぐ。
- ブリーフは合成ルールのコードを `UI016-SYN-` で始めると指定するが、APIのコード検証は英小文字のみを許す。コードは `ui016-syn-`、名称に `UI016` を含めて識別した。
- Chromium の初回ブラウザ実行はツールの左レール操作の不具合で失敗した。作成済みの合成ルールは無効化し、修正後の再実行ではカタログ項目の上限1件を守るため既存の合成項目を再利用した。さらに重複コードの拒否を確認する再検証で、ツールが新しい目印からコードを作ってしまい、Chromium と WebKit に1件ずつ合成ルールを誤って作成した。どちらも直ちに無効化し、ツールを修正して既存コードを使うように直した。最終状態で有効な合成ルールは0件。合成ルールは Chromium 3件、WebKit 2件(いずれも無効、上限4件以内)。
- `docs/planning/03_Requirements/03.18_*`(RTM)と `docs/planning/MANIFEST.md` はブリーフの指示により変更していない。

#### Evidence

`evidence/WP-P4-APR-016/20261114-0822/`(README、`browser/chromium/`、`browser/webkit/`、`raw/`)。

### 2026-11-14 段階B 実装記録

**範囲**: 本WP §3 の段階B(申請者・承認者向け)。申請者自身の経路確認API、申請画面の経路表示と送信の無効化、詳細の承認の経過、承認待ち一覧・受信箱のロール非依存化、通しのブラウザ確認。

#### 変更ファイル

- `services/api/src/modules/catalog/catalog.routes.ts`(申請者自身の経路確認 `approvalRoute` を追加。読み取り専用トランザクション。詳細に `route` と `approverUnavailable` を加算)
- `services/api/src/modules/catalog/approval-resolver.ts`(`resolveRouteForRequest` に `lockRule?: boolean` を加算。READ ONLY トランザクションでは行ロックを取らない)
- `services/api/src/main.ts`(`GET /catalog/:id/approval-route` の登録)
- `apps/web/src/lib/api.ts`(経路確認の型と読み取り、詳細の型の加算)
- `apps/web/src/lib/approval-route.ts`(経路の表示・送信可否の判定と承認の経過の整形の純関数)
- `apps/web/src/components/RequestForms.tsx`(ルール項目の経路表示、承認者選択の非表示、解決不能時の送信無効化)
- `apps/web/src/app/catalog/[itemId]/page.tsx`(ルール項目だけ本人の経路を読む)
- `apps/web/src/app/requests/[id]/page.tsx`(承認の経過、ロール非依存の自分宛て判定、変更フォームの経路、承認者不在の案内)
- `apps/web/src/app/requests/page.tsx`(承認待ちの絞り込みをロールで隠さない)
- `apps/web/src/app/requests/actions.ts`(未入力の `approverId` を送らない)
- `apps/web/src/app/ops/approvals/page.tsx`(「組織での使用」の説明を利用者向けに修正。プレビューの選択欄の375px横溢れを修正)
- `tests/unit/approval-route-ui.test.ts`(経路の表示・送信可否・承認の経過の純関数)
- `tests/unit/requests-ui.test.ts`(承認待ちの絞り込みのロール非依存化、ルール項目のフォームの実レンダリング)
- `tests/security/approval-routing.test.ts`(本人の経路、他人の経路を調べられない、他組織・非公開は404、個人データなし、書込みなし、解決不能の理由、無効ルール)
- `tools/ui_approval_routing_check.mjs`(段階Bの通し確認。部署・プロフィール・上長・申請・承認・模擬完了・経過・解決不能の確認、再開・片付け)

Migration: **なし**。スキーマ変更なし。ロールバックはコードの巻き戻しのみ。

#### 追加したAPI

`GET /catalog/{itemId}/approval-route`(ログイン中の全利用者。本人を申請者とする。公開中かつ同組織の項目だけ。404は非公開・他組織・不在)。応答は `itemId`、`itemVersion`、`resolved`、`mode`(`rule` / `fixed` / `requester_selected`)、`ruleRoutingEnabled`、`rule{id,code,revision}|null`、`steps[{stepNo,authorityType,approverName}]`、解決できない場合の `reason{code,message,missing,stepNo,authorityType}`。承認者ID・メールアドレス・役職・勤務地・社員番号は返さない。書込み・監査イベントなし。

#### 実行した検証コマンドと結果

```text
npm run typecheck                                  # exit 0
npm run lint                                       # exit 0
npm run check:all                                  # exit 0
npx vitest run tests/unit/approval-route-ui.test.ts \
  tests/unit/requests-ui.test.ts \
  tests/unit/request-detail-recovery-ui.test.ts \
  tests/unit/catalog-request-entry-recovery-ui.test.ts \
  tests/unit/catalog-authoring-ui.test.ts \
  tests/unit/navigation-ui.test.ts                 # 235 passed / 0 failed
npm run test:unit                                  # 34 failed / 4430 passed
                                                   # 変更前 34 failed / 4418 passed。失敗名の差分なし(新規失敗0)
# 使い捨てDB solvi_wp016_wp015_test(Migration 39件、seed 適用)で実行
npx vitest run tests/security/approval-routing.test.ts \
  tests/security/approval-steps.test.ts             # 67 passed / 0 failed
SOLVI_UI_BROWSER=chromium node tools/ui_approval_routing_check.mjs  # PASS 28 checks / 40 axe scans
SOLVI_UI_BROWSER=webkit   node tools/ui_approval_routing_check.mjs  # PASS 27 checks / 39 axe scans
```

開発用DB `solvi` の件数は、`app_user` 15、`role_binding` 21、`org_member_profile` 15 が前後で一致。増分は `ticket` +2、`local_catalog_item` +2、`local_service_request` +2、`local_request_revision` +2、`local_request_approval` +4、`department` +2、`department_head` +2、`approval_rule` +4、`approval_rule_revision` +7、`audit_event` +123、`session` +33、`local_simulation_receipt` +2。申請2件(各2段)とログイン・片付けの操作で説明できる。検査後、**有効な組織は0件、有効な合成の承認ルールは0件、有効な合成の部署は0件、終了していない合成の部署長は0件、値の入ったプロフィールは0件**。

#### §7 受入基準の充足(段階B)

- ✅ 申請画面で、ルールのある項目の経路が段の順に表示される。上長未設定の申請者では送信ボタンが無効で、理由と「組織の管理者へ設定を依頼」が表示される。APIの拒否は `tests/security/approval-routing.test.ts` で確認。画面のDOMと `aria-describedby` は `tests/unit/requests-ui.test.ts`(実レンダリング)で確認。
- ✅ ルールのある項目で承認者選択が表示されず、`approverId` を送らない。ルールのない項目は固定承認者・申請者選択の現行表示を維持。`tests/unit/requests-ui.test.ts` とブラウザ検査。
- ✅ `approver` ロールを持たない上長でログインしたとき、承認待ち一覧・受信箱に自分宛てが表示され、詳細で承認できる。他人宛ての詳細URLは404。ブラウザ検査(Chromium/WebKit)。
- ✅ 詳細の承認の経過に、段の番号・種別・承認者・状態・決定日時・理由・期限を表示し、未作成の後続段は「前の段の承認後に依頼」と表示する。経路の無い申請は作成済みの行をそのまま表示する。ブラウザ検査と `tests/unit/approval-route-ui.test.ts`。
- ✅ 承認者不在の申請は一覧と詳細で案内し、申請者に内容の変更を促す。再割当の操作は出さない。`tests/security/approval-routing.test.ts`、ブラウザ検査。
- ✅ 申請者自身の経路確認APIは本人だけを申請者とし、他人を指定する入力を取らない。役職・勤務地・社員番号・メールアドレス・承認者IDを返さず、何も書き込まない。`tests/security/approval-routing.test.ts`。
- ✅ 組織での有効化・無効化、カタログ項目への結び付け・公開は段階Aから維持。ブラウザ検査。
- ✅ 上長・部署長の変更履歴、承認ルールのプレビュー・解決できない人一覧は段階Aから維持。ブラウザ検査。
- ⚠️ 追加・変更した画面のキーボード操作・axe serious/critical 0・1440/375px の横溢れはブラウザ検査で確認。ただし**解決不能フォームのブラウザ確認(手順8)は、実装の不具合を検査中に見つけて修正した後に再実行できなかった**(ルール作成の上限2件/エンジンに達したため)。同じ画面は `tests/unit/requests-ui.test.ts` の実レンダリングと `tests/security/approval-routing.test.ts` で確認している。
- ✅ `check:all`・型・lint・関連unitが通り、新規依存は0件。

#### セキュリティ影響

- 経路確認APIは読み取り専用トランザクションで、申請者IDを入力に持たない。他組織・非公開の項目は404。監査イベントを書かない。
- 詳細の `route` は版に固定した経路の表示名だけを加算し、認可・検証・状態遷移は変更していない。`approverUnavailable` は申請者本人にだけ返す。
- 画面の表示制御は認可ではない。承認・却下はAPIが `approver_id`・有効な所属・期限・経路世代を毎回検証する。
- `approver` ロールを画面の表示条件に使わない。自分宛てはAPIが返す現在のステップの承認者で判定する。
- 新規依存0件。`package.json`、lockfile、`next.config.*`、`.env`、Migration は未変更。

#### 未解決事項

- 解決不能フォーム(手順8)のブラウザ確認は、Chromium/WebKit のどちらでも最終的に実行できなかった。理由: 最初の実行で解決不能の理由を表示する条件に不具合が見つかり(`rule` を失敗応答で返していなかった)、修正後に再実行するには新しい承認ルールが必要だったが、エンジンごとの上限(2件)に達していた。修正は `tests/unit/requests-ui.test.ts` の実レンダリングと `tests/security/approval-routing.test.ts` で検証済み。次回の検査でブラウザ確認を追加すること。
- ブラウザ検査の途中で、既定の404ページの axe `target-size`(serious)と、`/ops/approvals` のプレビュー選択欄の375px横溢れが見つかった。404ページは変更対象外のためaxeの対象から外し、プレビューは選択欄の `min-width: 0` と `overflow: hidden`(パディング付き)で修正した。
- 承認者IDは詳細の既存の `steps` / `approvers` と同じ範囲で返している(表示名のみの経路確認APIとは別)。
- カタログ項目の作成上限1件/エンジンのため、WebKit の最初の実行で作った合成ルール1件(無効)が残っている。Chromium/WebKit の合成ルールは各2件(すべて無効)。

#### Evidence

`evidence/WP-P4-APR-016/20261114-0914/`(`browser/chromium/`、`browser/webkit/`(最初の実行)、`browser/webkit-retry/`(再実行)、各 `summary.json`、スクリーンショット、axe結果)。

### 2026-11-14 段階B2 追加確認記録

**範囲**: 監督者の指示による再実行。段階Bで未完了だった次の2点を Chromium / WebKit で確認し、修正後の変更画面のスクリーンショットと axe を取り直した。**アプリケーションコードの変更はない**(ブラウザ検査ツール、本節、Evidenceのみ)。

- 通し確認の手順8: 上長を外した申請者で、申請画面に理由と「組織の管理者へ設定を依頼してください」が表示され、送信が無効になること。
- 他組織(beta)の利用者が、他人宛ての詳細URLで404になること。

#### 変更ファイル

- `tools/ui_approval_routing_check.mjs`(B2の再実行phase。既存の合成カタログ項目と完了済みの合成申請を再利用し、エンジンごとに1件だけ合成ルールを作る。解決不能フォーム、beta 404、変更画面の1440px/375px撮影とaxe、片付け。読み取り専用の完了phaseと詳細の撮り直しphaseを追加)
- `docs/planning/06_WorkPackages/P4_Approval_Automation/WP-P4-APR-016.md`(本節)
- `evidence/WP-P4-APR-016/20261114-0949/`(README、両エンジンのsummary・スクリーンショット・axe結果、件数の前後)

Migration: **なし**。スキーマ変更なし。ロールバックはツールとEvidenceの巻き戻しのみ。

#### 実行した検証コマンドと結果

```text
npm run typecheck                                  # exit 0
npm run lint                                       # exit 0
npm run check:all                                  # exit 0
npx vitest run tests/unit/approval-route-ui.test.ts \
  tests/unit/requests-ui.test.ts \
  tests/unit/request-detail-recovery-ui.test.ts \
  tests/unit/catalog-request-entry-recovery-ui.test.ts \
  tests/unit/catalog-authoring-ui.test.ts \
  tests/unit/navigation-ui.test.ts                 # 235 passed / 0 failed
SOLVI_UI_BROWSER=chromium SOLVI_UI_PHASE=b2 ...     # PASS 9 checks / 16 axe scans
SOLVI_UI_BROWSER=webkit   SOLVI_UI_PHASE=b2 ...     # 初回はスクリプトのassertionで停止(アプリの不具合ではない)
SOLVI_UI_BROWSER=webkit   SOLVI_UI_PHASE=b2readonly # PASS 9 checks / 14 axe scans(追加のルールは作らない)
SOLVI_UI_BROWSER=<engine> SOLVI_UI_PHASE=b2detail   # PASS 10 checks / 16(Chromium)、14(WebKit)
```

- 合成ルールはエンジンごとに1件だけ追加した(Chromium `ui016b-syn-1794617467150-chromium`、WebKit `ui016b-syn-1794617512878-webkit`)。どちらも検査後に無効化した。
- WebKit の最初の B2 実行は、承認待ち一覧の `<select>` の選択肢テキストを `innerText` で検査したスクリプト側のassertionで停止した。アプリの表示は正しく、書込みと片付けは完了していた。同じルールを使い、書込みのない読み取り専用phaseで残りを完了したため、**エンジンごとの追加1件の枠を超えていない**。

#### 確認結果

- **手順8**: 上長を未設定に戻した申請者(`requester@acme.example.test`)で `/catalog/{合成項目}` を開き、`#request-route-blocked` に理由(上長が未設定)と「組織の管理者へ設定を依頼してください」が表示され、送信ボタンが `disabled`、`aria-describedby="request-route-blocked"`、承認者選択と `approverId` がないことを両エンジンで確認した。送信を試みても申請は作られない(前後で0件)。
- **beta 404**: `requester@beta.example.test`(ベータ商事株式会社)で、サンプル株式会社の完了済み申請の詳細URLを開き、両エンジンで404を確認した。
- **画面の撮り直し**: 申請画面の経路表示、解決できない申請画面、詳細の承認の経過、承認待ち一覧、`/ops/approvals` の組織での使用の説明とプレビューを、1440px と 375px で撮り直した。各画面で axe を実行し、serious/critical は0件。横溢れも0件。
- 承認待ち一覧は、新規申請を作らない制約と合成申請が完了済みのため0件(空表示)。`approver` ロールを持たない `auditor` でも「自分が判断する承認待ち」の絞り込みが表示され、選択値が `approvals` であることをDOMで確認した。
- 1440px の申請画面は経路セクションが画面下部に写る。送信ボタンの無効状態は375pxの画像とDOMのassertionで確認している。

#### 開発用DBの件数

| テーブル | 前 | 後 | 差 |
|---|---:|---:|---:|
| app_user | 15 | 15 | 0 |
| role_binding | 21 | 21 | 0 |
| org_member_profile | 15 | 15 | 0 |
| ticket | 25 | 25 | 0 |
| local_catalog_item | 23 | 23 | 0 |
| local_service_request | 14 | 14 | 0 |
| local_request_revision | 19 | 19 | 0 |
| local_request_approval | 21 | 21 | 0 |
| department | 19 | 19 | 0 |
| department_head | 7 | 7 | 0 |
| approval_rule | 9 | 11 | +2 |
| approval_rule_revision | 15 | 17 | +2 |
| org_approval_setting | 1 | 1 | 0 |
| audit_event | 1648 | 1687 | +39 |
| session | 409 | 428 | +19 |
| local_simulation_receipt | 6 | 6 | 0 |

増分は、エンジンごとの合成ルール1件(作成・有効化・無効化)と、ルールの結び付け・公開・非公開、プロフィール設定/解除、ログイン、片付けの画面操作で説明できる。申請・チケット・カタログ項目・部署・部署長・プロフィール行は増えていない。

#### 片付けの確認

- `org_approval_setting.rule_routing_enabled` は **false**(有効な組織0件)。
- 有効な `ui016b-syn-` ルールは **0件**。今回追加した2件はどちらも `active=false`。
- 有効な `UI016B-SYN-` 部署は **0件**、終了していない合成部署長は **0件**。
- 主部署または上長に値の入った `org_member_profile` は **0件**。
- 合成カタログ項目2件は **非公開**、下書きに承認ルールの参照は残っていない。合成申請2件は `completed` のまま。
- 片付けは、Chromium の完了時、WebKit の最初の実行が停止した時、読み取り専用の完了時のいずれも、最初に組織でのルールの使用を無効へ戻す手順から実行した。

#### §7 への影響

- 段階Bで ⚠️ としていた「解決不能フォーム(手順8)のブラウザ確認」は、両エンジンで解消した。
- 「他組織の利用者による他人宛て詳細URLの404」も両エンジンで確認した。
- §7 の受入基準はすべて充足。未解決のCritical/Highはない。

#### 未解決事項

- 1440px の申請画面2枚は、経路セクションが画面下部に写る構図で、無効な送信ボタンは375pxの画像で確認している(検査自体は両エンジン・両幅でDOMとaxeを実行済み)。
- 承認待ち一覧は、新規申請を作らない制約により空表示である。`approver` ロールを持たない利用者に絞り込みが見えることはDOMで確認した。

#### Evidence

`evidence/WP-P4-APR-016/20261114-0949/`(README、`browser/chromium/`、`browser/webkit/`、各 `summary.json`、スクリーンショット、axe結果、`counts-before.json`、`counts-after.json`)。
