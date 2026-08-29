import { describe, expect, test } from "bun:test";
import { assertSafeUrl, isBlockedIp } from "../../packages/core/src/ssrf.ts";

describe("SSRF blocklist", () => {
  test("blocks loopback, RFC1918, link-local, and metadata", () => {
    expect(isBlockedIp("127.0.0.1")).toBe(true);
    expect(isBlockedIp("10.1.2.3")).toBe(true);
    expect(isBlockedIp("192.168.0.9")).toBe(true);
    expect(isBlockedIp("172.16.5.1")).toBe(true);
    expect(isBlockedIp("169.254.169.254")).toBe(true);
    expect(isBlockedIp("::1")).toBe(true);
    expect(isBlockedIp("8.8.8.8")).toBe(false);
  });

  test("rejects localhost and file URLs", async () => {
    await expect(assertSafeUrl("http://localhost/secret")).rejects.toThrow(/SSRF/);
    await expect(assertSafeUrl("file:///etc/passwd")).rejects.toThrow(/SSRF/);
  });

  test("rejects a host that resolves to a blocked IP", async () => {
    await expect(
      assertSafeUrl("http://evil.example/x", async () => [{ address: "169.254.169.254", family: 4 }]),
    ).rejects.toThrow(/SSRF/);
  });

  test("allows a host that resolves only to public IPs", async () => {
    await assertSafeUrl("https://example.com/report.pdf", async () => [
      { address: "93.184.216.34", family: 4 },
    ]);
  });
});
