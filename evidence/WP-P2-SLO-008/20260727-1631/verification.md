# WP-P2-SLO-008 Evidence

- 実施日時: 2026-07-27 16:31:10 JST
- 対象: SLO・アラート・オンコール・合成監視

## 0. 最初に見つかったこと(このWPの実質的な出発点)

**WP-P1-OBS-005 で定義したメトリクスは、一度も記録されていなかった。**

```
MeterProvider after SDK start: NoopMeterProvider
counter: NoopCounterMetric
```

`NodeSDK` に `metricReader` を渡していなかったため MeterProvider が生成されず、
`metrics.getMeter()` は NoopMeterProvider を返していた。
`recordHttpRequest()` `recordOutboxLag()` `recordAuthzDenial()` の呼び出しは
すべて黙って捨てられていた。**例外も警告も出ない。**

単体テストは自前のインメモリリーダーを立てるため、全て緑のままだった。
OBS-005 のトレースでも同じ形の欠陥が起き、`verify_tracing.mjs` で初めて見つかった。
今回も単体テストではなく、稼働中のスタックに対する実測で発見した。

メトリクスが1件も出ていない状態では、SLOを何本定義しても判定できない。
したがって本WPの最初の作業は配管を通すことになった(→ [[99.4_Decision_Log]] DL-009)。

## 1. メトリクスの公開(修正後の実測)

`METRICS_PORT` を設定し、`PrometheusExporter` を `metricReader` として接続。

```
metric families: 3
solvi_http_requests_total counter
solvi_http_duration histogram
```

メトリクス名は推測せず、実際の `/metrics` 出力から確認してアラート定義に使った。

## 2. ヘルスチェックをSLIから除外

初回の実測で `/healthz` が SLI の系列に入っていた。

```
solvi_http_requests_total{http_method="GET",http_route="/healthz",...} 3
```

ヘルスチェックは高頻度・常に高速・常に成功する。混ぜると
**可用性が水増しされ、レイテンシのp95が薄まる**。
利用者が1件も成功していなくても、ヘルスチェックが毎秒通っていれば
可用性99.9%と表示されうる。

`SLO_EXCLUDED_ROUTES` として**記録側**で除外した。
クエリ側のフィルタにしなかったのは、新しいダッシュボードを書く人が
1度忘れた時点で数字が静かに嘘になるため(→ DL-008)。

## 3. SLO配線の検証 (`tools/verify_slo_pipeline.mjs`)

```
1. アプリからのメトリクス公開
  OK   api の /metrics に到達できる
  OK   solvi_http_requests_total が公開されている
  OK   solvi_http_duration が公開されている
  OK   ヘルスチェックが SLI の系列に混ざっていない

2. Prometheus のスクレイプ
  OK   Prometheus に到達できる
  OK   solvi-* のスクレイプ対象が設定されている — 4 件
  OK   solvi-api / solvi-executor / solvi-synthetic / solvi-worker をスクレイプできている

3. アラートルール
  OK   8種すべてのアラートが読み込まれている
  OK   すべてのルールが正常に評価されている
  OK   すべてのアラートに runbook の参照がある

4. 合成監視
  OK   合成監視の結果が Prometheus に入っている — 2 チェック
  注記 未実行のチェックがある: login, ticket_create

OK: SLOの配線は期待どおりです
```

「アラートを書いた」ことと「鳴る」ことは別である。
構文エラーがあると Prometheus はそのファイルを丸ごと無視するため、
読み込みと評価の健全性まで機械的に確認している。

## 4. 疑似アラート演習(§7 受入基準)

| 時刻 (UTC) | 出来事 |
|---|---|
| 07:21:28 | `docker compose stop executor` — 障害を起こす |
| 07:23:4x | Prometheus で `SolviTargetDown` が pending → firing(`for: 2m`) |
| **07:24:02** | **alert-sink が firing 通知を受信**(発生から約2分34秒) |
| 07:25:48 | `docker compose start executor` — 復旧 |
| **07:29:02** | **alert-sink が resolved 通知を受信**(`group_interval: 5m` の次のフラッシュ) |

受信内容:

```
firing   SolviTargetDown page solvi-executor @2026-07-27T07:24:02.261Z
resolved SolviTargetDown page solvi-executor @2026-07-27T07:29:02.261Z
```

**解決通知まで確認した。** 発火だけを確認して終えると、
「鳴りっぱなしで復旧が伝わらない」状態に気付けない。

通知本文にチケット件名・利用者名・宛先アドレスは含まれない
(メトリクスのラベルに識別子を入れていないため、そもそも載せられない)。

## 5. 演習中に見つけた抑止ルールの欠陥

当初の `inhibit_rules` は次のようになっていた。

```yaml
- source_matchers: [alertname = SolviTargetDown]
  target_matchers: [slo = availability]
  equal: ['job']
```

2つの問題があった。

1. **源である `SolviTargetDown` 自身が抑止対象に含まれる**
   (`SolviTargetDown` のラベルにも `slo: availability` がある)
2. **`equal: ['job']` が一致しない。** `job` ラベルを持つのは `SolviTargetDown` だけで、
   `SolviNoTraffic` などは持たない。したがって抑止は**成立していなかった**

抑止は「鳴らさない」設定であり、間違えても何も起きないため気付けない。
alertname の明示列挙に変更し、読んで効果を判断できる形にした。

## 6. 合成監視

| チェック | 結果 |
|---|---|
| `portal_top` | 成功(web 起動途中は正しく失敗を報告した) |
| `api_ready` | 成功 |
| `login` | **未実行** — WP-P1-IDM-003 未実装 |
| `ticket_create` | **未実行** — 認証済みセッションが必要 |

未実行のチェックは `solvi_synthetic_skipped` として公開し、
**成功として扱っていない**。監視できているつもりになるのを防ぐため。

## 7. 回帰テスト

`tests/unit/slo-metrics.test.ts` — 11件すべて通過。

| 検証 | 内容 |
|---|---|
| 計器が実際に記録される | 5種すべての計器で、記録が読み出せること |
| SLIの分母を汚さない | `/healthz` `/readyz` `/metrics` が系列に入らないこと |
| 業務ルートは除外されない | 除外が広すぎないこと |
| ステータスコードは階級で持つ | 500/502/503 が3系列に分かれず 5xx に集約されること |
| 属性に識別子が含まれない | `ticket.id` `user.id` `organization.id` `correlation.id` が無いこと |

テスト作成中、`AggregationTemporality.CUMULATIVE` では前のテストの値が
次の収集にも乗り、テスト順序に依存して壊れることが判明したため DELTA に変更した。

**この単体テストだけでは今回の欠陥は防げない。** 自前のリーダーを立てるため、
本番の配線が切れていても緑になる。本番経路の確認は
`tools/verify_slo_pipeline.mjs` が担う。役割を分けている。

## 8. 検証コマンドと結果

```
npm run lint                       ESLint: No issues found
npm run typecheck                  通過
node tools/check_allowed_paths.mjs OK (24 WP / 99 paths)
node tools/check_architecture.mjs  OK: 禁止依存はありません (42ファイル / 5ルール)
node tools/check_image_pinning.mjs OK (11 イメージ参照すべて digest 固定)
node tools/verify_slo_pipeline.mjs OK: SLOの配線は期待どおりです
npx vitest run                     15 files / 1006 tests passed
```

## 9. 受入基準の充足状況

| # | 基準 | 状態 |
|---|---|---|
| 1 | SLOが文書化され、計測手段が動作している | **達成** — `docs/ops/slo.md`、配線を実測で確認 |
| 2 | 疑似アラートで通知到達を1回以上実証 | **達成** — §4(解決通知まで確認) |
| 3 | 1週間の観測でノイズアラート0件 | **未達** — 実運用データが必要。Gate A の前提 |
| 4 | オンコール表・連絡経路・エスカレーション先の記載 | **部分達成** — 役割・経路・基準は確定。**担当者名と連絡先が未記入**(OQ-013) |
| 5 | 合成監視が3導線を定期実行 | **未達** — 2導線のみ。login / ticket_create は WP-P1-IDM-003 待ち |
| 6 | パイロット中断の判断基準が明記されている | **達成** — 08.3 §2 |

## 10. 残っている制約

- **ノイズ観測(基準3)は実施できない。** 実利用のトラフィックが必要であり、
  パイロット開始後にしか測れない。現に `SolviNoTraffic` はローカルの
  無トラフィック環境で pending になっており、パイロット期間の
  夜間・休日には誤検知しうる。抑止時間帯の調整が必要になる見込み。
- **オンコール表の担当者名が空欄**(OQ-013)。この状態では障害時に
  「誰に連絡すればよいか」が決まらない。パイロット開始2週間前までに記入が必要。
- 本番のアラート通知先(メール・チャット)が未決定(OQ-012)。
  現在は webhook でローカルのシンクに受けている。
- 合成監視の `login` / `ticket_create` は WP-P1-IDM-003 完了後に有効化する。

**したがって Gate A(GA-6)は本WP完了時点では通過できない。**
残るのは実運用データと担当者確定であり、実装作業ではない。
