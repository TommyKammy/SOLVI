-- SLA判定の保存列を廃止する (FR-TKT-008 / WP-P2-SLAUI-016)
--
-- `response_sla_breached` / `resolution_sla_breached` は、
-- **状態遷移のときにしか更新されなかった。**
--
-- つまり放置されたチケットは期限を過ぎてもフラグが立たない。
-- 一覧で最も見たいのは放置されたものであり、**そこだけが更新されない**。
-- しかもこの列はどのAPI応答にも画面にも出ていなかったため、
-- 誰も気付かないまま「SLAを実装した」ことになっていた。
--
-- 判定は読むたびに計算する(`ticket-query.ts` の SLA_ELAPSED_SQL /
-- `TicketService.slaStatus`)。計算してしまえば陳腐化しない。
-- 保存値と実際が食い違う余地そのものが消える。
--
-- **二重の真実を残さない。** 列を残したまま書き込みだけをやめると、
-- 古い値が入ったまま「参照してよい列」に見え続ける。
-- 次に触る人が信じてしまうので、列ごと消す。
--
-- 件数の規模(パイロットで数千件)なら、索引の効かない計算列でも
-- 一覧の応答時間に影響しない。増えたときは
-- 「保存して定期更新」ではなく**生成列と索引**を検討する
-- (生成列なら書き忘れが起きない)。

-- +migrate up

-- 索引も一緒に消える(列に依存しているため)。明示しておく —
-- 「なぜ索引が消えたのか」を後から探させない。
DROP INDEX IF EXISTS ticket_sla_breach_idx;

ALTER TABLE ticket
  DROP COLUMN IF EXISTS response_sla_breached,
  DROP COLUMN IF EXISTS resolution_sla_breached;

-- +migrate down

ALTER TABLE ticket
  ADD COLUMN response_sla_breached   boolean NOT NULL DEFAULT false,
  ADD COLUMN resolution_sla_breached boolean NOT NULL DEFAULT false;

-- 0008 が作っていた索引を戻す。戻さないと 0008 の down で
-- 「無いものを消す」ことになり、往復が対称でなくなる。
CREATE INDEX ticket_sla_breach_idx
  ON ticket (organization_id, created_at DESC)
  WHERE response_sla_breached OR resolution_sla_breached;
