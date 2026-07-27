## Work Package

<!-- 例: [WP-P1-DATA-002] Organization/User/Role schemaとRLS -->

- WP ID:
- 正本: `docs/planning/06_WorkPackages/<Phase>/<WP-ID>.md`
- Closes: <!-- 該当WPの最後のPRのみ #Issue番号を書く -->

## Acceptance Criteria の充足状況

<!-- WPの§7を貼り、各項目に証拠(テスト名・コマンド・出力)を添える -->

- [ ]

## 変更内容

-

## Migration

- [ ] スキーマ変更なし
- [ ] スキーマ変更あり → up/down の内容、ロールバック手順、既存データ互換の説明:

## 検証

```
# 実行したコマンドと結果をそのまま貼る
```

## セキュリティ影響

<!-- 影響がない場合も「なし」と明記する。AGENTS.md §3 -->

- 認可・境界への影響:
- Secretの取り扱い:
- 監査イベント:
- 該当する脅威ID(docs/planning/02_Architecture/02.14_Threat_Model.md):

## UI変更

- [ ] UI変更なし
- [ ] UI変更あり → スクリーンショット / axe実行結果を添付(AGENTS.md §1.15)

## Evidence

- 保存先: `evidence/<WP-ID>/<YYYYMMDD-HHMM>/`

## チェック

- [ ] §4 Allowed Paths の外を変更していない
- [ ] 新規依存パッケージを追加していない(追加した場合は理由・代替案・ライセンスを記載)
- [ ] 失敗テストのskip/削除をしていない
- [ ] 一時的な検証バイパス(認可・RLS・署名検証)をコードに残していない
- [ ] `status: draft` の文書を根拠にしていない
