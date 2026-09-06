import { describe, expect, test } from "bun:test";
import { logger, serializeError } from "../../packages/core/src/logger.ts";

function captureConsole<K extends "log" | "warn" | "error">(
  method: K,
  run: () => void,
): string {
  const original = console[method];
  let captured = "";
  console[method] = ((line: string) => {
    captured = line;
  }) as typeof console[K];
  try {
    run();
  } finally {
    console[method] = original;
  }
  return captured;
}

describe("logger", () => {
  test("info emits a single JSON line on console.log with level and timestamp", () => {
    const line = captureConsole("log", () => {
      logger.info({ event: "server_listening", port: 3000 });
    });
    const record = JSON.parse(line);
    expect(record.level).toBe("info");
    expect(record.event).toBe("server_listening");
    expect(record.port).toBe(3000);
    expect(typeof record.timestamp).toBe("string");
    expect(new Date(record.timestamp).toString()).not.toBe("Invalid Date");
  });

  test("warn emits on console.warn", () => {
    const line = captureConsole("warn", () => {
      logger.warn({ event: "blob_cleanup_failed", key: "documents/doc_1/original" });
    });
    const record = JSON.parse(line);
    expect(record.level).toBe("warn");
    expect(record.event).toBe("blob_cleanup_failed");
  });

  test("error emits on console.error", () => {
    const line = captureConsole("error", () => {
      logger.error({ event: "worker_claim_failed" });
    });
    const record = JSON.parse(line);
    expect(record.level).toBe("error");
    expect(record.event).toBe("worker_claim_failed");
  });

  test("a multi-line stack trace stays on one JSON line", () => {
    const error = new Error("boom");
    error.stack = "Error: boom\n    at one (file.ts:1:1)\n    at two (file.ts:2:2)";
    const line = captureConsole("error", () => {
      logger.error({ event: "http_error", error: serializeError(error) });
    });
    expect(line.split("\n")).toHaveLength(1);
    const record = JSON.parse(line);
    expect(record.error.message).toBe("boom");
    expect(record.error.stack).toContain("at two");
  });
});

describe("serializeError", () => {
  test("extracts name, message, and stack from a real Error", () => {
    const error = new Error("something broke");
    const result = serializeError(error);
    expect(result.name).toBe("Error");
    expect(result.message).toBe("something broke");
    expect(result.stack).toContain("something broke");
  });

  test("includes a string code when the error carries one", () => {
    const error = Object.assign(new Error("failed"), { code: "PAYLOAD_TOO_LARGE" });
    expect(serializeError(error).code).toBe("PAYLOAD_TOO_LARGE");
  });

  test("omits code when absent rather than including undefined", () => {
    const result = serializeError(new Error("plain"));
    expect("code" in result).toBe(false);
  });

  test("falls back to String() for a non-Error thrown value", () => {
    expect(serializeError("just a string")).toEqual({ message: "just a string" });
    expect(serializeError(42)).toEqual({ message: "42" });
  });
});
