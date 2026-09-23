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
    const init = await Bun.file(new URL("../../../drizzle/postgres/0001_init.sql", import.meta.url)).text();
    await client.unsafe(init);

    const embeddings = await Bun.file(new URL("../../../drizzle/postgres/0002_embeddings.sql", import.meta.url)).text();
    await client.unsafe(embeddings);

    const fts = await Bun.file(new URL("../../../drizzle/postgres/0003_fts.sql", import.meta.url)).text();
    await client.unsafe(fts);
  } finally {
    await client.end();
  }
}
