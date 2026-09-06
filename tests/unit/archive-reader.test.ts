import { describe, expect, test } from "bun:test";
import AdmZip from "adm-zip";
import { AdmZipArchiveReader } from "../../packages/core/src/archive/reader.ts";

function buildZip(files: Array<{ name: string; content: string }>): Uint8Array {
  const zip = new AdmZip();
  for (const file of files) {
    zip.addFile(file.name, Buffer.from(file.content, "utf8"));
  }
  return new Uint8Array(zip.toBuffer());
}

describe("AdmZipArchiveReader", () => {
  test("lists entries with declared sizes, skipping directories", () => {
    const zip = new AdmZip();
    zip.addFile("folder/", Buffer.alloc(0)); // a trailing slash makes adm-zip store a directory entry
    zip.addFile("notes.txt", Buffer.from("hello world", "utf8"));
    const reader = new AdmZipArchiveReader(new Uint8Array(zip.toBuffer()));
    const entries = reader.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.path).toBe("notes.txt");
    expect(entries[0]!.declaredUncompressedBytes).toBe(11);
    expect(entries[0]!.isDirectory).toBe(false);
    expect(entries[0]!.isSymlink).toBe(false);
  });

  test("reads an entry's decompressed bytes", () => {
    const bytes = buildZip([{ name: "a.txt", content: "content of a" }]);
    const reader = new AdmZipArchiveReader(bytes);
    const data = reader.read("a.txt", 1024);
    expect(new TextDecoder().decode(data)).toBe("content of a");
  });

  test("throws for an unknown entry path", () => {
    const bytes = buildZip([{ name: "a.txt", content: "x" }]);
    const reader = new AdmZipArchiveReader(bytes);
    expect(() => reader.read("missing.txt", 1024)).toThrow();
  });

  test("throws when the decompressed entry exceeds maxBytes", () => {
    const bytes = buildZip([{ name: "big.txt", content: "0123456789" }]);
    const reader = new AdmZipArchiveReader(bytes);
    expect(() => reader.read("big.txt", 5)).toThrow();
  });
});
