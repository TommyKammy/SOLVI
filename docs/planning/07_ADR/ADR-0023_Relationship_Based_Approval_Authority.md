---
project: SOLVI
doc_id: "ADR-0023"
title: "関係ベースの承認権限(上長・部署長)と承認経路の固定・再割当"
category: "07_ADR"
type: "adr"
status: "accepted"
version: "0.2.0"
created: "2026-11-12"
updated: "2026-11-12"
owner: "SOLVI Product Team"
tags: ["adr", "approval", "authorization", "identity", "organization"]
source_of_truth: true
implementation_status: "not-started"
---

# ADR-0023: 関係ベースの承認権限(上長・部署長)と承認経路の固定・再割当

## Status

**ACCEPTED**(2026-11-12 / Owner: SOLVI Product Team)。利用者(Product Owner)が方針と未決事項11点を推奨どおりに決定し、本ADRの内容(リスク受容 RA-04 を含む)を確認のうえ2026-11-12に承認した。本ADRに基づく実装PR(認可・RLS・監査・Migrationに触れるもの)は、引き続き人間のSecurity Reviewerのレビューを必須とする(AGENTS §1.16)。`要確認` と書いた箇所は未確定のままであり、各WPの着手時に確定する。

- Supersedes: なし(既存ADRの決定は書き換えない)
- Superseded by: なし
- 関連: [[ADR-0006_Privileged_Executor_Separation]]、[[ADR-0007_AI_Advisory_Only]]、[[ADR-0009_Append_Only_Audit]]、[[ADR-0015_Organization_Isolation_and_RLS]]、[[ADR-0020_Catalog_Form_Definition_Extensions]]、[[ADR-0021_Catalog_Delegation_And_Fulfillment]]、[[ADR-0022_Catalog_Optional_Request_Fields]]

`要確認` と書いた箇所は、計画・現行コード・既存baseline文書だけでは決められず、最も安全側(fail closed)で記述したものである。レビューで確定する。

## Context

[[03.5_Catalog_and_Approval_Requirements]]が承認者決定について定めているのは「承認者決定ロジック(上司承認・グループ承認)はIdP属性でなくSOLVI内のRoleBinding/組織データを正とする」の1行だけだった。現行実装(`services/api/src/modules/catalog/catalog.routes.ts`、模擬)の事実は次のとおり。

- カタログ定義の `approval.approverId`(固定承認者)は**任意**である。未設定なら申請者が `approver` ロール保持者から選ぶ(入力 `approverId` は常に必須)。
- 承認の決定は `approver` ロールの保持と `approver_id` の一致を要求する(`decide`)。
- `local_request_approval` は申請の版ごとに1行で、期限は行ごとに作成時点から72時間(`addApproval`)。申請の `expired` は承認行から導出し、`local_service_request.state` のCHECKに `expired` は無い。
- 承認の有効性は作業チェック更新・模擬完了の**実行時**にも再検証され、承認者が現在も有効な `approver` かを `validateApprover` で再確認している。作業チェック更新は `approvalMatches`(snapshot_hash・revision・固定承認者の照合)も呼ぶ。
- 監査イベントは `request.*`(`AUDIT_EVENT_TYPES`)を使っている。正本の[[02.17_Audit_Event_Catalog]]は `approval.*` を定めている。
- 部署・上長・役職を保持するテーブルは無い。`app_user` は組織に属さず、所属は `role_binding`(期限付き)から導出する(`db/migrations/0002_identity_and_organization.sql`)。

SOLVIに「部署・上長・承認ルーティング」を追加する(利用者承認済みの計画。Vault外 `.local/` の計画書v2はこのADRと関連文書への落とし込みが完了するまで根拠にならない)。これは次の理由で認可モデルの変更であり、ADRと人間のレビューが必須である。

1. 承認者が「ロール」ではなく「関係(誰の上長か)」で決まる。上長の設定を書き換えられる者が承認者を作り出せるため、設定自体が承認権限の付与と同格になる。
2. 多段化により「現在の1行」だけを見る箇所(決定・変更・取消・実行時検証・冪等リプレイ・一覧・詳細)が一斉に危険になる。
3. 承認者が人事異動・退職で無効になった場合の振る舞いを定めないと、経路が人の操作なしに変わり、監査上「誰の判断か」が曖昧になる。

制約: 体制は小規模で、Executorは未実装(`services/executor/src/main.ts` のみ)。承認コードはすでに `services/api/src/modules/catalog/` にあり、既存申請を壊さない加算的な移行が必要である。

## Decision

### 1. 「有効な所属」の定義

組織Oにおける利用者Uが**有効な所属**であるとは、`app_user.status='active'` かつ、Oに対し有効期間内(`valid_from <= 判定時刻 < valid_until`。`valid_until` がNULLなら無期限)の `role_binding` が**1つ以上**あることをいう。ロールの種類は問わない。`org_member_profile` 行の存在は所属の証明にならない(複合FKが保証するのは行の存在だけ)。判定時刻はDBの `clock_timestamp()` とし、解決時・決定時に毎回検査する。

### 2. 承認ステップの種別と権限根拠

ステップの `authority_type` は `legacy` / `fixed` / `manager` / `department_head` とする。

- `legacy`(既存行のバックフィル値)と `fixed`: 従来どおり `approver` ロールの保持を要求する。`legacy` は「固定」と「申請者が選んだ」の両方を含むため `fixed` と区別する。
- `manager` / `department_head`: **そのステップの `approver_id` であること**を権限根拠とし、`approver` ロールを要求しない。

決定時に毎回検証する項目(いずれか欠ければ拒否):

1. 決定者がステップの `approver_id` と一致する。
2. 決定者が §1 の有効な所属である。
3. 決定者が申請者本人でない。
4. ステップが `pending` で期限内、かつ現在の `route_generation` に属する。
5. `revision` / `snapshot_hash` / `route_hash` が一致する。
6. `fixed` / `legacy` の場合は `approver` ロールを持つ。

承認取消(`revoke`)の権限は現行踏襲とする(自分が承認したステップの承認者、または `org_admin`)。

### 3. 上長・部署長の設定は特権操作

上長(`manager_user_id`)・主部署・部署長の設定と変更は承認権限の付与と同格の特権操作として扱う。

- 変更できるのは `org_admin` のみ。**本人は自分の上長と主部署を変更できない**(`org_admin` 本人の分を含む。`platform_admin` が組織切替下で操作する場合の扱いは `要確認`)。
- **組織管理者の上長は常に未設定とする**(2026-11-12 利用者の決定。当初の `要確認` を確定)。当該組織で有効期間内の `org_admin` ロールを持つ利用者には、誰も上長を設定できない。上長が設定済みの利用者へ `org_admin` を付与する場合は、先に上長を外す(自動では外さない)。帰結: 組織管理者が申請者で、ルールが上長承認の場合、上長は未設定として扱われ、ルールの `onUnresolved`(部署長へ進む、または拒否)に従う。組織管理者の主部署は、本人ではなく別の `org_admin` が設定する(単独の `org_admin` 組織では主部署を設定できない。必要になった時点で後継の決定とする)。
- すべての変更を before/after つきの監査イベントに残す。別の履歴テーブルは作らない(申請時点の経路は承認側に保存されるため再現に不要)。
- `org_admin` が自分の部下・上長関係を作って承認者を作る脅威は、検知で対処する(監査イベント + アクセスレビュー([[WP-P1-SEC-024]]の対象)に追加)。二重承認までは求めない。脅威は [[02.14_Threat_Model]] T-26。
- 上長・部署の循環は、組織単位のadvisory lockを取ってから祖先をたどるトリガで拒否する(同時更新のすり抜けを防ぐ)。部署の深さ上限は10とし、DBとAPIの両方で検証する。

### 4. 高リスク申請は固定承認者を必須とする

高リスク申請([[03.5_Catalog_and_Approval_Requirements]] FR-CAT-010 の対象)は、関係ベース(`manager` / `department_head`)のステップだけでは承認として成立しない。`approver` ロールを持つ固定承認者のステップを必須とする。二重承認とSoDの詳細は[[WP-P4-APR-017]]で扱う。**高リスクかどうかを何で判定するか(カタログ定義の属性か、Executorの Critical Action 分類か)は現行コード・文書のどちらにも定義が無く `要確認`**。判定が確定するまで、ルールの保存時検証とWP-P4-APR-015の受入基準には「高リスクと分類された項目は `fixed` 段を含まないルールを拒否する」を置き、分類の実体は[[WP-P4-APR-017]]で定義する。

### 5. 一覧・詳細の可視性

承認待ち一覧と申請詳細の可視性は、ロールではなく「自分が `approver_id` のステップがある」ことで判定する(上長・部署長は `approver` ロールが無くても自分宛てを見られる)。申請者本人と、現行の担当者ロール(`agent` / `org_admin` / `platform_admin`)の可視性は変更しない。他人の申請IDを指定した決定・閲覧は404を返す(T-02)。

### 6. 経路は版ごとに固定し、変更は「再割当」だけ

- 経路(ステップ配列・ルール参照・解決根拠)は申請の版(revision)ごとに解決して固定し、`route_hash` を保存する。申請内容の変更時は、その版の**全ステップ**を `invalidated` にして新版で再解決する。
- 上長・部署長が申請後に変わっても、進行中の申請の経路は変わらない(申請時の経路を保持)。
- 経路を変える遷移は**再割当だけ**である。未決定(`pending`)ステップの承認者が無効になった場合、自動では差し替えない。決定は拒否され、申請は「承認者不在」として滞留一覧に出る。`org_admin` が再割当を実行する。
- 再割当は、現在の経路世代の未決定ステップを `invalidated` にし、`route_generation` を増やして、現時点の組織データで**残りのステップだけ**を再解決し、新しい `route` と `route_hash` を保存する。承認済みステップは保持する。自己承認・重複・SoDの検証は同じものを通す。`approval.reassigned` を記録する。
- 暗黙の差し替え(自動フォールバック、`org_admin` への自動回送)は設けない。

### 7. 承認済みステップの承認者が後から無効になった場合(現行からの挙動変更)

**止めない。** ステップは、決定時点で §2 を満たしていれば有効であり続ける。`fixed` / `legacy` も同じ扱いとする。

現行コードは作業チェック更新(`updateChecklist`)と模擬完了(`simulate`)の実行時に、承認者が現在も有効な `approver` かを `validateApprover` で再検証して止めている。これは挙動変更であり、新しい検証(WP-P4-APR-011 の `assertApprovalComplete`)では**実行時に承認者の現在の有効性を要求しない**。実行時に引き続き検証するのは、申請者と承認者の非同一、承認者同士の非重複、snapshot_hash / revision / route_hash の一致、全ステップの `approved` と期限内決定である。承認後に承認者の不正・誤承認が判明した場合は、承認取消(FR-CAT-009)で止める。

理由: 承認は決定時点の事実の記録であり、承認後の異動・退職で既承認の申請が実行不能になると、申請者の再申請と承認者探しという業務停止を招く。一方、承認の信頼性は決定時の厳格な検証(§2)と取消経路で担保する。

Executorとの接続は本ADRの対象外とし、[[WP-P4-EXEC-004]]で[[02.16_Executor_Command_Contract]] §3 の承認再検証との整合を決める。02.16 §3-3 が照会するのは承認の状態(approved・未失効・未取消・hash一致)であり承認者の現在の有効性ではない。ただし特権書込み(AGENTS §1.4)で本§7をそのまま適用してよいかは `要確認`(Executor接続時に再判断する)。

### 8. 承認期限

期限は**ステップごと**に、そのステップが `pending` になった時点から起算する。値は**72時間**とし、営業日カレンダーが導入されるまでの暫定値とする([[03.5_Catalog_and_Approval_Requirements]] FR-CAT-011 の「既定3営業日」を改訂)。後続ステップの行は、前のステップが承認された時点で作る。申請の `expired` は現行どおり承認行から導出し、`local_service_request.state` のCHECKは変更しない。

### 9. 承認者決定の方式(解決順)

リゾルバは入力 `{organizationId, requesterId, definition(申請snapshotに固定された版), now}` から、ステップ配列 `{stepNo, approverId, authorityType, resolvedFrom}`・`ruleRef{ruleId, revision}`・`routeHash` を返すか、解決不能の理由(どの設定が足りないか)を返す。

1. 定義に `ruleId` があれば、そのルールの `current_revision` の `steps` を順に解決する。
2. `ruleId` が無く `approverId` があれば、固定承認者1段(現行互換)。
3. どちらも無ければ、現行どおり申請者が選んだ承認者1段(現行互換)。この方式は当面残す。廃止する場合は、既存項目への固定承認者またはルールの設定が先行する。
4. `fixed`: 設定された承認者が有効な所属で `approver` ロールを持つこと。
5. `manager`: 申請者の `manager_user_id`。未設定・無効・申請者本人なら `onUnresolved`(`department_head` または `reject`)に従う。**上長の上長へは自動でたどらない。**
6. `department_head`: 申請者の主部署の長 → 祖先部署の長の順に探索し、見つかった部署長が申請者本人なら飛ばして上位へ進む。探索は祖先までとする。
7. 全ステップで: 申請者本人でない / 有効な所属である / 経路内で同一人物が重複しない(重複は拒否し統合しない)。
8. 解決できなければ**申請を拒否**し、足りない設定を返す。部署長も不在の場合に `org_admin` へフォールバックしない。

同じ入力・同じDB状態なら同じ経路になる(`now` は引数で渡す)。`routeHash` は `snapshot_hash` と同じ共有ライブラリの正規化で算出する。`steps` は直列のみで、`multi_level` という種別は設けない(2要素以上なら多段)。並列・定足数・グループ承認・代理は後続([[WP-P4-APR-017]])。ルールのある項目では申請者は承認者を選ばない(`approverId` を送らない/無視または拒否)。

### 10. 承認ルールとカタログ定義の結び付け

ルール(`approval_rule` と、append-onlyの `approval_rule_revision`)は組織スコープで管理し、**カタログ定義の版属性 `approval.ruleId`** で項目に結び付ける。`scope_type/scope_id/priority` 方式は採らない。業務カテゴリは版属性でありIDを持たない([[ADR-0020_Catalog_Form_Definition_Extensions]])こと、定義の版に含めれば申請snapshotにルール参照が自然に固定されることが理由である。旧属性の欠落は受理し、旧版・過去申請を補完更新しない([[ADR-0020_Catalog_Form_Definition_Extensions]]〜[[ADR-0022_Catalog_Optional_Request_Fields]]と同じ方針)。`steps` の各要素は共有のZodスキーマで検証する(`fixed: {approverId}` / `manager: {onUnresolved: 'department_head'|'reject'}` / `department_head: {onUnresolved: 'reject'}`)。最大段数は `要確認`(WP-P4-APR-015で上限値を確定する)。

### 11. 模擬テーブルの拡張

既存の `local_request_approval` / `local_request_revision` を**拡張**する(加算的な列追加)。承認コードは `services/api/src/modules/catalog/` に置き、`modules/approval/` は新設しない。

- `local_request_revision`: `route jsonb NULL`、`route_hash text NULL`、`route_generation integer NOT NULL DEFAULT 1`
- `local_request_approval`: `step_no`、`route_generation`、`authority_type`(`legacy` 既定)、`resolved_from`、`decided_by`(代理導入時に `approver_id` と分かれる)。`UNIQUE (request_id, organization_id, revision, route_generation, step_no)`
- 既存行は `step_no=1, authority_type='legacy'` でバックフィルし、既存申請は再解決しない。`current_approval_id` は現在 `pending` のステップを指し、全ステップ承認後は最終ステップを指す。

Executorの実装時に承認の正本をどう切り出すか([[02.16_Executor_Command_Contract]] の `approval_ref`)は[[WP-P4-EXEC-004]]で扱い、必要なら後継ADRで決める。

### 12. データモデルと閲覧範囲

- 部署(`department`)・組織プロフィール(`org_member_profile`)・部署長(`department_head`)を組織スコープで新設する。全テーブルに `organization_id` とRLSを設け、複合FKで他組織の上長・部署をDBレベルで拒否する。`app_user` は変更しない(1人が複数組織に所属しうるため、部署・上長は `(organization_id, user_id)` のプロフィールに置く)。
- 部署の削除は行わず `active=false` で無効化する。無効化は所属プロフィール・承認ルール・進行中申請の参照を確認して拒否する。
- 部署長は `EXCLUDE (department_id WITH =, tstzrange(valid_from, valid_until) WITH &&)` で同一部署・同一時刻1名を保証する。これには **`btree_gist` 拡張を追加**する(決定済み。拡張を作成できない環境では、トリガ + ロックで代替する)。
- 1ユーザーの主部署は1つ(兼務は後続)。`cost_center` は持たない(責任者を引くテーブルが無いため。後続)。
- 部署・上長・役職は個人データである。RLSは組織単位までしか守れないため、閲覧範囲はAPI層で制限する: `org_admin`、本人、その人の上長。担当者(`agent`)には部署と表示名までを返す。
- 上長・部署のIdP/SCIM同期は対象外(後続。[[03.7_Identity_OIDC_SCIM_Requirements]]の準拠マトリクスに上長属性を追加する改訂が先)。

### 13. 有効化の単位、監査、Executor

- ルールの使用(新規申請でルールを解決するか)は**組織単位の設定(DB)**で有効化し、環境変数にしない。無効化しても、進行中の多段申請は全ステップの承認を要求し続ける。無効化の効果は「新規申請でルールを使わない」ことだけに限る。
- 監査イベントは[[02.17_Audit_Event_Catalog]]の `approval.*` へ移行する。現行コードの `request.*` との対応・新イベントは02.17に定める。
- Executor接続は本ADRの対象外とする(02.16 §3 の `approval_ref` が多段で何を指すかの決定には02.16の改訂が必要)。`assertApprovalComplete` は、将来の照会エンドポイントの中身として再利用できる形にする。

## Consequences

### 得られるもの

- 上長・部署長を `approver` ロールの個別付与なしに承認者にでき、利用者側の運用が回る。
- 承認の権限根拠・決定時の検証項目・経路の変更手段が一意に定まり、監査で「誰の判断で承認者が決まり・変わったか」を追跡できる。
- 多段の申請が一部の承認だけで実行される事故を、フラグ非依存の全ステップ検証で防げる。
- 既存申請・既存カタログ定義を変換せず、加算的に移行できる。

### 受け入れるコスト

- 認可モデルが「ロール」と「関係」の2系統になり、決定・一覧・詳細のすべての認可経路を改修・検証する必要がある。
- 上長・部署長の設定が承認権限の付与と同格になるため、`org_admin` の権限が実質的に強くなる。検知(監査・アクセスレビュー)で対処し、予防的な二重承認は求めない(リスク受容)。
- §7により、承認後に承認者が退職・異動しても既承認の申請は実行できる。誤承認の事後対応は承認取消に依存する。
- 承認者不在の申請は自動で進まず、`org_admin` による再割当を待つ。滞留一覧と運用が必要になる。
- `btree_gist` 拡張の追加(環境によっては作成権限の確認が必要)と、部署・上長の循環検査トリガ(組織単位ロック)の保守コスト。
- 模擬テーブル(`local_*`)を拡張するため、Executor実装時に承認の正本を切り出す際の書き直しリスクが残る。
- 「申請者が承認者を選ぶ」方式を残す間、承認者の決め方が2通り併存する。

## Rejected Alternatives

計画書v1の権限モデルの選択肢は次の3案だった。

- **案A: 全承認者に `approver` ロールを付与する** — 既存の認可は変わらないが、上長が変わるたびに管理者がロールを付与・剥奪する運用になり、現場が回らない。ロール付与の漏れ・取り残しが承認権限の過大・過小を生み、上長の入れ替わり(異動)に追随できない。
- **案B: 関係ベースの権限を追加する(承認者を関係から導出する)** — 本ADRの方向性に近いが、単独では「関係の導出結果が決定時に正しいか」の検証と、経路の固定・再割当の扱いを定めない。
- **案C: 承認ステップ自体を権限とする** — 最小の変更で関係を表現できるが、ステップの偽造・IDORの防止を徹底しないと、ステップ行の改ざんが承認者の作出になる。

**採用: B/Cの組み合わせ。** 権限根拠はステップの `approver_id`(C)とし、そのステップが関係(B)から解決されたものであることを `authority_type` と `route_hash` で固定し、決定時に §2 の6項目を毎回検証して偽造・IDORを防ぐ。`fixed` / `legacy` は従来のロール要求を保つ。

その他の却下案:

- **承認者が無効になったら自動で次の承認者(上長の上長、`org_admin`)へフォールバックする** — 経路が人の操作なしに変わり、誰の判断で承認者が変わったかが監査上あいまいになる。再割当を唯一の経路変更遷移にする。
- **`app_user` に部署・上長を直接足す** — 1人が複数組織に所属できるため、組織境界を越えて他組織の上長情報が見える。`(organization_id, user_id)` の組織プロフィールに置く。
- **ルールとカタログ項目の結び付けを `scope_type/scope_id/priority` で行う(v1)** — 業務カテゴリが版属性でIDを持たず、申請snapshotにルール参照が固定されない。定義の版属性 `ruleId` を採る。
- **`modules/approval/` を新設して既存のモックテーブルを置き換える** — 既存申請との互換を保ちにくく、Executor未実装の段階で正本を二重に持つ。既存テーブルを拡張する。
- **承認済みステップの承認者が無効になったら実行を止める(現行)** — 異動・退職による業務停止を招く。取消経路で代替する(§7)。`fixed` のみ止める分け方も検討したが、同じ承認が種別で異なる効力になる複雑さに見合わない。
- **シャドウモード(新旧経路の比較)** — 既存項目に比較対象の新ルールが無く、得られるのは実質プロフィールの充足率だけである。代わりにプロフィール充足率の表示とルール作成時のプレビューを提供する。
- **Executor接続をP0に含める** — Executorは未実装で、02.16の契約変更(Executor境界のADR対象)が必要になるため含めない。

## Security Impact

認可・Identity・監査・承認統制に影響する(セキュリティ関連。人間レビュー必須、AGENTS §1.16)。

- 新しい攻撃面: 上長・部署長関係の改ざんによる承認者の作出([[02.14_Threat_Model]] T-26)。対策は §3(org_admin限定・本人変更不可・監査・アクセスレビュー)、§4(高リスクは固定承認者必須)、§2(決定時の検証)、§1(所属の失効を決定時に検査)。
- 関連する既存脅威: T-02(IDOR/BOLA。他人の申請IDは404)、T-03(mass assignment。ルールのある項目での `approverId` 送信)、T-07(IdP属性を権威にしない)、T-08(自己承認・偽装承認。全経路で拒否)、T-19(監査)、T-01(組織境界。複合FK + API認可 + RLS)。
- AIは承認者を選ばない・承認を決定しない([[ADR-0007_AI_Advisory_Only]])。AIサービスからExecutor APIへの経路は作らない(AGENTS §1.3)。
- 個人データ(部署・上長・役職)の閲覧範囲をAPI層で制限する(§12)。
- Secretは扱わない。新規依存パッケージは追加しない(`btree_gist` はPostgreSQLの拡張であり、npm依存ではない)。

## Operational Impact

- 滞留一覧(承認者不在の申請)と再割当の運用手順が必要になる。上長・部署長の設定漏れ(プロフィール充足率)を運用で監視する。
- `btree_gist` の作成権限をMigration実行環境で確認する(`CREATE EXTENSION` はマイグレーション用ownerで実行)。
- 関連Runbookの新設・更新は[[WP-P4-APR-016]](UI)と[[WP-P4-APR-015]]のFollow-upで扱う。

## Migration Impact

- 新規: `department` / `org_member_profile` / `department_head` / `approval_rule` / `approval_rule_revision`(各RLS付き。[[WP-P4-IDM-012]]、[[WP-P4-APR-015]])。`local_request_revision` / `local_request_approval` への列追加(加算的。[[WP-P4-APR-014]])。
- バックフィル: 有効な `role_binding` がある (組織, 利用者) ごとに空の `org_member_profile` を作る。既存の `local_request_approval` は `step_no=1, authority_type='legacy'`。既存のカタログ定義は変換しない。既存申請は再解決しない。
- 監査: 既存の `request.*` 行は書き換えない(append-only)。読み手は新旧の両方の名前を受理する。
- Freshservice移行への影響: 上長・部署の移行は対象外(IdP/SCIM同期と同じく後続)。

## Rollback

- 有効化は組織単位のDB設定であり、無効にすれば新規申請でルールを使わない(現行互換の経路に戻る)。進行中の多段申請は全ステップの承認を要求し続ける。
- down migration は、新しい列・テーブルにデータがある場合は拒否する(`0036_catalog_operations.sql` と同じ方式)。データがあるときは前進修復(互換readerを維持し、UI・書込みを無効化)とする。
- §7の挙動変更は、`assertApprovalComplete` から実行時の承認者有効性検証を除いたものであり、再度要求するにはコードの変更で足りる(スキーマ変更なし)。

## Follow-up

- [[WP-P4-APR-010]]: 本ADRと関連文書の改訂(文書のみ)。
- [[WP-P4-APR-011]]: `assertApprovalComplete` の導入と §7 の挙動変更。**本ADRが `accepted` になるまで §7 部分の実装に着手しない**(監督者が判断)。
- [[WP-P4-IDM-012]] / [[WP-P4-IDM-013]]: 部署・プロフィール・部署長のスキーマ・API・UI。
- [[WP-P4-APR-014]] / [[WP-P4-APR-015]] / [[WP-P4-APR-016]]: 経路・状態機械、ルール・リゾルバ・関係ベース認可、UI。
- [[WP-P4-APR-017]]: 代理承認・高リスク二重承認とSoD(高リスクの判定基準を含む)・並列/定足数/グループ承認・リマインドとエスカレーション。
- [[WP-P4-EXEC-004]]: Executor側の承認再検証との結合(§7の適用可否を含む)。
- 後続候補: カスタムユーザーフィールド、コストセンター責任者、兼務(複数の主部署)、部署・上長のIdP/SCIM同期、営業日カレンダーによる期限(3営業日への復帰)。
- 再判断の条件: Executorの実装開始時(承認の正本の切り出し)、IdP/SCIM同期の着手時(上長属性の権威)。

## Verification

- 決定時の検証6項目(§2)・有効な所属(§1)・経路固定と再割当(§6)・§7の挙動変更: [[WP-P4-APR-011]] / [[WP-P4-APR-014]] / [[WP-P4-APR-015]] の受入基準(状態機械の全遷移テスト TL-02、承認者スコープ TL-06、セキュリティテスト TL-16)。
- 組織境界・循環(同時更新を含む)・部署長の重複: [[WP-P4-IDM-012]] のDB/RLSテスト(TL-05 / TL-06)、`tools/check_rls.mjs`。
- 脅威T-26の検知: 監査イベントとアクセスレビューの対象追加を[[WP-P4-IDM-013]]で検証。
- レビュー: 認証・認可・RLS・監査に触れるPRは人間のSecurity Reviewerのレビュー必須(CODEOWNERS)。Gate B GB-3の対象([[04.22_Gate_Definitions]])。
