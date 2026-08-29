import { AppError } from "../errors.ts";
import { assertSafeUrl, type LookupFn } from "../ssrf.ts";
import type { DocumentService } from "./document-service.ts";

export type UrlFetch = (url: string, init: RequestInit) => Promise<Response>;

function filenameOf(url: URL, contentDisposition: string | null): string {
  const star = contentDisposition?.match(/filename\*=UTF-8''([^;]+)/i);
  if (star?.[1]) return decodeURIComponent(star[1]);
  const quoted = contentDisposition?.match(/filename="([^"]+)"/i);
  if (quoted?.[1]) return quoted[1];
  const last = url.pathname.split("/").filter(Boolean).pop();
  return last && last.includes(".") ? last : "download.bin";
}

export class UrlIngestService {
  constructor(
    private readonly documents: DocumentService,
    private readonly limits: {
      MAX_UPLOAD_BYTES: number;
      URL_FETCH_TIMEOUT_MS: number;
      URL_FETCH_MAX_REDIRECTS: number;
    },
    private readonly deps: { fetch: UrlFetch; lookup?: LookupFn } = { fetch: globalThis.fetch },
  ) {}

  async ingest(input: {
    url: string;
    collectionId?: string;
    metadata?: Record<string, unknown>;
  }) {
    let current = await assertSafeUrl(input.url, this.deps.lookup);
    let res: Response | undefined;
    for (let hop = 0; hop <= this.limits.URL_FETCH_MAX_REDIRECTS; hop++) {
      res = await this.deps.fetch(current.href, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(this.limits.URL_FETCH_TIMEOUT_MS),
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) throw new AppError("DOCUMENT_FETCH_FAILED", "Redirect missing Location.", 400);
        current = await assertSafeUrl(new URL(loc, current).href, this.deps.lookup);
        continue;
      }
      break;
    }
    if (!res || res.status >= 300) {
      throw new AppError("DOCUMENT_FETCH_FAILED", "URL fetch failed.", 400);
    }
    if (!res.ok) throw new AppError("DOCUMENT_FETCH_FAILED", `URL fetch returned ${res.status}.`, 400);
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > this.limits.MAX_UPLOAD_BYTES) {
      throw new AppError("PAYLOAD_TOO_LARGE", "Download exceeds MAX_UPLOAD_BYTES.", 413);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > this.limits.MAX_UPLOAD_BYTES) {
      throw new AppError("PAYLOAD_TOO_LARGE", "Download exceeds MAX_UPLOAD_BYTES.", 413);
    }
    return this.documents.upload({
      filename: filenameOf(current, res.headers.get("content-disposition")),
      bytes: buf,
      collectionId: input.collectionId,
      metadata: input.metadata,
    });
  }
}
