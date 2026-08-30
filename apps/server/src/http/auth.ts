export type AuthScope = "read" | "write" | "admin";

export function scopeAllows(have: string[], need: AuthScope): boolean {
  if (have.includes("admin")) return true;
  if (need === "read") return have.includes("read") || have.includes("write");
  if (need === "write") return have.includes("write");
  return false;
}

export function requiredScope(method: string, pathname: string): AuthScope | null {
  if (pathname === "/health") return null;
  // The login/check/logout endpoints ARE the auth mechanism - they must be reachable
  // without already holding a session or key.
  if (pathname === "/api/v1/session") return null;
  if (pathname === "/mcp") return "read";
  if (!pathname.startsWith("/api/v1")) return null;
  if (pathname.startsWith("/api/v1/api-keys")) return "admin";
  if (method === "GET") return "read";
  if (pathname === "/api/v1/search" || pathname === "/api/v1/search/explain") return "read";
  return "write";
}
