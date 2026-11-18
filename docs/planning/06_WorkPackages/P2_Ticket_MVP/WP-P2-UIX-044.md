---
project: SOLVI
doc_id: "WP-P2-UIX-044"
title: "UI v2のアプリシェルとデザイントークン(薄いブルーの左サイドバー)"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-11-18"
updated: "2026-11-18"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "ui"]
source_of_truth: true
implementation_status: "not-started"
story_points: 8
risk: "medium"
workstream: "UIX"
phase: "P2"
requirement_ids: ["NFR-UX-001", "NFR-UX-002", "NFR-UX-003", "NFR-UX-004"]
depends_on: ["WP-P2-UIX-025", "WP-P2-UIX-030", "WP-P2-UIX-043", "WP-P2-SEC-025"]
---

# WP-P2-UIX-044: UI v2のアプリシェルとデザイントークン(薄いブルーの左サイドバー)

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | UIX |
| Risk | medium |
| Story Points | 8 |
| Suggested Owner | Frontend + Product Owner |
| Parallelizable | No(全画面の共通部分に触れる。UIX-045 / 046 の前提) |
| Gate | Gate A |

## 1. Purpose

[[WP-P2-UIX-025]] で作ったFreshservice準拠のシェル(64pxアイコンレール+フライアウト)を、UI v2のシェルへ置き換える。
**既存のAPI・認可・状態機械・監査は変えない。** 変えるのはシェルの構造とデザイントークンだけである。

UI v2の要点:

- 左サイドバーは幅256pxのテキストメニュー。件数を併記する。配色は**薄いブルー**で、SOLVIを識別する色とする。
- 本文は白を基調にし、影を使わない。区切りは1pxの線とする。角丸は6/8/10pxの3段階。
- 上部バーは高さ56pxで、現在地・日付・検索(⌘K)・主ボタン(新規チケット)を置く。
- ライト/ダークの両テーマを持つ。

画面ごとの情報配置は後続WPで行う。ホームは [[WP-P2-UIX-045]]、チケット一覧・詳細は [[WP-P2-UIX-046]] が担当する。

## 2. Requirement IDs

`NFR-UX-001`, `NFR-UX-002`, `NFR-UX-003`, `NFR-UX-004`

## 3. Dependencies

[[WP-P2-UIX-025]], [[WP-P2-UIX-030]], [[WP-P2-UIX-043]], [[WP-P2-SEC-025]]

- 依存WPはすべてbaselineかつ実装済み(着手時に再確認する)。
- [[WP-P2-SEC-025]] のCSP(nonce方式・強制モード)を前提にする。**外部フォント・外部CSSは読み込まない**。
- [[11.3_Design_System]] がbaselineになっていること(トークンの正本)。

## 4. Scope / Allowed Paths

- `apps/web/src/app/layout.tsx`
- `apps/web/src/app/globals.css`
- `apps/web/src/app/freshservice.css`
- `apps/web/src/components/AppShell.tsx`
- `apps/web/src/components/AppFrame.tsx`
- `apps/web/src/components/FreshserviceIcon.tsx`
- `apps/web/src/components/ThemeToggle.tsx`(新規)
- `apps/web/src/lib/navigation-groups.ts`
- `tests/unit/navigation-ui.test.ts`
- `tests/unit/ui-contrast-and-focus.test.ts`
- `tests/unit/notification-preference-ui.test.ts`
- `tests/unit/notification-list-ui.test.ts`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-044.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/11_UI_UX/11.13_Mockup_Asset_Index.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-UIX-044/`

`freshservice.css` のファイル名は変えない。名前を変えると、既存テストとimportの差分が本WPの目的と関係なく膨らむためである。改名は別WPで扱う。

## 5. Out of Scope

- API、DB、Migration、認可、RLS、監査、Outbox、Worker、Executor、AIの変更
- ホーム、チケット一覧、チケット詳細の情報配置の変更(UIX-045 / 046)
- 新規npm依存の追加。Webフォントの読み込みも含む
- テーマ設定のサーバー保存(プロフィールAPIへの項目追加)
- 担当グループごとの件数表示(グループ数ぶんのAPI呼び出しが増えるため。§14で決定)
- 他社製品(参考にしたデザインの製品を含む)のロゴ・名称・画像の複製

## 6. Deliverables

- デザイントークンをCSS変数として定義する(ライト/ダーク)。値は [[11.3_Design_System]] による
- 左サイドバー(256px、薄いブルー、ロール別表示、件数バッジ)
- 上部バー(56px、現在地、日付、検索、新規チケット、通知、ユーザーメニュー)
- テーマ切替(ライト/ダーク。初期値はOS設定に従う)
- 800px以下の幅では、サイドバーをメニューボタンで開閉する(UIX-030の挙動を維持)
- 変更前後のスクリーンショットとaxeの結果をEvidenceに保存

### 6.1 デザイントークン

トークンの正本は [[11.3_Design_System]] とする(色は§4、文字は§5、寸法は§6、テーマ切替は§7)。本WPは値を書き写さず、トークン名で参照する。
見た目の見本は `assets/ui/SOLVI_UI_v2_Mockup.html` とする。

## 7. Acceptance Criteria

- [ ] ログイン後の全画面で、左に幅256pxのサイドバー、上に高さ56pxの上部バーが出る。64pxのアイコンレールとフライアウトは出ない。
- [ ] サイドバーの背景・境界・現在地・文字色が [[11.3_Design_System]] §4 の `--side-*` の値と一致する(ライト/ダークとも)。
- [ ] サイドバーの項目はロールで絞る。絞り方は現行の `buildNavigationGroups` と同じにする。requesterには管理・チケット対応が出ず、agent以上にはチケット対応・資産・変更が出る。
- [ ] 現在地の項目に `aria-current="page"` が付く。すべての項目にTabで到達できる。
- [ ] 業務受信箱・自分の担当・解決期限超過の件数を表示する。件数は既存の `api.inbox` と `api.ticketOverview` から取り、1画面あたりの追加呼び出しは2回以内に抑える。取得に失敗したら件数を出さず、エラーにもしない。
- [ ] 上部バーに、現在地・操作中の組織・検索・新規チケット・通知・ユーザーメニューが出る。検索の送信先は従来どおり(staffは `/ops?q=`、requesterは `/knowledge?q=`)。
- [ ] テーマ切替で、ライト/ダークがアプリシェルとトークンを使う部分に効く(各画面のCSS Modulesの固定色は対象外)。初期値はOS設定に従う。選んだテーマはブラウザの保存領域に残し、読み書きに失敗しても表示は壊れない。
- [ ] テーマの初期化にインラインスクリプトを使う場合は、[[WP-P2-SEC-025]] のnonceを付ける。CSPを緩めない。
- [ ] 本文・補足文字・サイドバーの文字は、両テーマでWCAG 2.2 AAのコントラスト比(4.5:1)を満たす。`ui-contrast-and-focus` テストで検査する。
- [ ] 800px以下の幅では、サイドバーが初期状態で閉じる。メニューボタンで開閉でき、開いた状態でも全リンクにキーボードで到達できる。
- [ ] ログイン、組織選択、ログアウト、組織切り替えが従来どおり動く。
- [ ] 既存の全ルート(`/inbox`, `/ops`, `/ops/overview`, `/portal`, `/knowledge`, `/catalog`, `/requests`, `/assets`, `/changes`, `/settings/notifications`, 管理画面)を表示できる。
- [ ] `npm run typecheck`、`npm run lint`、`npm run check:all`、§4のテストが通る。
- [ ] axeで、ログイン・`/inbox`・`/ops`・チケット詳細の4画面を両テーマで検査し、serious/criticalの違反がない。
- [ ] API・DB・Migrationの変更がない。

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-12(主要導線のE2E): ログイン→組織選択→受信箱→チケット詳細の表示
- TL-13(アクセシビリティ): axeで主要4画面を両テーマで検査
- 既存のunit/integration/securityテスト(表示層だけの変更で回帰がないこと)

### Evidence

`evidence/WP-P2-UIX-044/<YYYYMMDD-HHMM>/` に次を保存する。

- 変更前後の `/inbox`、`/ops`、チケット詳細、`/portal`(1440×900と375×812、ライト/ダーク)
- 実行した検証コマンドと結果
- axeのJSONとサマリ
- コントラスト比の一覧([[11.3_Design_System]] §4の文字色と背景色の組み合わせ)

## 9. Security and Audit

- 表示層だけの変更。API認可・RLS・監査イベント・Secretの扱いは変えない。
- サイドバーに項目を出さないことを認可の代わりにしない(既存方針のとおり)。
- CSPは [[WP-P2-SEC-025]] の強制モードを維持する。外部オリジン(フォント・CDN)を足さない。
- テーマ設定はブラウザに保存する表示上の好みだけにする。個人情報・トークンは保存しない。
- Evidenceには実データ・実PII・Cookie・トークンを含めない。

## 10. Rollback / 失敗時の扱い

Migrationはない。`AppFrame.tsx` / `freshservice.css` / `navigation-groups.ts` をUIX-043完了時点に戻せば、旧シェルに戻る。
`ThemeToggle.tsx` を削除し、`layout.tsx` の参照を外す。DB・APIには影響しない。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。WP-P2-UIX-044だけを実装してください。

正本:
1. AGENTS.md
2. 本WP(特に§7)
3. docs/planning/11_UI_UX/11.3_Design_System.md(トークンの正本)
4. NFR-UX-001〜004(03.13)
5. docs/planning/assets/ui/SOLVI_UI_v2_Mockup.html(見た目の見本。データはすべて架空)
6. 既存のapps/web実装

やること:
- freshservice.css のトークンを11.3 §4の値に置き換え、ライト/ダークの両方を定義する。
- AppFrame を、256pxの左サイドバー+56pxの上部バーの構成に変える。
- navigation-groups.ts のロール別の絞り込みは保ったまま、テキストメニューと件数の形にする。
- 件数は api.inbox と api.ticketOverview だけから取る。失敗したら件数を出さない。
- ThemeToggle を追加する。初期値はOS設定、保存はブラウザ。CSPのnonceを守る。
- モバイル幅の開閉(UIX-030)を維持する。
- 主要4画面のスクリーンショット(両テーマ)とaxe結果をEvidenceへ保存する。

やってはいけないこと:
- API/DB/Migration/認可/監査の変更
- 外部フォント・外部CSS・新規npm依存の追加
- CSPを緩めること
- 担当グループ別の件数表示(本WPの範囲外)
- 他社製品のロゴ・名称・画像の複製

完了報告:
- 変更ファイル一覧
- 実行した検証コマンドと結果
- §7の各項目の充足状況
- セキュリティ影響
- 未解決事項
- Evidenceの保存先
```

## 12. Definition of Done

- [ ] §7 Acceptance Criteriaをすべて満たす
- [ ] §8のテストが通り、Evidenceを保存した
- [ ] Migrationがない(表示層だけ)ことを確認した
- [ ] 関連ドキュメント(WP台帳、RTM、Dependency Map、Mockup Asset Index、MANIFEST)を更新した
- [ ] 未解決のCritical/Highがない
- [ ] Product Ownerの承認を得た
- [ ] Execution Logへ結果を追記した

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-11-18 | Claude | - | Draft | `assets/ui/SOLVI_UI_v2_Mockup.html` | Product OwnerよりUI v2(薄いブルーの左サイドバー)の依頼。モックアップを作成し、WP案を起草した。 |
| 2026-11-18 | Product Owner | - | Baseline | - | 未決事項の決定を反映し、baselineとして承認。 |

## 14. 決定事項(2026-11-18 Product Owner)

- **テーマの保存先**: ブラウザに保存する(端末ごと)。サーバー保存は行わない。
- **担当グループ別の件数**: 出さない。サイドバーにはグループ名だけを出す。
- **ダークテーマの適用範囲**: アプリシェルとトークンを使う部分だけ。各画面のCSS Modulesの固定色は後続WPで置き換える。
- **トークンの正本**: [[11.3_Design_System]] に書き写し、本WPと同時にbaselineにする。
