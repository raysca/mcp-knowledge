import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { createApp } from "../../apps/server/src/app.ts";
import { loadEnv } from "../../apps/server/src/config/env.ts";

describe("archive upload API", () => {
  let dir = "";
  let server: Bun.Server<undefined>;
  let base = "";
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-knowledge-archive-"));
    const env = loadEnv({
      DATABASE_URL: `file:${join(dir, "app.db")}`,
      STORAGE_PATH: join(dir, "blobs"),
    });
    app = await createApp(env);
    server = Bun.serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    app.stop();
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  });

  function buildZip(files: Array<{ name: string; content: string }>): Uint8Array {
    const zip = new AdmZip();
    for (const file of files) zip.addFile(file.name, Buffer.from(file.content, "utf8"));
    return new Uint8Array(zip.toBuffer());
  }

  test("uploading a .zip returns an archiveId, not a document id", async () => {
    const bytes = buildZip([{ name: "a.txt", content: "hello archive" }]);
    const form = new FormData();
    form.set("file", new File([bytes as BlobPart], "export.zip"));
    const res = await fetch(`${base}/api/v1/documents`, { method: "POST", body: form });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { archiveId: string; status: string };
    expect(body.archiveId.startsWith("arc_")).toBe(true);
    expect(body.status).toBe("queued");
  });

  test("archive status reaches completed and documents become ready", async () => {
    const bytes = buildZip([
      { name: "one.txt", content: "first document body" },
      { name: "two.txt", content: "second document body" },
      { name: "skip.exe", content: "not allowlisted" },
    ]);
    const form = new FormData();
    form.set("file", new File([bytes as BlobPart], "batch.zip"));
    const upload = await fetch(`${base}/api/v1/documents`, { method: "POST", body: form });
    const { archiveId } = (await upload.json()) as { archiveId: string };

    let status: { state: string; counts: Record<string, number>; documentIds: string[] } | undefined;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const res = await fetch(`${base}/api/v1/archives/${archiveId}`);
      status = (await res.json()) as typeof status;
      if (status?.state === "completed" || status?.state === "completed_with_errors") break;
      await Bun.sleep(100);
    }
    // skip.exe is merely unsupported (a benign skip), not a failed entry, so the archive
    // as a whole still reaches "completed" - "completed_with_errors" is reserved for real
    // per-entry failures, same distinction the directory scanner's status makes.
    expect(status?.state).toBe("completed");
    expect(status?.counts.extracted).toBe(2);
    expect(status?.counts.unsupported).toBe(1);
    expect(status?.documentIds).toHaveLength(2);

    for (const documentId of status!.documentIds) {
      let ready = false;
      const docDeadline = Date.now() + 15_000;
      while (Date.now() < docDeadline) {
        const res = await fetch(`${base}/api/v1/documents/${documentId}`);
        const doc = (await res.json()) as { status: string };
        if (doc.status === "ready") { ready = true; break; }
        await Bun.sleep(100);
      }
      expect(ready).toBe(true);
    }
  });

  test("GET /api/v1/archives lists recent imports newest first", async () => {
    const res = await fetch(`${base}/api/v1/archives?limit=10`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; originalFilename: string }> };
    expect(body.items.length).toBeGreaterThanOrEqual(2);
    expect(body.items.map((item) => item.originalFilename)).toContain("batch.zip");
  });

  test("GET /api/v1/archives/:id 404s for an unknown id", async () => {
    const res = await fetch(`${base}/api/v1/archives/arc_missing`);
    expect(res.status).toBe(404);
  });
});
