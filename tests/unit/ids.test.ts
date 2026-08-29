import { describe, expect, test } from "bun:test";
import { ID_PREFIXES, newId } from "../../packages/core/src/ids.ts";

describe("newId", () => {
  test("uses the prefix and an underscore", () => {
    for (const prefix of ID_PREFIXES) {
      const id = newId(prefix);
      expect(id.startsWith(`${prefix}_`)).toBe(true);
      expect(id.slice(prefix.length + 1).length).toBeGreaterThan(20);
    }
  });

  test("is unique", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(newId("doc"));
    }
    expect(seen.size).toBe(200);
  });

  test("is time-sortable (UUIDv7)", async () => {
    const first = newId("doc");
    await Bun.sleep(2);
    const second = newId("doc");
    expect(first < second).toBe(true);
  });
});
