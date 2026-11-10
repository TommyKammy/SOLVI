---
project: SOLVI
doc_id: "WP-P2-UIX-025"
title: "Freshservice準拠のアプリシェルと共通UI基盤"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-11-10"
updated: "2026-11-10"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "ui"]
source_of_truth: true
implementation_status: "done"
story_points: 8
risk: "medium"
workstream: "UIX"
phase: "P2"
requirement_ids: ["NFR-UX-001", "NFR-UX-002", "NFR-UX-003", "NFR-UX-004"]
depends_on: ["WP-P2-OPSUI-010", "WP-P2-PORTAL-002", "WP-P2-UISTATE-018"]
---

# WP-P2-UIX-025: Freshservice準拠のアプリシェルと共通UI基盤

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | UIX |
| Risk | medium |
| Story Points | 8 |
| Suggested Owner | Frontend + Product Owner |
| Parallelizable | No(既存画面の共通部分に触れる) |
| Gate | Gate A |

## 1. Purpose

Freshservice(本番)のエージェント向けUIを、**既存のAPI・認可・状態機械・監査を変えずに**SOLVIへ移植するための共通基盤を作る。
本WPでは全画面に効くアプリシェル(左アイコンレール、上部バー、コンテンツ面)とデザイントークン、共通部品の見た目を整える。
画面ごとの情報配置(ダッシュボード、チケット一覧の右フィルタ、詳細の右プロパティ等)は後続WPで行う。

## 2. Requirement IDs

`NFR-UX-001`, `NFR-UX-002`, `NFR-UX-003`, `NFR-UX-004`

## 3. Dependencies

[[WP-P2-OPSUI-010]], [[WP-P2-PORTAL-002]], [[WP-P2-UISTATE-018]]

依存WPはすべてbaselineかつ実装済み。本WPは表示層だけを変更し、APIとDBには触れない。

## 4. Scope / Allowed Paths

- `apps/web/src/app/layout.tsx`
- `apps/web/src/app/globals.css`
- `apps/web/src/app/freshservice.css`
- `apps/web/src/components/AppShell.tsx`
- `apps/web/src/components/AppFrame.tsx`
- `apps/web/src/components/FreshserviceIcon.tsx`
- `apps/web/src/lib/navigation-groups.ts`
- `tests/unit/notification-preference-ui.test.ts`
- `tests/unit/notification-list-ui.test.ts`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-025.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-UIX-025/`

## 5. Out of Scope

- API、DB、認可、監査、Outbox、Worker、Executor、AIの変更
- 画面ごとの情報配置の再設計(後続WP)
- Freshworksのロゴ・画像・イラスト・フォントファイルの複製
- Freshserviceにのみ存在する機能(問題、リリース、プロジェクト、購買、クラウド、ソフトウェア、契約)のメニュー追加
- 新規npm依存の追加
- 実データ・実PIIのEvidenceへの保存

## 6. Deliverables

- Freshserviceのライトテーマに合わせたデザイントークン(`freshservice.css`)
- 左アイコンレール(ロール別表示、ホバー/フォーカスで開くフライアウト)
- 上部バー(現在地、組織、検索、作成、通知、ユーザーメニュー)
- 未ログイン時の公開ヘッダーとログイン/組織選択カード
- モバイル幅でレールを開閉できるメニュー
- 既存ページが新しいシェル内で表示されることのスクリーンショットEvidence

## 7. Acceptance Criteria

- [ ] ログイン済みの全画面で、左に64pxのアイコンレール、上に64pxの上部バーが表示される。横並びのテキストナビは表示されない。
- [ ] レールの項目はロールで絞られる。requesterは管理・チケット対応を表示せず、agent以上はチケット対応・資産・変更を表示する。
- [ ] レールの各項目はTabで到達でき、ホバーまたはフォーカスでフライアウトが開く。`aria-current="page"`が現在地に付く。
- [ ] 上部バーに現在地、操作中の組織、検索、作成、通知、ユーザーメニューが表示され、検索はstaffでは`/ops?q=`、requesterでは`/knowledge?q=`へ送信される。
- [ ] 800px以下の幅ではレールが初期状態で閉じ、上部バーのメニューボタンで開閉できる。開いた状態でも全リンクへキーボードで到達できる。
- [ ] ログイン、組織選択、ログアウト、組織切り替えが従来どおり動作する。
- [ ] 既存の全ルート(`/inbox`, `/ops`, `/ops/overview`, `/portal`, `/knowledge`, `/catalog`, `/requests`, `/assets`, `/changes`, `/settings/notifications`, 管理画面)が表示できる。
- [ ] `npm run typecheck`、`npm run lint`、`npm run check:all`、シェルに関係する単体テスト(`notification-preference-ui` / `notification-list-ui`)が通る。全`npm test`はこのスナップショットではworkspace側にテストが無く失敗するため、品質ゲートには使わない(既知)。
- [ ] axeでログイン、`/inbox`、`/ops`、チケット詳細の4画面にserious/criticalの違反がない。
- [ ] 変更前後のスクリーンショットをEvidenceへ保存し、参照したFreshservice画面と対応づける。
- [ ] API・DB・Migrationの変更がない。

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-12(主要導線のE2E): ログイン→組織選択→受信箱→チケット詳細→返信画面の表示
- TL-13(アクセシビリティ): axeによる主要4画面の検査
- 既存のunit/integration/securityテスト(表示層のみの変更で回帰がないこと)

### Evidence

- `evidence/WP-P2-UIX-025/<YYYYMMDD-HHMM>/`へ保存する。
- 変更前のSOLVI画面(`/inbox`, `/ops`, チケット詳細, `/portal`)
- 変更後の同画面(1440×900、モバイル375×812)
- 参照したFreshservice本番画面のスクリーンショット(個人情報・実データを含む場合はマスク)
- 実行した検証コマンドと結果
- axeのJSON/サマリ

## 9. Security and Audit

- 表示層のみ。API認可・RLS・監査イベント・Secretの扱いを変更しない。
- Freshservice本番は**読み取り専用**で調査する。入力・保存・削除・設定変更を行わない。
- Evidenceには実データ・実PII・Cookie・トークンを含めない。画面撮影は合成データのSOLVI画面を基本とし、Freshservice画面は必要最小限かつマスクする。
- ユーザーメニューからログアウトする既存経路を維持する。

## 10. Rollback / 失敗時の扱い

Migrationなし。`layout.tsx`の`AppShell`利用と`freshservice.css`のimportを戻し、旧`SiteHeader`へ戻すだけでロールバックできる。
CSSのみの変更なのでDB・APIへの影響はない。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。WP-P2-UIX-025だけを実装してください。

正本:
1. AGENTS.md
2. 本WP
3. NFR-UX-001〜004(03.13)
4. 既存のapps/web実装

参照:
- Freshservice本番のライトテーマ(左64pxレール、上部64pxバー、白いコンテンツ面、#276cf0、#12334c、#eaeef2、Inter/14px)
- 既存のSOLVIルートとAPI。ルート名・API・認可は変えない。

やること:
- AppShell/AppFrame/FreshserviceIconを追加し、layout.tsxから使う。
- 左レールはロール別。フライアウトはhoverとfocus-withinで開く。
- 上部バーに現在地、組織、検索、作成、通知、ユーザーメニューを置く。
- freshservice.cssで既存クラスを上書きし、全画面の見た目を揃える。
- モバイル幅の開閉を入れる。
- 主要4画面のスクリーンショットとaxe結果をEvidenceへ保存する。

やってはいけないこと:
- API/DB/Migration/認可/監査の変更
- Freshworksのロゴ・画像・イラストの複製
- Freshserviceにしかない機能のメニュー追加
- 新規npm依存の追加
- 実データ・PII・SecretのEvidence保存

完了報告:
- 変更ファイル一覧
- 実行した検証コマンドと結果
- §7の各項目の充足状況
- セキュリティ影響(なし)
- 未解決事項
- Evidenceの保存先
```

## 12. Definition of Done

- [ ] §7 Acceptance Criteriaをすべて満たす
- [ ] §8のテストが通り、Evidenceを保存した
- [ ] Migrationなし(表示層のみ)を確認した
- [ ] 関連ドキュメント(WP台帳、RTM、Dependency Map、MANIFEST)を更新した
- [ ] 未解決のCritical/Highがない
- [ ] Product Ownerの承認を得た(2026-11-10 移植依頼)
- [ ] Execution Logへ結果を追記した

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-11-10 | Codex | - | Done | `evidence/WP-P2-UIX-025/20261110-1235/` | Product OwnerよりFreshservice UI移植の依頼。本番は読み取り専用。 |

### 2026-11-10 の実行結果

- 変更ファイル:
  - `apps/web/src/app/layout.tsx`
  - `apps/web/src/app/freshservice.css`(新規)
  - `apps/web/src/components/AppShell.tsx`(新規)
  - `apps/web/src/components/AppFrame.tsx`(新規)
  - `apps/web/src/components/FreshserviceIcon.tsx`(新規)
  - `apps/web/src/lib/navigation-groups.ts`(新規)
  - `tests/unit/notification-preference-ui.test.ts`
  - `tests/unit/notification-list-ui.test.ts`
  - `apps/web/src/components/SiteHeader.tsx` / `AppNavigation.tsx`(新シェルへ置換したため削除)
- Migration: なし(表示層のみ)。DBスキーマ・API・認可・監査の変更なし。
- 検証:
  - `npm run typecheck` 成功
  - `npm run lint` 成功
  - `npm run check:all` 成功
  - `npx vitest run tests/unit/notification-preference-ui.test.ts tests/unit/notification-list-ui.test.ts` 成功(92件)
  - axe: `/login`, `/inbox`, `/ops`, `/ops/{ticket}` の4画面で違反0
- 既知の失敗(本WPに起因しない):
  - `npm test` はworkspace側にテストファイルが無く失敗
  - `npm run test:unit` は32件失敗(UIと無関係な既存失敗)
  - `npm run test:security` はMinIO/ClamAV/テストDB前提が揃わず9件失敗・555件skip
- セキュリティ影響: なし。Freshservice本番は読み取り専用。Evidenceに実PII/Secretなし。
- 未解決事項: 画面ごとの詳細レイアウト、ダッシュボードのチャート、氏名表示のためのAPI追加は後続WP。
- Rollback: `layout.tsx` の `AppShell` 利用と `freshservice.css` の import を戻し、旧シェルを復元する。DB変更なし。
