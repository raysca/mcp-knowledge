import { logger } from "@mcp-knowledge/core";
import { migrateLibsql } from "./libsql.ts";
import { migratePostgres } from "./postgres.ts";

const driver = process.env.DATABASE_DRIVER;
const url = process.env.DATABASE_URL ?? "file:./data/app.db";

if (driver === "postgres" || url.startsWith("postgres://") || url.startsWith("postgresql://")) {
  await migratePostgres(url);
  logger.info({ event: "database_migrated", driver: "postgres", url });
} else {
  await migrateLibsql(url);
  logger.info({ event: "database_migrated", driver: "libsql", url });
}
