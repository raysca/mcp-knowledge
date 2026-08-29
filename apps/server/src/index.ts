import homepage from "./ui/index.html";
import { createApp } from "./app.ts";
import { loadEnv } from "./config/env.ts";

const env = loadEnv();
const app = await createApp(env);

const server = Bun.serve({
  port: env.PORT,
  hostname: env.HOST,
  development: env.APP_PROFILE === "local",
  routes: {
    "/": homepage,
    "/collections": homepage,
    "/jobs": homepage,
    "/playground": homepage,
  },
  fetch: app.fetch,
});

console.log(`listening on http://${server.hostname}:${server.port}`);
