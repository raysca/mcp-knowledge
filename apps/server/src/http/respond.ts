import { AppError, errorBody, newId } from "@mcp-knowledge/core";

export function requestIdOf(req: Request): string {
  return req.headers.get("x-request-id") ?? newId("req");
}

export function json(data: unknown, status: number, requestId: string): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-request-id": requestId,
    },
  });
}

export function errorResponse(error: unknown, requestId: string): Response {
  if (error instanceof AppError) {
    return json(errorBody(error, requestId), error.status, requestId);
  }
  console.error(error);
  return json(
    errorBody(
      { code: "INTERNAL_ERROR", message: "Internal server error." },
      requestId,
    ),
    500,
    requestId,
  );
}

export function clampLimit(raw: string | null, max: number, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}
