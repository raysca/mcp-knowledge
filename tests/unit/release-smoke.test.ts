import { describe, expect, test } from "bun:test";
import { smokeFailureMessage } from "../../scripts/release/smoke.ts";

describe("release smoke diagnostics", () => {
  test("top-level smoke failure message never includes error diagnostics", () => {
    const raw = new Error("/Users/private/secret.pdf contains secret token");

    const message = smokeFailureMessage(raw);

    expect(message).toBe("Smoke check failed.");
    expect(message).not.toMatch(/secret\.pdf|secret token/);
  });
});
