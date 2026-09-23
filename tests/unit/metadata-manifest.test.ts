import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalDirectorySource } from "../../apps/server/src/startup-scan/local-directory-source.ts";

const manifestName = ".mcp-knowledge-manifest.json";

describe("ingest metadata manifest", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mcp-manifest-"));
    await mkdir(join(root, "articles", "nested"), { recursive: true });
    await writeFile(join(root, "articles", "nested", "one.md"), "one");
    await writeFile(join(root, "articles", "two.md"), "two");
    await writeFile(join(root, "plain.txt"), "plain");
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const create = () => LocalDirectorySource.create({ root, maxDepth: 8 });
  async function manifest(value: unknown) {
    await writeFile(join(root, manifestName), JSON.stringify(value));
  }
  async function candidates() {
    return Array.fromAsync((await create()).candidates(new AbortController().signal));
  }

  test("applies ordered shallow rules, preserves JSON values, and forces the relative sourcePath", async () => {
    await manifest({ rules: [
      { glob: "articles/**/*.md", metadata: { documentType: "guide", enabled: false, count: 0,
        label: "", missing: null, tags: ["a", { nested: [true, null] }], config: { old: 1 }, sourcePath: "forged.md" } },
      { glob: "articles/nested/one.?d", metadata: { documentType: "specific", config: { next: 2 } } },
    ] });
    const entries = await candidates();
    expect(entries).toHaveLength(3);
    expect(entries.find((entry) => entry.relativePath === "articles/nested/one.md")).toEqual({
      relativePath: "articles/nested/one.md",
      metadata: { sourcePath: "articles/nested/one.md", documentType: "specific", enabled: false,
        count: 0, label: "", missing: null, tags: ["a", { nested: [true, null] }], config: { next: 2 } },
    });
    expect(entries.find((entry) => entry.relativePath === "articles/two.md")).toMatchObject({
      metadata: { sourcePath: "articles/two.md", documentType: "guide", config: { old: 1 } },
    });
    expect(entries.find((entry) => entry.relativePath === "plain.txt")).toEqual({
      relativePath: "plain.txt", metadata: { sourcePath: "plain.txt" },
    });
  });

  test("loads only the root manifest, excludes manifests from reads, and fingerprints manifest bytes", async () => {
    const before = await create();
    await writeFile(join(root, "articles", manifestName), "not a manifest");
    expect((await create()).configurationFingerprint).toBe(before.configurationFingerprint);
    await manifest({ rules: [] });
    const first = await create();
    expect(first.sourceId).toBe(before.sourceId);
    expect(first.configurationFingerprint).not.toBe(before.configurationFingerprint);
    expect((await create()).configurationFingerprint).toBe(first.configurationFingerprint);
    await manifest({ rules: [{ glob: "**/*.md", metadata: { version: 2 } }] });
    expect((await create()).configurationFingerprint).not.toBe(first.configurationFingerprint);
    expect((await candidates()).map((entry) => entry.relativePath).sort()).toEqual([
      "articles/nested/one.md", "articles/two.md", "plain.txt",
    ]);
    for (const relativePath of [manifestName, `articles/${manifestName}`]) {
      await expect(first.inspectAndRead({ relativePath }, 4096, new AbortController().signal)).rejects.toThrow();
    }
  });

  test.each([
    null, [], {}, { rules: {} }, { rules: [], extra: true }, { rules: [null] },
    { rules: [{ glob: "*.md" }] }, { rules: [{ glob: "*.md", metadata: null }] },
    { rules: [{ glob: "*.md", metadata: [] }] }, { rules: [{ glob: "*.md", metadata: "text" }] },
    { rules: [{ glob: "*.md", metadata: {}, extra: true }] },
  ].map((value) => [value]))("rejects malformed schema %j", async (value) => {
    await manifest(value);
    await expect(create()).rejects.toMatchObject({ code: "INVALID_INGEST_MANIFEST" });
  });

  test.each([
    "", "/etc/*.md", "C:/data/*.md", "C:*.md", "\\\\host\\share\\*.md", "articles\\*.md",
    "../*.md", "articles/../*.md", "./*.md", "articles/./*.md", "articles//*.md", "articles/",
    "{articles,../outside}/*.md", "articles/{..,nested}/*.md", "!articles/*.md", "@(../outside)/*.md",
    "articles/[.][.]/*.md", "articles/\u0000.md",
  ])("rejects unsafe or ambiguous glob %s", async (glob) => {
    await manifest({ rules: [{ glob, metadata: {} }] });
    await expect(create()).rejects.toMatchObject({ code: "INVALID_INGEST_MANIFEST" });
  });

  test.each([
    "{", '{"rules":[{"glob":"*.md","metadata":{"value":1e999}}]}',
    '{"rules":[{"glob":"*.md","metadata":{"__proto__":{"polluted":true}}}]}',
    '{"rules":[{"glob":"*.md","metadata":{"nested":[{"constructor":{"prototype":{}}}]}}]}',
    '{"rules":[{"glob":"*.md","metadata":{"nested":{"prototype":true}}}]}',
  ])("rejects invalid JSON or unsafe metadata %s", async (contents) => {
    await writeFile(join(root, manifestName), contents);
    await expect(create()).rejects.toMatchObject({ code: "INVALID_INGEST_MANIFEST" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("rejects oversized and deeply nested metadata without unbounded reads", async () => {
    await writeFile(join(root, manifestName), " ".repeat(1024 * 1024 + 1));
    await expect(create()).rejects.toMatchObject({ code: "INVALID_INGEST_MANIFEST" });
    await writeFile(join(root, manifestName), '{"rules":[{"glob":"*.md","metadata":{"nested":' +
      "[".repeat(1000) + "null" + "]".repeat(1000) + "}}]}");
    await expect(create()).rejects.toMatchObject({ code: "INVALID_INGEST_MANIFEST" });
  });

  test("rejects malformed UTF-8 with the public manifest error", async () => {
    await writeFile(join(root, manifestName), Uint8Array.of(0xff, 0xfe));
    await expect(create()).rejects.toMatchObject({ code: "INVALID_INGEST_MANIFEST" });
  });

  test("rejects symlink and directory manifests", async () => {
    await writeFile(join(root, "actual.json"), '{"rules":[]}');
    await symlink("actual.json", join(root, manifestName));
    await expect(create()).rejects.toMatchObject({ code: "INVALID_INGEST_MANIFEST" });
    await rm(join(root, manifestName));
    await symlink("missing.json", join(root, manifestName));
    await expect(create()).rejects.toMatchObject({ code: "INVALID_INGEST_MANIFEST" });
    await rm(join(root, manifestName));
    await mkdir(join(root, manifestName));
    await expect(create()).rejects.toMatchObject({ code: "INVALID_INGEST_MANIFEST" });
  });
});
