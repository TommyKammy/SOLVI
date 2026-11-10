# WP-P2-UIX-035 実行記録

- 日付: 2026-11-10
- ブランチ: `wp/WP-P2-UIX-035`
- 対象: 左レールのナレッジ現在地判定を修正
- 変更範囲: `apps/web/src/components/AppFrame.tsx` のみ

## 1. 原因

`ナレッジ管理` の現在地判定が `matchPath: '/knowledge'` で、
`ナレッジ検索` と同じパスを見ていた。さらに判定が `usePathname()` だけを
使っていたため、`?manage=1` の有無を区別できず、両方に
`aria-current="page"` が付いていた。

修正前の実測:

```text
/knowledge           検索=page(青) / 管理=page(青)
/knowledge?manage=1  検索=page(青) / 管理=page(青)
```

## 2. 修正

- 現在地判定を「パス + クエリ」に変更した(`useSearchParams`)。
- `matchPath` はパスの上書きだけに限定し、クエリは `href` から引き継ぐ。
- 同じパスが複数一致する場合は、クエリが多い項目を優先する。
- フライアウトの選択中表示は、解決済みの現在項目と一致する1件だけにした。

```ts
// パスが長いほど、クエリが多いほど「今ここ」として優先する。
// 例: /knowledge?manage=1 では「ナレッジ検索」より「ナレッジ管理」。
```

## 3. 検証結果

すべて `org_admin` で確認。選択中は `aria-current="page"` かつ青背景
`rgb(232, 241, 255)`。

| 画面 | 選択中の項目 |
|---|---|
| `/knowledge` | ナレッジ検索 |
| `/knowledge?manage=1` | ナレッジ管理 |
| `/knowledge/{id}` | ナレッジ検索 |
| `/knowledge/{id}?manage=1` | ナレッジ管理 |
| `/knowledge/new` | 記事を作成 |

他グループの回帰確認:

| 画面 | 選択中の項目 |
|---|---|
| `/inbox` | 業務受信箱 |
| `/ops` | チケット対応 |
| `/catalog` | サービスカタログ |
| `/catalog/manage` | カタログ管理 |
| `/assets` | 資産台帳 |
| `/changes` | 変更管理 |
| `/ops/admin` | 管理ホーム |
| `/requests` | 申請状況 |

- axe: 上記13画面すべて違反0
- モバイル(375×812): ナレッジ管理のみ選択中、`bodyWidth=375`
- 依頼者はサポートシェルのため左レールのフライアウト対象外
- `npm run typecheck` / `npm run lint` / `npm run check:all` 成功

## 4. セキュリティ影響

なし。表示層のみで、API・DB・認可・監査の変更はない。

## 5. 残課題

なし。

## 6. Evidence一覧

- `knowledge-search.png` / `knowledge-manage.png`: ナレッジ検索・管理
- `knowledge-article.png` / `knowledge-article-manage.png`: 記事詳細
- `knowledge-new.png`: 記事作成
- `inbox.png` / `ops.png` / `catalog.png` / `catalog-manage.png` など: 他グループの回帰確認
- `mobile-knowledge-manage.png`: モバイル
- `summary.json`: 各画面の選択中項目とaxe
- `run.log`: 実行ログ
