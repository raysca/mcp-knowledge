import { describe, expect, test } from "bun:test";
import { UrlIngestService } from "../../packages/core/src/services/url-ingest.ts";
import type { DocumentService } from "../../packages/core/src/services/document-service.ts";

const limits = {
  MAX_UPLOAD_BYTES: 1024,
  URL_FETCH_TIMEOUT_MS: 5000,
  URL_FETCH_MAX_REDIRECTS: 3,
};

describe("URL ingest SSRF", () => {
  test("blocks a redirect to 169.254.169.254", async () => {
    const urls: string[] = [];
    const ingest = new UrlIngestService({} as DocumentService, limits, {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      fetch: async (url) => {
        urls.push(url);
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        });
      },
    });
    await expect(ingest.ingest({ url: "https://example.com/report.pdf" })).rejects.toThrow(/SSRF/);
    expect(urls.length).toBe(1);
  });
});
