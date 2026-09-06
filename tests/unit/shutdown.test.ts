import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShutdownHandler } from "../../apps/server/src/shutdown.ts";

describe("createShutdownHandler", () => {
  test("stops the app then server exactly once for concurrent calls", async () => {
    const calls: string[] = [];
    const shutdown = createShutdownHandler({
      stopApp: () => calls.push("app"),
      stopServer: async () => {
        calls.push("server");
      },
    });

    await Promise.all([shutdown(), shutdown()]);

    expect(calls).toEqual(["app", "server"]);
  });

  test("SIGTERM lets an app process with the local embedder exit promptly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-knowledge-shutdown-"));
    const child = Bun.spawn(
      ["bun", join(import.meta.dir, "../fixtures/shutdown-app-entry.ts"), dir],
      { stdout: "pipe", stderr: "pipe" },
    );

    try {
      const reader = child.stdout.getReader();
      const ready = await Promise.race([
        reader.read(),
        Bun.sleep(10_000).then(() => ({ done: false, value: undefined })),
      ]);
      reader.releaseLock();
      expect(new TextDecoder().decode(ready.value)).toContain("ready");

      child.kill("SIGTERM");
      const exitCode = await Promise.race([
        child.exited,
        Bun.sleep(2_000).then(() => "timeout" as const),
      ]);

      expect(exitCode).not.toBe("timeout");
      expect(exitCode).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("a completed ingestion cannot leave its deadline keeping the process alive", async () => {
    const child = Bun.spawn(
      ["bun", join(import.meta.dir, "../fixtures/worker-loop-successful-stop-entry.ts")],
      { stdout: "pipe", stderr: "pipe" },
    );

    try {
      const reader = child.stdout.getReader();
      const output = await Promise.race([
        reader.read(),
        Bun.sleep(5_000).then(() => ({ done: false, value: undefined })),
      ]);
      reader.releaseLock();
      expect(new TextDecoder().decode(output.value)).toContain("done");

      const exitCode = await Promise.race([
        child.exited,
        Bun.sleep(2_000).then(() => "timeout" as const),
      ]);
      expect(exitCode).not.toBe("timeout");
      expect(exitCode).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  }, 10_000);

  test.each(["failure", "in-flight-stop", "handle-backed-stop"])("%s releases its ingestion deadline", async (scenario) => {
    const child = Bun.spawn(
      ["bun", join(import.meta.dir, "../fixtures/worker-loop-successful-stop-entry.ts"), scenario],
      { stdout: "pipe", stderr: "pipe" },
    );

    try {
      const reader = child.stdout.getReader();
      const output = await Promise.race([
        reader.read(),
        Bun.sleep(5_000).then(() => ({ done: false, value: undefined })),
      ]);
      reader.releaseLock();
      expect(new TextDecoder().decode(output.value)).toContain("done");
      const exitCode = await Promise.race([
        child.exited,
        Bun.sleep(2_000).then(() => "timeout" as const),
      ]);
      expect(exitCode).not.toBe("timeout");
      expect(exitCode).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  }, 10_000);

  test("stopping while claimJob resolves does not begin or retain another job", async () => {
    const child = Bun.spawn(
      ["bun", join(import.meta.dir, "../fixtures/worker-loop-successful-stop-entry.ts"), "claim-race"],
      { stdout: "pipe", stderr: "pipe" },
    );

    try {
      const reader = child.stdout.getReader();
      const output = await Promise.race([
        reader.read(),
        Bun.sleep(5_000).then(() => ({ done: false, value: undefined })),
      ]);
      reader.releaseLock();
      const exitCode = await Promise.race([
        child.exited,
        Bun.sleep(2_000).then(() => "timeout" as const),
      ]);
      expect(exitCode).not.toBe("timeout");
      expect(exitCode).toBe(0);
      expect(new TextDecoder().decode(output.value)).toBe("done\n");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  }, 10_000);

  test("a worker crash after stop cannot keep the process alive", async () => {
    const child = Bun.spawn(
      ["bun", join(import.meta.dir, "../fixtures/embedder-crash-during-stop-entry.ts")],
      { stdout: "pipe", stderr: "pipe" },
    );

    try {
      const reader = child.stdout.getReader();
      const output = await Promise.race([
        reader.read(),
        Bun.sleep(5_000).then(() => ({ done: false, value: undefined })),
      ]);
      reader.releaseLock();
      expect(new TextDecoder().decode(output.value)).toContain("done");

      const exitCode = await Promise.race([
        child.exited,
        Bun.sleep(2_000).then(() => "timeout" as const),
      ]);
      expect(exitCode).not.toBe("timeout");
      expect(exitCode).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  }, 10_000);

  test("duplicate fatal callbacks cannot leave a recovery generation referenced", async () => {
    const child = Bun.spawn(
      ["bun", join(import.meta.dir, "../fixtures/embedder-duplicate-fatal-entry.ts")],
      { stdout: "pipe", stderr: "pipe" },
    );

    try {
      const reader = child.stdout.getReader();
      const output = await Promise.race([
        reader.read(),
        Bun.sleep(5_000).then(() => ({ done: false, value: undefined })),
      ]);
      reader.releaseLock();
      expect(new TextDecoder().decode(output.value)).toContain("done");

      const exitCode = await Promise.race([
        child.exited,
        Bun.sleep(2_000).then(() => "timeout" as const),
      ]);
      expect(exitCode).not.toBe("timeout");
      expect(exitCode).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  }, 10_000);
});
