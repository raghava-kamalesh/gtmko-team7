import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createDatabase } from "./db.js";
import { attachVoiceProxy } from "./voice.js";

const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../.env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

const port = Number(process.env.PORT ?? 3001);
const database = await createDatabase();
const app = createApp(database);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Costco commerce API listening on http://localhost:${info.port}`);
});
attachVoiceProxy(server as unknown as import("node:http").Server);

async function shutdown() {
  server.close();
  await database.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
