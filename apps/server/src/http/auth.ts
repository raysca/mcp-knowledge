export function isLoopbackAddress(addr: string | null | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/i, "").toLowerCase();
  return a === "127.0.0.1" || a === "::1" || a === "localhost";
}

export function shouldSkipAuth(
  env: { AUTH_DISABLED: boolean },
  remoteAddress?: string | null,
): boolean {
  return env.AUTH_DISABLED && isLoopbackAddress(remoteAddress);
}

export type AuthScope = "read" | "write" | "admin";

export function scopeAllows(have: string[], need: AuthScope): boolean {
  if (have.includes("admin")) return true;
  if (need === "read") return have.includes("read") || have.includes("write");
  if (need === "write") return have.includes("write");
  return false;
}

export function requiredScope(method: string, pathname: string): AuthScope | null {
  if (pathname === "/health") return null;
  if (pathname === "/mcp") return "read";
  if (!pathname.startsWith("/api/v1")) return null;
  if (pathname.startsWith("/api/v1/api-keys")) return "admin";
  if (method === "GET") return "read";
  if (pathname === "/api/v1/search" || pathname === "/api/v1/search/explain") return "read";
  return "write";
}
