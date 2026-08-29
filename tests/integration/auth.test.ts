import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/server/src/app.ts";
import { loadEnv } from "../../apps/server/src/config/env.ts";
import { handleRequest } from "../../apps/server/src/http/router.ts";

describe("auth", () => {
  let dir = "";
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-auth-"));
    app = await createApp(
      loadEnv({
        AUTH_DISABLED: "true",
        DATABASE_URL: `file:${join(dir, "app.db")}`,
        STORAGE_PATH: join(dir, "blobs"),
      }),
    );
  });

  afterAll(async () => {
    app.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test("AUTH_DISABLED does not skip auth for a non-loopback remote", async () => {
    const res = await handleRequest(
      new Request("http://x/api/v1/documents"),
      app.services,
      "10.0.0.4",
    );
    expect(res.status).toBe(401);
  });

  test("AUTH_DISABLED skips auth on loopback", async () => {
    const res = await handleRequest(
      new Request("http://x/api/v1/documents"),
      app.services,
      "127.0.0.1",
    );
    expect(res.status).toBe(200);
  });
});

describe("auth required", () => {
  let dir = "";
  let server: Bun.Server<undefined>;
  let base = "";
  let stop: () => void;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-auth2-"));
    const app = await createApp(
      loadEnv({
        DATABASE_URL: `file:${join(dir, "app.db")}`,
        STORAGE_PATH: join(dir, "blobs"),
      }),
    );
    stop = app.stop;
    server = Bun.serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    stop();
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  });

  test("API without a key is 401 when AUTH_DISABLED is false", async () => {
    const res = await fetch(`${base}/api/v1/documents`);
    expect(res.status).toBe(401);
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
  });
});
