# WP-P1-DATA-002 Evidence

- 実施日時: 2026-07-27 10:15:53 JST
- Commit: f49b86a267db92d0a17393fdf8e7de5e8654a5d9
- 対象: Organization/User/Role スキーマ と RLS(ADR-0015 / 02.18)

## 1. RLS設定と接続ロール権限の検査 (Gate 1 G1-3)
```
$ node tools/check_rls.mjs
RLS検査: 問題 0 件
  note: app_user: 非組織スコープ — 1人が複数組織へ所属しうる。role_binding 経由で分離する
  note: identity: 非組織スコープ — app_user に従属。role_binding 経由で分離する
  note: organization: 非組織スコープ — organization_id ではなく id 自身が組織を表す。RLSは id で分離する
  note: role: 非組織スコープ — ロール定義は参照データ。組織に依存しない
  note: schema_migration: 非組織スコープ — マイグレーション管理。業務データではない
OK: RLS設定と接続ロール権限は期待どおりです。
```

## 2. 越境テスト (TL-06 / Gate 1 G1-2)
```
$ npx vitest run tests/security
 ✓ tests/security/cross-org.test.ts (18 tests) 52ms
 Test Files  1 passed (1)
      Tests  18 passed (18)
```

## 3. 認可ロジックの単体テスト
```
 ✓ tests/unit/authz.test.ts (15 tests) 2ms
 Test Files  1 passed (1)
      Tests  15 passed (15)
```

## 4. マイグレーション up/down 往復 (TL-05)
```
reverting 0002_identity_and_organization.sql ...
  ok
applying 0002_identity_and_organization.sql ...
  ok

1 件を適用しました。
```

## 5. RLSの実挙動(コンテキスト未設定で0行)
```sql
-- アプリロールで app.current_org を設定せずに参照
 organization_rows 
-------------------
                 0
(1 row)

```
