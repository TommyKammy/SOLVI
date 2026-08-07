---
project: SOLVI
doc_id: "WP-P1-IDM-012"
title: "資格情報を設定する経路を1つにする"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-08-07"
updated: "2026-08-07"
owner: "SOLVI Product Team"
tags: ["workpackage", "p1", "identity", "security", "maintainability"]
source_of_truth: true
implementation_status: "done"
phase: "P1"
workstream: "IDM"
risk: "medium"
story_points: 3
depends_on: ["WP-P1-IDM-009", "WP-P1-IDM-011"]
requirement_ids: ["FR-IDM-007", "NFR-SEC-002", "NFR-MNT-001"]
aliases: ["WP-P1-IDM-012"]
---

# WP-P1-IDM-012: 資格情報を設定する経路を1つにする

| 項目 | 値 |
|---|---|
| Phase | P1 |
| Workstream | IDM |
| Risk | medium |
| Story Points | 3 |
| 依存 | [[WP-P1-IDM-009]] / [[WP-P1-IDM-011]] |
| Evidence | `evidence/WP-P1-IDM-012/20260807-0130/` |

## 1. 「未接続」の裏返し

`LocalAuthService.createCredential` は誰からも呼ばれていなかった。
それでも**パスワードの設定は動いていた** — `tools/create_local_user.mjs` と
`tools/seed.mjs` が同じ手順を書き写していたためである。

呼ばれない関数があるのではない。
**呼ばれない関数と同じことをする写しが二つあった。**

## 2. 写しは、写した時点からずれていく

| | `createCredential` | `create_local_user.mjs` | `seed.mjs` |
|---|---|---|---|
| scryptの形式 | `hashPassword` | **自前で再実装** | `hashPassword` |
| `password_changed_at` | 更新する | 更新する | **更新しない** |
| セッションの失効 | する | する | **しない** |
| 強度の検査 | する | 長さのみ | しない |
| 停止利用者の拒否 | しない | する | しない |

**5行すべてで食い違っている。**

`create_local_user.mjs` は `N: 16384, r: 8, p: 1` と `maxmem` を書き写していた。
**scryptのコストを上げれば、この経路で作った利用者だけがログインできなくなる。**
どちらの経路も「動いている」ので、上げた人はそれに気付かない。

## 3. 直し方

`createCredential` を唯一の書き込み口にし、両方のツールがそれを呼ぶ。
ツールは入力を読み、利用者を引き、サービスを呼ぶだけになった。

### 停止された利用者の拒否をサービスへ移した

この判定は**管理ツール側にだけ**書かれていた。

[[WP-P1-IDM-011]] で退職者のアクセスを止められるようにしたが、
`createCredential` は利用者の状態を見ていなかった。
止めた直後に別の経路で資格情報を設定し直せば入れてしまう。

**規則は操作のある場所に置く。** 呼び出し側の1つに置くと、
次の呼び出し側が現れたときに漏れる — 実際に漏れていた。
→ [[99.4_Decision_Log|DL-031]]

### 設定したことを監査へ残す

残さないと、後から「誰かがパスワードを差し替えた」ことに気付けない。

実行者は管理ツールであり、認証された利用者ではない。`system` として残す。
**人の名前を騙るより、「ツールが実行した」と正直に書くほうが調査の役に立つ。**

パスワードもハッシュも載せない。検査でも
「`after_state` に `scrypt` の文字が現れない」ことを固定した。

## 4. 検査を足した — 同じ手続きが二か所に無いか

`check_unwired.mjs` にセクションF を追加した。
security に関わる書き込みが1か所からしか行われないことを見る。

| 対象 | いま |
|---|---|
| `INSERT INTO local_credential` | `local-auth.service.ts` のみ |
| `UPDATE session ... SET revoked_at` | `session.service.ts` のみ |

**未接続の検査だけでは、この欠陥は捉えられなかった。**
「呼ばれていない」は分かるが、「呼ばれていないのに動いている理由」は
写しの存在であり、それは別の形の検査が要る。
→ [[04.23_Wiring_Verification]] §9 / [[99.4_Decision_Log|DL-032]]

## 5. 検証

| 検査 | 結果 |
|---|---|
| `npx vitest run` | **1330 passed (28 files)** — 資格情報の検査8件を追加 |
| `check_unwired.mjs` | OK。セクションF 追加、`createCredential` を承知リストから外した |
| e2e 6本 | すべて OK |
| `check_rls` / `check_architecture` / `check_allowed_paths` | OK |

実経路: ツールで再設定 → 新パスワードで 200 / 旧パスワードで 401、
停止中の利用者へは拒否(終了コード1)、短いパスワードも拒否、
`db:seed` 後の全12件が同一のハッシュ形式。

## 6. 残っている制約

- **利用者が自分でパスワードを変える経路は無い。** 意図的に作っていない。
  ADR-0019 によりローカル認証は検証段階限りであり、本番の資格情報は
  外部IdPが持つ([[WP-P1-IDM-003]])。
  **要求されていない機能を作って、後で捨てることはしない**
- パスワードリセットのメール送信は無い。管理者がツールで再設定する
- **監査の実行者が `system` 固定。** ツールを叩いた人間は記録に残らない
- seed の再実行は全員のセッションを失効させる(設定し直しているので正しい)

## 7. 関連

- [[WP-P1-IDM-009]] — `createCredential` の実装元
- [[WP-P1-IDM-011]] — 退職者のアクセス停止
- [[04.23_Wiring_Verification]] §9
- [[ADR-0019_Local_Authentication_For_Development]]
