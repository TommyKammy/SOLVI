# WP-P2-COLLAB-004 Evidence

- 実施日時: 2026-07-27 14:53:56 JST
- 対象: コメント・内部メモ・添付(2つの漏えい経路の遮断)

## 1. 内部メモの可視性 (FR-TKT-004)

検証: 依頼者のコメント一覧に内部メモが1件も含まれないこと。
可視性はSQLの条件(`($2::boolean OR visibility = public)`)で絞っており、
取得後のフィルタではない。フィルタを1箇所書き忘れた瞬間に漏れる実装を避けた。

| 検証 | 結果 |
|---|---|
| 依頼者の一覧に内部メモが含まれない | 通過(件数1、本文の文字列一致なし) |
| 担当者は公開・内部の両方を取得 | 通過(件数2) |
| 内部メモを直接ID指定 → 404 | 通過(存在秘匿) |
| 依頼者は内部メモを書き込めない | 通過(拒否+監査記録) |
| 内部メモのみのチケットで依頼者の取得結果が空 | 通過 |

## 2. 添付の受け入れ拒否 (FR-TKT-005 / 脅威 T-15)

許可リスト方式。以下はすべて拒否されることを実測した。

| ファイル名 | Content-Type | 拒否理由 |
|---|---|---|
| malware.exe | application/octet-stream | 拡張子が許可外 |
| script.sh / run.bat / payload.ps1 | text/plain | 拡張子が許可外 |
| evil.js | text/javascript | 拡張子が許可外 |
| page.html | text/html | 拡張子が許可外 |
| vector.svg | image/svg+xml | 拡張子が許可外(スクリプト埋込可) |
| noext | text/plain | 拡張子なし |
| ../../etc/passwd | text/plain | パス成分を含む |
| report.pdf.exe | application/pdf | 二重拡張子の最後で判定 |
| fake.png | application/x-msdownload | 拡張子とMIMEの不一致 |
| huge.pdf (26,214,401 B) | application/pdf | サイズ上限超過 |
| empty.pdf (0 B) | application/pdf | サイズ0 |
| report
.pdf | application/pdf | 制御文字を含む |

## 3. 署名付きURL (02.18 §4 / 脅威 T-16)
```
$ 3600秒を要求 → 実際に適用された有効期間
 Test Files  1 passed (1)
      Tests  32 passed (32)
```
- 3600秒を要求しても600秒に切り詰められる(実装側で上限を強制)
- オブジェクトキーは100件生成して全件一意、ファイル名・組織ID・チケット番号を含まない
- Content-Disposition: attachment を強制(インライン実行を避ける)

## 4. スキャン状態による配布制御

| scan_status | ダウンロードURL |
|---|---|
| pending | 発行されない(409 + 監査に denied 記録) |
| infected | 発行されない(409 + 監査に denied 記録) |
| clean | 発行される |

「UIに表示しない」ではなく「URLが存在しない」状態を実装した。
スキャナ本体の統合は後続WP(外部サービス未選定)。ゲート機構を先に作った。

## 5. 全テスト
```
 Test Files  7 passed (7)
      Tests  857 passed (857)
```

## 6. 各種検査
```
OK: RLS設定と接続ロール権限は期待どおりです。
OK: 禁止依存はありません。
OK: 未注釈・期限切れの skip はありません。
```

## 7. 実装中に判明した問題

### テストのクリーンアップ順序が外部キーで壊れた

ticket_comment が ticket を参照するようになったことで、
既存の WP-P2-TKT-001 のテストが `DELETE FROM ticket` で外部キー違反になった。
個々のテストファイルが独自に削除順を持つと、子テーブルが増えるたびに
**別のWPのテストが壊れる**。`tests/support/cleanup.ts` に削除順を集約した。
