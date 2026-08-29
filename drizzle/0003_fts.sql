CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks_fts USING fts5(
  chunk_id UNINDEXED,
  content,
  heading_path,
  tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS document_chunks_fts_ai AFTER INSERT ON document_chunks BEGIN
  INSERT INTO document_chunks_fts(chunk_id, content, heading_path)
  VALUES (
    new.id,
    new.content,
    coalesce((SELECT group_concat(value, ' ') FROM json_each(new.heading_path)), '')
  );
END;

CREATE TRIGGER IF NOT EXISTS document_chunks_fts_ad AFTER DELETE ON document_chunks BEGIN
  DELETE FROM document_chunks_fts WHERE chunk_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS document_chunks_fts_au AFTER UPDATE ON document_chunks BEGIN
  DELETE FROM document_chunks_fts WHERE chunk_id = old.id;
  INSERT INTO document_chunks_fts(chunk_id, content, heading_path)
  VALUES (
    new.id,
    new.content,
    coalesce((SELECT group_concat(value, ' ') FROM json_each(new.heading_path)), '')
  );
END;

INSERT INTO document_chunks_fts(chunk_id, content, heading_path)
SELECT
  id,
  content,
  coalesce((SELECT group_concat(value, ' ') FROM json_each(heading_path)), '')
FROM document_chunks
WHERE id NOT IN (SELECT chunk_id FROM document_chunks_fts);
