import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema/postgres.ts";

export type PostgresClient = postgres.Sql;

export function createPostgresClient(url: string, options: postgres.Options<{}> = {}): postgres.Sql {
  return postgres(url, {
    max: 20,
    idle_timeout: 30,
    connect_timeout: 30,
    ...options,
  });
}

export function createPostgresDb(clientOrUrl: string | postgres.Sql) {
  const client = typeof clientOrUrl === "string" ? createPostgresClient(clientOrUrl) : clientOrUrl;
  return drizzle(client, { schema });
}

export async function migratePostgres(url: string): Promise<void> {
  const client = createPostgresClient(url, { max: 1 });
  try {
    const files = [
      "0001_init.sql",
      "0002_embeddings.sql",
      "0003_fts.sql",
      "0004_catalog.sql",
      "0005_fts_titles.sql",
    ];
    for (const file of files) {
      const sql = await Bun.file(new URL(`../../../drizzle/postgres/${file}`, import.meta.url)).text();
      await client.unsafe(sql);
    }
  } finally {
    await client.end();
  }
}
