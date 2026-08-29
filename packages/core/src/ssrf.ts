import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { AppError } from "./errors.ts";

export type ResolvedAddress = { address: string; family: number };
export type LookupFn = (hostname: string) => Promise<ResolvedAddress[]>;

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const o = Number(p);
    if (o > 255) return null;
    n = (n << 8) + o;
  }
  return n >>> 0;
}

function inCidr(ip: string, base: string, bits: number): boolean {
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(base);
  if (a == null || b == null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

export function isBlockedIp(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/i, "");
  if (v4 === "::1" || ip === "::1") return true;
  if (ipv4ToInt(v4) == null) {
    const lower = ip.toLowerCase();
    if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
    return false;
  }
  return (
    inCidr(v4, "127.0.0.0", 8) ||
    inCidr(v4, "10.0.0.0", 8) ||
    inCidr(v4, "172.16.0.0", 12) ||
    inCidr(v4, "192.168.0.0", 16) ||
    inCidr(v4, "169.254.0.0", 16) ||
    inCidr(v4, "0.0.0.0", 8)
  );
}

const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal", "metadata"]);

export async function assertSafeUrl(
  raw: string,
  lookup: LookupFn = defaultLookup,
): Promise<{ url: URL; addresses: ResolvedAddress[] }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError("SSRF_BLOCKED", "SSRF: URL is not allowed.", 400);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError("SSRF_BLOCKED", "SSRF: URL is not allowed.", 400);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTS.has(host) || isBlockedIp(host)) {
    throw new AppError("SSRF_BLOCKED", "SSRF: URL is not allowed.", 400);
  }
  const addrs = await lookup(host);
  if (addrs.length === 0 || addrs.some((a) => isBlockedIp(a.address))) {
    throw new AppError("SSRF_BLOCKED", "SSRF: URL is not allowed.", 400);
  }
  return { url, addresses: addrs };
}

async function defaultLookup(hostname: string): Promise<ResolvedAddress[]> {
  const all = await dnsLookup(hostname, { all: true });
  return all.map((a) => ({ address: a.address, family: a.family }));
}

// ponytail: DNS-rebinding TOCTOU - assertSafeUrl above validates a DNS answer, but a plain
// fetch() to the same hostname re-resolves independently. Since the attacker controls DNS for
// the URL they submitted, they can answer "safe" for our lookup and "127.0.0.1"/metadata IP for
// the real connection a moment later. Verified live: node:http(s)'s `lookup` option genuinely
// pins the TCP connection to the address we choose (confirmed via ECONNREFUSED against a
// deliberately-wrong pinned IP, then a real 200 + valid TLS against the correct one) - so the
// only real fix is to connect to the SAME addresses assertSafeUrl already checked, not the
// hostname again. Host/SNI still come from the URL, so TLS cert validation is unaffected.
export function createPinnedFetch(
  addresses: ResolvedAddress[],
  maxBodyBytes: number,
): (url: string, init: RequestInit) => Promise<Response> {
  return (url, init) =>
    new Promise((resolve, reject) => {
      const target = new URL(url);
      const requestFn = target.protocol === "https:" ? httpsRequest : httpRequest;
      const lookup = (
        _hostname: string,
        _options: unknown,
        callback: (err: Error | null, addresses: { address: string; family: number }[]) => void,
      ) => callback(null, addresses.map((a) => ({ address: a.address, family: a.family })));
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        req.destroy();
        reject(err);
      };
      const req = requestFn(target, { method: (init.method as string) ?? "GET", lookup }, (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          if (settled) return;
          total += chunk.byteLength;
          if (total > maxBodyBytes) {
            fail(new Error("MAX_UPLOAD_BYTES exceeded while streaming"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) for (const vv of v) headers.append(k, vv);
            else if (v != null) headers.set(k, v);
          }
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0, headers }));
        });
        res.on("error", fail);
      });
      req.on("error", fail);
      const signal = init.signal as AbortSignal | undefined;
      if (signal) {
        if (signal.aborted) req.destroy(new Error("aborted"));
        else signal.addEventListener("abort", () => req.destroy(new Error("timeout")));
      }
      req.end();
    });
}
