# WP-P2-UIX-040 検証記録

2026-11-10 / ローカル合成データ / 基点 `0e1aa3e`。

日付・数値・複数選択、補足説明、条件付き表示、セクション、独立した業務カテゴリを実装した。新属性は任意で旧定義へ既定値を挿入しない。APIとWeb入力試験は同じ共有定義・検証を用い、非表示の値はsnapshotに保存しない。管理コードと保存キーの生成、dirty/pending排他、申請時点の定義固定は維持する。

## 検証

- `rtk proxy npx vitest run tests/unit/catalog-*.test.ts tests/unit/portal-catalog.test.ts`: 11ファイル、465件成功。
- `rtk npm run typecheck` / `rtk npm run lint` / `rtk npm run check:all` / `rtk npm run build`: 成功。変更ファイルの整形と追加・変更テストのstrict型チェックも成功。
- 全体unitは4072成功・34失敗（別に収集エラー1ファイル）。[unit-summary.json](unit-summary.json)。既存34失敗と収集エラー1ファイルを前回記録と比較し、新規失敗なし。品質ゲート全体の合格とは扱わずWPはreview。
- 実API/PGは[api-smoke.json](api-smoke.json): 7項目成功。保存・公開・申請、新型の不正POST拒否、hidden値除去、0保持、配列の候補順正規化、版変更後の旧snapshot/hash/承認/history不変、異組織API404とアプリロールのRLSを確認。
- [ブラウザ記録](browser/README.md): Chrome157/WebKit26.5各9検査成功、各5画面のaxe違反0。PC/375px、キーボード、条件/必須・日付/数値範囲/0/複数選択、補足とセクション、カテゴリ検索、申請snapshotを確認。
- 入力試験の業務POSTは0。両engineは各1件の合成draft保存・公開・申請のみ。WebKitはhydration前fillの不備を直し、作成済みfixtureを照合して申請部分だけ再開した。追加のテンプレート画像は読み取りだけで撮影。

## レビューで直した問題

任意の補足を空へ戻した際の偽dirty、object property順だけの偽dirty、条件元の型変更で条件を解除できない状態、空白カテゴリの保存/試験差、編集途中の複数候補の空白値を修正。制約エラーを日本語化。確認チェックはPCテンプレートの最後のセクションへ配置した。

## 変更境界

DDL/Migration・追加依存なし。認可/RLS/監査/Executor・既存サービス・過去申請を変更しない。API検証の合成catalogは終了後非公開。ブラウザ用合成catalogは検証用に区別して保持する。新形式を保存した後は、そのreaderを保持したままUIを戻す。Safari/Edge製品実機は未実施。
