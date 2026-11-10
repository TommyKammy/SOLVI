-- +migrate up
-- Derived work items remain in their existing source tables. Only read receipts persist here.
CREATE TABLE work_inbox_read_receipt (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organization(id),
 user_id uuid NOT NULL REFERENCES app_user(id),
 source_kind text NOT NULL CHECK(source_kind IN ('ticket','request_approval','change')),
 source_id uuid NOT NULL,
 event_key text NOT NULL CHECK(length(event_key)=64),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id,user_id,source_kind,source_id,event_key)
);
ALTER TABLE work_inbox_read_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_inbox_read_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY work_inbox_read_isolation ON work_inbox_read_receipt
 USING(organization_id=app_current_org() AND user_id=NULLIF(current_setting('app.inbox_user',true),'')::uuid)
 WITH CHECK(organization_id=app_current_org() AND user_id=NULLIF(current_setting('app.inbox_user',true),'')::uuid);
GRANT SELECT,INSERT ON work_inbox_read_receipt TO solvi_app;
CREATE TRIGGER work_inbox_read_immutable BEFORE UPDATE OR DELETE ON work_inbox_read_receipt
 FOR EACH ROW EXECUTE FUNCTION reject_asset_history_change();
CREATE INDEX local_request_approver_queue ON local_request_approval(organization_id,approver_id,request_id) WHERE state='pending';
CREATE INDEX local_change_owner_queue ON local_change(organization_id,owner_id,state);
CREATE INDEX local_change_creator_queue ON local_change(organization_id,created_by,state);
-- +migrate down
-- Loses ONLY new read receipts. Do not use for development shutdown.
DROP INDEX local_change_creator_queue;
DROP INDEX local_change_owner_queue;
DROP INDEX local_request_approver_queue;
DROP TABLE work_inbox_read_receipt;
