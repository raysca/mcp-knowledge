import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../..");

describe("release workflow", () => {
  test("typechecks and validates committed scale reports before publishing", async () => {
    const workflow = await readFile(resolve(repositoryRoot, ".github/workflows/docker.yml"), "utf8");

    expect(workflow).toMatch(/^\s*- run: bun run typecheck$/m);
    expect(workflow).toMatch(/^\s*- run: bun scripts\/release\/validate-scale-reports\.ts$/m);
  });

  test("publishes a minor SemVer image tag", async () => {
    const workflow = await readFile(resolve(repositoryRoot, ".github/workflows/docker.yml"), "utf8");

    expect(workflow).toContain("type=semver,pattern={{major}}.{{minor}}");
  });
});
