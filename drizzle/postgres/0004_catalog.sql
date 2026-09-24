CREATE TABLE IF NOT EXISTS corpus_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation BIGINT NOT NULL CHECK (generation >= 0)
);

INSERT INTO corpus_state (id, generation)
SELECT 1, count(*) FROM documents WHERE deleted_at IS NULL
ON CONFLICT (id) DO NOTHING;

CREATE INDEX IF NOT EXISTS documents_catalog_order ON documents(created_at DESC, id DESC)
WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION bump_corpus_generation() RETURNS TRIGGER AS $$
BEGIN
  UPDATE corpus_state SET generation = generation + 1 WHERE id = 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION bump_corpus_generation_delete() RETURNS TRIGGER AS $$
BEGIN
  UPDATE corpus_state SET generation = generation + 1 WHERE id = 1;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS documents_catalog_insert ON documents;
CREATE TRIGGER documents_catalog_insert
AFTER INSERT ON documents
FOR EACH ROW
WHEN (NEW.deleted_at IS NULL)
EXECUTE FUNCTION bump_corpus_generation();

DROP TRIGGER IF EXISTS documents_catalog_update ON documents;
CREATE TRIGGER documents_catalog_update
AFTER UPDATE ON documents
FOR EACH ROW
WHEN ((OLD.deleted_at IS NULL OR NEW.deleted_at IS NULL)
  AND (OLD.status IS DISTINCT FROM NEW.status
    OR OLD.title IS DISTINCT FROM NEW.title
    OR OLD.current_revision_id IS DISTINCT FROM NEW.current_revision_id
    OR OLD.metadata IS DISTINCT FROM NEW.metadata
    OR OLD.collection_id IS DISTINCT FROM NEW.collection_id
    OR OLD.original_filename IS DISTINCT FROM NEW.original_filename
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR OLD.updated_at IS DISTINCT FROM NEW.updated_at
    OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at))
EXECUTE FUNCTION bump_corpus_generation();

DROP TRIGGER IF EXISTS documents_catalog_delete ON documents;
CREATE TRIGGER documents_catalog_delete
AFTER DELETE ON documents
FOR EACH ROW
WHEN (OLD.deleted_at IS NULL)
EXECUTE FUNCTION bump_corpus_generation_delete();
