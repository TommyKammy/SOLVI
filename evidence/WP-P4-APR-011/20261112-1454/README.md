# WP-P4-APR-011 検証記録(再実行)
- Commit SHA(基点): 5c33cca794206bb52225536a9f4ab43a4b6cca1f / Node v26.13.0 / vitest 3.2.7 / ローカルPostgreSQL(値は記録しない)
- 追加+関連unit: 18 files / 695件成功。security(実PG): 18件成功、実行前後のDB件数が同一(raw/db_counts_*.json)。
- test:unit: 変更前34失敗/4305 → 変更後34失敗/4343、新規失敗0(unit_comparison.json)。
- typecheck / lint / check:all(Allowed Paths検査含む): exit 0。
- smoke_catalog_flow.mjs は資格情報がないため未実行。
