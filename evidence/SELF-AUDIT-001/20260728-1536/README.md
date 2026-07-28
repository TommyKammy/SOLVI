# 横断的自己点検 — 「定義したが動いていない」欠陥の棚卸し

実施日: 2026-07-28 (UTC)
対象: SOLVI 全体(Phase 1 / Phase 2 実装分)

## 1. 動機

これまでに見つかった欠陥のうち6件が、**同じ形をしていた。**

| # | 欠陥 | 外から見えた状態 |
|---|---|---|
| 1 | OpenTelemetry 自動計装が tsx/ESM で無効 | スパン0件。エラーも警告も無し |
| 2 | MeterProvider 未接続 | すべての記録が黙って捨てられていた |
| 3 | 署名付きURLのエンコード不一致 | PUT は通り、GET だけが一度も成功していなかった |
| 4 | ClamAV が5か月古い定義で稼働 | スキャンは成功し `clean` が返り続けた |
| 5 | SLA目標値がシードに無い | 新規構築では判定基準が空 |
| 6 | Alertmanager の抑止規則が一致しない | 抑止が成立していなかった |

設定は存在し、ヘルスチェックは通り、テストは緑で、外から見て何も壊れていない。
**動いていないだけ**である。共通する原因は「宣言」と「実行経路」を
突き合わせていないことであった。

## 2. 検査の方法

`tools/check_unwired.mjs` を作り、突き合わせを機械化した。

- A. 監査イベント型のうち、どこからも記録されないもの
- B. アラート式が参照するメトリクスのうち、実在しないもの
- C. エントリポイントから到達できる経路で呼ばれていない公開関数
- D. 定義されているが誰も読まない環境変数
- E. `down` を持たないマイグレーション

C はエントリポイント(各 `main.ts` / 画面 / `tools/*.mjs`)から
import を辿り、**到達可能なファイル**を先に求めてから判定する。
関数どうしが呼び合っていても、そのファイルへ誰も到達しないなら
実行されないためである。

**この検査自体が「動いていない」状態になりうる。**
対象が0件のときは静かに OK を返さず、「検査が成立していません」と報告する。

## 3. 見つかったもの

### 3.1 通知の仕組み全体が本番経路から切り離されていた(最大)

`enqueueOutboxEvent` の呼び出しはテストにしか無く、`OutboxDispatcher` は
どこからも生成されていなかった。統合25件・単体19件のテストが通り、
WP-P2-NTF-005 は「実装済み」だったが、**業務処理は1件もイベントを積まず、
配送も走っていなかった。** 通知は一度も送られていない。

修正: 業務トランザクション内(`ticket.service.ts` / `collaboration.service.ts`)へ
`enqueueOutboxEvent` を追加し、`services/api/src/main.ts` で10秒周期の配送を開始。

検証(テスト補助を使わない実経路):

```
OK  全3件を配送
通知 1 件
  → requester@acme.example.test / "[INC-2026-000003] 新しいコメントがあります"
OK  内部メモは通知されていない
```

### 3.2 監査アンカーが一度も実行されていなかった

`computeDailyRoot` / `persistAnchor` / `verifyAnchor` は互いに呼び合い、
テストも通っていたが、**`services/worker/src/main.ts` はそのファイルを
読み込んでいなかった。** 改ざん検知は実装済みとして扱われ、
一度も動いていなかった。

さらに悪いことに、仮に動かしていても**空のアンカーを毎日記録していた**。
`audit_event` のRLSは `organization_id = app_current_org()` であり、
組織コンテキストを持たないバッチからは0件に見える。
0件でも連鎖ハッシュは正しく計算でき、保存も成功する。

修正:
- migration 0014 で `app.anchor` の読み取り専用例外を追加(登録制。既存フラグを流用しない)
- `runner.ts` を追加し、実行前に例外ポリシーの実在を確認する。無ければ実行しない
- worker で1時間おきに実行(前日分を固定し、直近3日を照合)
- メトリクス `solvi.audit.anchors` と、不一致・**未実行**の両方を捉えるアラート2件

実行結果:

```
date=2026-07-27 created verified=1 root=630c66a2679e
solvi_audit_anchors_total{outcome="match"} 1
```

### 3.3 アラートが存在しないメトリクスを参照していた

`SolviScannerSignaturesStale` は `solvi_scanner_signature_age_seconds` を
参照していたが、実際の名前は `solvi_scanner_signature_age` である。
**このアラートは永久に発火しない。** これは前回のWPで私自身が作り込んだ欠陥である。

### 3.4 ログの表題が付加フィールドに上書きされていた

`logger.info('audit anchor', { message: '...' })` の `message` が
表題を上書きし、`audit anchor` で検索しても1件も出てこなかった。
ログは出ているのに**探せない**。この検査中、実際にこれで足を取られた。

修正: 表題を優先し、衝突した値は `detail` へ移す。許可リストにも `detail` を追加。

### 3.5 `SESSION_SECRET` が必須なのに誰も読んでいなかった

セッションは256ビットの乱数を SHA-256 で保存するだけで、署名鍵を使わない。
使われない秘密を必須にすると、運用者は「替えればセッションが切れる」と読む。
実際には何も起きない。**宣言ごと削除した。**

### 3.6 `OTEL_SERVICE_NAMESPACE` が読まれていなかった

`service.namespace` は `'solvi'` の直書きだった。設定しても何も変わらない。
`startTracing` のオプションへ渡すようにした。

### 3.7 ローカル資格情報がシードに含まれていなかった

`seed.mjs` はユーザとロールを作るが `local_credential` を作らない。
別のツールを手で叩く前提だったが、その手順は立ち上げ手順のどこにも無い。
テストが資格情報を消したあとは seed を再実行しても戻らず、
**画面は正常なのに全員が 401 になる。** 原因は認証の不具合に見える。

修正: `seed.mjs` が冪等に資格情報を作るようにした
(`hashPassword` を再実装せず共有実装を使うため `tsx` 経由に変更、`npm run db:seed`)。

### 3.8 テスト用の失敗装置が本番のソースにあった

`FailingEmailSender`(必ず送信に失敗する)が `services/api` 側にあった。
設定の取り違え1つで配送を止められる。`tests/support/` へ移した。

## 4. 承知のうえで残したもの

`tools/check_unwired.mjs` の `ACCEPTED_UNWIRED` に理由を書いて一覧へ出し続ける。
黙って除外しない。理由を書けないものは入れられない。

| 対象 | 理由 |
|---|---|
| `signWebhook` / `verifyWebhook` / `InMemoryNonceStore` | Webhook送信の受け口がまだ無い |
| `isDerivedPriority` | 優先度が導出値のままかを画面に出す判定。画面側が未実装 |
| `assertCanSwitchOrganization` | 組織横断操作の門番。経路も画面もまだ無い |
| **`RelationService`** | **HTTP経路も画面も無い。WP-P2-REL-009 は「実装済み」だが利用者からは到達できない** |

未使用の監査イベント型9件は、Phase 1 で作った台帳に対して
まだ機能そのものが無いもの(組織管理・ユーザ管理・監査エクスポート)である。

## 5. 検証結果

| 検査 | 結果 |
|---|---|
| `npx vitest run` | **1199 passed (25 files)** |
| `npm run lint` | No issues found |
| `npm run typecheck` | エラー無し |
| `check_rls.mjs` | OK |
| `check_architecture.mjs` | OK |
| `check_allowed_paths.mjs` | OK |
| `check_unwired.mjs` | OK(注記3件) |
| マイグレーション往復 (0014 down → up) | OK |
| `verify_tracing.mjs` | 7/7 |
| `verify_slo_pipeline.mjs` | OK |
| `e2e/portal_flow` / `conversation_flow` / `attachment_flow` | すべて OK |

## 6. 開発環境での注意

`metrics_audit_anchor.txt` に `outcome="mismatch"` が1件記録されている。
これは**改ざんではない。** テストスイートが `audit_event` を削除するため、
アンカーを作ったあとにテストを流すと必ず不一致になる。
本番では監査イベントは削除されないため起きない。

開発環境でアンカーを作り直す場合は、`audit_anchor` を
(append-only トリガを一時的に外して)空にしてから worker を再起動する。

## 7. この検査の限界

**静的な突き合わせであり、実際に動くことの証明ではない。**
「呼ばれている」ことは分かるが「正しく動いている」ことは分からない。
今回見つけた欠陥のうち 3.4(ログの上書き)は、この検査ではなく
実際に動かして探した過程で見つかった。

実経路の確認は `verify_tracing` / `verify_slo_pipeline` / `e2e/*` が担う。
両方を回し続ける必要がある。
