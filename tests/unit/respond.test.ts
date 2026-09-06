import { describe, expect, test } from "bun:test";
import { AppError } from "../../packages/core/src/index.ts";
import { errorResponse } from "../../apps/server/src/http/respond.ts";

function captureConsoleError(run: () => void): string {
  const original = console.error;
  let captured = "";
  console.error = ((line: string) => {
    captured = line;
  }) as typeof console.error;
  try {
    run();
  } finally {
    console.error = original;
  }
  return captured;
}

describe("errorResponse", () => {
  test("logs an unexpected error as one JSON line carrying the request id", async () => {
    const line = captureConsoleError(() => {
      errorResponse(new Error("unexpected failure"), "req_abc");
    });
    const record = JSON.parse(line);
    expect(record.level).toBe("error");
    expect(record.event).toBe("http_error");
    expect(record.requestId).toBe("req_abc");
    expect(record.error.message).toBe("unexpected failure");
  });

  test("does not log an AppError (already a known, expected failure)", async () => {
    let logged = false;
    const original = console.error;
    console.error = (() => {
      logged = true;
    }) as typeof console.error;
    try {
      const res = errorResponse(new AppError("DOCUMENT_NOT_FOUND", "not found", 404), "req_1");
      expect(res.status).toBe(404);
    } finally {
      console.error = original;
    }
    expect(logged).toBe(false);
  });

  test("still returns a safe 500 body with no internal detail", async () => {
    let res!: Response;
    captureConsoleError(() => {
      res = errorResponse(new Error("db exploded with /Users/private/secret"), "req_2");
    });
    const body = await res.json();
    expect(body).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Internal server error.", requestId: "req_2" },
    });
  });
});
