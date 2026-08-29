import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema/libsql.ts";

export async function migrateLibsql(url: string): Promise<void> {
  if (url.startsWith("file:")) {
    const file = url.slice("file:".length);
    if (file !== ":memory:" && file.length > 0) {
      await mkdir(dirname(file), { recursive: true });
    }
  }
  const client = createClient({ url });
  const init = await Bun.file(new URL("../../../drizzle/0001_init.sql", import.meta.url)).text();
  await client.executeMultiple(init);
  const info = await client.execute("PRAGMA table_info(document_chunks)");
  const hasEmbedding = info.rows.some((row) => {
    const name = (row as { name?: unknown }).name ?? (row as unknown as unknown[])[1];
    return name === "embedding";
  });
  if (!hasEmbedding) {
    const alter = await Bun.file(
      new URL("../../../drizzle/0002_embeddings.sql", import.meta.url),
    ).text();
    await client.executeMultiple(alter);
  }
  const fts = await client.execute(
    "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = 'document_chunks_fts'",
  );
  if (fts.rows.length === 0) {
    const sql = await Bun.file(
      new URL("../../../drizzle/0003_fts.sql", import.meta.url),
    ).text();
    await client.executeMultiple(sql);
  }
  client.close();
}

export function createLibsqlDb(url: string) {
  const client = createClient({ url });
  return drizzle(client, { schema });
}
