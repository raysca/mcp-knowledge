import {
  CollectionService,
  DocumentService,
  IngestionService,
  loadWordPiece,
} from "@mcp-knowledge/core";
import { createKnowledgeRepository, migrateLibsql } from "@mcp-knowledge/db";
import { AnyDocParser, NativeTextParser, createParserRegistry } from "@mcp-knowledge/parser";
import { createBlobStore } from "@mcp-knowledge/storage";
import type { AppEnv } from "./config/env.ts";
import { handleRequest, type AppServices } from "./http/router.ts";
import { startWorkerLoop } from "./workers/loop.ts";

export async function createApp(env: AppEnv): Promise<{
  fetch: (req: Request) => Promise<Response>;
  services: AppServices;
  stop: () => void;
}> {
  if (env.DATABASE_DRIVER !== "libsql") {
    throw new Error("M2 only supports DATABASE_DRIVER=libsql");
  }
  await migrateLibsql(env.DATABASE_URL);
  const repo = createKnowledgeRepository(env.DATABASE_URL);
  const blobs = createBlobStore(env);
  const registry = createParserRegistry([
    new NativeTextParser(),
    new AnyDocParser(env.PARSER_TIMEOUT_MS),
  ]);
  const countTokens = await loadWordPiece(env.EMBEDDING_MODEL_PATH);
  const ingestion = new IngestionService(repo, blobs, registry, countTokens, env);
  const documents = new DocumentService(repo, blobs, env.MAX_UPLOAD_BYTES);
  const services: AppServices = {
    env,
    documents,
    collections: new CollectionService(repo),
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
    fetch: (req) => handleRequest(req, services),
  };
}
