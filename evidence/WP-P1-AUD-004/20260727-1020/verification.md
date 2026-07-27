# WP-P1-AUD-004 Evidence

- 実施日時: 2026-07-27 10:20:51 JST
- 対象: append-only 監査基盤と日次アンカー(ADR-0009 / 02.17)

## Gate 1 G1-4: append-only の強制
```
 ✓ tests/security/audit-append-only.test.ts (18 tests) 109ms
      Tests  18 passed (18)
```

### 検証した内容
- アプリロールからの UPDATE / DELETE / TRUNCATE がすべて拒否される
- **owner 権限でもトリガが拒否する**(権限だけでは内部者を止められないため二層化)
- 他組織IDを詐称した監査イベントの書き込みが RLS で拒否される
- outcome=denied に policyDecision がないイベントは記録できない

## Gate 1 G1-5: 日次アンカーによる改ざん検知
- イベントを事後 UPDATE → verifyAnchor が mismatch を検出
- イベントを事後 DELETE → mismatch と件数差を検出
- アンカー自体は上書き不可(改ざん後の辻褄合わせを防止)

## 全テスト
```
 Test Files  3 passed (3)
      Tests  51 passed (51)
```

## RLS検査
```
RLS検査: 問題 0 件
  note: app_user: 非組織スコープ — 1人が複数組織へ所属しうる。role_binding 経由で分離する
  note: audit_anchor: 非組織スコープ — 日次ハッシュは組織横断の整合性を担保するため分割しない。参照は監査者ロールで制御する
  note: identity: 非組織スコープ — app_user に従属。role_binding 経由で分離する
  note: organization: 非組織スコープ — organization_id ではなく id 自身が組織を表す。RLSは id で分離する
  note: role: 非組織スコープ — ロール定義は参照データ。組織に依存しない
  note: schema_migration: 非組織スコープ — マイグレーション管理。業務データではない
OK: RLS設定と接続ロール権限は期待どおりです。
```
