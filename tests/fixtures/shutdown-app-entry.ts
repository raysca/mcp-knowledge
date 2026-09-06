import { join } from "node:path";
import { createApp } from "../../apps/server/src/app.ts";
import { loadEnv } from "../../apps/server/src/config/env.ts";
import { createShutdownHandler } from "../../apps/server/src/shutdown.ts";

const root = process.argv[2];
if (!root) throw new Error("temporary data directory is required");

const app = await createApp(
  loadEnv({
    APP_PROFILE: "local",
    DATABASE_URL: `file:${join(root, "app.db")}`,
    STORAGE_PATH: join(root, "blobs"),
  }),
);
const server = Bun.serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
const shutdown = createShutdownHandler({
  stopApp: app.stop,
  stopServer: () => server.stop(false),
});

process.on("SIGTERM", () => void shutdown());
process.stdout.write("ready\n");
