import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/server/src/app.ts";
import { loadEnv } from "../../apps/server/src/config/env.ts";
import { createKnowledgeRepository } from "../../packages/db/src/index.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mcp-job-recovery-"));
  temporaryDirectories.push(directory);
  return directory;
}

function environment(directory: string, role: "all" | "api") {
  return loadEnv({
    ROLE: role,
    DATABASE_URL: `file:${join(directory, "knowledge.db")}`,
    STORAGE_PATH: directory,
    JOB_LEASE_MS: "1",
  });
}

async function start(directory: string, role: "all" | "api") {
  const app = await createApp(environment(directory, role));
  const server = Bun.serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  return {
    base: `http://127.0.0.1:${server.port}`,
    stop() {
      app.stop();
      server.stop(true);
    },
  };
}

async function upload(base: string, bytes: string) {
  const form = new FormData();
  form.set("file", new File([bytes], "recovery.md"));
  const response = await fetch(`${base}/api/v1/documents`, { method: "POST", body: form });
  expect(response.status).toBe(202);
  return (await response.json()) as { id: string };
}

async function jobs(base: string) {
  const response = await fetch(`${base}/api/v1/jobs`);
  return (await response.json()) as {
    items: Array<{ id: string; documentId: string; status: string; attempt: number }>;
  };
}

async function waitReady(base: string, id: string, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/v1/documents/${id}`);
    const document = (await response.json()) as { status?: string; latestError?: string };
    if (document.status === "ready") return document;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for document ${id} to become ready`);
}

async function waitJob(base: string, id: string, status: string, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const job = (await jobs(base)).items.find((candidate) => candidate.id === id);
    if (job?.status === status) return job;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for job ${id} to become ${status}`);
}

async function expectSingleLiveDocument(base: string, id: string) {
  const response = await fetch(`${base}/api/v1/documents?limit=100`);
  const body = (await response.json()) as { items: Array<{ id: string }> };
  expect(body.items.filter((document) => document.id === id)).toHaveLength(1);
  expect(body.items).toHaveLength(1);
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("durable ingestion job recovery", () => {
  test(
    "a queued job completes after restart without creating a duplicate live document",
    async () => {
      const directory = await temporaryDirectory();
      const api = await start(directory, "api");
      const created = await upload(
        api.base,
        "# Queued restart\n\nThe queued restart marker is durable-queue-441.\n",
      );
      const queued = (await jobs(api.base)).items.find((job) => job.documentId === created.id);
      expect(queued?.status).toBe("queued");
      api.stop();

      const restarted = await start(directory, "all");
      try {
        await waitReady(restarted.base, created.id);
        await waitJob(restarted.base, queued!.id, "completed");
        await expectSingleLiveDocument(restarted.base, created.id);
      } finally {
        restarted.stop();
      }
    },
    90_000,
  );

  test(
    "restart reclaims a stale running lease and completes the same job",
    async () => {
      const directory = await temporaryDirectory();
      const api = await start(directory, "api");
      const created = await upload(
        api.base,
        "# Stale lease\n\nThe stale lease marker is reclaim-lease-552.\n",
      );
      const repository = createKnowledgeRepository(environment(directory, "api").DATABASE_URL);
      const claimed = await repository.claimJob("dead-worker", 60_000);
      expect(claimed?.status).toBe("running");
      expect(claimed?.attempt).toBe(1);
      api.stop();
      await Bun.sleep(5);

      const restarted = await start(directory, "all");
      try {
        await waitReady(restarted.base, created.id);
        const completed = await waitJob(restarted.base, claimed!.id, "completed");
        expect(completed.attempt).toBe(2);
        await expectSingleLiveDocument(restarted.base, created.id);
      } finally {
        restarted.stop();
      }
    },
    90_000,
  );

  test(
    "a terminal failed job can be retried to ready from its canonical original",
    async () => {
      const directory = await temporaryDirectory();
      const api = await start(directory, "api");
      const content = "# Terminal retry\n\nThe terminal retry marker is revive-job-663.\n";
      const created = await upload(api.base, content);
      const repository = createKnowledgeRepository(environment(directory, "api").DATABASE_URL);
      let terminalJobId = "";
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const claimed = await repository.claimJob(`failing-worker-${attempt}`, 60_000);
        expect(claimed?.attempt).toBe(attempt);
        terminalJobId = claimed!.id;
        const failed = await repository.failJob(claimed!.id, new Error("simulated worker loss"));
        expect(failed.status).toBe(attempt === 3 ? "failed" : "retrying");
      }
      api.stop();

      const restarted = await start(directory, "all");
      try {
        const retry = await fetch(`${restarted.base}/api/v1/jobs/${terminalJobId}/retry`, {
          method: "POST",
        });
        expect(retry.status).toBe(202);
        await waitReady(restarted.base, created.id);
        await waitJob(restarted.base, terminalJobId, "completed");

        const duplicateForm = new FormData();
        duplicateForm.set("file", new File([content], "same-content.md"));
        const duplicate = await fetch(`${restarted.base}/api/v1/documents`, {
          method: "POST",
          body: duplicateForm,
        });
        expect(duplicate.status).toBe(200);
        const duplicateBody = (await duplicate.json()) as {
          id: string;
          status: string;
          revision: number;
          duplicate: boolean;
        };
        expect(duplicateBody).toEqual({ id: created.id, status: "ready", revision: 1, duplicate: true });
        await expectSingleLiveDocument(restarted.base, created.id);
      } finally {
        restarted.stop();
      }
    },
    90_000,
  );
});
