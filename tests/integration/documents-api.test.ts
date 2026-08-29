import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/server/src/app.ts";
import { loadEnv } from "../../apps/server/src/config/env.ts";

describe("documents API", () => {
  let dir = "";
  let server: Bun.Server<undefined>;
  let base = "";

  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-knowledge-"));
    const env = loadEnv({
      AUTH_DISABLED: "true",
      DATABASE_URL: `file:${join(dir, "app.db")}`,
      STORAGE_PATH: join(dir, "blobs"),
      MAX_UPLOAD_BYTES: "64",
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

  function upload(filename: string, body: string | Uint8Array) {
    const form = new FormData();
    form.set("file", new File([body as BlobPart], filename)); // ponytail: same BlobPart lib quirk as document-service.ts
    return fetch(`${base}/api/v1/documents`, { method: "POST", body: form });
  }

  test("health", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("upload, list, get, download, delete", async () => {
    const bytes = "hello knowledge\n";
    const created = await upload("note.txt", bytes);
    expect(created.status).toBe(202);
    const body = (await created.json()) as {
      id: string;
      status: string;
      revision: number;
      duplicate: boolean;
    };
    expect(body.id.startsWith("doc_")).toBe(true);
    expect(["processing", "ready"]).toContain(body.status);
    expect(body.revision).toBe(1);
    expect(body.duplicate).toBe(false);

    const list = await fetch(`${base}/api/v1/documents`);
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { items: Array<{ id: string; status: string }> };
    expect(listed.items.some((d) => d.id === body.id)).toBe(true);

    const got = await fetch(`${base}/api/v1/documents/${body.id}`);
    expect(got.status).toBe(200);
    const doc = (await got.json()) as { originalFilename: string; status: string };
    expect(doc.originalFilename).toBe("note.txt");
    expect(["processing", "ready"]).toContain(doc.status);

    const file = await fetch(`${base}/api/v1/documents/${body.id}/file`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe(bytes);

    const del = await fetch(`${base}/api/v1/documents/${body.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    const missing = await fetch(`${base}/api/v1/documents/${body.id}`);
    expect(missing.status).toBe(404);
    const err = (await missing.json()) as { error: { code: string } };
    expect(err.error.code).toBe("DOCUMENT_NOT_FOUND");
  });

  test("duplicate live sha256 returns 200", async () => {
    const first = await upload("dup.txt", "same-bytes");
    expect(first.status).toBe(202);
    const a = (await first.json()) as { id: string };
    const second = await upload("dup-again.txt", "same-bytes");
    expect(second.status).toBe(200);
    const b = (await second.json()) as { id: string; duplicate: boolean };
    expect(b.id).toBe(a.id);
    expect(b.duplicate).toBe(true);
  });

  test("oversize upload is 413", async () => {
    const res = await upload("big.txt", "x".repeat(65));
    expect(res.status).toBe(413);
    const err = (await res.json()) as { error: { code: string } };
    expect(err.error.code).toBe("PAYLOAD_TOO_LARGE");
  });
});
