import { describe, expect, test } from "bun:test";
import { boundedInteger } from "../../apps/server/src/mcp/arguments.ts";

describe("boundedInteger", () => {
  const opts = { name: "limit", defaultValue: 8, min: 1, max: 20 };

  test("uses the default for missing, null, and empty values", () => {
    expect(boundedInteger(undefined, opts)).toBe(8);
    expect(boundedInteger(null, opts)).toBe(8);
    expect(boundedInteger("", opts)).toBe(8);
  });

  test("uses the default for non-finite numeric values", () => {
    expect(boundedInteger(Number.NaN, opts)).toBe(8);
    expect(boundedInteger(Number.POSITIVE_INFINITY, opts)).toBe(8);
    expect(boundedInteger(Number.NEGATIVE_INFINITY, opts)).toBe(8);
  });

  test("accepts an integer number or digit string within bounds", () => {
    expect(boundedInteger(12, opts)).toBe(12);
    expect(boundedInteger("20", opts)).toBe(20);
  });

  test("rejects values that are not bounded safe integers", () => {
    for (const value of [-1, 0, 21, 1.5, true, [], {}, "1.5", "-1", " 2"]) {
      let error: unknown;
      try {
        boundedInteger(value, opts);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: "INVALID_TOOL_ARGUMENTS", status: 400 });
    }
  });
});
