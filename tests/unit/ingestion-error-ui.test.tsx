import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { IngestionErrorDetails, parseIngestionError } from "../../apps/server/src/ui/lib/ingestion-error.ts";

describe("parseIngestionError", () => {
  test.each([
    ["DOCUMENT_NEEDS_OCR: ignored", "DOCUMENT_NEEDS_OCR", "This document needs OCR before it can be ingested.", "Make the document searchable with OCR, then re-upload it."],
    ["DOCUMENT_ENCRYPTED: ignored", "DOCUMENT_ENCRYPTED", "This document is password-protected.", "Remove the password, then re-upload the file."],
    ["DOCUMENT_UNSUPPORTED_FORMAT: ignored", "DOCUMENT_UNSUPPORTED_FORMAT", "This file format is not supported.", "Convert the file to a supported format, then re-upload it."],
    ["DOCUMENT_RESOURCE_LIMIT: ignored", "DOCUMENT_RESOURCE_LIMIT", "This file is too large or complex to ingest.", "Split the file or reduce its size, then re-upload it."],
    ["PAYLOAD_TOO_LARGE: ignored", "PAYLOAD_TOO_LARGE", "This upload is too large.", "Split the file or reduce its size, then re-upload it."],
    ["INGESTION_TIMEOUT: ignored", "INGESTION_TIMEOUT", "Ingestion timed out.", "Retry once. If it fails again, check Jobs and troubleshooting."],
    ["DOCUMENT_MALFORMED: ignored", "DOCUMENT_MALFORMED", "This file could not be read.", "Re-export the file from its source application, then re-upload it."],
  ])("uses fixed copy for %s", (value, code, message, action) => {
    expect(parseIngestionError(value)).toEqual({ code, message, action });
  });

  test("falls back safely when stored data is unknown or hostile", () => {
    const hostile = "NOPE: /Users/private/secret.pdf token super-secret-token";
    expect(parseIngestionError(hostile)).toEqual({
      code: "DOCUMENT_MALFORMED",
      message: "This file could not be read.",
      action: "Check Jobs and troubleshooting, then re-export the file before trying again.",
    });
  });
});

describe("IngestionErrorDetails", () => {
  test("renders safe code, message, and action without rendering hostile stored data", () => {
    const html = renderToStaticMarkup(
      <IngestionErrorDetails value="NOPE: /Users/private/secret.pdf token super-secret-token" />,
    );

    expect(html).toContain("DOCUMENT_MALFORMED");
    expect(html).toContain("This file could not be read.");
    expect(html).toContain("Check Jobs and troubleshooting");
    expect(html).not.toContain("/Users/private/secret.pdf");
    expect(html).not.toContain("super-secret-token");
  });
});
