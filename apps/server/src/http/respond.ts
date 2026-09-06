import { AppError, errorBody, logger, newId, serializeError } from "@mcp-knowledge/core";

// ponytail: a client-supplied header can contain characters (CRLF, control chars) that make
// `new Response()` throw when we echo it back — verified: crashes every request that reaches
// json()/errorResponse with that header. Only reuse it if it's safe to put back in a header.
const SAFE_REQUEST_ID = /^[\x21-\x7e]{1,200}$/;

export function requestIdOf(req: Request): string {
  const supplied = req.headers.get("x-request-id");
  return supplied && SAFE_REQUEST_ID.test(supplied) ? supplied : newId("req");
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
  logger.error({ event: "http_error", requestId, error: serializeError(error) });
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
