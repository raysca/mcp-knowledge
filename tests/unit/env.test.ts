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
  });

  test("rejects unknown APP_PROFILE", () => {
    expect(() => loadEnv({ APP_PROFILE: "staging" })).toThrow(/APP_PROFILE/);
  });

  test("server profile defaults to postgres and s3", () => {
    const env = loadEnv({ APP_PROFILE: "server" });
    expect(env.DATABASE_DRIVER).toBe("postgres");
    expect(env.STORAGE_DRIVER).toBe("s3");
    expect(env.WORKER_CONCURRENCY).toBe(4);
  });
});
