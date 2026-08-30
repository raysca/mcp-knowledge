CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  collection_id TEXT REFERENCES collections(id) ON DELETE SET NULL,
  current_revision_id TEXT,
  title TEXT,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  extension TEXT,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  latest_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS documents_collection_id_idx ON documents(collection_id);
CREATE INDEX IF NOT EXISTS documents_status_idx ON documents(status);
CREATE INDEX IF NOT EXISTS documents_deleted_at_idx ON documents(deleted_at);
CREATE UNIQUE INDEX IF NOT EXISTS documents_sha256_live ON documents(sha256) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS document_revisions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  parser_name TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  chunker_name TEXT NOT NULL,
  chunker_version TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_dimensions INTEGER NOT NULL,
  embedding_version TEXT NOT NULL,
  normalized_storage_key TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (document_id, revision)
);

CREATE INDEX IF NOT EXISTS document_revisions_document_id_idx ON document_revisions(document_id);

CREATE TABLE IF NOT EXISTS document_chunks (
  id TEXT PRIMARY KEY,
  collection_id TEXT,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES document_revisions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding_text TEXT NOT NULL,
  heading_path TEXT NOT NULL DEFAULT '[]',
  location TEXT,
  token_count INTEGER NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (revision_id, sequence),
  UNIQUE (revision_id, content_hash)
);

CREATE INDEX IF NOT EXISTS document_chunks_document_id_idx ON document_chunks(document_id);

CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES document_revisions(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  locked_by TEXT,
  locked_at INTEGER,
  started_at INTEGER,
  completed_at INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ingestion_jobs_status_created_idx ON ingestion_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS ingestion_jobs_revision_id_idx ON ingestion_jobs(revision_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

-- ponytail: webhooks/settings are post-v1. DROP so existing local DBs lose the empty tables.
DROP TABLE IF EXISTS webhook_deliveries;
DROP TABLE IF EXISTS webhooks;
DROP TABLE IF EXISTS system_settings;
