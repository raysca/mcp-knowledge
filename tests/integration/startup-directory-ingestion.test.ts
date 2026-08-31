import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnowledgeRepository } from "../../packages/core/src/index.ts";
import { createKnowledgeRepository } from "../../packages/db/src/index.ts";
import { createApp } from "../../apps/server/src/app.ts";
import { loadEnv } from "../../apps/server/src/config/env.ts";
import type { StartupScanStatus } from "../../apps/server/src/startup-scan/coordinator.ts";
import { LocalDirectorySource } from "../../apps/server/src/startup-scan/local-directory-source.ts";

async function waitForScan(base: string): Promise<StartupScanStatus> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const status = (await fetch(`${base}/api/v1/ingest/scan-status`).then((r) =>
      r.json(),
    )) as StartupScanStatus;
    if (["completed", "completed_with_errors", "failed"].includes(status.state)) return status;
    await Bun.sleep(20);
  }
  throw new Error("scan did not finish");
}

type Doc = { id: string; originalFilename: string; status: string };

describe("startup directory ingestion (end to end)", () => {
  let baseDir = "";
  let sourceRoot = "";
  let dbPath = "";
  let blobsPath = "";
  let sourceId = "";
  const repos: KnowledgeRepository[] = [];

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "mcp-startup-scan-"));
    sourceRoot = join(baseDir, "source");
    dbPath = join(baseDir, "app.db");
    blobsPath = join(baseDir, "blobs");
    await mkdir(sourceRoot, { recursive: true });
    sourceId = (await LocalDirectorySource.create({ root: sourceRoot, maxDepth: 8 })).sourceId;
  });

  afterAll(async () => {
    for (const repo of repos) {
      const maybeCloseable = repo as unknown as { close?: () => void };
      maybeCloseable.close?.();
    }
    await rm(baseDir, { recursive: true, force: true });
  });

  function repo(): KnowledgeRepository {
    const created = createKnowledgeRepository(`file:${dbPath}`);
    repos.push(created);
    return created;
  }

  // Boots a fresh app instance against the same database/source root, runs a startup scan
  // to completion, and tears the instance down again - this is how each scenario proves
  // its behavior survives a real process restart rather than reusing in-memory state.
  async function runScan(): Promise<{ status: StartupScanStatus; jobCount: number; docs: Doc[] }> {
    const env = loadEnv({
      DATABASE_URL: `file:${dbPath}`,
      STORAGE_PATH: blobsPath,
      INGEST_DATA_DIR: sourceRoot,
    });
    const app = await createApp(env);
    const server = Bun.serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      app.startStartupScan();
      const status = await waitForScan(base);
      const jobs = (await fetch(`${base}/api/v1/jobs`).then((r) => r.json())) as {
        items: unknown[];
      };
      const docs = (await fetch(`${base}/api/v1/documents?limit=100`).then((r) => r.json())) as {
        items: Doc[];
      };
      return { status, jobCount: jobs.items.length, docs: docs.items };
    } finally {
      app.stop();
      server.stop(true);
    }
  }

  // Runs a plain API request (upload, purge, ...) against a throwaway app instance, without
  // triggering a startup scan.
  async function withApp<T>(fn: (base: string) => Promise<T>): Promise<T> {
    const env = loadEnv({
      DATABASE_URL: `file:${dbPath}`,
      STORAGE_PATH: blobsPath,
      INGEST_DATA_DIR: sourceRoot,
    });
    const app = await createApp(env);
    const server = Bun.serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      return await fn(base);
    } finally {
      app.stop();
      server.stop(true);
    }
  }

  async function docStatus(base: string, id: string): Promise<number> {
    return (await fetch(`${base}/api/v1/documents/${id}`)).status;
  }

  test("imports a new file", async () => {
    await writeFile(join(sourceRoot, "note.txt"), "hello from disk\n");

    const first = await runScan();
    expect(first.status.state).toBe("completed");
    expect(first.jobCount).toBe(1);
    const note = first.docs.filter((d) => d.originalFilename === "note.txt");
    expect(note.length).toBe(1);
    expect(["processing", "ready"]).toContain(note[0]!.status);
  });

  test("unchanged restart: same live document ID, no additional job", async () => {
    await writeFile(join(sourceRoot, "unchanged.txt"), "steady state\n");
    const first = await runScan();
    const before = first.docs.find((d) => d.originalFilename === "unchanged.txt");
    expect(before).toBeDefined();

    const second = await runScan();
    expect(second.status.state).toBe("completed");
    expect(second.jobCount).toBe(first.jobCount);
    const after = second.docs.find((d) => d.originalFilename === "unchanged.txt");
    expect(after?.id).toBe(before!.id);

    await withApp(async (base) => {
      expect(await docStatus(base, before!.id)).toBe(200);
    });
  });

  test("changed same path: old ID 404s, new ID exists, one additional job", async () => {
    await writeFile(join(sourceRoot, "changeme.txt"), "version one\n");
    const first = await runScan();
    const oldDoc = first.docs.find((d) => d.originalFilename === "changeme.txt");
    expect(oldDoc).toBeDefined();

    await writeFile(join(sourceRoot, "changeme.txt"), "version two, different bytes\n");
    const second = await runScan();
    expect(second.status.state).toBe("completed");
    expect(second.jobCount).toBe(first.jobCount + 1);

    await withApp(async (base) => {
      expect(await docStatus(base, oldDoc!.id)).toBe(404);
    });
    const newDoc = second.docs.find(
      (d) => d.originalFilename === "changeme.txt" && d.id !== oldDoc!.id,
    );
    expect(newDoc).toBeDefined();
    await withApp(async (base) => {
      expect(await docStatus(base, newDoc!.id)).toBe(200);
    });
  });

  test("rename same bytes: old ID 404s, new path owns a new ID, one additional job", async () => {
    await writeFile(join(sourceRoot, "rename-src.txt"), "rename me please\n");
    const first = await runScan();
    const oldDoc = first.docs.find((d) => d.originalFilename === "rename-src.txt");
    expect(oldDoc).toBeDefined();

    await rename(join(sourceRoot, "rename-src.txt"), join(sourceRoot, "rename-dst.txt"));
    const second = await runScan();
    expect(second.status.state).toBe("completed");
    expect(second.jobCount).toBe(first.jobCount + 1);

    await withApp(async (base) => {
      expect(await docStatus(base, oldDoc!.id)).toBe(404);
    });
    const renamedDoc = second.docs.find((d) => d.originalFilename === "rename-dst.txt");
    expect(renamedDoc).toBeDefined();
    expect(renamedDoc!.id).not.toBe(oldDoc!.id);
    await withApp(async (base) => {
      expect(await docStatus(base, renamedDoc!.id)).toBe(200);
    });
    expect(second.docs.some((d) => d.originalFilename === "rename-src.txt")).toBe(false);
  });

  test("copy while old exists: one live document, no additional job", async () => {
    await writeFile(join(sourceRoot, "copy-src.txt"), "copy me exactly\n");
    const first = await runScan();
    const original = first.docs.find((d) => d.originalFilename === "copy-src.txt");
    expect(original).toBeDefined();

    await copyFile(join(sourceRoot, "copy-src.txt"), join(sourceRoot, "copy-dup.txt"));
    const second = await runScan();
    expect(second.status.state).toBe("completed");
    expect(second.jobCount).toBe(first.jobCount);

    expect(second.docs.some((d) => d.originalFilename === "copy-dup.txt")).toBe(false);
    await withApp(async (base) => {
      expect(await docStatus(base, original!.id)).toBe(200);
    });

    const currentRepo = repo();
    const dupSourceFile = await currentRepo.getSourceFile(sourceId, "copy-dup.txt");
    expect(dupSourceFile?.documentId).toBeUndefined();
    expect(dupSourceFile?.lastOutcome).toBe("duplicate");
  });

  test("missing source path: prior document remains live", async () => {
    await writeFile(join(sourceRoot, "missing-me.txt"), "will vanish\n");
    const first = await runScan();
    const doc = first.docs.find((d) => d.originalFilename === "missing-me.txt");
    expect(doc).toBeDefined();

    await rm(join(sourceRoot, "missing-me.txt"));
    const second = await runScan();
    expect(second.status.state).toBe("completed");

    await withApp(async (base) => {
      expect(await docStatus(base, doc!.id)).toBe(200);
    });
  });

  test("manual duplicate: manual document stays live, no scanner ownership or new job", async () => {
    const manualBytes = "manual upload content, never scanned\n";
    const manualId = await withApp(async (base) => {
      const form = new FormData();
      form.set("file", new File([manualBytes], "manual.txt"));
      const created = await fetch(`${base}/api/v1/documents`, { method: "POST", body: form });
      expect(created.status).toBe(202);
      return ((await created.json()) as { id: string }).id;
    });

    const baseline = await runScan();
    await writeFile(join(sourceRoot, "manual-dup.txt"), manualBytes);
    const scanned = await runScan();
    expect(scanned.status.state).toBe("completed");
    expect(scanned.jobCount).toBe(baseline.jobCount);

    await withApp(async (base) => {
      const res = await fetch(`${base}/api/v1/documents/${manualId}`);
      expect(res.status).toBe(200);
      const doc = (await res.json()) as { originalFilename: string; status: string };
      expect(doc.originalFilename).toBe("manual.txt");
      expect(doc.status).not.toBe("deleted");
    });
    expect(scanned.docs.some((d) => d.originalFilename === "manual-dup.txt")).toBe(false);

    const currentRepo = repo();
    const sourceFile = await currentRepo.getSourceFile(sourceId, "manual-dup.txt");
    expect(sourceFile?.documentId).toBeUndefined();
    expect(sourceFile?.lastOutcome).toBe("duplicate");
  });

  test("manual delete/purge: present source imports on the next complete cycle", async () => {
    await writeFile(join(sourceRoot, "purge-target.txt"), "purge candidate\n");
    const first = await runScan();
    const before = first.docs.find((d) => d.originalFilename === "purge-target.txt");
    expect(before).toBeDefined();

    await withApp(async (base) => {
      const purged = await fetch(`${base}/api/v1/documents/purge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "purge" }),
      });
      expect(purged.status).toBe(200);
    });

    await withApp(async (base) => {
      expect(await docStatus(base, before!.id)).toBe(404);
    });

    const second = await runScan();
    expect(second.status.state).toBe("completed");
    const after = second.docs.find((d) => d.originalFilename === "purge-target.txt");
    expect(after).toBeDefined();
    expect(after!.id).not.toBe(before!.id);
    await withApp(async (base) => {
      expect(await docStatus(base, after!.id)).toBe(200);
    });
  });
});
