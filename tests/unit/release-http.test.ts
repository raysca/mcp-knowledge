import { describe, expect, test } from "bun:test";
import { waitForDocument, waitForHealth } from "../../scripts/release/http.ts";

describe("release HTTP polling", () => {
  test("waitForHealth recovers from transient health failures", async () => {
    let attempts = 0;
    const sleeps: number[] = [];

    await waitForHealth({
      baseUrl: "http://release.test",
      timeoutMs: 1_000,
      fetch: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("connection refused");
        if (attempts === 2) return new Response("unavailable", { status: 503 });
        return Response.json({ ok: true });
      },
      sleep: async (ms) => void sleeps.push(ms),
    });

    expect(attempts).toBe(3);
    expect(sleeps).toEqual([250, 250]);
  });

  test("waitForDocument returns the ready document", async () => {
    let attempts = 0;
    let authorization: string | null = null;

    const document = await waitForDocument("doc_ready", {
      baseUrl: "http://release.test",
      timeoutMs: 1_000,
      requestInit: { headers: { authorization: "Bearer test-api-key" } },
      fetch: async (input, init) => {
        attempts += 1;
        authorization = new Request(input, init).headers.get("authorization");
        return Response.json(
          attempts === 1
            ? { id: "doc_ready", status: "processing", latestError: null }
            : { id: "doc_ready", status: "ready", latestError: null },
        );
      },
      sleep: async () => undefined,
    });

    expect(document).toEqual({ id: "doc_ready", status: "ready", latestError: null });
    expect(attempts).toBe(2);
    expect(authorization === "Bearer test-api-key").toBe(true);
  });

  test("waitForDocument exposes a terminal failure without waiting", async () => {
    let slept = false;

    await expect(
      waitForDocument("doc_failed", {
        baseUrl: "http://release.test",
        fetch: async () =>
          Response.json({ id: "doc_failed", status: "failed", latestError: "PARSER_FAILED: safe failure" }),
        sleep: async () => {
          slept = true;
        },
      }),
    ).rejects.toThrow("PARSER_FAILED");

    expect(slept).toBe(false);
  });

  test("waitForDocument never exposes raw terminal diagnostics", async () => {
    const rawDiagnostic = "PARSER_FAILED: /Users/private/secret.pdf contains secret token";

    await expect(
      waitForDocument("doc_failed", {
        baseUrl: "http://release.test",
        fetch: async () =>
          Response.json({ id: "doc_failed", status: "failed", latestError: rawDiagnostic }),
      }),
    ).rejects.toThrow("PARSER_FAILED");

    await expect(
      waitForDocument("doc_failed", {
        baseUrl: "http://release.test",
        fetch: async () =>
          Response.json({ id: "doc_failed", status: "failed", latestError: rawDiagnostic }),
      }),
    ).rejects.not.toThrow(/secret\.pdf|secret token/);
  });
});
