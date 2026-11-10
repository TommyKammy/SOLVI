# WP-P2-UIX-041 検証記録

2026-11-10〜11 / ローカル合成データ / 基点 `dc717d8`（優先度2）。

## 実装

- 認可されたサービスの下書きを新しい未保存フォームへ複製。GETで書き込まず、管理コード・作成キーは新規、責任者は作成者へ戻す。
- 版管理した共有質問セットを作成・更新・挿入。質問・セクション・条件参照を一緒に再採番し、挿入後は独立したコピーとして扱う。上限超過では現在の入力を変更しない。
- 組織ロールcatalog_editorは保存済みownerが自分の下書きだけを編集する。他人/別組織・owner偽装・公開・権限付与・セット管理は拒否。既存の管理者限定・理由/期限付き委任UIを利用する。全体staff権限へ追加しない。
- 管理一覧に責任者・更新時刻・未公開変更・公開前の設定確認を表示。候補/編集/公開はAPI capabilityに従い、欠落時は操作を許可しない。
- 公開定義の担当グループで新規申請チケットを初期配置。requesterの役割を偽装せず、state=newを維持。初期属性をticket.createdで監査し、手動割当者に見せない。
- 作業チェックは申請revision別の独立versionで保存。必須作業と有効な承認・hash整合をサーバーで確認してから模擬完了する。チェック更新で申請version/hash/承認は変えない。

## 検証結果

| 検証 | 結果 |
|---|---|
| 関連unit（catalog、portal、directory、auth時計） | 16ファイル / 586件成功 |
| 全体unit | 4174成功 / 34失敗、別に1ファイル収集エラー。新規失敗0 |
| 型、lint、整形、strictテスト型検査 | 成功 |
| check:all、本番build | 成功 |
| 実API/PostgreSQL | 14項目成功 |
| Chrome157 / WebKit26.5 | 各9項目成功、各6画面のaxe違反0 |
| 1440px / 375px、キーボード | 成功、狭幅の横溢れ0 |
| Migration0036 | ローカル適用済み、checksum一致 |
| 再起動後Web/API | login・healthz・readyz HTTP200 |

全体unitの失敗名は前段の基準と同一。[unit-summary.json](unit-summary.json)に保存し、全体ゲート合格とは扱わない。テストのskip・削除・無効化は行っていない。

主なコマンド:

- `rtk proxy npx vitest run tests/unit/catalog-*.test.ts tests/unit/portal-catalog.test.ts tests/unit/user-directory.test.ts tests/unit/auth-role-clock.test.ts`
- `rtk npm run test:unit -- --reporter=json --outputFile=.local/fix-041/unit.json`
- `rtk npm run typecheck` / `rtk npm run lint` / `rtk npm run check:all` / `rtk npm run build`
- `rtk proxy node --env-file=.env tools/smoke_catalog_operations.mjs`
- `rtk proxy node tools/ui_catalog_operations_check.mjs`（WebKitは`SOLVI_UI_BROWSER=webkit`）

資格情報は非出力の環境変数から渡し、詳細ログはGit管理外`.local/fix-041/`へ保存。

## 境界・再開・修正

[実API/PG記録](api-smoke.json)で保存ownerの認可、期限切れ/取消、共有版の独立・冪等/競合、初期routing、必須チェックと旧progress保持、RLS、不変性、監査を確認した。委任APIの期限形式の不一致は検証ツールを直し、作成済み合成ユーザーを照合して再利用した。13項目成功後の取消検証でDB/ホストの約59msの時計差を実測し、RoleBinding評価をDB clockへ統一した。Session寿命・idle契約は変更しない。既存fixtureの後半だけを再開し、新しいcatalog/requestは追加していない。

[ブラウザ記録](browser/README.md)で各engineの新規合成catalog3・共有セット1・申請1、公開/承認/必須チェック/模擬完了を確認。Chromeの誤ったDTO期待とWebKitのnative select横溢れは、書込み済みfixtureを照合して再利用した。長い選択名はselect自身の省略表示で扱い、祖先containerをclipして隠さず、選択肢の全文と読み上げ名を保持した。

複製の候補再取得でcopyFromが失われる問題も独立レビューで修正。承認hash不一致時の進捗更新を拒否し、新監査イベントには変更前後を記録する。独立したコードレビューは人間のセキュリティレビューの代替にはしない。

## レビュー・rollback

認可変更を含むため[AGENTS.md](../../AGENTS.md) §1.16の人間レビューはpending。WP/ADRもreview待ちを維持し、mainへpushしない。Migration0036は新データがある場合に損失を伴うdownを拒否する。readerとデータを保持した前方互換rollbackを使い、既存申請・履歴・監査を消さない。API検証用の委任は取消、対象catalogは非公開、合成groupは無効化済み。ブラウザ検証データは識別可能な合成データとして保持する。Safari/Edge製品実機は未実施。
