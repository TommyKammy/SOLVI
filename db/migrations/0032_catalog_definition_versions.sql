-- +migrate up
ALTER TABLE local_catalog_item ADD COLUMN edit_version integer NOT NULL DEFAULT 1 CHECK(edit_version>0),
 ADD COLUMN draft_revision integer NOT NULL DEFAULT 1 CHECK(draft_revision>0),
 ADD COLUMN published_revision integer,
 ADD COLUMN created_by uuid REFERENCES app_user(id), ADD COLUMN creation_key uuid;
UPDATE local_catalog_item SET draft_revision=version,published_revision=CASE WHEN active THEN version END;
CREATE UNIQUE INDEX catalog_creation_key ON local_catalog_item(organization_id,created_by,creation_key) WHERE creation_key IS NOT NULL;
CREATE TABLE local_catalog_revision (
 item_id uuid NOT NULL, organization_id uuid NOT NULL, revision integer NOT NULL CHECK(revision>0),
 title text NOT NULL, description text NOT NULL, definition jsonb NOT NULL,
 created_by uuid REFERENCES app_user(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(item_id,organization_id,revision),
 FOREIGN KEY(item_id,organization_id) REFERENCES local_catalog_item(id,organization_id)
);
INSERT INTO local_catalog_revision(item_id,organization_id,revision,title,description,definition)
 SELECT id,organization_id,version,title,description,definition FROM local_catalog_item;
ALTER TABLE local_catalog_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_catalog_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY local_catalog_revision_isolation ON local_catalog_revision
 USING(organization_id=app_current_org()) WITH CHECK(organization_id=app_current_org());
GRANT SELECT ON local_catalog_revision TO solvi_app,solvi_auditor;
GRANT INSERT ON local_catalog_revision TO solvi_app;
GRANT INSERT,UPDATE ON local_catalog_item TO solvi_app;
CREATE TRIGGER local_catalog_revision_immutable BEFORE UPDATE OR DELETE ON local_catalog_revision
 FOR EACH ROW EXECUTE FUNCTION reject_asset_history_change();
-- +migrate down
-- Removes only new catalog editing metadata/history; current published projection and requests remain.
-- Do not use for development shutdown. Unsaved/unpublished revisions would be lost.
DROP TABLE local_catalog_revision;
REVOKE INSERT,UPDATE ON local_catalog_item FROM solvi_app;
DROP INDEX catalog_creation_key;
ALTER TABLE local_catalog_item DROP COLUMN edit_version,DROP COLUMN draft_revision,
 DROP COLUMN published_revision,DROP COLUMN created_by,DROP COLUMN creation_key;
