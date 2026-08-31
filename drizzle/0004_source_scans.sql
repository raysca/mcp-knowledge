CREATE TABLE IF NOT EXISTS source_scan_state (
  source_id TEXT PRIMARY KEY,
  configuration_fingerprint TEXT NOT NULL,
  active_cycle TEXT,
  limit_reached INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS source_files (
  source_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  sha256 TEXT,
  document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
  last_outcome TEXT NOT NULL,
  scan_cycle TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, relative_path)
);

CREATE UNIQUE INDEX IF NOT EXISTS source_files_document_owned
  ON source_files(document_id) WHERE document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS source_files_source_sha
  ON source_files(source_id, sha256);
CREATE INDEX IF NOT EXISTS source_files_source_cycle
  ON source_files(source_id, scan_cycle);
