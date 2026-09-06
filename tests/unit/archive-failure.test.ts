import { describe, expect, test } from "bun:test";
import { AppError, publicArchiveFailure, type ArchiveFailureCode } from "../../packages/core/src/index.ts";

describe("publicArchiveFailure", () => {
  test.each([
    ["ARCHIVE_TOO_LARGE", "This archive exceeds the configured entry or size limit."],
    ["ARCHIVE_MALFORMED", "This archive could not be read."],
  ])("returns stable public copy for %s", (code, message) => {
    expect(publicArchiveFailure(new AppError(code as ArchiveFailureCode, "untrusted zip library output"))).toEqual({
      code: code as ArchiveFailureCode,
      message,
    });
  });

  test("maps unknown archive errors to malformed without leaking paths", () => {
    const result = publicArchiveFailure(new Error("central directory read failed for /Users/private/upload.zip"));
    expect(result).toEqual({ code: "ARCHIVE_MALFORMED", message: "This archive could not be read." });
    expect(JSON.stringify(result)).not.toContain("/Users/private/upload.zip");
  });

  test.each(["toString", "constructor", "__proto__"])("rejects inherited failure code %s", (code) => {
    expect(publicArchiveFailure({ code })).toEqual({
      code: "ARCHIVE_MALFORMED",
      message: "This archive could not be read.",
    });
  });
});
