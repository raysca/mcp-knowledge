CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  collection_id TEXT REFERENCES collections(id) ON DELETE SET NULL,
  current_revision_id TEXT,
  title TEXT,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  extension TEXT,
  size_bytes BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  latest_error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ
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
  size_bytes BIGINT NOT NULL,
  parser_name TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  chunker_name TEXT NOT NULL,
  chunker_version TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_dimensions INTEGER NOT NULL,
  embedding_version TEXT NOT NULL,
  normalized_storage_key TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
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
  heading_path JSONB NOT NULL DEFAULT '[]'::jsonb,
  location JSONB,
  token_count INTEGER NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
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
  locked_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS ingestion_jobs_status_created_idx ON ingestion_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS ingestion_jobs_revision_id_idx ON ingestion_jobs(revision_id);
CREATE UNIQUE INDEX IF NOT EXISTS ingestion_jobs_active_rev ON ingestion_jobs(revision_id) WHERE status IN ('queued', 'running', 'retrying');

CREATE TABLE IF NOT EXISTS archive_imports (
  id TEXT PRIMARY KEY,
  collection_id TEXT REFERENCES collections(id) ON DELETE SET NULL,
  original_filename TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  state TEXT NOT NULL,
  staging_storage_key TEXT,
  locked_by TEXT,
  locked_at TIMESTAMPTZ,
  entries JSONB NOT NULL DEFAULT '[]'::jsonb,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS archive_imports_state_created_idx ON archive_imports(state, created_at);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS source_scan_state (
  source_id TEXT PRIMARY KEY,
  configuration_fingerprint TEXT NOT NULL,
  active_cycle TEXT,
  limit_reached BOOLEAN NOT NULL DEFAULT FALSE,
  started_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS source_files (
  source_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  sha256 TEXT,
  document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
  last_outcome TEXT NOT NULL,
  scan_cycle TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (source_id, relative_path)
);

CREATE UNIQUE INDEX IF NOT EXISTS source_files_document_owned
  ON source_files(document_id) WHERE document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS source_files_source_sha
  ON source_files(source_id, sha256);
CREATE INDEX IF NOT EXISTS source_files_source_cycle
  ON source_files(source_id, scan_cycle);
