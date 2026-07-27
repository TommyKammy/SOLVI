---
project: SOLVI
doc_id: "WP-P2-SCAN-011"
title: "ウイルススキャンと添付アップロード"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-07-27"
updated: "2026-07-27"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "security"]
source_of_truth: true
implementation_status: "done"
phase: "P2"
workstream: "SECURITY"
risk: "high"
story_points: 8
depends_on: ["WP-P2-COLLAB-004", "WP-P2-OPSUI-010"]
requirement_ids: ["FR-TKT-005", "NFR-SEC-005"]
aliases: ["WP-P2-SCAN-011"]
---

# WP-P2-SCAN-011: ウイルススキャンと添付アップロード

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | SECURITY |
| Risk | high |
| Story Points | 8 |
| Gate | Gate A |

## 1. Purpose

添付ファイルを**安全に受け取り、安全に配る**。

ダウンロードURLは `scan_status = \'clean\'` でなければ発行されない
([[WP-P2-COLLAB-004]] が実装済み)。スキャナが無ければ `pending` のまま残る。

つまり **スキャナ不在のままアップロード画面を作ると、アップロードできるが
誰も開けないファイルが増えるだけ**になる。利用者は「スクリーンショットを送った」と
思い、担当者には見えない。無い機能より悪い。

したがって OQ-011(スキャナ選定)を先に閉じた。

## 2. Requirement IDs

`FR-TKT-005`(添付の配布制御)、`NFR-SEC-005`

## 3. Dependencies

- [[WP-P2-COLLAB-004]] — 添付のドメインとスキャンゲート
- [[WP-P2-OPSUI-010]] — 画面の土台

## 4. Scope / Allowed Paths

- `db/migrations/`
- `packages/shared/src/scan/`
- `packages/shared/src/storage/`
- `services/worker/src/jobs/scan/`
- `apps/web/src/`
- `tools/`
- `tests/`

## 5. Out of Scope

- 署名DB(freshclam)の更新運用手順 → 別途
- freshclam(署名DB更新)の運用手順
- 本番相当環境でのスキャナ構成(arm64ネイティブ等)

## 6. Deliverables

- ClamAV クライアント(`INSTREAM`)
- 添付スキャンワーカー
- スキャナ用のRLS例外(登録制・SELECT限定)
- バケット作成ツール
- 添付のアップロード画面

## 7. Acceptance Criteria

- [x] ClamAV がローカルコンテナで動作し、**外部サービスへの接続を必要としない**
- [x] **EICAR が infected として検疫される**(実スキャナで実証)
- [x] 通常のファイルが clean になる
- [x] **スキャナへ到達できないとき clean にしない**(pending のまま)
- [x] 実体を取得できないとき clean にしない
- [x] サイズ上限超過を clean にしない
- [x] 応答が解釈できないとき clean にしない
- [x] 試行上限に達したものを自動で clean にしない
- [x] **署名付きURLで実際に取得できる**(形だけでなく実地で)
- [x] 添付が常にダウンロードとして扱われる(ブラウザで実行させない)
- [x] 依頼者・担当者が画面から添付をアップロードできる
- [x] スキャン中の状態が画面に表示される(「何が起きていて、いつ開けるようになるか」を書く)

## 8. Verification and Evidence

- `tests/unit/clamav.test.ts`(13件)
- `tests/security/attachment-scan.test.ts`(7件)
- `tests/security/object-storage.test.ts`(11件)

Evidenceは`evidence/WP-P2-SCAN-011/<YYYYMMDD-HHMM>/`へ保存する。

## 9. Security and Audit

| 論点 | 対応 |
|---|---|
| 検疫の素通り | 判定を3値にし、**判定できなかったものを clean にしない** |
| 検体の滞留 | ディスクへ置かず `INSTREAM` で送る |
| 越境 | `app.scanner` の SELECT 限定例外(→ [[02.18_Organization_Data_Model_and_RLS]] §3.3) |
| ログ | 検体名は残すが**ファイル名は残さない**(業務情報が含まれる) |
| ブラウザ実行 | `Content-Disposition: attachment` + `application/octet-stream` |

## 10. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-07-27 | Fable 5 | `5ba8179` | **Partial**(第1段: スキャン基盤) | `evidence/WP-P2-SCAN-011/20260727-2320/` | 単体13 + 検疫7 + ストレージ11。全体 1141 tests passed |

### OQ-011 の決定: ClamAV

外部サービスへの接続を必要とせず、ローカルコンテナで完結する。
clamd の `INSTREAM` を使い、**ファイルを一時ディスクへ置かない** —
スキャン前の検体がファイルシステム上に存在する時間を作らない。

公式イメージが arm64 を出していないため amd64 をエミュレーションで動かす
(起動に約50秒)。本番相当環境では別の構成を検討する必要がある。

### clean を安売りしない

判定は3値。「感染していない」と「判定できなかった」を区別する。
到達不能・解釈不能・サイズ超過・実体取得失敗・試行上限 — いずれも `pending` のまま残す。

**滞留は「使いにくい」だけだが、誤った `clean` は社内へのマルウェア配布経路になる。**

### 発見した既存の欠陥: 署名付きGETが一度も成功していなかった

スキャナが実体を読もうとして 403 になり、調べたところ
**添付のダウンロードは一度も動いていなかった**。

原因は `encodeURIComponent` が `! \' ( ) *` を変換しないこと。
SigV4 が要求する RFC 3986 の正規化と食い違う。

壊れ方が厄介だった: **PUT は通り GET だけが 403 になる**
(PUT の追加パラメータは `Content-Type` だけで該当文字を含まないため)。

**なぜ気付かれなかったか。** 既存のテストは署名付きURLの「形」しか検査しておらず、
実際に取得していなかった。「URLが生成できる」と「そのURLで取得できる」は
別の主張である。実際に PUT/GET する検証を常設した。

| 2026-07-27 | Fable 5 | `6ecda76` | Done(第2段: 画面) | `evidence/WP-P2-SCAN-011/20260728-0617-ui/` | 通し確認18項目 / a11y 9画面 violation 0 |

### 第2段で見つけた設計上の問題

**内部名で署名したURLはブラウザが使えない。**

APIはコンテナ内部の名前(`http://minio:9000`)で署名付きURLを作るが、
**それを受け取るのはブラウザ**であり、その名前を解決できない。

ローカル固有の問題ではない。本番でもアプリはVPC内のエンドポイントを、
ブラウザは公開URLを使うことが多い。**SigV4 はホスト名を署名対象に含む**ため、
渡す相手が使うホストで署名しなければ、名前解決に成功しても署名が合わない。

`S3_PUBLIC_ENDPOINT` を分離した。

| 用途 | 使う接続先 |
|---|---|
| ブラウザへ渡す署名付きURL | `S3_PUBLIC_ENDPOINT` |
| サーバ自身の実体取得(スキャン) | `S3_ENDPOINT` |

### 画面の設計判断

**スキャン中を隠さない。** 「まだ開けません」とだけ出すと、利用者は壊れていると
思って同じファイルを何度も送り直す。何が起きていて、いつ開けるようになるのかを書く。
開けないファイル名はリンクに見せない — 押しても開かないものをリンクにすると
壊れていると思われる。

**署名付きURLを画面に埋め込まない。** 埋め込むと、ページを共有したり
スクリーンショットを撮ったりしただけで、有効期限まで誰でも取得できてしまう。
毎回サーバへ問い合わせ、その時点の権限とスキャン状態で判断する。

**開けるかどうかは API が `downloadable` として返す。** 画面が `scanStatus` を
解釈して判断すると、状態が増えたときに画面ごとに判断が分かれる。

### スキャン滞留のアラート

`SolviAttachmentScanStalled` を [[WP-P2-SLO-008]] のルールへ追加した。
判定不能だけが続く状態を検知する(`clean` が1件でも出ていればスキャナは生きている)。

**画面は正常に見えるが添付が誰も開けない状態になる。**
利用者からは「ファイルが壊れている」としか見えず、発見が遅れる。

### 残っている制約

- **freshclam(署名DB更新)の運用手順が未整備。** 古い定義のまま動き続けると
  新しいマルウェアを見逃すが、**検知できていないことは検知できない**
- amd64 エミュレーションのため、本番相当環境では別の構成の検討が必要
- 添付の削除・差し替えができない。誤って添付した場合の取り消し手段が無い
- スキャン試行の上限に達したものを人が確認する手順が未整備
