---
project: SOLVI
doc_id: "WP-P2-UIX-044"
title: "UI v2のアプリシェルとデザイントークン(薄いブルーの左サイドバー)"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.2.0"
created: "2026-11-18"
updated: "2026-11-18"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "ui"]
source_of_truth: true
implementation_status: "done"
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

- [x] §7 Acceptance Criteriaをすべて満たす
- [x] §8のテストが通り、Evidenceを保存した
- [x] Migrationがない(表示層だけ)ことを確認した
- [x] 関連ドキュメント(WP台帳、RTM、Dependency Map、Mockup Asset Index、MANIFEST)を更新した
- [x] 未解決のCritical/Highがない
- [x] Product Ownerの承認を得た
- [x] Execution Logへ結果を追記した

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-11-18 | Claude | - | Draft | `assets/ui/SOLVI_UI_v2_Mockup.html` | Product OwnerよりUI v2(薄いブルーの左サイドバー)の依頼。モックアップを作成し、WP案を起草した。 |
| 2026-11-18 | Product Owner | - | Baseline | - | 未決事項の決定を反映し、baselineとして承認。 |
| 2026-11-18 | Codex | - | Review | `evidence/WP-P2-UIX-044/20261118-1310/` | UI v2のシェル・トークン・テーマ切替を実装。§7の検証はすべて成功(axe 20スキャンで違反0)。Product Ownerの承認待ち。 |
| 2026-11-18 | Codex | - | Review fix | `evidence/WP-P2-UIX-044/20261118-1310/logs/review-fix.txt` | レビュー指摘2件を修正: 「自分の担当」「解決期限超過」のリンクを`operationsMetricQuery`から生成して件数条件(未完了全体)と一致させ、サイドバー件数をホバー・フォーカス・現在地で`--side-ink`にしてコントラスト検査を追加。 |

### 2026-11-18 実装結果(Review)

#### 変更ファイル

- `apps/web/src/app/layout.tsx` — テーマ初期化スクリプトを追加。CSPのnonceをリクエストヘッダーから読み、nonceが無いときはスクリプトを出さない。
- `apps/web/src/app/globals.css` — 既存のグローバル色トークンをUI v2のトークンへ委譲(本文・補足・境界・アクセント・状態色)。ダークテーマで固定色が残らないようにした。
- `apps/web/src/app/freshservice.css` — 11.3 §4のトークンを`light-dark()`で定義(ライト/ダーク)。256px左サイドバー・56px上部バー・テーマ切替のスタイルを追加し、64pxアイコンレールとフライアウトのスタイルを削除。影を廃止し、角丸を6/8/10pxに統一。
- `apps/web/src/components/AppShell.tsx` — `api.inbox`と`api.ticketOverview`から件数を取得(1画面あたり最大2回、`Promise.allSettled`で失敗を握りつぶさず件数だけ省略)。上部バーの日付をサーバーで生成。
- `apps/web/src/components/AppFrame.tsx` — 256pxテキストサイドバー+56px上部バーへ変更。`aria-current`、Tab到達性、モバイル開閉(UIX-030のフォーカス移動・`inert`・Escape)を維持。`state`の重複クエリでも現在地判定できるよう修正。
- `apps/web/src/components/ThemeToggle.tsx`(新規) — OS設定を初期値にし、選択を`localStorage`へ保存。読み書き失敗時も表示を壊さない。サーバー保存なし。
- `apps/web/src/lib/navigation-groups.ts` — ロール別絞り込みを維持したまま、`自分の担当`・`解決期限超過`の項目と件数を追加。件数は`api.inbox`と`api.ticketOverview`だけから取り、担当グループ別の件数は出さない。
- `tests/unit/navigation-ui.test.ts` — 件数・ロール絞り込み・失敗時の非表示・0件の非強調を追加。
- `tests/unit/ui-contrast-and-focus.test.ts` — 11.3 §4の全トークン値、両テーマのコントラスト、`light-dark()`の定義、56px/256px、モバイルの非表示、CSP nonce、テーマ保存を検査。
- `tests/unit/notification-preference-ui.test.ts` / `tests/unit/notification-list-ui.test.ts` — シェルが件数APIを呼ぶためのモックを追加(件数失敗時も既存の通知表示が壊れないこと)。
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-044.md` — 本ログ。`implementation_status: review`。
- `docs/planning/MANIFEST.md` — 本WPの更新に伴うハッシュ再生成。
- `evidence/WP-P2-UIX-044/20261118-1310/` — 実画面のスクリーンショット、axe、検証ログ、コントラスト一覧。

#### Migration

- なし。DBスキーマ・API・認可・RLS・監査・Outbox・Worker・Executor・AIは変更していない。
- ロールバック: `AppFrame.tsx` / `freshservice.css` / `navigation-groups.ts` / `globals.css` をUIX-043完了時点に戻し、`ThemeToggle.tsx`を削除して`layout.tsx`の参照とテーマ初期化スクリプトを外す。DB・APIへの影響はない。

#### 実行した検証コマンドと結果

```text
npm run typecheck
  -> 成功(全workspace)

npm run lint
  -> 失敗: 3 errors。すべて `.claude/worktrees/*/apps/web/next-env.d.ts`(git管理外の
     ローカルworktree)の triple-slash-reference。本WPの変更ファイルではない。
     `git ls-files` の追跡対象だけを `eslint --max-warnings=0 --no-warn-ignored` で
     検査すると成功(証拠: logs/lint-tracked-files.txt)。

npm run check:all
  -> 成功(Allowed Paths / Architecture / Images / Skips / Unwired / Traceability / WorkPackages)

npx vitest run tests/unit/navigation-ui.test.ts tests/unit/ui-contrast-and-focus.test.ts \
  tests/unit/notification-preference-ui.test.ts tests/unit/notification-list-ui.test.ts
  -> 4ファイル成功

npx vitest run tests/unit/support-portal-ui.test.ts
  -> 成功(既存のサポートポータル回帰)

npm run test:unit
  -> 116ファイル成功 / 4790 passed / 26 skipped
```

ブラウザ検証(本番ビルド、使い捨てDB `solvi_wp044_evidence_test`):

```text
node capture.mjs evidence/WP-P2-UIX-044/20261118-1310
  -> 20スキャン(5画面 × 2幅 × 2テーマ)
     axe serious/critical: 0
     axe 違反ノード合計: 0
     375pxの横はみ出し: 0
     コンソールエラー: 0
     ログインへの意図しないリダイレクト: 0
```

#### §7 Acceptance Criteriaの充足

- [x] 256pxサイドバー+56px上部バー。64pxレール/フライアウトなし。
  - 実測: `sidebarWidth: 256`, `topbarHeight: 56`, `flyoutPresent: false`。`screens/light-1440-inbox.png`。
- [x] サイドバーの背景・境界・現在地・文字色が `--side-*` と一致(両テーマ)。
  - 実測: ライト `rgb(238, 244, 252)` = `#EEF4FC`。ダークは `screens/dark-1440-inbox.png`。`ui-contrast-and-focus`で両テーマの値を検査。
- [x] ロールで絞る。requesterに管理・チケット対応を出さず、agent以上にチケット対応・資産・変更を出す。
  - `tests/unit/navigation-ui.test.ts` と既存の承認ルール・監査メニューの検査が成功。
- [x] 現在地に`aria-current="page"`。全項目にTabで到達。
  - デスクトップ: 26/26リンクに到達。クエリ付きの「自分の担当」でも現在地が一致(`queryCurrent`)。
  - モバイル: 開いた状態でも26/26リンクに到達(`openKeyboard`)。
- [x] 業務受信箱・自分の担当・解決期限超過の件数。`api.inbox`と`api.ticketOverview`だけ。追加呼び出しは最大2回。失敗時は件数を出さずエラーにしない。
  - 実測: 業務受信箱7件、自分の担当7件、解決期限超過0件。0件は強調しない。
  - 失敗時の非表示は`navigation-ui`の「両方失敗」「片方失敗」テストで確認。
- [x] 上部バーに現在地・操作中の組織・検索・新規チケット・通知・ユーザーメニュー。検索はstaff `/ops?q=`、requester `/knowledge?q=`。
  - 実測: `searchAction: "/ops"`, `newTicketHref: "/tickets/new"`, `notificationHref: "/settings/notifications"`, 組織名と日付を表示。
- [x] テーマ切替がシェルとトークンを使う部分に効く。初期値はOS。ブラウザ保存。読み書き失敗でも壊れない。
  - 実測: クリックで`data-theme=dark`・`localStorage=solvi-theme=dark`、再読込後もダーク。`localStorage`を例外にしても切替と表示が継続。
- [x] インライン初期化はCSP nonce付き。CSPを緩めない。
  - 実測: レスポンスの`script-src`は `'self' 'nonce-…' 'strict-dynamic'`。HTMLのインラインスクリプトと同一nonce。
- [x] 本文・補足・サイドバー文字が両テーマで4.5:1以上。
  - `tests/unit/ui-contrast-and-focus.test.ts` と `contrast.md`。axeのcolor-contrast違反0。
- [x] 800px以下で初期状態は閉じ、メニューボタンで開閉。開いた状態でも全リンクにキーボード到達。
  - 実測: 閉`visibility: hidden`、Tabで閉じたサイドバーに入らない、開くと閉じるボタンへフォーカス、背景`inert`、Escapeで開閉ボタンへ復帰。801pxでは表示。
- [x] ログイン・組織選択・ログアウト・組織切り替えが従来どおり。
  - `/login` 200、複数組織の合成agentで`/select-organization` 200。ログアウトフォームと組織切替リンクは既存のまま。
- [x] 既存の全ルートが表示できる。
  - `/inbox`, `/ops`, `/ops/overview`, `/portal`, `/knowledge`, `/catalog`, `/requests`, `/assets`,
    `/changes`, `/settings/notifications`, `/ops/admin`, `/ops/users`, `/ops/groups`,
    `/ops/notifications`, `/ops/access-review`, `/ops/approvals`, `/ops/approvals/changes`,
    `/ops/departments`, `/select-organization`, `/login` がすべて200(`summary.json`の`routes`)。
- [x] `npm run typecheck`、`npm run check:all`、§4のテストが通る。
  - `npm run lint`だけは上記のgit管理外worktreeで失敗。追跡対象のlintは成功。
- [x] axeでログイン・`/inbox`・`/ops`・チケット詳細の4画面を両テーマで検査し、serious/critical 0。
  - `/portal`も加えた5画面 × 2幅 × 2テーマ = 20スキャンで違反0。
- [x] API・DB・Migrationの変更がない。
  - `git status`の変更は表示層・テスト・ドキュメント・Evidenceのみ。

#### セキュリティ影響

- 表示層のみ。API認可・RLS・監査・Secretの扱いは変更していない。
- CSPはWP-P2-SEC-025の強制モードを維持。外部フォント・外部CSS・CDN・新規npm依存を追加していない。インラインスクリプトはnonce付きで、nonceが無い場合は出力しない。
- テーマ設定は`localStorage`の表示上の好みだけ。個人情報・トークン・Cookieは保存しない。
- Evidenceは合成データのみ。実データ・実PII・Cookie・トークン・パスワードを含まない。開発用DB `solvi` には接続していない。

#### 未解決事項

- **サポートポータル(`/portal`などrequesterの画面)は`SupportFrame`のまま**。WP §4のAllowed Pathsに`SupportFrame.tsx`が無く、依頼者向けセルフサービスシェルを別WPの範囲と解釈した。§7の「ログイン後の全画面」を文字どおり全画面(ポータル含む)と読む場合は、`SupportFrame`の256pxサイドバー化を別WPまたは本WPのスコープ拡張として判断してほしい。
- **サイドバーのクラス名`fs-rail`を残している**。`tests/unit/support-portal-ui.test.ts`が`class="fs-rail"`の有無を検査しており、同ファイルは§4のAllowed Paths外のため変更していない。見た目・挙動は256pxのテキストサイドバーで、64pxレールとフライアウトは存在しない。クラス名の整理は別WPで行う。
- **変更前のEvidence**: `/inbox` はHEAD時点の旧シェルを一時ディレクトリでビルドして撮り直した(`before/light-1440-inbox.png`, `before/light-375-inbox.png`)。`/ops`・チケット詳細・`/portal` はUIX-043の実画面を流用した。旧シェルにはダークテーマが無いため、ダークの変更前は無い。
- ダークテーマは§14の決定どおり、まずシェルとトークンを使う部分に適用した。各画面のCSS Modulesに残る固定色は後続WPで置き換える。今回、`globals.css`の共通トークンはUI v2へ委譲したため、多くの既存画面も追従する。
- `npm run lint`の3エラーはgit管理外の`.claude/worktrees`に起因する環境要因。追跡対象のlintは成功している。

#### Evidence

`evidence/WP-P2-UIX-044/20261118-1310/`

- `screens/` — 20スキャン(5画面 × 2幅 × 2テーマ)+ モバイルサイドバー開。
- `axe/` — 画面ごとのaxe JSON(すべて違反0)。
- `summary.json` — スキャン結果、シェル実測、キーボード、テーマ、CSP、全ルート。
- `contrast.md` — 11.3 §4の文字色/背景色のコントラスト比。
- `before/` — UIX-043時点の変更前画面(ライトのみ)。
- `logs/` — typecheck / lint / check:all / vitest / test:unit の出力。
- `capture.mjs.txt` / `run_stack.sh` — 実行スクリプトの複製。

#### 利用者の承認(2026-11-18)

- **2026-11-18、利用者(Product Owner)が PR #25(本WPの実装)をマージした**(main の `79ea3cd`)。これをProduct Ownerの承認として扱い、`done` とする。
- 先行して PR #24(UI v2のWPと [[11.3_Design_System]] のbaseline、`80c883b`)と PR #28(npm audit の期限付き例外、`f1eb703`)がマージされている。
- §7 は、Execution Log に記した範囲と未解決事項を含めて、PRのマージにより受け入れられたものとする。
- 残り: requester向けのポータル(`/portal` など `SupportFrame` の画面)は旧シェルのまま。新シェルとテーマ切替を広げるかは別WPで判断する。`fs-rail` のクラス名の整理、各画面のCSS Modulesに残る固定色のトークン化も後続WPで扱う。

## 14. 決定事項(2026-11-18 Product Owner)

- **テーマの保存先**: ブラウザに保存する(端末ごと)。サーバー保存は行わない。
- **担当グループ別の件数**: 出さない。サイドバーにはグループ名だけを出す。
- **ダークテーマの適用範囲**: アプリシェルとトークンを使う部分だけ。各画面のCSS Modulesの固定色は後続WPで置き換える。
- **トークンの正本**: [[11.3_Design_System]] に書き写し、本WPと同時にbaselineにする。

## 15. 決定事項(2026-11-18 Product Owner、done後の追記)

- **依頼者向けポータル(`SupportFrame` の画面)**: 本WPの対象外とし、UI v2のトークンとテーマ切替を広げる作業は [[WP-P2-UIX-047]] で扱う。§7の「ログイン後の全画面」は、staff向けのアプリシェル(`AppShell`)の画面と読む。
- **サイドバーの件数の文字色**: 強調行(ホバー・フォーカス・現在地)では `--side-ink` にする規則を [[11.3_Design_System]] §4 に追記した。
