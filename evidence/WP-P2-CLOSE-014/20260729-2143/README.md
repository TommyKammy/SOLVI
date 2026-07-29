# WP-P2-CLOSE-014: 自動クローズの実行と Reopen の導線

実施日: 2026-07-29 (UTC)

## 1. 問題

要求([[03.3_Ticket_Requirements]] 状態機械)は
「**Closed(Resolved後14日で自動)**」と定めている。
`state-machine.ts` にも `resolved → closed (auto_close)` の規則がある。

しかし `grep auto_close services/ apps/ tools/` の結果は **0件**。
**実行する者が居なかった。** 解決済みチケットは永久に `resolved` のまま残り、
ITSMとして完了しない。

さらに悪いことに、この遷移が担当者の画面に**手で押せるボタンとして出ていた**。
実際の表示:

```
[ in_progress にする ]  [ 完了にする ]  [ closed にする ]
```

3つの問題が同時に起きている。

1. `reopen` と `auto_close` に訳が無く、**内部の状態名が生で出ていた**
   (`ACTION_LABELS` の `?? \`${rule.to} にする\`` が埋めていた)
2. `close` と `auto_close` で**同じ意味のボタンが2つ並んでいた**
3. 自動化のための遷移理由が、手動操作の選択肢になっていた

これで7件目の「定義したが動いていない」である([[04.23_Wiring_Verification]])。
今回は**動いていないだけでなく、間違った形で画面に出ていた**。

## 2. 直したもの

### 2.1 自動クローズを実行する

`services/api/src/common/close/auto-close.ts` を追加し、1時間おきに回す。

APIプロセスで動かす理由は Outboxディスパッチャと同じ — 監査と通知の書き込みが
`services/api` にあり、worker から使うと境界を越える(`../outbox/dispatcher.ts` の冒頭)。

**読み取りは越境させ、書き込みは越境させない。**

候補の一覧を作るには全組織を横断する必要がある(migration 0016 の `app.autoclose`)。
一方、1件を閉じる操作は必ずその組織のコンテキストで行い、監査もその組織に残る。

**抽出時点の判断を信じない。** 抽出から実行までに人が Reopen していることがある。
1件ごとに状態機械へもう一度問う。

**1件の失敗で全体を止めない。** 止めると滞留が積み上がり、
あとで一度に大量に閉じることになる。

### 2.2 自動遷移を選択肢から外す

`NOT_MANUAL_REASONS = { auto_close, merge }` を導入した。

ラベルの既定値も変えた。`?? \`${rule.to} にする\`` は**訳が無いことを隠す**。
`?? \`${rule.to} (${rule.reason})\`` にして、訳の欠落が画面から見て分かる形にした。
テストでも「どの選択肢のラベルも `状態名 (理由)` の形にならない」ことを固定した。

修正後:

```
[ 対応を再開する(解決を取り消す) ]  [ 完了にする ]
```

### 2.3 依頼者が再開できるようにする

要求(FR-TKT-012)は「Resolved後14日以内は**Requester**/Agentが再開可」。
サービス層は 14日窓・期限切れ拒否・`resolvedAt` 必須まで完備していたが、
**依頼者に許可されていたのは `cancel` だけ**で、`reopen` は拒否されていた。
画面の導線も無かった。

これが無いと、依頼者は同じ件で新規に起票し直すしかない。
**履歴が分断され**、担当側から見ても再発なのか未解決なのか区別できなくなる。

依頼者の画面に「まだ解決していないと伝える」を追加した。
期限の判定はAPIが行う — 画面で日数を数えると規則を2か所に持つことになる。

### 2.4 自動遷移を人の操作として記録しない

監査は `actorType: 'system'`、`actorId` は載せない。
人として記録すると、記録を読む人が「誰が閉じたのか」を探して見つからず、
時間を使うことになる。

通知の `actorId` も省く。自動遷移には操作者が居ないため、
通知側の自己除外が誰にも当たらず**関係者全員へ届く**。それが正しい。

## 3. 実経路での確認

```
{"message":"auto close sweep","count":1,"detail":"candidates=1 closed=1 skipped=0 failed=0"}

     number      | state  | closed | actor_type | actor_id_null |   reason
-----------------+--------+--------+------------+---------------+------------
 INC-2026-000009 | closed | t      | system     | t             | auto_close
```

担当者画面の選択肢(実スタックへHTTP):

```
resolved で出る操作:
   reopen → 対応を再開する(解決を取り消す)
   close → 完了にする
```

## 4. 検証結果

| 検査 | 結果 |
|---|---|
| `npx vitest run` | **1252 passed (26 files)** — 自動クローズと再開の検査10件を追加 |
| `tools/e2e/conversation_flow.mjs` | 全項目OK。**解決後の扱い10項目を追加** |
| `tools/e2e/{portal,attachment,relation}_flow.mjs` | すべて OK |
| `check_accessibility.mjs` | **12画面 violation 0** |
| `check_rls.mjs` / `check:all` | OK |
| マイグレーション往復 (0016 down → up) | OK |
| `npm run lint` / `npm run typecheck` | エラー無し |

## 5. 残っている制約

- **自動クローズの通知は `ticket.transitioned` として送られる。**
  件名は「状況が更新されました」であり、「14日経過したため完了にしました」とは
  書かれない。依頼者から見ると、なぜ今更updateが来たのか分かりにくい
- 14日という値は定数(`AUTO_CLOSE_AFTER_DAYS`)である。組織ごとに変えられない
- **営業日を数えない。** 暦日で14日。年末年始に解決したものは
  休みの間に窓が閉じる
