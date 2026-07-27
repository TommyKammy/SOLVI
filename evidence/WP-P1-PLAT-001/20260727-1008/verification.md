# WP-P1-PLAT-001 Evidence

- 実施日時: 2026-07-27 10:08:59 JST
- Commit: c5c9731868158c5369116db9b174c3d5bc45c2c8
- ホスト: Darwin arm64 / Node v25.6.1 / Docker 29.2.1

## 1. 環境変数の検証 (fail closed)
```
$ docker compose run --rm -e DATABASE_URL= api node -e "..."  # 必須値を欠いた状態
```

## 2. マイグレーション up/down 往復 (TL-05)
```
$ node tools/migrate.mjs up && node tools/migrate.mjs down && node tools/migrate.mjs up
```

## 3. サービス健全性
```
ai-advisor: Up 2 minutes (healthy)
api: Up 2 minutes (healthy)
executor: Up 2 minutes (healthy)
minio: Up 3 minutes (healthy)
postgres: Up 3 minutes (healthy)
worker: Up 2 minutes (healthy)
```

## 4. 境界検証
```

[1] サービスの健全性
  OK   api healthz — status=200
  OK   worker healthz — status=200
  OK   ai-advisor healthz — status=200

[2] readyz が依存先を見ていること
  OK   api readyz が postgres を確認
  OK   worker readyz が postgres を確認

[3] Executor がホストへ公開されていないこと(ADR-0006)
  OK   executor はホストから到達不可 — compose では expose のみ

[4] AI サービスの到達範囲(AGENTS.md §1.3 / 脅威 T-13)
  OK   ai-advisor → executor 到達不可 — gaierror
  OK   ai-advisor → postgres 到達不可 — gaierror
  OK   ai-advisor → api 到達不可 — gaierror

[5] 相関ID(NFR-OPS-003)
  OK   受信した相関IDが応答に返る — verify-boundaries-0001
  OK   不正な形式の相関IDは採番し直す — 137419b2-75db-4b13-87e9-9bbeb2d2f8d2

[6] エラー表現が RFC 9457 であること(ADR-0017)
  OK   未知のエンドポイントが problem+json を返す — status=404 type=https://solvi.internal/problems/not-found
  OK   problem に相関IDが含まれる

13/13 件が期待どおり
```

## 5. イメージ digest 固定 (NFR-SEC-008)
```
checked 5 image references
OK: すべてのイメージ参照が digest 固定されています。
```

## 6. Allowed Paths 検査
```
checked 18 baseline work packages, 66 allowed paths
OK: すべてのAllowed Pathがリポジトリ構造と一致しています。
```
