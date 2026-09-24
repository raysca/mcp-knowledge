ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(content, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(heading_path::text, '')), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS document_chunks_search_idx ON document_chunks USING gin (search_tsv);
