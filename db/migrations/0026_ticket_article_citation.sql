-- +migrate up
ALTER TABLE ticket_comment ADD CONSTRAINT ticket_comment_id_org UNIQUE(id, organization_id);
CREATE TABLE ticket_article_citation (
  comment_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  article_id uuid NOT NULL,
  article_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(comment_id, organization_id) REFERENCES ticket_comment(id, organization_id),
  FOREIGN KEY(article_id, organization_id, article_version) REFERENCES knowledge_version(article_id, organization_id, number)
);
ALTER TABLE ticket_article_citation ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_article_citation FORCE ROW LEVEL SECURITY;
CREATE POLICY ticket_article_citation_isolation ON ticket_article_citation
  USING(organization_id=app_current_org()) WITH CHECK(organization_id=app_current_org());
GRANT SELECT, INSERT ON ticket_article_citation TO solvi_app;
GRANT SELECT ON ticket_article_citation TO solvi_auditor;
-- +migrate down
-- Would discard NEW citation records: do not execute in routine local development.
DROP TABLE ticket_article_citation;
ALTER TABLE ticket_comment DROP CONSTRAINT ticket_comment_id_org;
