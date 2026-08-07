# WP-P2-SCAN-012: スキャン結果を書く場所を1つにする

実施日: 2026-08-07 (UTC)

## 1. 出発点

`CollaborationService.recordScanResult` は本番経路から呼ばれていなかった。
検査からだけ呼ばれていた。

書いていたのは worker の `AttachmentScanner.recordResult` である。
**同じ列を、二か所が違う内容で書いていた。**

## 2. 写しは古いまま取り残されていた

| 列 | `recordScanResult`(API側) | `recordResult`(worker) |
|---|---|---|
| `scan_status` | 書く | 書く |
| `scanned_at` | `now()` | 注入された時刻 |
| `scan_signature` | **書かない** | 書く |
| `scan_attempts` | **増やさない** | +1 |
| `scan_last_error` | **消さない** | NULL に消す |

原因ははっきりしている。**`recordScanResult` のほうが古い。**

`scan_signature` / `scan_attempts` / `scan_last_error` は
migration 0012([[WP-P2-SCAN-011]])で追加された。
その時点で worker 側は書くようになったが、
**API側の写しは追随していない。**

もしAPI側が使われていたら:

- **感染を検出しても検体名が残らない** — 何に感染したか分からない
- **前回の失敗理由が消えない** — いま健全な添付が「エラーを抱えている」ように
  見え続け、本当に調べるべきものが埋もれる
- 試行回数が増えないため、上限による打ち切りが効かない

## 3. 直し方 — 消す

書く場所は worker である。API側の写しは削除した。

**繋ぎ先を作るのではなく、消すのが正しい場合がある。**
この関数は「スキャナ本体の統合は後続WP」という但し書き付きの仮置きだった。
後続WP([[WP-P2-SCAN-011]])は来たが、実装先は worker であり、
仮置きのほうは片付けられずに残った。

**仮置きは、本物が出来た時点で消さないと写しになる。**

## 4. 検査の下準備も1つにした

検査は「この添付は clean である」という前提を作るために
`scan_status` を直接書いてよい。ただし**書き方は1つにする。**

`tests/support/scan.ts` の `markScanned()` に集めた。
以前は `recordScanResult` 経由が4か所、生SQLが1か所あり、
**後者は `scanned_at` しか埋めていなかった。**

検査ごとに違う列を埋めると、「この状態のとき何が起きるか」を
確かめているつもりで、**検査ごとに違う状態を作る**ことになる。

## 5. 取り残しを固定する検査を足した

`check_unwired.mjs` セクションF([[WP-P1-IDM-012]] で追加)に
`UPDATE ticket_attachment ... SET scan_status` を加えた。

さらに**振る舞いの検査**を1件足した:

> 一度失敗しても、次に成功すれば前回の失敗は消える

これは静的検査では捉えられない。列が増えたときに片方だけ
取り残される事故は、**「増えた列が正しく扱われているか」**を
実際に動かして見るしかない。

## 6. 検証結果

| 検査 | 結果 |
|---|---|
| `npx vitest run` | **1331 passed (28 files)** — 再試行後の消去を1件追加 |
| `check_unwired.mjs` | OK。セクションF に scan_status を追加、承知リストから外した |
| `check_rls` / `check_architecture` / `check_allowed_paths` | OK |
| e2e 6本 | すべて OK |
| `npm run lint` / `npm run typecheck` | エラー無し |

実経路(ClamAV 実体との突き合わせ):

```
1周目(スキャナ到達不可)  scan_status=pending  scan_last_error=有
2周目(到達可)            scan_status=clean    scan_last_error=null  scan_attempts=2
```

マイグレーションは無い。

## 7. 残っている制約

- **API から結果を受け取る口は無い。** 外部スキャナからの callback を
  受ける設計にはしていない。現状 worker が自分で取りに行く
- `markScanned()` は infected のとき既定の検体名を入れる。
  DB制約(`ticket_attachment_signature_only_infected`)を満たすためであり、
  実物の検体名を検査しているわけではない
- **セクションF の対象は手で選んでいる。** 網羅ではない
