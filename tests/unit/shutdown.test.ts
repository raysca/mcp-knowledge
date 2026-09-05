import { describe, expect, test } from "bun:test";
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
});
