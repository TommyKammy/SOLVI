-- WP-P2-NTFRETRY-058 / ADR-0040: one manual reservation per existing notification.
-- No backfill or change to notification, original Outbox, or preference rows.
-- +migrate up
-- Supporting unique indexes permit organization-qualified references. IDs remain
-- globally unique; these indexes do not alter the existing identity contract.
CREATE UNIQUE INDEX notification_retry_org_id_key ON notification (organization_id, id);
CREATE UNIQUE INDEX outbox_retry_org_id_key ON outbox_event (organization_id, id);

CREATE TABLE notification_retry_request (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id),
  notification_id uuid NOT NULL,
  original_outbox_id uuid NOT NULL,
  retry_outbox_id uuid NOT NULL UNIQUE,
  requested_by uuid NOT NULL REFERENCES app_user(id),
  -- A reference to the authenticated session, never its plaintext token/hash.
  -- Do not couple its mutable selected organization to this immutable approval.
  -- Sessions are ephemeral: the existing purger must remain free to delete them.
  -- A missing session makes execution ineligible while approval history survives.
  session_id uuid NOT NULL,
  approved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  failure_attempts smallint NOT NULL CHECK (failure_attempts >= 0 AND failure_attempts < 32767),
  failure_failed_at timestamptz NOT NULL,
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  UNIQUE (organization_id, notification_id),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, notification_id)
    REFERENCES notification (organization_id, id),
  FOREIGN KEY (organization_id, original_outbox_id)
    REFERENCES outbox_event (organization_id, id),
  FOREIGN KEY (organization_id, retry_outbox_id)
    REFERENCES outbox_event (organization_id, id),
  CHECK (retry_outbox_id <> original_outbox_id),
  CHECK (expires_at = approved_at + interval '15 minutes')
);

CREATE TABLE notification_retry_receipt (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id),
  request_id uuid NOT NULL UNIQUE,
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'rejected', 'unknown')),
  reason text,
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id text,
  FOREIGN KEY (organization_id, request_id)
    REFERENCES notification_retry_request (organization_id, id),
  CHECK (
    (outcome = 'succeeded' AND reason IS NULL)
    OR (outcome = 'failed' AND reason IS NOT NULL AND reason = 'sender_failed')
    OR (outcome = 'unknown' AND reason IS NOT NULL AND reason = 'result_unknown')
    OR (outcome = 'rejected' AND reason IS NOT NULL AND reason IN (
      'unsupported', 'not_failed', 'outbox_unavailable', 'outbox_not_stopped',
      'recipient_ineligible', 'event_invalid', 'target_changed',
      'approval_expired', 'session_invalid'
    ))
  )
);

ALTER TABLE notification_retry_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_retry_request FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_retry_request_org_read ON notification_retry_request
  FOR SELECT USING (organization_id = app_current_org());
CREATE POLICY notification_retry_request_self_insert ON notification_retry_request
  FOR INSERT WITH CHECK (
    organization_id = app_current_org()
    AND requested_by = NULLIF(current_setting('app.current_actor', true), '')::uuid
  );

ALTER TABLE notification_retry_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_retry_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_retry_receipt_org_read ON notification_retry_receipt
  FOR SELECT USING (organization_id = app_current_org());
-- The ordinary worker has an organization context, not an impersonated actor.
-- API/worker authorization is also enforced by the service (not by RLS alone).
CREATE POLICY notification_retry_receipt_org_insert ON notification_retry_receipt
  FOR INSERT WITH CHECK (organization_id = app_current_org());

GRANT SELECT, INSERT ON notification_retry_request, notification_retry_receipt TO solvi_app;
-- No UPDATE/DELETE grant or policy: approvals and terminal receipts are append-only.
COMMENT ON TABLE notification_retry_request IS
  'Immutable fifteen-minute notification approval; lifetime one reservation, no token or message content.';
COMMENT ON TABLE notification_retry_receipt IS
  'Immutable terminal recording-sender result; not an Executor Execution Receipt or proof of external delivery.';

-- +migrate down
-- Disable intake/worker and roll code back first. Never discard approval/result
-- history automatically. This does not undo any already changed notification.
DO $$ BEGIN
  -- A table owner without BYPASSRLS also obeys FORCE RLS. Its empty organization
  -- context cannot prove these tables empty. Refuse rather than drop hidden
  -- history; do not grant privileges or disable row security to run rollback.
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'NOTIFICATION_RETRY_ROLLBACK_VISIBILITY_REQUIRED';
  END IF;
  IF EXISTS (SELECT 1 FROM notification_retry_request)
     OR EXISTS (SELECT 1 FROM notification_retry_receipt) THEN
    RAISE EXCEPTION 'NOTIFICATION_RETRY_HISTORY_PRESENT';
  END IF;
END $$;
DROP TABLE notification_retry_receipt;
DROP TABLE notification_retry_request;
DROP INDEX outbox_retry_org_id_key;
DROP INDEX notification_retry_org_id_key;
