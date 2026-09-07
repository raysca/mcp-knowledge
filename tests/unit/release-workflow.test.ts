import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../..");

function jobSection(workflow: string, name: string, followingName?: string) {
  const start = workflow.indexOf(`  ${name}:\n`);
  expect(start).toBeGreaterThanOrEqual(0);

  const end = followingName === undefined ? workflow.length : workflow.indexOf(`\n  ${followingName}:\n`, start);
  expect(end).toBeGreaterThan(start);
  return workflow.slice(start, end);
}

describe("release workflow", () => {
  test("typechecks and validates committed scale reports in the test job before tests", async () => {
    const workflow = await readFile(resolve(repositoryRoot, ".github/workflows/docker.yml"), "utf8");
    const testJob = jobSection(workflow, "test", "platform-smoke");
    const install = testJob.indexOf("- run: bun install --frozen-lockfile");
    const typecheck = testJob.indexOf("- run: bun run typecheck");
    const validateScaleReports = testJob.indexOf("- run: bun scripts/release/validate-scale-reports.ts");
    const tests = testJob.indexOf("- run: bun test");

    expect(install).toBeGreaterThanOrEqual(0);
    expect(typecheck).toBeGreaterThan(install);
    expect(validateScaleReports).toBeGreaterThan(typecheck);
    expect(tests).toBeGreaterThan(validateScaleReports);
  });

  test("publishes after the test job with a minor SemVer image tag", async () => {
    const workflow = await readFile(resolve(repositoryRoot, ".github/workflows/docker.yml"), "utf8");
    const publishJob = jobSection(workflow, "publish");

    expect(publishJob).toContain("needs: [test, platform-smoke]");
    expect(publishJob).toContain("type=semver,pattern={{major}}.{{minor}}");
  });
});
