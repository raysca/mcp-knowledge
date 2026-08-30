import { describe, expect, test } from "bun:test";
import { loadEnv } from "../../apps/server/src/config/env.ts";

describe("loadEnv", () => {
  test("defaults to the local profile", () => {
    const env = loadEnv({});
    expect(env.APP_PROFILE).toBe("local");
    expect(env.DATABASE_DRIVER).toBe("libsql");
    expect(env.STORAGE_DRIVER).toBe("local");
    expect(env.ROLE).toBe("all");
    expect(env.MAX_UPLOAD_BYTES).toBe(67_108_864);
    expect(env.MAX_LIST_LIMIT).toBe(100);
    expect(env.DASHBOARD_PASSPHRASE).toBeUndefined();
  });

  test("DASHBOARD_PASSPHRASE is unset by default - no network-position auth anywhere", () => {
    // Regression: auth used to key off a remote-address heuristic (loopback bypass), which a
    // reverse proxy on the same box can defeat by making every request look loopback. That
    // whole mechanism is gone - an unset passphrase means the instance has no auth at all
    // (matches zero-config `bun dev`), and a set one is checked the same way for everyone.
    expect(loadEnv({ APP_PROFILE: "local" }).DASHBOARD_PASSPHRASE).toBeUndefined();
    expect(loadEnv({ APP_PROFILE: "local", DASHBOARD_PASSPHRASE: "  " }).DASHBOARD_PASSPHRASE).toBeUndefined();
    expect(loadEnv({ APP_PROFILE: "local", DASHBOARD_PASSPHRASE: "hunter2" }).DASHBOARD_PASSPHRASE).toBe(
      "hunter2",
    );
  });

  test("server profile refuses to boot without a passphrase", () => {
    expect(() => loadEnv({ APP_PROFILE: "server" })).toThrow(/DASHBOARD_PASSPHRASE/);
    expect(() => loadEnv({ APP_PROFILE: "server", DASHBOARD_PASSPHRASE: "x" })).not.toThrow();
  });

  test("rejects unknown APP_PROFILE", () => {
    expect(() => loadEnv({ APP_PROFILE: "staging" })).toThrow(/APP_PROFILE/);
  });

  test("server profile defaults to postgres and s3", () => {
    const env = loadEnv({ APP_PROFILE: "server", DASHBOARD_PASSPHRASE: "x" });
    expect(env.DATABASE_DRIVER).toBe("postgres");
    expect(env.STORAGE_DRIVER).toBe("s3");
    expect(env.WORKER_CONCURRENCY).toBe(4);
  });
});
