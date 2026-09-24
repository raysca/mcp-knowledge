ALTER TABLE documents ADD COLUMN IF NOT EXISTS title_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A')
  ) STORED;

CREATE INDEX IF NOT EXISTS documents_title_search_idx ON documents USING gin (title_tsv);

ALTER TABLE document_chunks DROP COLUMN IF EXISTS search_tsv CASCADE;
ALTER TABLE document_chunks ADD COLUMN search_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(heading_path::text, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(content, '')), 'C')
  ) STORED;

CREATE INDEX IF NOT EXISTS document_chunks_search_idx ON document_chunks USING gin (search_tsv);
