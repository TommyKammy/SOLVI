-- 期限切れセッションの削除権限 (WP-P1-IDM-013 / 03.16)
--
-- `SessionService.purgeExpired` は WP-P1-IDM-009 で書かれ、
-- 冒頭に「定期実行から呼ぶ」と書かれていた。
--
-- **呼ぶ定期実行が無かっただけでなく、呼んでも動かなかった。**
-- migration 0011 の GRANT は `SELECT, INSERT, UPDATE` までであり、
-- DELETE が無い。実行すれば `permission denied for table session` になる。
--
-- 未接続の関数は、**繋いでみるまで動くかどうか分からない**。
-- 「書いてある」ことと「動く」ことの間には、権限という層がもう一枚ある。
--
-- ## なぜ UPDATE で足りないのか
--
-- 失効(revoke)は UPDATE で足りる。しかし失効した行を残し続けると、
-- 「誰がいつどこから入ったか」という個人データが保持の根拠を失ったまま
-- 溜まり続ける(03.16 の Minimization)。消すには DELETE が要る。
--
-- ## 消しても記録は失わない
--
-- `session` 行は業務の記録ではなく運用の状態である。
-- 「なぜ失効したか」は `audit_event` 側に追記専用・ハッシュ連鎖で残る
-- (`session.revoked` / `user.deactivated` / `credential.set`)。
--
-- 監査そのものには DELETE を与えていない(migration 0003)。
-- **消してよい表と消してはいけない表を、権限で区別する。**

-- +migrate up

GRANT DELETE ON session TO solvi_app;

-- +migrate down

REVOKE DELETE ON session FROM solvi_app;
