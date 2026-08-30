import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/server/src/app.ts";
import { loadEnv } from "../../apps/server/src/config/env.ts";

describe("no passphrase configured", () => {
  let dir = "";
  let server: Bun.Server<undefined>;
  let base = "";
  let stop: () => void;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-auth-open-"));
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

  test("the instance is fully open - no network-position check anywhere", async () => {
    const res = await fetch(`${base}/api/v1/documents`);
    expect(res.status).toBe(200);
    const session = (await (await fetch(`${base}/api/v1/session`)).json()) as {
      passphraseRequired: boolean;
    };
    expect(session.passphraseRequired).toBe(false);
  });
});

describe("with a passphrase configured", () => {
  let dir = "";
  let server: Bun.Server<undefined>;
  let base = "";
  let stop: () => void;
  const PASSPHRASE = "correct-horse-battery-staple";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-auth-pass-"));
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

  test("API without a key or session is 401; health stays open", async () => {
    const res = await fetch(`${base}/api/v1/documents`);
    expect(res.status).toBe(401);
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
  });

  test("wrong passphrase is rejected, no cookie set", async () => {
    const res = await fetch(`${base}/api/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "nope" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("correct passphrase sets a session cookie that authenticates subsequent requests", async () => {
    const login = await fetch(`${base}/api/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: PASSPHRASE }),
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("set-cookie");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    const cookie = setCookie!.split(";")[0]!;

    const docs = await fetch(`${base}/api/v1/documents`, { headers: { cookie } });
    expect(docs.status).toBe(200);

    const check = (await (await fetch(`${base}/api/v1/session`, { headers: { cookie } })).json()) as {
      authenticated: boolean;
    };
    expect(check.authenticated).toBe(true);
  });

  test("a Bearer API key still works independently of the session cookie", async () => {
    const login = await fetch(`${base}/api/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: PASSPHRASE }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const created = (await (
      await fetch(`${base}/api/v1/api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name: "ci", scopes: ["read"] }),
      })
    ).json()) as { secret: string };

    const res = await fetch(`${base}/api/v1/documents`, {
      headers: { authorization: `Bearer ${created.secret}` },
    });
    expect(res.status).toBe(200);
  });

  test("logout clears the cookie", async () => {
    const res = await fetch(`${base}/api/v1/session`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  test("repeated wrong passphrases are rate-limited", async () => {
    let last: Response | undefined;
    for (let i = 0; i < 12; i++) {
      last = await fetch(`${base}/api/v1/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passphrase: "nope" }),
      });
    }
    expect(last!.status).toBe(429);
  });
});
