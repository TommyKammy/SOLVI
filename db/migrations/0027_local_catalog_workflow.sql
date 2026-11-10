-- +migrate up
CREATE TABLE local_catalog_item (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organization(id),
  code text NOT NULL, version integer NOT NULL CHECK(version>0), title text NOT NULL,
  description text NOT NULL, definition jsonb NOT NULL, active boolean NOT NULL DEFAULT true,
  UNIQUE(organization_id,code), UNIQUE(id,organization_id)
);
INSERT INTO local_catalog_item(id,organization_id,code,version,title,description,definition)
SELECT gen_random_uuid(),o.id,x.code,1,x.title,'ローカル検証用。承認手続きを試し、模擬結果を保存します。外部の権限やアカウントは変更しません。',
 jsonb_build_object('mode','local_simulation','action','simulate.access_grant','targetLabel',x.target,'allowedDurations',jsonb_build_array(1,7,30),'maxReasonLength',2000)
FROM organization o CROSS JOIN (VALUES
 ('vpn-demo','VPN アクセス申請（模擬）','検証用 VPN グループ'),
 ('tools-demo','開発ツール利用申請（模擬）','検証用 開発ツールグループ')
) x(code,title,target);
CREATE TABLE local_service_request (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organization(id),
  item_id uuid NOT NULL, requester_id uuid NOT NULL REFERENCES app_user(id),
  ticket_id uuid NOT NULL REFERENCES ticket(id), idempotency_key uuid NOT NULL,
  version integer NOT NULL CHECK(version>0), revision integer NOT NULL CHECK(revision>0),
  state text NOT NULL CHECK(state IN ('pending','approved','rejected','invalidated','completed','cancelled')),
  snapshot jsonb NOT NULL, snapshot_hash text NOT NULL CHECK(length(snapshot_hash)=64),
  current_approval_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,organization_id), UNIQUE(organization_id,requester_id,idempotency_key),
  FOREIGN KEY(item_id,organization_id) REFERENCES local_catalog_item(id,organization_id)
);
CREATE TABLE local_request_revision (
  request_id uuid NOT NULL, organization_id uuid NOT NULL, revision integer NOT NULL,
  snapshot jsonb NOT NULL, snapshot_hash text NOT NULL, changed_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(request_id,organization_id,revision),
  FOREIGN KEY(request_id,organization_id) REFERENCES local_service_request(id,organization_id)
);
CREATE TABLE local_request_approval (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, request_id uuid NOT NULL,
  revision integer NOT NULL, snapshot_hash text NOT NULL, approver_id uuid NOT NULL REFERENCES app_user(id),
  state text NOT NULL CHECK(state IN ('pending','approved','rejected','invalidated','cancelled','expired')),
  reason text, decided_at timestamptz, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,organization_id),
  FOREIGN KEY(request_id,organization_id,revision) REFERENCES local_request_revision(request_id,organization_id,revision)
);
ALTER TABLE local_service_request ADD CONSTRAINT local_request_approval_fk
 FOREIGN KEY(current_approval_id,organization_id) REFERENCES local_request_approval(id,organization_id)
 DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE local_simulation_receipt (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, request_id uuid NOT NULL,
  approval_id uuid NOT NULL, snapshot_hash text NOT NULL, idempotency_key text NOT NULL UNIQUE,
  simulation boolean NOT NULL CHECK(simulation), result jsonb NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(request_id,organization_id),
  FOREIGN KEY(request_id,organization_id) REFERENCES local_service_request(id,organization_id),
  FOREIGN KEY(approval_id,organization_id) REFERENCES local_request_approval(id,organization_id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['local_catalog_item','local_service_request','local_request_revision','local_request_approval','local_simulation_receipt'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY %I ON %I USING(organization_id=app_current_org()) WITH CHECK(organization_id=app_current_org())',t||'_isolation',t);
  EXECUTE format('GRANT SELECT ON %I TO solvi_app, solvi_auditor',t);
 END LOOP;
END $$;
GRANT INSERT,UPDATE ON local_service_request,local_request_approval TO solvi_app;
GRANT INSERT ON local_request_revision,local_simulation_receipt TO solvi_app;
-- +migrate down
-- Deletes NEW workflow data: not part of normal development shutdown/rollback.
DROP TABLE local_simulation_receipt;
ALTER TABLE local_service_request DROP CONSTRAINT local_request_approval_fk;
DROP TABLE local_request_approval;
DROP TABLE local_request_revision;
DROP TABLE local_service_request;
DROP TABLE local_catalog_item;
