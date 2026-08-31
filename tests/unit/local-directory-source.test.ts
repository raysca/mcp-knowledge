import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  fileSnapshotChanged,
  LocalDirectorySource,
} from "../../apps/server/src/startup-scan/local-directory-source.ts";

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const item of items) values.push(item);
  return values;
}

describe("LocalDirectorySource", () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mcp-local-source-"));
    outside = await mkdtemp(join(tmpdir(), "mcp-local-source-outside-"));
    await mkdir(join(root, "one", "two"), { recursive: true });
    await mkdir(join(root, ".hidden"));
    await mkdir(join(root, "normal-directory"));
    await writeFile(join(root, "root.txt"), "root");
    await writeFile(join(root, "one", "one.txt"), "one");
    await writeFile(join(root, "one", "two", "two.txt"), "two");
    await writeFile(join(root, ".hidden.txt"), "hidden");
    await writeFile(join(root, ".hidden", "secret.txt"), "secret");
    await writeFile(join(outside, "outside.txt"), "outside");
    await symlink("one", join(root, "directory-link"));
    await symlink(outside, join(root, "child-link"));
    await symlink("root.txt", join(root, "file-link.txt"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  test("enumerates only ordinary visible files within the configured depth", async () => {
    const source = await LocalDirectorySource.create({ root, maxDepth: 0 });
    expect(await collect(source.candidates(new AbortController().signal))).toEqual([
      { relativePath: "root.txt" },
    ]);

    const nested = await LocalDirectorySource.create({ root, maxDepth: 2 });
    const signal = new AbortController().signal;
    expect((await collect(nested.candidates(signal))).map((x) => x.relativePath).sort()).toEqual([
      "one/one.txt",
      "one/two/two.txt",
      "root.txt",
    ]);
  });

  test("reports only safe, statable paths", async () => {
    const source = await LocalDirectorySource.create({ root, maxDepth: 2 });

    expect(await source.pathState("root.txt")).toBe("present");
    expect(await source.pathState("missing.txt")).toBe("missing");
    expect(await source.pathState("../outside.txt")).toBe("unknown");
  });

  test("reads stable files, enforces size limits, and rejects traversal", async () => {
    const source = await LocalDirectorySource.create({ root, maxDepth: 2 });
    const signal = new AbortController().signal;
    const candidate = { relativePath: "root.txt" };

    await expect(source.inspectAndRead(candidate, 3, signal)).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
    });
    await expect(source.inspectAndRead({ relativePath: "../outside.txt" }, 10, signal)).rejects.toThrow(
      "Source candidate path is unsafe.",
    );
    await expect(source.inspectAndRead(candidate, 4, signal)).resolves.toMatchObject({
      bytes: new TextEncoder().encode("root"),
      sizeBytes: 4,
      sha256: "4813494d137e1631bba301d5acab6e7bb7aa74ce1185d456565ef51d737677b2",
    });
  });

  test("rejects paths that traverse an intermediate child symlink", async () => {
    const source = await LocalDirectorySource.create({ root, maxDepth: 2 });
    const candidate = { relativePath: "child-link/outside.txt" };

    expect(await source.pathState(candidate.relativePath)).toBe("unknown");
    await expect(source.inspectAndRead(candidate, 10, new AbortController().signal)).rejects.toThrow(
      "Source candidate path is unsafe.",
    );
  });

  test("detects size, modification time, and inode changes between snapshots", () => {
    const before = { size: 4, mtimeMs: 1_000, ino: 10 };

    expect(fileSnapshotChanged(before, before)).toBeFalse();
    expect(fileSnapshotChanged(before, { ...before, size: 5 })).toBeTrue();
    expect(fileSnapshotChanged(before, { ...before, mtimeMs: 1_001 })).toBeTrue();
    expect(fileSnapshotChanged(before, { ...before, ino: 11 })).toBeTrue();
  });
});
