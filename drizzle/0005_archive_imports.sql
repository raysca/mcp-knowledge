CREATE TABLE IF NOT EXISTS archive_imports (
  id TEXT PRIMARY KEY,
  collection_id TEXT REFERENCES collections(id) ON DELETE SET NULL,
  original_filename TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL,
  staging_storage_key TEXT,
  locked_by TEXT,
  locked_at INTEGER,
  entries TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS archive_imports_state_created_idx
  ON archive_imports(state, created_at);
