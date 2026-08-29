import { CollectionService, DocumentService } from "@mcp-knowledge/core";
import { createKnowledgeRepository, migrateLibsql } from "@mcp-knowledge/db";
import { createBlobStore } from "@mcp-knowledge/storage";
import type { AppEnv } from "./config/env.ts";
import { handleRequest, type AppServices } from "./http/router.ts";

export async function createApp(env: AppEnv): Promise<{
  fetch: (req: Request) => Promise<Response>;
  services: AppServices;
}> {
  if (env.DATABASE_DRIVER !== "libsql") {
    throw new Error("M1 only supports DATABASE_DRIVER=libsql");
  }
  await migrateLibsql(env.DATABASE_URL);
  const repo = createKnowledgeRepository(env.DATABASE_URL);
  const blobs = createBlobStore(env);
  const services: AppServices = {
    env,
    documents: new DocumentService(repo, blobs, env.MAX_UPLOAD_BYTES),
    collections: new CollectionService(repo),
  };
  return {
    services,
    fetch: (req) => handleRequest(req, services),
  };
}
