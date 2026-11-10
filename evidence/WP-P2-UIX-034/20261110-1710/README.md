# WP-P2-UIX-034 実行記録

- 日付: 2026-11-10
- ブランチ: `wp/WP-P2-UIX-034`
- 対象: サポートシェルの適用をロール基準に修正
- 変更範囲: `apps/web/src/components/AppFrame.tsx` のみ

## 1. 原因

WP-P2-UIX-033では、サポートシェルの適用をURLのパスだけで判定していた。
そのため、`org_admin` が管理者ダッシュボードの左レールから
`/knowledge` や `/catalog` を開いても、依頼者と同じサポートUIになった。

## 2. 修正

サポートシェルの条件を「サポート対象パス かつ スタッフではない」に変更した。

```ts
if (pathname === '/portal' || (isSupportPath(pathname) && !staff)) {
  return <SupportFrame>...</SupportFrame>;
}
```

- `/portal` はスタッフ・依頼者ともサポートポータルホーム。
- スタッフ(`agent`, `org_admin`, `platform_admin`)は、同じURLでもエージェントUI。
- 依頼者(`requester` などスタッフ以外)はサポートUI。
- `/catalog/manage`, `/knowledge/new`, `/inbox`, `/ops` は従来どおりエージェントUI。

## 3. 検証結果

### org_admin

| 画面 | 左レール | サポートヘッダー |
|---|---:|---:|
| `/knowledge` | 1 | 0 |
| `/catalog` | 1 | 0 |
| `/tickets/new` | 1 | 0 |
| `/tickets/{id}` | 1 | 0 |
| `/requests` | 1 | 0 |
| `/settings/notifications` | 1 | 0 |
| `/portal` | 0 | 1 |

左レールからの実操作:

| 操作 | 左レール | サポートヘッダー | タイトル |
|---|---:|---:|---|
| 左レール「ナレッジ」 | 1 | 0 | ナレッジを探す |
| 左レール「サービスカタログ」 | 1 | 0 | サービスカタログ |

### requester

| 画面 | 左レール | サポートヘッダー |
|---|---:|---:|
| `/knowledge` | 0 | 1 |
| `/catalog` | 0 | 1 |
| `/tickets/new` | 0 | 1 |
| `/tickets/{id}` | 0 | 1 |
| `/requests` | 0 | 1 |
| `/settings/notifications` | 0 | 1 |
| `/portal` | 0 | 1 |

- axe: 上記すべて違反0
- `npm run typecheck` / `npm run lint` / `npm run check:all` 成功

## 4. セキュリティ影響

なし。表示層のみで、API・DB・認可・監査の変更はない。
ロール判定は既存の `navigationRoles` の `staff` を使用している。

## 5. 残課題

- `/assets` はサポートシェル対象外。
- 管理・編集画面(`/catalog/manage`, `/knowledge/new`)はエージェントUIのまま。
- サポートポータルの横断検索は未実装。

## 6. Evidence一覧

- `admin-knowledge.png` / `admin-catalog.png`: org_adminのエージェントUI
- `admin-rail-knowledge.png` / `admin-rail-catalog.png`: 左レールからの実操作
- `requester-knowledge.png` / `requester-catalog.png`: requesterのサポートUI
- `requester-*.png`: その他サブ画面
- `summary.json`: ロール別のレール/ヘッダー/axe
- `run.log`: 実行ログ
