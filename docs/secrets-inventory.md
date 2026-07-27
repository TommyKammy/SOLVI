# Secret一覧

ADR-0016 の Follow-up。用途・保管先・ローテーション周期・所有者を管理する。
**この表に値そのものを書かない。** 保管先の参照だけを書く。

## 用途別のパス分離

| 用途 | Secrets Manager パス | 読取可能なIAMロール | ローテーション | 所有者 |
|---|---|---|---|---|
| Core API のDB接続 | `solvi/core/db` | api, worker | 90日 | Tech Lead |
| Core API のセッション秘密 | `solvi/core/session` | api | 90日 | Tech Lead |
| Object Storage 資格情報 | `solvi/core/storage` | api, worker | 90日 | Tech Lead |
| **Executor のDB接続** | `solvi/executor/db` | **executor のみ** | 90日 | Security Reviewer |
| **Okta OAuth service app 秘密鍵** | `solvi/executor/okta` | **executor のみ** | 180日 | Security Reviewer |
| **Microsoft Graph client credential** | `solvi/executor/graph` | **executor のみ** | 180日 | Security Reviewer |
| Command署名鍵(KMS) | `alias/solvi-command-signing` | worker(署名) / executor(検証は公開鍵) | 年1回 | Security Reviewer |
| SCIM Bearer token | `solvi/scim/token` | api | **90日**(FR-IDM-009) | Security Reviewer |
| OIDC クライアント秘密 | `solvi/core/oidc` | api | 180日 | Security Reviewer |
| AIプロバイダAPIキー | `solvi/ai/provider` | ai-advisor のみ | 90日 | Tech Lead |

## 不変条件

- **Core と AI の IAM ロールから `solvi/executor/*` を読めないこと。** これが ADR-0006 の実装であり、
  Gate B の GB-7 / GB-8 で検査する。
- Command署名鍵は KMS 管理とし、平文で取り出さない。
- ローカル開発は `.env`(gitignore済み)。本番の値をローカルへ入れない。
- Break Glass 用資格情報は封緘保管し、使用時は必ずローテーションする
  (`docs/planning/08_Runbooks/08.13_Break_Glass_Runbook.md`)。

## 四半期レビュー(NFR-SEC-002)

各Secretについて以下を確認し、記録を `evidence/access-review/<YYYYQn>/` へ残す。

- [ ] 読取可能なIAMロールが表のとおりか(過剰付与がないか)
- [ ] ローテーション周期を守れているか
- [ ] 使われていないSecretが残っていないか
- [ ] 所有者が現任者か
