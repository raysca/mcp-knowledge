import { describe, expect, test } from "bun:test";
import { createPinnedFetch } from "../../packages/core/src/ssrf.ts";

describe("createPinnedFetch", () => {
  // Regression: assertSafeUrl validated a DNS answer and then discarded it - a plain fetch()
  // to the same hostname re-resolves independently, which is exactly the DNS-rebinding TOCTOU
  // an attacker who controls DNS for their own submitted URL can exploit (answer "safe" for
  // our check, then something internal for the real connection). The fix must connect to the
  // SAME address that was validated, not the hostname again.
  //
  // This proves it the other direction: a hostname that does NOT resolve via real DNS at all
  // (guaranteed NXDOMAIN) still succeeds when pinned to a real local server's address - the
  // only way that's possible is if the connection used the pinned address, not fresh DNS.
  test("connects to the pinned address, not a fresh DNS lookup of the hostname", async () => {
    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("pinned ok"),
    });
    const fetchFn = createPinnedFetch(
      [{ address: "127.0.0.1", family: 4 }],
      1024,
    );
    const res = await fetchFn(`http://definitely-does-not-exist.invalid:${server.port}/`, {
      method: "GET",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("pinned ok");
  });

  test("aborts once the streamed body exceeds the byte cap", async () => {
    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("x".repeat(10_000)),
    });
    const fetchFn = createPinnedFetch([{ address: "127.0.0.1", family: 4 }], 100);
    await expect(
      fetchFn(`http://ignored.invalid:${server.port}/`, { method: "GET" }),
    ).rejects.toThrow(/MAX_UPLOAD_BYTES/);
  });
});
