-- WP-P2-UIX-041 / ADR-0021. Local catalog delegation and fulfillment progress.
-- +migrate up
ALTER TABLE role DROP CONSTRAINT role_code_check;
ALTER TABLE role ADD CONSTRAINT role_code_check CHECK (code IN (
 'platform_admin','platform_auditor','org_admin','agent','approver','auditor','requester','catalog_editor'
));
INSERT INTO role(id,code,scope,name) VALUES
 ('00000000-0000-4000-8000-000000000008','catalog_editor','org','カタログ編集者');

CREATE TABLE local_catalog_question_set_revision (
 set_id uuid NOT NULL, organization_id uuid NOT NULL REFERENCES organization(id),
 revision integer NOT NULL CHECK(revision>0), title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 200),
 description text NOT NULL CHECK(char_length(description)<=2000),
 fields jsonb NOT NULL CHECK(jsonb_typeof(fields)='array' AND jsonb_array_length(fields)<=10),
 sections jsonb NOT NULL CHECK(jsonb_typeof(sections)='array' AND jsonb_array_length(sections)<=10),
 created_by uuid NOT NULL REFERENCES app_user(id), creation_key uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(set_id,organization_id,revision)
);
CREATE UNIQUE INDEX catalog_question_set_creation_key
 ON local_catalog_question_set_revision(organization_id,created_by,creation_key) WHERE creation_key IS NOT NULL;
ALTER TABLE local_catalog_question_set_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_catalog_question_set_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY catalog_question_set_revision_isolation ON local_catalog_question_set_revision
 USING(organization_id=app_current_org()) WITH CHECK(organization_id=app_current_org());
GRANT SELECT,INSERT ON local_catalog_question_set_revision TO solvi_app;
GRANT SELECT ON local_catalog_question_set_revision TO solvi_auditor;
CREATE TRIGGER catalog_question_set_revision_immutable BEFORE UPDATE OR DELETE ON local_catalog_question_set_revision
 FOR EACH ROW EXECUTE FUNCTION reject_asset_history_change();

CREATE TABLE local_request_checklist_progress (
 request_id uuid NOT NULL, organization_id uuid NOT NULL REFERENCES organization(id),
 request_revision integer NOT NULL CHECK(request_revision>0), version integer NOT NULL CHECK(version>0),
 completion jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(completion)='object'),
 updated_by uuid NOT NULL REFERENCES app_user(id), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(request_id,organization_id,request_revision),
 FOREIGN KEY(request_id,organization_id,request_revision)
  REFERENCES local_request_revision(request_id,organization_id,revision)
);
ALTER TABLE local_request_checklist_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_request_checklist_progress FORCE ROW LEVEL SECURITY;
CREATE POLICY request_checklist_progress_isolation ON local_request_checklist_progress
 USING(organization_id=app_current_org()) WITH CHECK(organization_id=app_current_org());
GRANT SELECT,INSERT,UPDATE ON local_request_checklist_progress TO solvi_app;
GRANT SELECT ON local_request_checklist_progress TO solvi_auditor;

-- +migrate down
-- Refuse a lossy rollback. Keep compatible readers and disable the UI/writes instead.
-- A migrator without BYPASSRLS must fail instead of seeing a silently filtered zero count.
SET LOCAL row_security = off;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM local_catalog_question_set_revision)
 OR EXISTS(SELECT 1 FROM local_request_checklist_progress)
 OR EXISTS(SELECT 1 FROM role_binding rb JOIN role r ON r.id=rb.role_id WHERE r.code='catalog_editor')
 OR EXISTS(SELECT 1 FROM local_catalog_revision WHERE definition ?| ARRAY['ownerId','fulfillmentGroupId','checklist'])
 OR EXISTS(SELECT 1 FROM local_service_request WHERE snapshot->'item'->'definition' ?| ARRAY['ownerId','fulfillmentGroupId','checklist'])
 THEN RAISE EXCEPTION '0036 rollback refused: retain catalog operation data and compatible readers'; END IF;
END $$;
DROP TABLE local_request_checklist_progress;
DROP TABLE local_catalog_question_set_revision;
DELETE FROM role WHERE code='catalog_editor';
ALTER TABLE role DROP CONSTRAINT role_code_check;
ALTER TABLE role ADD CONSTRAINT role_code_check CHECK (code IN (
 'platform_admin','platform_auditor','org_admin','agent','approver','auditor','requester'
));
