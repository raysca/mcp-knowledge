import { describe, expect, test } from "bun:test";
import {
  createSessionCookieValue,
  loginRateLimited,
  verifySessionCookieValue,
} from "../../apps/server/src/http/session.ts";

describe("session cookie", () => {
  test("a value signed with the secret verifies", () => {
    const value = createSessionCookieValue("s3cret");
    expect(verifySessionCookieValue("s3cret", value)).toBe(true);
  });

  test("wrong secret, tampered value, and missing value all fail closed", () => {
    const value = createSessionCookieValue("s3cret");
    expect(verifySessionCookieValue("wrong-secret", value)).toBe(false);
    const [expiresAt] = value.split(".");
    expect(verifySessionCookieValue("s3cret", `${expiresAt}.deadbeef`)).toBe(false);
    expect(verifySessionCookieValue("s3cret", undefined)).toBe(false);
    expect(verifySessionCookieValue("s3cret", "not-even-the-right-shape")).toBe(false);
  });

  test("an expired value fails even with a valid signature", () => {
    const expired = createSessionCookieValue("s3cret", -1000);
    expect(verifySessionCookieValue("s3cret", expired)).toBe(false);
  });

  test("rotating the passphrase invalidates every outstanding session for free", () => {
    // This is the whole point of signing with the passphrase itself instead of a separate
    // session-store secret: no revocation list needed, changing the passphrase does it.
    const value = createSessionCookieValue("old-passphrase");
    expect(verifySessionCookieValue("new-passphrase", value)).toBe(false);
  });
});

describe("login rate limiting", () => {
  test("allows a handful of attempts then blocks", () => {
    const key = `test-${crypto.randomUUID()}`;
    let blocked = false;
    for (let i = 0; i < 15; i++) blocked = loginRateLimited(key) || blocked;
    expect(blocked).toBe(true);
    // a different key is unaffected
    expect(loginRateLimited(`other-${crypto.randomUUID()}`)).toBe(false);
  });
});
