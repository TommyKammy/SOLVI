-- +migrate up
ALTER TABLE asset DROP CONSTRAINT asset_source_kind_check;
ALTER TABLE asset ADD CONSTRAINT asset_source_kind_check CHECK(source_kind IN ('manual','csv'));
CREATE TABLE asset_import_plan (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organization(id),
 source_key text NOT NULL CHECK(length(source_key) BETWEEN 1 AND 64),
 content_hash text NOT NULL, plan_hash text NOT NULL, plan jsonb NOT NULL,
 created_by uuid NOT NULL REFERENCES app_user(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,organization_id)
);
CREATE TABLE asset_import_receipt (
 import_id uuid PRIMARY KEY, organization_id uuid NOT NULL,
 result jsonb NOT NULL, applied_by uuid NOT NULL REFERENCES app_user(id), applied_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(import_id,organization_id) REFERENCES asset_import_plan(id,organization_id)
);
CREATE TABLE asset_source_identity (
 organization_id uuid NOT NULL, source_key text NOT NULL, external_id text NOT NULL CHECK(length(external_id) BETWEEN 1 AND 120),
 asset_id uuid NOT NULL, import_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,source_key,external_id), UNIQUE(organization_id,source_key,asset_id),
 FOREIGN KEY(asset_id,organization_id) REFERENCES asset(id,organization_id),
 FOREIGN KEY(import_id,organization_id) REFERENCES asset_import_plan(id,organization_id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['asset_import_plan','asset_import_receipt','asset_source_identity'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY %I ON %I USING(organization_id=app_current_org()) WITH CHECK(organization_id=app_current_org())',t||'_isolation',t);
  EXECUTE format('GRANT SELECT ON %I TO solvi_app,solvi_auditor',t);
  EXECUTE format('GRANT INSERT ON %I TO solvi_app',t);
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_asset_history_change()',t||'_immutable',t);
 END LOOP;
END $$;
-- +migrate down
-- Refuses constraint restoration while CSV-created assets exist; never run for routine shutdown.
ALTER TABLE asset DROP CONSTRAINT asset_source_kind_check;
ALTER TABLE asset ADD CONSTRAINT asset_source_kind_check CHECK(source_kind='manual');
DROP TABLE asset_source_identity;
DROP TABLE asset_import_receipt;
DROP TABLE asset_import_plan;
