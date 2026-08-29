import { lookup as dnsLookup } from "node:dns/promises";
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

export async function assertSafeUrl(raw: string, lookup: LookupFn = defaultLookup): Promise<URL> {
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
  return url;
}

async function defaultLookup(hostname: string): Promise<ResolvedAddress[]> {
  const all = await dnsLookup(hostname, { all: true });
  return all.map((a) => ({ address: a.address, family: a.family }));
}
