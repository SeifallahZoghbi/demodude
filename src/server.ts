// Process bootstrap: reads env, wires the registry, store and Claude client into
// the Hono app, and starts the HTTP listener. Nothing here is imported by tests.

import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import Anthropic from "@anthropic-ai/sdk";
import { createApp } from "./app.js";
import { createAppRegistry } from "./apps.js";
import { createGuide, type Guide } from "./claude.js";
import { LIMITS, createRateLimiter } from "./limits.js";
import { openSessionStore } from "./sessions.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const log = (msg: string): void => console.log(`${new Date().toISOString()} ${msg}`);

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8900);
  const host = process.env.HOST ?? "127.0.0.1";
  const appsDir = path.resolve(process.env.APPS_DIR ?? "./apps");
  const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");
  const basePath = process.env.PUBLIC_BASE_PATH ?? "";
  const adminToken = process.env.ADMIN_TOKEN || undefined;
  // dist/server.js and src/server.ts both sit one level below the repo root.
  const publicDir = path.resolve(here, "..", "public");

  if (!Number.isInteger(port) || port <= 0) throw new Error(`PORT must be a positive integer, got "${process.env.PORT}"`);

  await mkdir(dataDir, { recursive: true });
  const store = openSessionStore(path.join(dataDir, "sessions.db"));

  const registry = createAppRegistry({ appsDir, log });
  const loaded = await registry.reload();
  log(`apps loaded from ${appsDir}: ${loaded.loaded.join(", ") || "none"}`);
  for (const e of loaded.errors) log(`apps: ${e}`);
  registry.watch();

  // The SDK reads ANTHROPIC_API_KEY itself; we only check presence so that a
  // missing key degrades to a clear panel message instead of a boot crash.
  let guide: Guide | undefined;
  if (process.env.ANTHROPIC_API_KEY) {
    guide = createGuide({ client: new Anthropic(), log });
  } else {
    log("ANTHROPIC_API_KEY is not set: serving demos without the AI guide");
  }

  const app = createApp({
    registry,
    store,
    guide,
    sessionLimiter: createRateLimiter({ max: LIMITS.sessionsPerIp, windowMs: LIMITS.sessionsPerIpWindowMs }),
    ipSalt: randomBytes(16).toString("hex"),
    publicDir,
    basePath,
    adminToken,
    log,
  });

  const sweeper = setInterval(() => {
    const n = store.expireIdle();
    if (n > 0) log(`expired ${n} idle session(s)`);
  }, 5 * 60 * 1000);

  const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    log(`demodude listening on http://${info.address}:${info.port}${basePath || ""}`);
    if (!adminToken) log("ADMIN_TOKEN unset: admin endpoints disabled");
  });

  const shutdown = (signal: string): void => {
    log(`${signal} received, shutting down`);
    clearInterval(sweeper);
    registry.close();
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error("demodude failed to start:", err);
  process.exit(1);
});
