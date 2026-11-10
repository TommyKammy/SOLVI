-- +migrate up
CREATE TABLE asset (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organization(id),
 asset_tag text NOT NULL CHECK(length(asset_tag) BETWEEN 1 AND 64),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
 kind text NOT NULL CHECK(kind IN ('pc','server','vm','network','mobile','saas')),
 state text NOT NULL CHECK(state IN ('stocked','in_use','repair','retired')),
 model text NOT NULL DEFAULT '', serial_number text NOT NULL DEFAULT '', hostname text NOT NULL DEFAULT '', vendor text NOT NULL DEFAULT '',
 assigned_user_id uuid REFERENCES app_user(id), location text NOT NULL DEFAULT '', internal_notes text NOT NULL DEFAULT '',
 source_kind text NOT NULL DEFAULT 'manual' CHECK(source_kind='manual'),
 version integer NOT NULL CHECK(version>0), created_by uuid NOT NULL REFERENCES app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,organization_id),
 CHECK(state <> 'in_use' OR assigned_user_id IS NOT NULL),
 CHECK(state NOT IN ('stocked','retired') OR assigned_user_id IS NULL)
);
CREATE UNIQUE INDEX asset_tag_org_key ON asset(organization_id,lower(asset_tag));
CREATE UNIQUE INDEX asset_serial_org_key ON asset(organization_id,lower(serial_number)) WHERE serial_number<>'';
CREATE INDEX asset_owner_state ON asset(organization_id,assigned_user_id,state);
CREATE TABLE asset_revision (
 asset_id uuid NOT NULL, organization_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
 snapshot jsonb NOT NULL, reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),
 changed_by uuid NOT NULL REFERENCES app_user(id), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(asset_id,organization_id,version),
 FOREIGN KEY(asset_id,organization_id) REFERENCES asset(id,organization_id)
);
ALTER TABLE asset ADD CONSTRAINT asset_current_revision_fk FOREIGN KEY(id,organization_id,version)
 REFERENCES asset_revision(asset_id,organization_id,version) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ticket ADD CONSTRAINT ticket_id_org_asset_key UNIQUE(id,organization_id);
CREATE TABLE asset_ticket_link (
 asset_id uuid NOT NULL, ticket_id uuid NOT NULL, organization_id uuid NOT NULL,
 active boolean NOT NULL, version integer NOT NULL CHECK(version>0), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(asset_id,ticket_id,organization_id),
 FOREIGN KEY(asset_id,organization_id) REFERENCES asset(id,organization_id),
 FOREIGN KEY(ticket_id,organization_id) REFERENCES ticket(id,organization_id)
);
CREATE TABLE asset_ticket_event (
 id uuid PRIMARY KEY, asset_id uuid NOT NULL, ticket_id uuid NOT NULL, organization_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0), operation text NOT NULL CHECK(operation IN ('linked','unlinked')),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000), actor_id uuid NOT NULL REFERENCES app_user(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(asset_id,ticket_id,organization_id,version),
 FOREIGN KEY(asset_id,ticket_id,organization_id) REFERENCES asset_ticket_link(asset_id,ticket_id,organization_id)
);
ALTER TABLE asset_ticket_link ADD CONSTRAINT asset_link_current_event_fk FOREIGN KEY(asset_id,ticket_id,organization_id,version)
 REFERENCES asset_ticket_event(asset_id,ticket_id,organization_id,version) DEFERRABLE INITIALLY DEFERRED;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['asset','asset_revision','asset_ticket_link','asset_ticket_event'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY %I ON %I USING(organization_id=app_current_org()) WITH CHECK(organization_id=app_current_org())',t||'_isolation',t);
  EXECUTE format('GRANT SELECT ON %I TO solvi_app,solvi_auditor',t);
 END LOOP;
END $$;
GRANT INSERT,UPDATE ON asset,asset_ticket_link TO solvi_app;
GRANT INSERT ON asset_revision,asset_ticket_event TO solvi_app;
CREATE FUNCTION reject_asset_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'asset history is immutable'; END;
$$;
CREATE TRIGGER asset_revision_immutable BEFORE UPDATE OR DELETE ON asset_revision FOR EACH ROW EXECUTE FUNCTION reject_asset_history_change();
CREATE TRIGGER asset_ticket_event_immutable BEFORE UPDATE OR DELETE ON asset_ticket_event FOR EACH ROW EXECUTE FUNCTION reject_asset_history_change();
-- +migrate down
-- Destructive to NEW assets/history; never used for routine local shutdown.
ALTER TABLE asset_ticket_link DROP CONSTRAINT asset_link_current_event_fk;
DROP TABLE asset_ticket_event;
DROP TABLE asset_ticket_link;
ALTER TABLE ticket DROP CONSTRAINT ticket_id_org_asset_key;
ALTER TABLE asset DROP CONSTRAINT asset_current_revision_fk;
DROP TABLE asset_revision;
DROP TABLE asset;
DROP FUNCTION reject_asset_history_change();
