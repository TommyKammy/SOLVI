-- +migrate up
CREATE TABLE local_change (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organization(id), sequence_no integer NOT NULL CHECK(sequence_no>0),
 ticket_id uuid NOT NULL, owner_id uuid NOT NULL REFERENCES app_user(id), created_by uuid NOT NULL REFERENCES app_user(id),
 creation_key uuid NOT NULL, creation_hash text NOT NULL,
 version integer NOT NULL CHECK(version>0), revision integer NOT NULL CHECK(revision>0),
 state text NOT NULL CHECK(state IN ('draft','review','approved','rejected','scheduled','in_progress','completed','failed','cancelled')),
 snapshot jsonb NOT NULL, snapshot_hash text NOT NULL CHECK(length(snapshot_hash)=64), current_approval_id uuid,
 started_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,organization_id), UNIQUE(organization_id,sequence_no), UNIQUE(organization_id,created_by,creation_key),
 FOREIGN KEY(ticket_id,organization_id) REFERENCES ticket(id,organization_id),
 CHECK(state NOT IN ('in_progress','completed','failed') OR started_at IS NOT NULL)
);
CREATE TABLE local_change_revision (
 change_id uuid NOT NULL, organization_id uuid NOT NULL, revision integer NOT NULL,
 snapshot jsonb NOT NULL, snapshot_hash text NOT NULL, reason text NOT NULL,
 actor_id uuid NOT NULL REFERENCES app_user(id), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(change_id,organization_id,revision), UNIQUE(change_id,organization_id,revision,snapshot_hash), FOREIGN KEY(change_id,organization_id) REFERENCES local_change(id,organization_id)
);
ALTER TABLE local_change ADD CONSTRAINT local_change_current_revision_fk FOREIGN KEY(id,organization_id,revision,snapshot_hash)
 REFERENCES local_change_revision(change_id,organization_id,revision,snapshot_hash) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE local_change_asset (
 change_id uuid NOT NULL, asset_id uuid NOT NULL, organization_id uuid NOT NULL, active boolean NOT NULL,
 PRIMARY KEY(change_id,asset_id,organization_id),
 FOREIGN KEY(change_id,organization_id) REFERENCES local_change(id,organization_id), FOREIGN KEY(asset_id,organization_id) REFERENCES asset(id,organization_id)
);
CREATE TABLE local_change_approval (
 id uuid PRIMARY KEY, change_id uuid NOT NULL, organization_id uuid NOT NULL, revision integer NOT NULL,
 snapshot_hash text NOT NULL, approver_id uuid NOT NULL REFERENCES app_user(id), expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,organization_id), UNIQUE(id,change_id,organization_id,revision),
 FOREIGN KEY(change_id,organization_id,revision) REFERENCES local_change_revision(change_id,organization_id,revision)
);
ALTER TABLE local_change ADD CONSTRAINT local_change_current_approval_fk FOREIGN KEY(current_approval_id,id,organization_id,revision)
 REFERENCES local_change_approval(id,change_id,organization_id,revision) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE local_change_decision (
 approval_id uuid NOT NULL, organization_id uuid NOT NULL, decision text NOT NULL CHECK(decision IN ('approved','rejected')),
 reason text NOT NULL, actor_id uuid NOT NULL REFERENCES app_user(id), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(approval_id,organization_id), FOREIGN KEY(approval_id,organization_id) REFERENCES local_change_approval(id,organization_id)
);
CREATE TABLE local_change_event (
 id uuid PRIMARY KEY, change_id uuid NOT NULL, organization_id uuid NOT NULL, version integer NOT NULL, revision integer NOT NULL,
 action text NOT NULL, before_state text, after_state text NOT NULL, reason text NOT NULL,
 command_key uuid NOT NULL, input_hash text NOT NULL, response jsonb NOT NULL,
 actor_id uuid NOT NULL REFERENCES app_user(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(change_id,organization_id,version), UNIQUE(change_id,organization_id,command_key),
 FOREIGN KEY(change_id,organization_id) REFERENCES local_change(id,organization_id)
);
ALTER TABLE local_change ADD CONSTRAINT local_change_current_event_fk FOREIGN KEY(id,organization_id,version)
 REFERENCES local_change_event(change_id,organization_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE local_change_result (
 id uuid PRIMARY KEY, change_id uuid NOT NULL, organization_id uuid NOT NULL, revision integer NOT NULL, approval_id uuid NOT NULL,
 snapshot_hash text NOT NULL, outcome text NOT NULL CHECK(outcome IN ('completed','failed')),
 summary text NOT NULL, test_results text NOT NULL, backout_performed boolean NOT NULL, backout_reason text NOT NULL,
 simulation boolean NOT NULL CHECK(simulation), external_changes integer NOT NULL CHECK(external_changes=0),
 started_at timestamptz NOT NULL, finished_at timestamptz NOT NULL,
 actor_id uuid NOT NULL REFERENCES app_user(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(change_id,organization_id), FOREIGN KEY(change_id,organization_id,revision) REFERENCES local_change_revision(change_id,organization_id,revision),
 FOREIGN KEY(approval_id,change_id,organization_id,revision) REFERENCES local_change_approval(id,change_id,organization_id,revision), CHECK(finished_at>=started_at)
);
CREATE TABLE local_change_pir (
 id uuid PRIMARY KEY, change_id uuid NOT NULL, organization_id uuid NOT NULL,
 root_cause text NOT NULL, lessons text NOT NULL, prevention text NOT NULL,
 actor_id uuid NOT NULL REFERENCES app_user(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(change_id,organization_id), FOREIGN KEY(change_id,organization_id) REFERENCES local_change_result(change_id,organization_id)
);
CREATE INDEX local_change_state_updated ON local_change(organization_id,state,updated_at);
CREATE INDEX local_change_ticket ON local_change(organization_id,ticket_id);
CREATE INDEX local_change_asset_lookup ON local_change_asset(organization_id,asset_id) WHERE active;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['local_change','local_change_revision','local_change_asset','local_change_approval','local_change_decision','local_change_event','local_change_result','local_change_pir'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY %I ON %I USING(organization_id=app_current_org()) WITH CHECK(organization_id=app_current_org())',t||'_isolation',t);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO solvi_app',t);
  EXECUTE format('GRANT SELECT ON %I TO solvi_auditor',t);
  IF t NOT IN ('local_change','local_change_asset') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_asset_history_change()',t||'_immutable',t);
  END IF;
 END LOOP;
END $$;
GRANT UPDATE ON local_change,local_change_asset TO solvi_app;
-- +migrate down
-- Destructive to NEW local Change history; not for normal development shutdown.
DROP TABLE local_change_pir;
DROP TABLE local_change_result;
ALTER TABLE local_change DROP CONSTRAINT local_change_current_event_fk;
DROP TABLE local_change_event;
DROP TABLE local_change_decision;
ALTER TABLE local_change DROP CONSTRAINT local_change_current_approval_fk;
DROP TABLE local_change_approval;
DROP TABLE local_change_asset;
ALTER TABLE local_change DROP CONSTRAINT local_change_current_revision_fk;
DROP TABLE local_change_revision;
DROP TABLE local_change;
