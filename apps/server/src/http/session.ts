import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "mk_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ponytail: stateless signed cookie, not a session table - no store to clean up, no extra
// migration. The cookie's own signature is its validity proof: HMAC(expiresAt) keyed by the
// passphrase itself, so rotating DASHBOARD_PASSPHRASE invalidates every outstanding session
// for free, without a revocation list.
function sign(secret: string, expiresAt: number): string {
  return createHmac("sha256", secret).update(String(expiresAt)).digest("hex");
}

export function createSessionCookieValue(secret: string, ttlMs = SESSION_TTL_MS): string {
  const expiresAt = Date.now() + ttlMs;
  return `${expiresAt}.${sign(secret, expiresAt)}`;
}

export function verifySessionCookieValue(secret: string, value: string | undefined | null): boolean {
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot < 0) return false;
  const expiresAt = Number(value.slice(0, dot));
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  const given = Buffer.from(value.slice(dot + 1), "hex");
  const want = Buffer.from(sign(secret, expiresAt), "hex");
  return given.length === want.length && timingSafeEqual(given, want);
}

export function parseCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

// `Secure` requires HTTPS or browsers silently drop the cookie - fine for local http://
// dev, but a server-profile deployment behind TLS termination needs it. ponytail: this
// assumes the server profile is the one behind TLS; a real TRUST_PROXY-style override for
// unusual topologies (TLS-terminating proxy in front of a "local" profile instance) is out
// of scope until that's a real deployment someone has, not before.
export function sessionCookieHeader(secret: string, appProfile: string): string {
  const value = createSessionCookieValue(secret);
  const secure = appProfile === "server" ? " Secure;" : "";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly;${secure} SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

export function clearSessionCookieHeader(appProfile: string): string {
  const secure = appProfile === "server" ? " Secure;" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly;${secure} SameSite=Strict; Max-Age=0`;
}

// ponytail: in-memory, per-process, resets on restart - matches WORKER_CONCURRENCY's existing
// single-process assumption elsewhere in this codebase. Good enough to stop naive brute-force
// against a single instance; add a shared store if this ever runs multi-replica behind a
// load balancer (same ceiling as the job queue's current single-process design).
const attempts = new Map<string, { count: number; resetAt: number }>();
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

export function loginRateLimited(key: string): boolean {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > LOGIN_MAX_ATTEMPTS;
}
