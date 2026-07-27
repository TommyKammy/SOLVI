# WP-P1-OBS-005 Evidence

- 実施日時: 2026-07-27 15:31:40 JST
- 対象: 分散トレース・メトリクス・ログの突き合わせ(Gate 1 G1-6の一部)

## 1. 実スタックでのトレース疎通
```
[1] リクエストを発生させる
  OK   APIへのリクエスト — status=404

[2] Jaegerへ到達するまで待つ

[3] サービスがJaegerに登録されている
  OK   solvi-api が登録されている — services=jaeger-all-in-one, solvi-api

[4] トレースが記録されている
  OK   solvi-api のトレースが存在する — 3 件
  OK   スパンに service.name が付いている — 4 spans
  OK   ヘルスチェックがトレースに含まれない — 0 件

[5] ログに trace id が載っている
  OK   trace id を含むログ行がある — 6 行
  OK   ログに接続文字列やJWTが出ていない

7/7 件が期待どおり
```

## 2. 単体テスト(トレース伝播とredaction)
```
 Test Files  1 passed (1)
      Tests  10 passed (10)
```

### 検証した内容
- **Outbox経由でトレース文脈を運べる**(W3C traceparent のシリアライズ・復元)
  これが切れると「申請は成功したが実行されていない」場合の追跡ができなくなる
- 例外はspanに記録したうえで再送出(握りつぶすとトレース上は成功に見える)
- スパン内のログに trace id が載り、スパン外では載らない(全ゼロを書かない)
- 計装で増えた属性が redaction の許可リストを迂回しないこと

## 3. 実装中に発覚した問題

### 自動計装が tsx/ESM 環境で無言で無効になっていた

OpenTelemetry の auto-instrumentation は CommonJS の require パッチに依存する。
開発環境(tsx + ESM)ではモジュールのパッチが効かず、SDKは起動するが
**スパンが1つも作られない**状態だった。エラーもログも出ないため、
単体テスト(インメモリExporter)だけでは気付けない。

実スタックへの疎通確認(`tools/verify_tracing.mjs`)を書いていたため発覚した。
「計装は設定を1つ間違えるだけで無言で無効になる」という想定が実際に起きた。

対応: HTTPハンドラで**明示的にスパンを張る**。自動計装は補助として残すが依存しない。
これにより実行環境(tsx / node / bundler)に関わらずトレースが機能する。

### BatchSpanProcessor の遅延で誤判定しかけた
既定のスケジュール遅延は5秒。検証スクリプトの待機が3秒だったため
「計装は動いているのにトレースが無い」と誤判定していた。待機を8秒へ延長した。

## 4. 設計上の判断

| 判断 | 理由 |
|---|---|
| ヘルスチェックをトレースから除外 | 大量に来るうえ障害解析の役に立たず、ノイズでトレースが埋まる |
| SQL文をスパン属性に載せない(enhancedDatabaseReporting: false) | 値がバインドされる前でもクエリ文から業務内容が推測できる |
| メトリクスのラベルにID類を入れない | ticket_id や user_id を入れると時系列が無限に増え監視基盤を壊す。個別追跡はトレースと監査の役割 |
| ステータスコードを階級(2xx/4xx/5xx)で保持 | 個別コードは時系列を増やすわりに判断には階級で足りる |
| トレースは監査の正本ではない | サンプリングで欠落し保持期間も短い。証跡は audit_event(ADR-0009) |

## 5. 全テスト
```
 Test Files  12 passed (12)
      Tests  951 passed (951)
```

## 6. 各種検査
```
OK: 禁止依存はありません。
OK: すべてのイメージ参照が digest 固定されています。
OK: RLS設定と接続ロール権限は期待どおりです。
```

## 7. 追加した依存(AGENTS.md §1.13)

| パッケージ | 理由 |
|---|---|
| @opentelemetry/api, sdk-node, sdk-metrics | 02.13 と本WPが指定する標準。自前実装は保守負担が大きい |
| exporter-trace-otlp-http, exporter-metrics-otlp-http | OTLP/HTTP でコレクタへ送る。ベンダ非依存 |
| instrumentation-http, instrumentation-pg | 補助的な自動計装(上記の理由で依存はしない) |
| resources, semantic-conventions | サービス名などの標準属性 |
| sdk-trace-node, core (devDependency) | テスト用のインメモリExporterとW3C伝播 |

いずれも OpenTelemetry 公式・Apache-2.0。ライセンス上の制約はない。
