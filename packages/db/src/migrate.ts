import { logger } from "@mcp-knowledge/core";
import { migrateLibsql } from "./libsql.ts";

const url = process.env.DATABASE_URL ?? "file:./data/app.db";
await migrateLibsql(url);
logger.info({ event: "database_migrated", url });
