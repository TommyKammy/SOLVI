-- +migrate up
CREATE TABLE knowledge_article (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id),
  state text NOT NULL CHECK (state IN ('draft', 'review', 'published', 'retired')),
  version integer NOT NULL CHECK (version > 0),
  published_version integer,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id)
);
CREATE TABLE knowledge_version (
  article_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  number integer NOT NULL CHECK (number > 0),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  tags text NOT NULL DEFAULT '' CHECK (length(tags) <= 500),
  audience text NOT NULL CHECK (audience IN ('organization', 'staff')),
  author_id uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (article_id, organization_id, number),
  FOREIGN KEY (article_id, organization_id) REFERENCES knowledge_article(id, organization_id)
);
ALTER TABLE knowledge_article ADD CONSTRAINT knowledge_current_version
  FOREIGN KEY (id, organization_id, version) REFERENCES knowledge_version(article_id, organization_id, number)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge_article ADD CONSTRAINT knowledge_published_version
  FOREIGN KEY (id, organization_id, published_version) REFERENCES knowledge_version(article_id, organization_id, number)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge_article ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_article FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_version FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_article_isolation ON knowledge_article
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
CREATE POLICY knowledge_version_isolation ON knowledge_version
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE ON knowledge_article TO solvi_app;
GRANT SELECT, INSERT ON knowledge_version TO solvi_app;
GRANT SELECT ON knowledge_article, knowledge_version TO solvi_auditor;
CREATE FUNCTION reject_knowledge_version_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'knowledge versions are immutable'; END;
$$;
CREATE TRIGGER knowledge_version_immutable BEFORE UPDATE OR DELETE ON knowledge_version
  FOR EACH ROW EXECUTE FUNCTION reject_knowledge_version_change();
-- +migrate down
-- Destructive to NEW knowledge data. Do not execute for routine local rollback.
ALTER TABLE knowledge_article DROP CONSTRAINT knowledge_current_version;
ALTER TABLE knowledge_article DROP CONSTRAINT knowledge_published_version;
DROP TABLE knowledge_version;
DROP TABLE knowledge_article;
DROP FUNCTION reject_knowledge_version_change();
