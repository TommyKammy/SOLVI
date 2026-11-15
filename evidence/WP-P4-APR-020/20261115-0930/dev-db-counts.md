# 開発用DB(solvi)の件数 — 作業前(2026-11-15 08:52 頃)と作業後

| テーブル | 作業前 | 作業後 |
|---|---|---|
| local_service_request | 18 | 18 |
| local_request_revision | 23 | 23 |
| local_request_approval | 30 | 30 |
| local_request_route_generation | 2 | 2 |
| local_request_approval_notice | 8 | 8 |
| audit_event | 1960 | 1960 |
| notification | 95 | 95 |
| outbox_event | 454 | 454 |
| schema_migration | 41 (最大0041) | 41 (最大0041) |
| pg_policies (public) | 78 | 78 |
| approval_delegation | なし(0042未適用) | 0 (表が無い) |

開発用DBへの書込み(Migration/INSERT/UPDATE/DELETE/cleanup/seed)は行っていない。SELECT と管理者接続での件数のみ。
