import { describe, expect, test } from "bun:test";
import { isLoopbackAddress, shouldSkipAuth } from "../../apps/server/src/http/auth.ts";

describe("loopback auth", () => {
  test("AUTH_DISABLED only skips auth for loopback remotes", () => {
    const env = { AUTH_DISABLED: true };
    expect(shouldSkipAuth(env, "127.0.0.1")).toBe(true);
    expect(shouldSkipAuth(env, "::1")).toBe(true);
    expect(shouldSkipAuth(env, "10.0.0.8")).toBe(false);
    expect(shouldSkipAuth(env, "8.8.8.8")).toBe(false);
    expect(shouldSkipAuth(env, undefined)).toBe(false);
  });

  test("AUTH_DISABLED false never skips, even on loopback", () => {
    expect(shouldSkipAuth({ AUTH_DISABLED: false }, "127.0.0.1")).toBe(false);
  });

  test("mapped IPv4 loopback is loopback", () => {
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });
});
