import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/server/src/app.ts";
import { loadEnv } from "../../apps/server/src/config/env.ts";
import { createSessionCookieValue, SESSION_COOKIE } from "../../apps/server/src/http/session.ts";

describe("GET /api/v1/ingest/scan-status - no INGEST_DATA_DIR configured", () => {
  let dir = "";
  let server: Bun.Server<undefined>;
  let base = "";
  let stop: () => void;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-scan-status-open-"));
    const app = await createApp(
      loadEnv({ DATABASE_URL: `file:${join(dir, "app.db")}`, STORAGE_PATH: join(dir, "blobs") }),
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

  test("reports disabled status with not_configured reason", async () => {
    const response = await fetch(`${base}/api/v1/ingest/scan-status`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: "disabled",
      currentPath: null,
      limitReached: false,
      disabledReason: "not_configured",
    });
  });
});

describe("GET /api/v1/ingest/scan-status - with dashboard auth enabled", () => {
  let dir = "";
  let server: Bun.Server<undefined>;
  let base = "";
  let stop: () => void;
  const PASSPHRASE = "correct-horse-battery-staple";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-scan-status-auth-"));
    const app = await createApp(
      loadEnv({
        DASHBOARD_PASSPHRASE: PASSPHRASE,
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

  test("requires read auth, same as other GET /api/v1 routes", async () => {
    const unauthed = await fetch(`${base}/api/v1/ingest/scan-status`);
    expect(unauthed.status).toBe(401);

    // Build the session cookie directly instead of going through POST /api/v1/session,
    // whose login endpoint is rate-limited per remote address and shares that limiter's
    // state across every test file in this process (see auth.test.ts's rate-limit test).
    const cookie = `${SESSION_COOKIE}=${createSessionCookieValue(PASSPHRASE)}`;
    const authed = await fetch(`${base}/api/v1/ingest/scan-status`, {
      headers: { cookie },
    });
    expect(authed.status).toBe(200);
    expect(await authed.json()).toMatchObject({ state: "disabled", disabledReason: "not_configured" });
  });
});
