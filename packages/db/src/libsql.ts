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
  const sqlPath = new URL("../../../drizzle/0001_init.sql", import.meta.url);
  const sql = await Bun.file(sqlPath).text();
  const client = createClient({ url });
  await client.executeMultiple(sql);
  client.close();
}

export function createLibsqlDb(url: string) {
  const client = createClient({ url });
  return drizzle(client, { schema });
}
