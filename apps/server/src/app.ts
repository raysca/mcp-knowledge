import { resolve } from "node:path";
import {
  ApiKeyService,
  CollectionService,
  DocumentService,
  IngestionService,
  SearchService,
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
import { startWorkerLoop } from "./workers/loop.ts";

export async function createApp(env: AppEnv): Promise<{
  fetch: (
    req: Request,
    server?: { requestIP?: (req: Request) => { address: string } | null },
  ) => Promise<Response>;
  services: AppServices;
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
  const services: AppServices = {
    env,
    documents,
    collections: new CollectionService(repo),
    search: new SearchService(embedder, vectors, lexical, repo, env),
    keys: new ApiKeyService(repo),
    urls: new UrlIngestService(documents, env),
  };
  const stopWorker =
    env.ROLE === "api"
      ? () => undefined
      : startWorkerLoop({
          repo,
          ingestion,
          leaseMs: env.JOB_LEASE_MS,
          ingestionTimeoutMs: env.INGESTION_TIMEOUT_MS,
        });
  return {
    services,
    stop: stopWorker,
    fetch: (req, server) => handleRequest(req, services, server?.requestIP?.(req)?.address),
  };
}
