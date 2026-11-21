-- WP-P3-KNWUI-062. NULL retains the original literal text in immutable versions.
-- +migrate up
ALTER TABLE knowledge_version ADD COLUMN body_doc_v1 jsonb
  CHECK (body_doc_v1 IS NULL OR (jsonb_typeof(body_doc_v1) = 'object' AND body_doc_v1->>'type' IS NOT DISTINCT FROM 'doc'));

-- +migrate down
LOCK TABLE knowledge_version IN ACCESS EXCLUSIVE MODE;
SET LOCAL row_security = off;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM knowledge_version WHERE body_doc_v1 IS NOT NULL) THEN
    RAISE EXCEPTION 'Rich knowledge versions exist. Keep the read-compatible schema.';
  END IF;
END $$;
ALTER TABLE knowledge_version DROP COLUMN body_doc_v1;
