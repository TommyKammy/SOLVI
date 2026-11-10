# WP-P2-UIX-025 実行記録

- 日付: 2026-11-10
- ブランチ: `wp/WP-P2-UIX-025`
- 対象: Freshservice準拠のアプリシェルと共通UI基盤
- 変更範囲: 表示層のみ(API・DB・認可・監査・Executorは未変更)

## 1. 参照したFreshservice画面(読み取り専用)

本番 (`https://ts-pharma.freshservice.com`) を、専用ChromeプロファイルとCDPで観察した。
入力・保存・削除・設定変更は行っていない。

| 画面 | URL | 参考にした点 |
|---|---|---|
| ダッシュボード | `/a/dashboard/default` | 左64pxレール、上部64pxバー、白いカード、スコアカード |
| チケット一覧 | `/a/tickets/view/unresolved` | 高密度テーブル、右フィルタパネル、空状態 |
| チケット詳細 | `/a/tickets/3548` | 左の本文+右のプロパティパネル、上部アクション |
| ナレッジ | `/a/solutions/articles/filters/all_articles` | 左カテゴリ+右テーブル |
| サービスカタログ | `/a/catalog/request-items` | 左カテゴリ+検索+カード |
| カタログ項目 | `/a/catalog/request-items/46` | 左フォーム+右サマリ+固定フッター |
| 変更 | `/a/changes/view/all` | 一覧+右フィルタ |
| 資産 | `/cmdb/items` | 一覧+右フィルタ |
| 承認 | `/a/approvals` | タブ+空状態 |
| 管理 | `/ws/2/admin/home` | 管理カードグリッド |
| 利用者ポータル | `/support/home` | ヒーロー+検索+4アクションカード |

**本番画面のスクリーンショットは、実データ・実PIIを含むためリポジトリへ保存していない。**
ローカルの `.local/captures/` にのみ保管している。

## 2. 実装したもの

- `apps/web/src/components/AppShell.tsx`
  - 認証済み/未認証/GLPIモードの分岐
  - ロール別のナビゲーション生成
  - 通知リンクを表示する前の保護APIによる権限確認(旧SiteHeaderの挙動を維持)
- `apps/web/src/components/AppFrame.tsx`
  - 左アイコンレール(64px)
  - ホバー/フォーカスで開くフライアウト
  - 上部バー(現在地、検索、作成、ヘルプ、通知、ユーザーメニュー)
  - モバイル幅の開閉(閉じるボタン、Escape、背景クリック)
- `apps/web/src/components/FreshserviceIcon.tsx`
  - SOLVI用のインラインSVG。Freshworksのアイコン素材は複製していない。
- `apps/web/src/lib/navigation-groups.ts`
  - ロール→レール項目の純粋関数。単体テスト可能。
- `apps/web/src/app/freshservice.css`
  - Freshserviceのライトテーマを参考にしたトークン
  - 既存クラス(ボタン、入力、テーブル、状態、カード、タブ、空状態)の上書き
  - 公開画面(ログイン・組織選択)のカード
  - 800px以下のモバイルレイアウト

参考にした主な値:

| 項目 | 値 |
|---|---|
| アプリ背景 | `#EFF6FF` |
| サーフェス | `#FFFFFF` |
| 本文 | `#12334C` |
| 補助文字 | `#485A68` |
| 淡い文字 | `#5F7183`(コントラスト確保のため参照値から調整) |
| 境界 | `#EAEEF2` |
| ブランド | `#276CF0` |
| 強ブランド | `#003FD2` |
| 角丸 | 8px / 12px |
| 基本文字 | 14px / 20px |
| フォント | Inter → 日本語システムフォント |

## 3. 受入基準の充足

| # | 基準 | 結果 | 証拠 |
|---|---|---|---|
| 1 | 64pxレール+64px上部バー、横並びテキストナビなし | 充足 | `agent/desktop-inbox.png`, `desktop-ops.png` |
| 2 | ロール別の表示制御 | 充足 | agent/admin のスクリーンショット、`navigation-groups` の単体テスト |
| 3 | Tab到達・hover/focusでフライアウト・aria-current | 充足 | `desktop-rail-flyout.png`, `desktop-rail-focus.png` |
| 4 | 上部バーの現在地・組織・検索・作成・通知・ユーザーメニュー | 充足 | 各デスクトップスクリーンショット |
| 5 | 800px以下でレール開閉、全リンクへキーボード到達 | 充足 | `agent/mobile-inbox.png`, `agent/mobile-menu-open.png` |
| 6 | ログイン・組織選択・ログアウト・組織切替が従来どおり | 充足 | 手動確認、`desktop-login.png` |
| 7 | 既存全ルートが表示できる | 充足 | `desktop-*.png` / `agent/desktop-*.png` |
| 8 | typecheck / lint / check:all / 関連単体テスト | 充足 | §4 |
| 9 | axeで主要4画面にserious/criticalなし | 充足 | §4、`summary.json` |
| 10 | 変更前後のスクリーンショット | 充足 | `agent/desktop-*.png`, `desktop-*.png` |
| 11 | API・DB・Migrationの変更なし | 充足 | `git diff --stat` |

## 4. 実行した検証

```sh
npm run typecheck
# 成功(全workspace)

npm run lint
# 成功(警告0)

npm run check:all
# 成功(check:paths / architecture / images / skips / unwired / traceability / workpackages)

npx vitest run tests/unit/notification-preference-ui.test.ts tests/unit/notification-list-ui.test.ts
# 成功: 2ファイル / 92テスト

SOLVI_SMOKE_PASSWORD=local-dev-password-1 node --env-file=.env tools/smoke_ticket_flow.mjs
# 成功: passed=true / INC-2026-000004 を作成
# 作成・割当・対応開始、公開返信と解決、同時更新409、越境404、
# 内部メモ非公開、再開、カーソル、DB永続化・監査を確認
```

axe(WCAG 2.2 AA)の結果:

| 画面 | 結果 |
|---|---|
| `/login` | 違反0 |
| `/inbox` | 違反0 |
| `/ops` | 違反0 |
| `/ops/{ticket}` | 違反0 |

`screenshots` と `summary.json` は本ディレクトリに保存した。

### 既知の失敗(本WPの変更に起因しない)

- `npm test` は `services/api` / `worker` / `executor` のworkspaceにテストファイルが無いため失敗する(スナップショットの既存構成)。
- `npm run test:unit` は32件失敗する(`performance-search-static-cli` など、UIと無関係な既存失敗)。
- `npm run test:security` はローカルのMinIO/ClamAV/テストDB前提が揃わず9件失敗・555件skip。
- これらは本WPの表示層変更とは独立している。UIの品質ゲートは typecheck / lint / check:all / 関連単体テスト / axe で確認した。

## 5. セキュリティ影響

- API・DB・RLS・認可・監査・Executorの変更なし。
- Freshservice本番は読み取り専用で観察。入力・保存・削除・設定変更なし。
- EvidenceにSecret・Cookie・実PIIを保存していない。
- 通知リンクは、従来どおり保護API(`api.notifications`)で現在の権限を確認してから表示する。

## 6. 残課題(後続WP)

- チケット一覧の右フィルタパネル化、チケット詳細の右プロパティパネル化。
- ダッシュボードのスコアカード+チャート化(`/ops/overview` は暫定)。
- ナレッジの左カテゴリツリー、カタログのカテゴリカード、ポータルのヒーロー検索。
- 管理画面のカードグリッド化。
- 上部バーの「作成する」を分割メニュー(障害/依頼)にする。
- ユーザーメニューに氏名・メールを出すには、セッションAPIへ表示用の最小情報を追加する必要がある(本WPではAPI変更なしのため未対応)。
- 下部のレール項目ではフライアウトが画面下端に近づく場合がある。必要なら自動反転を追加する。

## 7. Evidence一覧

- `agent/desktop-*.png`: agent(担当者)で撮影したデスクトップ画面
- `agent/mobile-*.png`: agentで撮影したモバイル画面
- `desktop-*.png`: org_adminで撮影した管理画面
- `desktop-rail-flyout.png` / `desktop-rail-focus.png`: レールのフライアウト
- `desktop-user-menu.png`: ユーザーメニュー
- `summary.json` / `agent/summary.json`: axe結果と撮影対象
- `run.log` / `agent/run.log`: 実行ログ
