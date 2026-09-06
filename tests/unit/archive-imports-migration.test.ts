import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { migrateLibsql } from "../../packages/db/src/index.ts";

describe("archive_imports migration", () => {
  test("creates the table and its index", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-archive-migration-"));
    const url = `file:${join(dir, "app.db")}`;
    try {
      await migrateLibsql(url);
      const client = createClient({ url });
      const table = await client.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'archive_imports'",
      );
      expect(table.rows).toHaveLength(1);
      const index = await client.execute(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'archive_imports_state_created_idx'",
      );
      expect(index.rows).toHaveLength(1);
      client.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("migrating twice is a no-op (idempotent)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-archive-migration-"));
    const url = `file:${join(dir, "app.db")}`;
    try {
      await migrateLibsql(url);
      await migrateLibsql(url); // must not throw
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
