import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnowledgeRepository } from "../../packages/core/src/index.ts";
import { createKnowledgeRepository } from "../../packages/db/src/index.ts";
import { createApp, type AppOverrides } from "../../apps/server/src/app.ts";
import { loadEnv } from "../../apps/server/src/config/env.ts";
import type { StartupScanStatus } from "../../apps/server/src/startup-scan/coordinator.ts";
import { LocalDirectorySource } from "../../apps/server/src/startup-scan/local-directory-source.ts";

type App = Awaited<ReturnType<typeof createApp>>;
type Instance = { app: App; server: ReturnType<typeof Bun.serve>; base: string };

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function boot(env: ReturnType<typeof loadEnv>, overrides?: AppOverrides): Promise<Instance> {
  const app = await createApp(env, overrides);
  const server = Bun.serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  cleanups.push(() => {
    app.stop();
    server.stop(true);
  });
  return { app, server, base: `http://127.0.0.1:${server.port}` };
}

async function scanStatus(base: string): Promise<StartupScanStatus> {
  return (await fetch(`${base}/api/v1/ingest/scan-status`).then((r) => r.json())) as StartupScanStatus;
}

async function waitForTerminal(base: string): Promise<StartupScanStatus> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const status = await scanStatus(base);
    if (["completed", "completed_with_errors", "failed"].includes(status.state)) return status;
    await Bun.sleep(20);
  }
  throw new Error("scan did not reach a terminal state");
}

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error("condition did not become true in time");
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Wraps a real LocalDirectorySource, letting a scenario override individual seam methods
// (inspectAndRead in particular) while everything else behaves exactly like production.
function wrapRealSource(
  real: LocalDirectorySource,
  patch: Partial<{
    inspectAndRead: LocalDirectorySource["inspectAndRead"];
  }> = {},
) {
  return {
    sourceId: real.sourceId,
    configurationFingerprint: real.configurationFingerprint,
    candidates: real.candidates.bind(real),
    inspectAndRead: patch.inspectAndRead ?? real.inspectAndRead.bind(real),
    pathState: real.pathState.bind(real),
  };
}

describe("startup scan resilience", () => {
  test("a low file limit is honored per startup and the scan continues across restarts", async () => {
    const root = await tempDir("mcp-resilience-limit-");
    const dbPath = join(await tempDir("mcp-resilience-limit-db-"), "app.db");
    const blobsPath = join(await tempDir("mcp-resilience-limit-blobs-"), "blobs");
    for (let i = 0; i < 5; i += 1) {
      await writeFile(join(root, `file-${i}.txt`), `content ${i}\n`);
    }

    const envFor = () =>
      loadEnv({
        DATABASE_URL: `file:${dbPath}`,
        STORAGE_PATH: blobsPath,
        INGEST_DATA_DIR: root,
        INGEST_DATA_MAX_FILES: "2",
      });

    async function runOneStartup(): Promise<StartupScanStatus> {
      const instance = await boot(envFor());
      instance.app.startStartupScan();
      return waitForTerminal(instance.base);
    }

    expect((await runOneStartup()).limitReached).toBe(true);
    expect((await runOneStartup()).limitReached).toBe(true);
    expect((await runOneStartup()).limitReached).toBe(false);

    const repo: KnowledgeRepository = createKnowledgeRepository(`file:${dbPath}`);
    cleanups.push(() => (repo as unknown as { close?: () => void }).close?.());
    expect((await repo.listDocuments({ limit: 50 })).items).toHaveLength(5);
  });

  test("the server and health endpoint are available before the source is released, and while scanning", async () => {
    const root = await tempDir("mcp-resilience-health-");
    const dbPath = join(await tempDir("mcp-resilience-health-db-"), "app.db");
    const blobsPath = join(await tempDir("mcp-resilience-health-blobs-"), "blobs");
    await writeFile(join(root, "note.txt"), "hello\n");

    const gate = deferred<void>();
    let sourceRequested = false;
    const overrides: AppOverrides = {
      createDirectorySource: async (input) => {
        sourceRequested = true;
        await gate.promise;
        const real = await LocalDirectorySource.create({ root: input.root, maxDepth: input.maxDepth });
        return wrapRealSource(real);
      },
    };

    const env = loadEnv({
      DATABASE_URL: `file:${dbPath}`,
      STORAGE_PATH: blobsPath,
      INGEST_DATA_DIR: root,
    });
    const instance = await boot(env, overrides);

    // createApp()/serve resolved without ever touching the (still blocked) fake source.
    expect(sourceRequested).toBe(false);
    const health = await fetch(`${instance.base}/health`);
    expect(health.status).toBe(200);

    instance.app.startStartupScan();
    await waitUntil(async () => sourceRequested);

    // Still responsive while the scan is blocked awaiting the source.
    expect((await fetch(`${instance.base}/health`)).status).toBe(200);
    expect((await scanStatus(instance.base)).state).toBe("scanning");

    gate.resolve();
    const status = await waitForTerminal(instance.base);
    expect(status.state).toBe("completed");
  });

  test("a missing root fails the scan while health and job APIs remain available", async () => {
    const dbPath = join(await tempDir("mcp-resilience-missing-db-"), "app.db");
    const blobsPath = join(await tempDir("mcp-resilience-missing-blobs-"), "blobs");
    const missingRoot = join(await tempDir("mcp-resilience-missing-root-"), "does-not-exist");

    const overrides: AppOverrides = {
      createDirectorySource: async () => {
        throw new Error(`ENOENT: no such file or directory, lstat '${missingRoot}'`);
      },
    };

    const env = loadEnv({
      DATABASE_URL: `file:${dbPath}`,
      STORAGE_PATH: blobsPath,
      INGEST_DATA_DIR: missingRoot,
    });
    const instance = await boot(env, overrides);

    instance.app.startStartupScan();
    const status = await waitForTerminal(instance.base);
    expect(status.state).toBe("failed");
    expect(status.error).not.toBeNull();
    expect(status.error).not.toContain(missingRoot);

    expect((await fetch(`${instance.base}/health`)).status).toBe(200);
    const jobs = await fetch(`${instance.base}/api/v1/jobs`);
    expect(jobs.status).toBe(200);
  });

  test("one unstable candidate fails in isolation and a later candidate still queues", async () => {
    const root = await tempDir("mcp-resilience-flaky-");
    const dbPath = join(await tempDir("mcp-resilience-flaky-db-"), "app.db");
    const blobsPath = join(await tempDir("mcp-resilience-flaky-blobs-"), "blobs");
    await writeFile(join(root, "a-unstable.txt"), "will fail to read\n");
    await writeFile(join(root, "b-valid.txt"), "reads just fine\n");

    const overrides: AppOverrides = {
      createDirectorySource: async (input) => {
        const real = await LocalDirectorySource.create({ root: input.root, maxDepth: input.maxDepth });
        return wrapRealSource(real, {
          inspectAndRead: async (candidate, maxBytes, signal) => {
            if (candidate.relativePath === "a-unstable.txt") {
              throw new Error("Source file changed while it was read.");
            }
            return real.inspectAndRead(candidate, maxBytes, signal);
          },
        });
      },
    };

    const env = loadEnv({
      DATABASE_URL: `file:${dbPath}`,
      STORAGE_PATH: blobsPath,
      INGEST_DATA_DIR: root,
    });
    const instance = await boot(env, overrides);
    instance.app.startStartupScan();
    const status = await waitForTerminal(instance.base);

    expect(status.state).toBe("completed_with_errors");
    expect(status.counts.failed).toBe(1);
    expect(status.counts.queued).toBe(1);

    const docs = (await fetch(`${instance.base}/api/v1/documents?limit=50`).then((r) => r.json())) as {
      items: { originalFilename: string }[];
    };
    expect(docs.items.some((d) => d.originalFilename === "b-valid.txt")).toBe(true);
    expect(docs.items.some((d) => d.originalFilename === "a-unstable.txt")).toBe(false);
  });

  test("stop() aborts an active scan and the next app instance resumes the same cycle", async () => {
    const root = await tempDir("mcp-resilience-resume-");
    const dbPath = join(await tempDir("mcp-resilience-resume-db-"), "app.db");
    const blobsPath = join(await tempDir("mcp-resilience-resume-blobs-"), "blobs");
    await writeFile(join(root, "resume-a.txt"), "first file\n");
    await writeFile(join(root, "resume-b.txt"), "second file\n");

    const hang = deferred<{ bytes: Uint8Array; sizeBytes: number; sha256: string }>();
    const overrides: AppOverrides = {
      createDirectorySource: async (input) => {
        const real = await LocalDirectorySource.create({ root: input.root, maxDepth: input.maxDepth });
        return wrapRealSource(real, { inspectAndRead: async () => hang.promise });
      },
    };

    const env = loadEnv({
      DATABASE_URL: `file:${dbPath}`,
      STORAGE_PATH: blobsPath,
      INGEST_DATA_DIR: root,
    });
    const first = await boot(env, overrides);
    first.app.startStartupScan();
    await waitUntil(async () => (await scanStatus(first.base)).currentPath !== null);
    expect((await scanStatus(first.base)).state).toBe("scanning");

    first.app.stop();
    first.server.stop(true);

    // A fresh app instance, using the real (unblocked) source, resumes the interrupted cycle.
    const second = await boot(loadEnv({
      DATABASE_URL: `file:${dbPath}`,
      STORAGE_PATH: blobsPath,
      INGEST_DATA_DIR: root,
    }));
    second.app.startStartupScan();
    const status = await waitForTerminal(second.base);
    expect(status.state).toBe("completed");

    const docs = (await fetch(`${second.base}/api/v1/documents?limit=50`).then((r) => r.json())) as {
      items: { originalFilename: string }[];
    };
    expect(docs.items.some((d) => d.originalFilename === "resume-a.txt")).toBe(true);
    expect(docs.items.some((d) => d.originalFilename === "resume-b.txt")).toBe(true);
  });

  test("scan status never exposes the absolute source root", async () => {
    const root = await tempDir("mcp-resilience-privacy-");
    const dbPath = join(await tempDir("mcp-resilience-privacy-db-"), "app.db");
    const blobsPath = join(await tempDir("mcp-resilience-privacy-blobs-"), "blobs");
    await writeFile(join(root, "note.txt"), "content\n");

    const env = loadEnv({
      DATABASE_URL: `file:${dbPath}`,
      STORAGE_PATH: blobsPath,
      INGEST_DATA_DIR: root,
    });
    const instance = await boot(env);
    instance.app.startStartupScan();
    const status = await waitForTerminal(instance.base);

    expect(status.state).toBe("completed");
    expect(JSON.stringify(status)).not.toContain(root);
  });
});
