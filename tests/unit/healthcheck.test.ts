import { describe, expect, test } from "bun:test";
import { checkHealth } from "../../scripts/healthcheck.ts";

describe("checkHealth", () => {
  test("accepts only a 200 response with an ok payload", async () => {
    const healthy = await checkHealth({
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    });
    const wrongStatus = await checkHealth({
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 204 }),
    });
    const wrongBody = await checkHealth({
      fetch: async () => new Response(JSON.stringify({ ok: false }), { status: 200 }),
    });

    expect(healthy).toBe(true);
    expect(wrongStatus).toBe(false);
    expect(wrongBody).toBe(false);
  });

  test("returns false when the request or response JSON fails", async () => {
    const networkFailure = await checkHealth({
      fetch: async () => Promise.reject(new Error("network unavailable")),
    });
    const jsonFailure = await checkHealth({
      fetch: async () => new Response("not json", { status: 200 }),
    });

    expect(networkFailure).toBe(false);
    expect(jsonFailure).toBe(false);
  });
});
