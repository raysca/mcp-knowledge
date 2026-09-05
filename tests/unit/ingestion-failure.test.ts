import { describe, expect, test } from "bun:test";
import { AppError, publicIngestionFailure, type IngestionFailureCode } from "../../packages/core/src/index.ts";

describe("publicIngestionFailure", () => {
  test.each([
    ["DOCUMENT_NEEDS_OCR", "This document needs OCR before it can be ingested."],
    ["DOCUMENT_ENCRYPTED", "This document is password-protected."],
    ["DOCUMENT_UNSUPPORTED_FORMAT", "This file format is not supported."],
    ["DOCUMENT_RESOURCE_LIMIT", "This file is too large or complex to ingest."],
    ["PAYLOAD_TOO_LARGE", "This upload is too large."],
    ["INGESTION_TIMEOUT", "Ingestion timed out."],
    ["DOCUMENT_MALFORMED", "This file could not be read."],
  ])("returns stable public copy for %s", (code, message) => {
    expect(publicIngestionFailure(new AppError(code as IngestionFailureCode, "untrusted worker output"))).toEqual({
      code: code as IngestionFailureCode,
      message,
    });
  });

  test("maps unknown parser output to malformed without leaking paths or secrets", () => {
    const result = publicIngestionFailure(
      new Error("parser failed for /Users/private/secret.pdf with token super-secret-token"),
    );

    expect(result).toEqual({
      code: "DOCUMENT_MALFORMED",
      message: "This file could not be read.",
    });
    expect(JSON.stringify(result)).not.toContain("/Users/private/secret.pdf");
    expect(JSON.stringify(result)).not.toContain("super-secret-token");
  });
});
