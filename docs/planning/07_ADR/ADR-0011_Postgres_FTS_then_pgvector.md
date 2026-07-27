---
project: SOLVI
doc_id: "ADR-0011_Postgres_FTS_then_pgvector"
title: "日本語検索はPostgreSQL FTSで開始し、必要が実証されたらpgvectorを追加する"
category: "07_ADR"
type: "adr"
status: "accepted"
version: "0.2.0"
created: "2026-07-27"
updated: "2026-07-27"
owner: "SOLVI Product Team"
tags: ["adr"]
source_of_truth: true
implementation_status: "not-started"
---

# ADR-0011: 日本語検索はPostgreSQL FTSで開始し、必要が実証されたらpgvectorを追加する

## Status

**ACCEPTED**(2026-07-27 / Owner: Product Owner + Security Reviewer)

- Supersedes: なし
- Superseded by: なし

## Context

ナレッジ検索は本システムの自己解決率(01.8)に直結する。しかし初日から検索クラスタやベクトルDBを導入すると、運用対象とコストが増え、テナント境界の担保箇所も増える。

## Decision

初期検索は**PostgreSQL全文検索**(日本語形態素解析。pgroongaまたはpg_bigmを候補としWP-P3-SRCH-002で実測比較して決定)で実装する。セマンティック検索は、評価セットでFTSの不足が定量的に示された場合に**同一DB内のpgvector**として追加する。外部検索クラスタは採用しない。

## Consequences

### 得られるもの

- 運用対象が増えず、テナント境界(RLS)を検索にもそのまま適用できる
- バックアップ・リストアの単位が1つのまま
- 検索インデックスが派生データであり再構築可能

### 受け入れるコスト

- 日本語検索の精度チューニング(辞書・同義語)が必要
- 大規模化(記事10万件超)では性能の再評価が要る
- ベクトル検索の性能はPostgreSQLの制約を受ける

## Rejected Alternatives

- **初日からElasticsearch/OpenSearch** — 運用・コスト・境界担保の対象が増える。MVPの検索要件はFTSで満たせる見込み
- **外部ベクトルDB(Pinecone等)** — テナント境界を外部サービス側でも担保する必要が生じ、監査の説明が複雑になる

## Security Impact

検索インデックス行にもorganization_idを持たせRLSを適用する。ベクトル検索は必ず**検索前フィルタ**でユーザ権限を適用し、post-filterによる情報漏えい(T-14)を避ける。

## Operational Impact

インデックス再構築の手順と所要時間をRunbook化する。検索応答はNFR-PERF-002(p95 2秒)で監視。

## Migration Impact

Freshserviceナレッジ移行時に日本語検索の実データ評価を行う(WP-P3-MIG-005)。

## Follow-up

- pgvector追加の判断基準: 評価セット50問でFTSのTop-5正解率が80%未満の場合
- 形態素解析拡張(pgroonga vs pg_bigm)の決定をWP-P3-SRCH-002の成果物とし、本ADRへ追記する
- **2026-07-27 追記**: [[WP-P2-SEARCH-006]] でチケット検索を実装した際、追加拡張を入れず
  pg_trgm の部分一致で開始した。1万件で p95 9.8ms(目標2000ms)と性能上の問題はないが、
  語の意味的な近さは扱えない。ナレッジ記事([[WP-P3-SRCH-002]])は文書量も検索精度の
  要求も高いため、そこで形態素解析拡張の要否を実データで判断する。

## Verification

この決定の遵守は、関連WPのAcceptance CriteriaとArchitecture/Security Test(TL-16)で検証する。PR Reviewで本ADRへのリンクを確認する。決定を変更する場合は本ADRを編集せず、後継ADRでSupersedeする。
