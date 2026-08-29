ALTER TABLE document_chunks
  ADD COLUMN embedding F32_BLOB(384);

CREATE INDEX document_chunks_embedding_idx
  ON document_chunks (libsql_vector_idx(embedding));
