import { resolve } from "node:path";
import {
  ApiKeyService,
  ArchiveImportService,
  CollectionService,
  DocumentService,
  IngestionService,
  SearchService,
  SourceImportService,
  UrlIngestService,
  loadWordPiece,
} from "@mcp-knowledge/core";
import { createKnowledgeRepository, migrateLibsql } from "@mcp-knowledge/db";
import { LocalTransformersEmbedder } from "@mcp-knowledge/embeddings";
import { AnyDocParser, NativeTextParser, createParserRegistry } from "@mcp-knowledge/parser";
import { LibsqlLexicalIndex, LibsqlVectorIndex } from "@mcp-knowledge/retrieval";
import { createBlobStore } from "@mcp-knowledge/storage";
import type { AppEnv } from "./config/env.ts";
import { handleRequest, type AppServices } from "./http/router.ts";
import { LocalDirectorySource } from "./startup-scan/local-directory-source.ts";
import { StartupIngestionCoordinator } from "./startup-scan/coordinator.ts";
import { startWorkerLoop } from "./workers/loop.ts";

export type AppOverrides = {
  createDirectorySource?: (input: {
    root: string;
    maxDepth: number;
  }) => Promise<Pick<
    LocalDirectorySource,
    "sourceId" | "configurationFingerprint" | "candidates" | "inspectAndRead" | "pathState"
  >>;
};

export async function createApp(env: AppEnv, overrides: AppOverrides = {}): Promise<{
  fetch: (
    req: Request,
    server?: { requestIP?: (req: Request) => { address: string } | null },
  ) => Promise<Response>;
  services: AppServices;
  startStartupScan: () => void;
  stop: () => void;
}> {
  if (env.DATABASE_DRIVER !== "libsql") {
    throw new Error("M3 only supports DATABASE_DRIVER=libsql");
  }
  await migrateLibsql(env.DATABASE_URL);
  const repo = createKnowledgeRepository(env.DATABASE_URL);
  const blobs = createBlobStore(env);
  const registry = createParserRegistry([
    new NativeTextParser(),
    new AnyDocParser(env.PARSER_TIMEOUT_MS),
  ]);
  const modelPath = resolve(env.EMBEDDING_MODEL_PATH);
  const countTokens = await loadWordPiece(modelPath);
  const embedder = new LocalTransformersEmbedder({ modelPath });
  const vectors = new LibsqlVectorIndex(env.DATABASE_URL);
  const lexical = new LibsqlLexicalIndex(env.DATABASE_URL);
  const ingestion = new IngestionService(repo, blobs, registry, countTokens, embedder, vectors, env);
  const documents = new DocumentService(repo, blobs, env.MAX_UPLOAD_BYTES);
  const archives = new ArchiveImportService(repo, blobs, documents, {
    MAX_UPLOAD_BYTES: env.MAX_UPLOAD_BYTES,
    MAX_ARCHIVE_ENTRIES: env.MAX_ARCHIVE_ENTRIES,
    MAX_ARCHIVE_UNCOMPRESSED_BYTES: env.MAX_ARCHIVE_UNCOMPRESSED_BYTES,
    MAX_ARCHIVE_COMPRESSION_RATIO: env.MAX_ARCHIVE_COMPRESSION_RATIO,
  });
  const stopWorker =
    env.ROLE === "api"
      ? () => undefined
      : startWorkerLoop({
          repo,
          ingestion,
          archives,
          leaseMs: env.JOB_LEASE_MS,
          ingestionTimeoutMs: env.INGESTION_TIMEOUT_MS,
        });
  const createDirectorySource = overrides.createDirectorySource ?? LocalDirectorySource.create;
  const disabledReason = !env.INGEST_DATA_DIR
    ? "not_configured"
    : env.APP_PROFILE !== "local"
      ? "unsupported_profile"
      : env.ROLE !== "all"
        ? "unsupported_role"
        : undefined;
  const sourceFactory = disabledReason
    ? undefined
    : () =>
        createDirectorySource({
          root: env.INGEST_DATA_DIR!,
          maxDepth: env.INGEST_DATA_MAX_DEPTH,
        });
  const startupScan = new StartupIngestionCoordinator({
    repo,
    maxFiles: env.INGEST_DATA_MAX_FILES,
    disabledReason,
    createSource: sourceFactory,
    createImporter: sourceFactory
      ? (source, signal) =>
          new SourceImportService({
            source,
            repo,
            blobs,
            archives,
            maxUploadBytes: env.MAX_UPLOAD_BYTES,
            signal,
          })
      : undefined,
  });
  const services: AppServices = {
    env,
    documents,
    archives,
    collections: new CollectionService(repo),
    search: new SearchService(embedder, vectors, lexical, repo, env),
    keys: new ApiKeyService(repo),
    urls: new UrlIngestService(documents, env),
    startupScan,
  };
  return {
    services,
    startStartupScan: () => startupScan.start(),
    stop: () => {
      startupScan.stop();
      stopWorker();
      embedder.stop();
    },
    fetch: (req, server) => handleRequest(req, services, server?.requestIP?.(req)?.address),
  };
}
