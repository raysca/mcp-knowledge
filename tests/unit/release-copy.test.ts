import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../..");

test("public installation copy uses stable image tags and released source checkout guidance", async () => {
  const [readme, landingPage] = await Promise.all([
    readFile(resolve(repositoryRoot, "README.md"), "utf8"),
    readFile(resolve(repositoryRoot, "index.html"), "utf8"),
  ]);

  for (const copy of [readme, landingPage]) {
    expect(copy).toContain("ghcr.io/raysca/mcp-knowledge:0.1");
    expect(copy).not.toContain("ghcr.io/raysca/mcp-knowledge:main");
    expect(copy.toLowerCase()).not.toContain("immutable");
  }

  expect(readme).toContain("git checkout v0.1.0");
  expect(readme).toMatch(/`main` for\s+current development/);

  expect(landingPage).not.toContain(
    "The <code>main</code> tag tracks the current published build. Pin a versioned tag when the first release is published.",
  );
});
