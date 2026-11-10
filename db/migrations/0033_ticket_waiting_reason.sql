-- WP-P2-REFINE-032 / ADR-0031: existing pending rows stay unknown.
-- Additive only. No backfill or business state/role changes.
-- +migrate up
ALTER TABLE ticket ADD COLUMN pending_reason text;
ALTER TABLE ticket ADD CONSTRAINT ticket_pending_reason_check CHECK (
  pending_reason IS NULL OR
  (state = 'pending' AND pending_reason IN ('wait_requester', 'wait_external'))
);
COMMENT ON COLUMN ticket.pending_reason IS
  'Current pending reason; NULL on legacy unknown pending or non-pending. Requester public reply resumes only wait_requester.';

-- +migrate down
-- Roll back application code first. Keep the column to retain waiting context.
-- Explicit down discards only the new context, never tickets/audit/comments.
ALTER TABLE ticket DROP CONSTRAINT ticket_pending_reason_check;
ALTER TABLE ticket DROP COLUMN pending_reason;
