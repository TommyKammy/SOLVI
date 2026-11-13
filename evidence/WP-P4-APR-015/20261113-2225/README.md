# Evidence: WP-P4-APR-015 段階A(承認ルール・有効化設定・リゾルバ・プレビュー・経路解決)

- Timestamp: 2026-11-13 22:25 JST
- Branch: `wp/WP-P4-APR-015`(変更は作業ツリー。コミットなし)
- Environment: macOS、Node.js `v26.13.0`、ローカル PostgreSQL。
- 検証は**使い捨てDB `solvi_wp015_test`**(Migration 0039 適用済み。seed 済み)のみ。
  Migration 互換テストは自分で `solvi_wp015_test_compat_<乱数>` を作成し、終了時に削除する。
- 開発用DB `solvi` は `SELECT count(*)` のみ。件数は作業前後で不変、`schema_migration` は38件・最大 `0038` のまま。
- 開発スタック(Web 3000 / API 3001)は停止・再起動していない。
- 接続文字列・パスワードは記録していない。`.local/credentials.txt` は開いていない。
  `.local/investigations/` は意図的に開いていないが、リポジトリ全体のgrepが数行に一致した
  (内容は実装根拠にしていない)。
- 生ログ: `raw/`(gitignore 対象)。

## 実装したもの(段階A)

1. **Migration 0039**: `approval_rule` / `approval_rule_revision`(append-only)/ `org_approval_setting`。
   RLS(ENABLE/FORCE)・GRANT(DELETEなし)・複合FK・`steps` の1〜3要素CHECK・downのデータ拒否。
   ルール行の識別列不変、`current_revision` の後退禁止、無効化の一方向化。
2. **定義の拡張**: `definition.approval.ruleId`(任意)。旧属性の欠落を受理。
   `steps` の共有Zodスキーマ(fixed / manager / department_head、1〜3段、未知キー拒否)。
3. **リゾルバ**: 純粋ロジックとDB読取を分離。有効な所属の定義を1か所に集約。
   ADR-0023 §9 の解決順、§6.1 の `resolvedFrom` 語彙、重複拒否、org_admin の上長未設定扱い、
   部署長の祖先探索(深さ10)、org_admin への自動フォールバックなし。
4. **申請・変更**: 有効化された組織で `ruleId` がある版だけルールで解決。それ以外は現行互換の1段。
   `approverId` はルール版では無視、互換版では従来どおり必須。冪等リプレイは `route_hash` で判定し、
   ルール版では `approverId` の違いを相違とみなさない。`approval.route.resolved` を各版に記録。
5. **API**: ルールの作成・版追加・無効化・一覧・履歴、有効化設定の取得・切替、
   カタログ項目/ルール指定のプレビュー、解決できない人の一覧。すべて `org_admin` のみ。
6. **カタログ定義の保存時検証**: `ruleId` が同じ組織の有効なルールを指すことを検証。
7. **`highRisk`**: ルール保存時に拒否。段数0/4はAPIとDBの両方で拒否。

## 検証結果(要約)

| 検証 | 結果 |
|---|---|
| 対象テスト(リゾルバ・ルール・経路・既存承認・Migration互換・部署) | **149 passed / 0 failed** |
| `vitest run tests/security` | 734 passed / 10 skipped / **個別テストの失敗0**。失敗は既知の読み込み不能6ファイルのみ |
| `npm run test:unit` | 34 failed / 4397 passed(4431)。**変更前と失敗テスト名が完全一致(差分0)** |
| `node tools/check_rls.mjs`(使い捨てDB) | 問題0件 / OK |
| `npm run typecheck` | 成功(exit 0) |
| `npm run lint` | 成功(exit 0) |
| `npm run check:all` | 成功(exit 0) |
| Prettier(変更ファイル) | 成功 |
| Migration up → down(データなし)→ up | 成功 |
| Migration down(データあり) | 拒否(`0039 rollback refused`)を確認 |
| 開発用DBの前後件数 | 完全一致。`schema_migration=38`、最大 `0038` |

## 既知の失敗(本WPの変更に起因しない)

- `npm run test:unit`: 34 failed / 4ファイル(`knowledge-list`, `knowledge-search-page`,
  `performance-runtime`, `performance-search-static-cli`)。変更前の基点と失敗テスト名が完全一致。
- `vitest run tests/security`: 失敗は既知の読み込み不能6ファイルのみ
  (`knowledge-pagination`, `notification-list`, `notification-manual-retry`, `notification-preference`,
  `notification-retry`, `user-directory-consistency`。`evidence/WP-P3-KNWUI-054/...` の欠落モジュールに依存)。
  これらを除く34ファイルは 734 passed / 10 skipped / 0 failed。

## セキュリティ影響

- 承認者・上長・部署長は、リクエストのIDをそのまま使わず、同じ組織の `role_binding`・
  `org_member_profile`・`department_head` から再検証して解決する。
- ルール・設定は `org_admin` のみ。他組織のルールはRLS・API・複合FKで拒否。
- ルールの版は append-only。UPDATE/DELETE のAPI経路を作らず、DBのトリガとGRANTでも拒否。
- 解決不能は現行互換へ黙って落とさず拒否。`approval.route.resolved` を成功時は同一トランザクション、
  拒否時はロールバック後の独立トランザクションで記録する(02.17 §2.2)。
- 監査・エラー応答に申請入力値・役職・勤務地・社員番号を載せない。プレビューの表示名も
  同じ組織の有効な所属に限定する。
- `decide` の認可・状態機械・実行前検証は変更していない(段階Bで扱う)。
- 新規依存0件。`package.json` / lockfile / `.env` / `next.config.*` / `apps/web/` は未変更。
