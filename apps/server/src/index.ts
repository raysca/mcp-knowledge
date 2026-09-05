import homepage from "./ui/index.html";
import { createApp } from "./app.ts";
import { loadEnv } from "./config/env.ts";
import { createShutdownHandler } from "./shutdown.ts";

const env = loadEnv();
const app = await createApp(env);

const server = Bun.serve({
  port: env.PORT,
  hostname: env.HOST,
  development: env.APP_PROFILE === "local",
  routes: {
    "/": homepage,
    "/collections": homepage,
    "/documents/:id": homepage,
    "/jobs": homepage,
    "/playground": homepage,
  },
  fetch: app.fetch,
});

const shutdown = createShutdownHandler({
  stopApp: () => app.stop(),
  stopServer: () => server.stop(false),
});

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

app.startStartupScan();
console.log(`listening on http://${server.hostname}:${server.port}`);
