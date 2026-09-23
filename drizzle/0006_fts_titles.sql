-- Run inside the migration runner's write transaction: schema, triggers and backfill
-- become visible together. Reapplying this rebuild is safe and never duplicates rows.
DROP TRIGGER IF EXISTS document_chunks_fts_ai;
DROP TRIGGER IF EXISTS document_chunks_fts_ad;
DROP TRIGGER IF EXISTS document_chunks_fts_au;
DROP TRIGGER IF EXISTS documents_fts_title_au;
DROP TABLE IF EXISTS document_chunks_fts;

CREATE VIRTUAL TABLE document_chunks_fts USING fts5(
  chunk_id UNINDEXED,
  title,
  heading_path,
  content,
  tokenize = 'unicode61'
);

CREATE TRIGGER document_chunks_fts_ai AFTER INSERT ON document_chunks BEGIN
  INSERT INTO document_chunks_fts(chunk_id, title, heading_path, content)
  VALUES (
    new.id,
    coalesce((SELECT title FROM documents WHERE id = new.document_id), ''),
    coalesce((SELECT group_concat(value, ' ') FROM json_each(new.heading_path)), ''),
    new.content
  );
END;

CREATE TRIGGER document_chunks_fts_ad AFTER DELETE ON document_chunks BEGIN
  DELETE FROM document_chunks_fts WHERE chunk_id = old.id;
END;

CREATE TRIGGER document_chunks_fts_au AFTER UPDATE ON document_chunks BEGIN
  DELETE FROM document_chunks_fts WHERE chunk_id = old.id;
  INSERT INTO document_chunks_fts(chunk_id, title, heading_path, content)
  VALUES (
    new.id,
    coalesce((SELECT title FROM documents WHERE id = new.document_id), ''),
    coalesce((SELECT group_concat(value, ' ') FROM json_each(new.heading_path)), ''),
    new.content
  );
END;

-- Ingestion may write chunks before setting the final document title.
CREATE TRIGGER documents_fts_title_au AFTER UPDATE OF title ON documents
WHEN old.title IS NOT new.title BEGIN
  UPDATE document_chunks_fts SET title = coalesce(new.title, '')
  WHERE chunk_id IN (SELECT id FROM document_chunks WHERE document_id = new.id);
END;

INSERT INTO document_chunks_fts(chunk_id, title, heading_path, content)
SELECT c.id, coalesce(d.title, ''),
  coalesce((SELECT group_concat(value, ' ') FROM json_each(c.heading_path)), ''), c.content
FROM document_chunks c JOIN documents d ON d.id = c.document_id;
