export type AppProfile = "local" | "server";
export type DatabaseDriver = "libsql" | "postgres";
export type StorageDriver = "local" | "s3";
export type ProcessRole = "all" | "api" | "worker";

export type AppEnv = {
  APP_PROFILE: AppProfile;
  ROLE: ProcessRole;
  PORT: number;
  HOST: string;
  DATABASE_DRIVER: DatabaseDriver;
  DATABASE_URL: string;
  STORAGE_DRIVER: StorageDriver;
  STORAGE_PATH: string;
  S3_BUCKET?: string;
  S3_ENDPOINT?: string;
  S3_REGION?: string;
  EMBEDDING_PROVIDER: string;
  EMBEDDING_MODEL: string;
  EMBEDDING_MODEL_PATH: string;
  EMBEDDING_DIMENSIONS: number;
  EMBEDDING_MAX_TOKENS: number;
  EMBEDDING_BATCH_SIZE: number;
  VECTOR_CANDIDATES: number;
  LEXICAL_CANDIDATES: number;
  RRF_K: number;
  JOB_LEASE_MS: number;
  WORKER_CONCURRENCY: number;
  MAX_UPLOAD_BYTES: number;
  MAX_EXTRACT_BYTES: number;
  MAX_DOCUMENT_PAGES: number;
  MAX_SPREADSHEET_CELLS: number;
  MAX_ARCHIVE_UNCOMPRESSED_BYTES: number;
  MAX_ARCHIVE_ENTRIES: number;
  MAX_ARCHIVE_COMPRESSION_RATIO: number;
  PARSER_TIMEOUT_MS: number;
  INGESTION_TIMEOUT_MS: number;
  MAX_CHUNKS_PER_DOCUMENT: number;
  MAX_LIST_LIMIT: number;
  DEFAULT_SEARCH_LIMIT: number;
  MAX_SEARCH_LIMIT_API: number;
  MAX_SEARCH_LIMIT_MCP: number;
  URL_FETCH_TIMEOUT_MS: number;
  URL_FETCH_MAX_REDIRECTS: number;
  WEBHOOK_TIMEOUT_MS: number;
  AUTH_DISABLED: boolean;
  MAX_MCP_DOCUMENT_CHARS: number;
};

function int(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid integer: ${raw}`);
  return n;
}

function bool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1";
}

export function loadEnv(source: Record<string, string | undefined> = process.env): AppEnv {
  const profileRaw = source.APP_PROFILE ?? "local";
  if (profileRaw !== "local" && profileRaw !== "server") {
    throw new Error(`Unknown APP_PROFILE: ${profileRaw}`);
  }
  const profile: AppProfile = profileRaw;

  const roleRaw = source.ROLE ?? "all";
  if (roleRaw !== "all" && roleRaw !== "api" && roleRaw !== "worker") {
    throw new Error(`Unknown ROLE: ${roleRaw}`);
  }

  const databaseDriver =
    (source.DATABASE_DRIVER as DatabaseDriver | undefined) ??
    (profile === "server" ? "postgres" : "libsql");
  const storageDriver =
    (source.STORAGE_DRIVER as StorageDriver | undefined) ??
    (profile === "server" ? "s3" : "local");

  return {
    APP_PROFILE: profile,
    ROLE: roleRaw,
    PORT: int(source.PORT, 3000),
    HOST: source.HOST ?? "127.0.0.1",
    DATABASE_DRIVER: databaseDriver,
    DATABASE_URL:
      source.DATABASE_URL ??
      (databaseDriver === "libsql" ? "file:./data/app.db" : ""),
    STORAGE_DRIVER: storageDriver,
    STORAGE_PATH: source.STORAGE_PATH ?? "./data/documents",
    S3_BUCKET: source.S3_BUCKET,
    S3_ENDPOINT: source.S3_ENDPOINT,
    S3_REGION: source.S3_REGION,
    EMBEDDING_PROVIDER: source.EMBEDDING_PROVIDER ?? "local",
    EMBEDDING_MODEL: source.EMBEDDING_MODEL ?? "all-minilm-l6-v2",
    EMBEDDING_MODEL_PATH: source.EMBEDDING_MODEL_PATH ?? "./models/default",
    EMBEDDING_DIMENSIONS: int(source.EMBEDDING_DIMENSIONS, 384),
    EMBEDDING_MAX_TOKENS: int(source.EMBEDDING_MAX_TOKENS, 256),
    EMBEDDING_BATCH_SIZE: int(source.EMBEDDING_BATCH_SIZE, 32),
    VECTOR_CANDIDATES: int(source.VECTOR_CANDIDATES, 50),
    LEXICAL_CANDIDATES: int(source.LEXICAL_CANDIDATES, 50),
    RRF_K: int(source.RRF_K, 60),
    JOB_LEASE_MS: int(source.JOB_LEASE_MS, 300_000),
    WORKER_CONCURRENCY: int(
      source.WORKER_CONCURRENCY,
      profile === "server" ? 4 : 1,
    ),
    MAX_UPLOAD_BYTES: int(source.MAX_UPLOAD_BYTES, 67_108_864),
    MAX_EXTRACT_BYTES: int(source.MAX_EXTRACT_BYTES, 8_388_608),
    MAX_DOCUMENT_PAGES: int(source.MAX_DOCUMENT_PAGES, 500),
    MAX_SPREADSHEET_CELLS: int(source.MAX_SPREADSHEET_CELLS, 200_000),
    MAX_ARCHIVE_UNCOMPRESSED_BYTES: int(
      source.MAX_ARCHIVE_UNCOMPRESSED_BYTES,
      104_857_600,
    ),
    MAX_ARCHIVE_ENTRIES: int(source.MAX_ARCHIVE_ENTRIES, 1024),
    MAX_ARCHIVE_COMPRESSION_RATIO: int(source.MAX_ARCHIVE_COMPRESSION_RATIO, 100),
    PARSER_TIMEOUT_MS: int(source.PARSER_TIMEOUT_MS, 30_000),
    INGESTION_TIMEOUT_MS: int(source.INGESTION_TIMEOUT_MS, 600_000),
    MAX_CHUNKS_PER_DOCUMENT: int(source.MAX_CHUNKS_PER_DOCUMENT, 20_000),
    MAX_LIST_LIMIT: int(source.MAX_LIST_LIMIT, 100),
    DEFAULT_SEARCH_LIMIT: int(source.DEFAULT_SEARCH_LIMIT, 8),
    MAX_SEARCH_LIMIT_API: int(source.MAX_SEARCH_LIMIT_API, 50),
    MAX_SEARCH_LIMIT_MCP: int(source.MAX_SEARCH_LIMIT_MCP, 20),
    URL_FETCH_TIMEOUT_MS: int(source.URL_FETCH_TIMEOUT_MS, 30_000),
    URL_FETCH_MAX_REDIRECTS: int(source.URL_FETCH_MAX_REDIRECTS, 3),
    WEBHOOK_TIMEOUT_MS: int(source.WEBHOOK_TIMEOUT_MS, 10_000),
    // Must stay an explicit opt-in, never a profile default. shouldSkipAuth checks the real
    // per-request remote address (Bun's server.requestIP), not the bind host, which correctly
    // closes the Docker `-p`-requires-0.0.0.0 gap this comment used to only worry about. But
    // it can't see through a reverse proxy: anyone who fronts the local profile with
    // nginx/Caddy/Cloudflare Tunnel on the same box (a common way to reach a self-hosted tool
    // remotely) has every real request arrive from the proxy's own loopback address - defaulting
    // this true would silently grant every proxied caller a free pass, not just this machine's
    // user. The one env var `bun dev` needs is a smaller cost than that failure mode.
    AUTH_DISABLED: bool(source.AUTH_DISABLED, false),
    MAX_MCP_DOCUMENT_CHARS: int(source.MAX_MCP_DOCUMENT_CHARS, 32_000),
  };
}
