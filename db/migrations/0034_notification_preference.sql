-- WP-P2-NTFPREF-057 / ADR-0039: optional ticket Email preferences only.
-- No existing notification, Outbox, user, role, or audit rows are changed.
-- +migrate up
CREATE TABLE notification_preference (
  organization_id uuid NOT NULL REFERENCES organization(id),
  user_id uuid NOT NULL REFERENCES app_user(id),
  ticket_email_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

ALTER TABLE notification_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preference FORCE ROW LEVEL SECURITY;

-- The ordinary delivery transaction has an organization, but no user actor.
-- SELECT therefore permits same-organization recipient preference lookup.
-- The public API separately limits its reads to the authenticated user.
CREATE POLICY notification_preference_org_read ON notification_preference
  FOR SELECT
  USING (organization_id = app_current_org());

CREATE POLICY notification_preference_self_insert ON notification_preference
  FOR INSERT
  WITH CHECK (
    organization_id = app_current_org()
    AND user_id = NULLIF(current_setting('app.current_actor', true), '')::uuid
  );

CREATE POLICY notification_preference_self_update ON notification_preference
  FOR UPDATE
  USING (
    organization_id = app_current_org()
    AND user_id = NULLIF(current_setting('app.current_actor', true), '')::uuid
  )
  WITH CHECK (
    organization_id = app_current_org()
    AND user_id = NULLIF(current_setting('app.current_actor', true), '')::uuid
  );

GRANT SELECT, INSERT, UPDATE ON notification_preference TO solvi_app;

COMMENT ON TABLE notification_preference IS
  'Optional new ticket Email setting; absent means enabled. Same-org SELECT for delivery, API self-only, DB self-only INSERT/UPDATE, no DELETE grant.';

-- +migrate down
-- Roll back feature code first and assess the loss of OFF settings: dropping this
-- table restores the default ON behavior. Existing notification history remains.
-- Do not run down during ordinary development shutdown.
DROP TABLE notification_preference;
