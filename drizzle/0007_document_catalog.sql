CREATE TABLE IF NOT EXISTS corpus_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL CHECK (generation >= 0)
);

-- The initial generation also accounts for documents that predate this migration.
INSERT OR IGNORE INTO corpus_state (id, generation)
SELECT 1, count(*) FROM documents WHERE deleted_at IS NULL;

-- Older source replacements left retired vectors in ANN candidate selection.
-- This migration also runs at startup: preserve history and live vectors, and
-- only repair non-NULL retired embeddings so repeated runs are no-ops.
UPDATE document_chunks SET embedding = NULL
WHERE embedding IS NOT NULL
  AND document_id IN (SELECT id FROM documents WHERE deleted_at IS NOT NULL);

CREATE INDEX IF NOT EXISTS documents_catalog_order ON documents(created_at DESC, id DESC)
WHERE deleted_at IS NULL;

CREATE TRIGGER IF NOT EXISTS documents_catalog_insert
AFTER INSERT ON documents WHEN NEW.deleted_at IS NULL
BEGIN
  UPDATE corpus_state SET generation = generation + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS documents_catalog_update
AFTER UPDATE ON documents
WHEN (OLD.deleted_at IS NULL OR NEW.deleted_at IS NULL)
  AND (OLD.status IS NOT NEW.status
    OR OLD.title IS NOT NEW.title
    OR OLD.current_revision_id IS NOT NEW.current_revision_id
    OR OLD.metadata IS NOT NEW.metadata
    OR OLD.collection_id IS NOT NEW.collection_id
    OR OLD.original_filename IS NOT NEW.original_filename
    OR OLD.created_at IS NOT NEW.created_at
    OR OLD.updated_at IS NOT NEW.updated_at
    OR OLD.deleted_at IS NOT NEW.deleted_at)
BEGIN
  UPDATE corpus_state SET generation = generation + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS documents_catalog_delete
AFTER DELETE ON documents WHEN OLD.deleted_at IS NULL
BEGIN
  UPDATE corpus_state SET generation = generation + 1 WHERE id = 1;
END;
