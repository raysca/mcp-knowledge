import { describe, expect, test } from "bun:test";
import { errorBody } from "../../packages/core/src/errors.ts";

describe("errorBody", () => {
  test("returns the envelope without a stack", () => {
    const body = errorBody(
      { code: "DOCUMENT_NOT_FOUND", message: "Document was not found." },
      "req_abc",
    );
    expect(body).toEqual({
      error: {
        code: "DOCUMENT_NOT_FOUND",
        message: "Document was not found.",
        requestId: "req_abc",
      },
    });
    expect(JSON.stringify(body)).not.toContain("stack");
  });
});
