import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { migrateLibsql } from "../../packages/db/src/index.ts";

describe("migrateLibsql unused tables", () => {
  let dir = "";
  let url = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-migrate-"));
    url = `file:${join(dir, "app.db")}`;
    const client = createClient({ url });
    await client.executeMultiple(`
      CREATE TABLE webhooks (id TEXT PRIMARY KEY);
      CREATE TABLE webhook_deliveries (id TEXT PRIMARY KEY);
      CREATE TABLE system_settings (key TEXT PRIMARY KEY);
    `);
    client.close();
    await migrateLibsql(url);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("drops leftover webhook and settings tables", async () => {
    const client = createClient({ url });
    const rows = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('webhooks', 'webhook_deliveries', 'system_settings')",
    );
    client.close();
    expect(rows.rows).toEqual([]);
  });
});
