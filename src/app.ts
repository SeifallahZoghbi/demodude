// All HTTP routes. Built as a factory so tests can mount it with a fake Claude
// client and an in-memory store. Every route is registered relative to
// PUBLIC_BASE_PATH so the service can live under a reverse-proxy sub-path.

import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { getConnInfo } from "@hono/node-server/conninfo";
import { z } from "zod";
import type { AppRegistry, LoadedApp } from "./apps.js";
import { NOT_CONFIGURED_MESSAGE, START_LINE, type Guide, type MessageParam } from "./claude.js";
import { LIMITS, type RateLimiter } from "./limits.js";
import { CapError, pendingToolUse, trimHistory, type SessionStore } from "./sessions.js";

export interface AppDeps {
  registry: AppRegistry;
  store: SessionStore;
  /** Undefined when ANTHROPIC_API_KEY is missing: routes still work, turns report it. */
  guide: Guide | undefined;
  sessionLimiter: RateLimiter;
  /** Per-boot random salt so stored IP hashes cannot be reversed from a rainbow table. */
  ipSalt: string;
  publicDir: string;
  basePath?: string;
  adminToken?: string | undefined;
  log?: (msg: string) => void;
  now?: () => number;
}

const sessionBody = z.object({ app: z.string().min(1).max(64) }).strict();

const turnBody = z
  .object({
    userText: z.string().max(LIMITS.maxUserTextChars).optional(),
    moveResult: z
      .object({
        id: z.string().min(1).max(200),
        ok: z.boolean(),
        result: z.string().max(2000).optional(),
        error: z.string().max(500).optional(),
      })
      .strict()
      .optional(),
    state: z.record(z.string(), z.unknown()).optional(),
    start: z.boolean().optional(),
  })
  .strict();

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function normaliseBase(base: string | undefined): string {
  if (!base) return "";
  let b = base.trim();
  if (!b.startsWith("/")) b = `/${b}`;
  while (b.endsWith("/")) b = b.slice(0, -1);
  return b;
}

function clientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    // app.request() in tests has no socket behind it.
    return "unknown";
  }
}

function tokenMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Resolves a request path inside a bundle, refusing anything that escapes it. */
function safeJoin(root: string, relative: string): string | undefined {
  if (relative.includes("\0")) return undefined;
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return target;
}

function cacheControlFor(relPath: string): string {
  const ext = path.extname(relPath).toLowerCase();
  if (ext === ".html" || ext === ".json" || ext === ".md" || ext === "") return "no-cache";
  // Vite-style hashed assets live under assets/ and never change in place.
  if (relPath.startsWith("assets/")) return "public, max-age=31536000, immutable";
  return "public, max-age=300";
}

export function createApp(deps: AppDeps): Hono {
  const base = normaliseBase(deps.basePath);
  const log = deps.log ?? ((msg: string) => console.log(msg));
  const now = deps.now ?? Date.now;
  const app = new Hono({ strict: false });
  // Sessions with a turn in flight; a second concurrent turn would corrupt history.
  const busy = new Set<string>();

  const href = (p: string): string => `${base}${p}`;
  const panelPath = (id: string): string => (base ? `${base}/${id}` : `/demo/${id}`);
  const bundlePath = (id: string): string => `${base}/apps/${id}`;

  function hashIp(ip: string): string {
    return createHash("sha256").update(`${deps.ipSalt}:${ip}`).digest("hex").slice(0, 32);
  }

  function requireAdmin(c: Context): Response | undefined {
    if (!deps.adminToken) return c.json({ error: "admin endpoints are disabled (ADMIN_TOKEN unset)" }, 404);
    if (!tokenMatches(c.req.query("token"), deps.adminToken)) return c.json({ error: "forbidden" }, 403);
    return undefined;
  }

  // ---- pages -------------------------------------------------------------

  app.get(href("/healthz"), (c) =>
    c.json({ ok: true, apps: deps.registry.list().map((a) => a.id), aiConfigured: Boolean(deps.guide) }),
  );

  // Registered without a trailing slash: non-strict routing then matches both forms.
  app.get(base || "/", (c) => {
    const items = deps.registry
      .list()
      .map((a) => `<li><a href="${escapeHtml(panelPath(a.id))}">${escapeHtml(a.manifest.name)}</a> <code>${escapeHtml(a.id)}</code></li>`)
      .join("\n");
    return c.html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Demos</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#222}code{color:#666}</style>
</head><body><h1>Available demos</h1>
${items ? `<ul>${items}</ul>` : "<p>No app bundles loaded. Add one under APPS_DIR (see docs/protocol.md).</p>"}
</body></html>`);
  });

  app.get(href("/static/:file"), async (c) => {
    const file = (c.req.param("file") ?? "");
    if (!/^[a-z0-9_.-]+$/i.test(file)) return c.text("not found", 404);
    const abs = safeJoin(deps.publicDir, file);
    if (!abs) return c.text("not found", 404);
    try {
      const body = await readFile(abs);
      const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
      return c.body(body, 200, { "Content-Type": type, "Cache-Control": "no-cache" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return c.text("not found", 404);
      throw err;
    }
  });

  // ---- bundle static files ------------------------------------------------

  app.get(href("/apps/:app/*"), async (c) => {
    const id = (c.req.param("app") ?? "");
    const loaded = deps.registry.get(id);
    if (!loaded) return c.text(`No demo named "${id}"`, 404);
    const prefix = `${bundlePath(id)}/`;
    // c.req.path drops a trailing slash in non-strict mode; the raw pathname keeps it.
    const pathname = new URL(c.req.url).pathname;
    // Relative asset URLs in the bundle only resolve under the trailing slash.
    if (!pathname.startsWith(prefix)) return c.redirect(prefix, 302);
    let rel: string;
    try {
      rel = decodeURIComponent(pathname.slice(prefix.length));
    } catch {
      return c.text("bad path", 400);
    }
    if (rel === "" || rel.endsWith("/")) rel += loaded.manifest.entry;
    return serveBundleFile(loaded, rel, c);
  });

  async function serveBundleFile(loaded: LoadedApp, rel: string, c: Context): Promise<Response> {
    const abs = safeJoin(loaded.dir, rel);
    if (!abs) return c.text("not found", 404);
    let info;
    try {
      info = await stat(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // SPA fallback: extension-less paths are client-side routes.
      if (path.extname(rel) === "" && rel !== loaded.manifest.entry) {
        return serveBundleFile(loaded, loaded.manifest.entry, c);
      }
      return c.text("not found", 404);
    }
    if (info.isDirectory()) return serveBundleFile(loaded, path.posix.join(rel, loaded.manifest.entry), c);
    const type = CONTENT_TYPES[path.extname(abs).toLowerCase()] ?? "application/octet-stream";
    const stream = Readable.toWeb(createReadStream(abs)) as ReadableStream;
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": type,
        "Content-Length": String(info.size),
        "Cache-Control": cacheControlFor(rel.replace(/\\/g, "/")),
      },
    });
  }

  // The panel route is a bare "/:app" under a base path, so it goes after every
  // fixed route to never shadow them.
  app.get(base ? `${base}/:app` : "/demo/:app", async (c) => {
    const id = (c.req.param("app") ?? "");
    const loaded = deps.registry.get(id);
    if (!loaded) return c.text(`No demo named "${id}"`, 404);
    const startPath = loaded.manifest.startPath.replace(/^\/+/, "");
    const config = {
      appId: loaded.id,
      appName: loaded.manifest.name,
      basePath: base,
      iframePath: `${bundlePath(loaded.id)}/${startPath}`,
    };
    const template = await readFile(path.join(deps.publicDir, "panel.html"), "utf8");
    const html = template
      .replaceAll("{{APP_NAME}}", escapeHtml(loaded.manifest.name))
      .replaceAll("{{BASE}}", escapeHtml(base))
      .replaceAll("{{CONFIG_JSON}}", JSON.stringify(config).replaceAll("<", "\\u003c"));
    return c.html(html, 200, { "Cache-Control": "no-cache" });
  });

  // ---- sessions -----------------------------------------------------------

  app.post(href("/api/session"), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const parsed = sessionBody.safeParse(body);
    if (!parsed.success) return c.json({ error: "expected { app }" }, 400);
    const loaded = deps.registry.get(parsed.data.app);
    if (!loaded) return c.json({ error: `No demo named "${parsed.data.app}"` }, 404);
    const ipHash = hashIp(clientIp(c));
    if (!deps.sessionLimiter.allow(ipHash)) {
      return c.json({ error: "Too many demo sessions from this address; try again later." }, 429);
    }
    const session = deps.store.create({ app: loaded.id, ipHash });
    return c.json({ sessionId: session.id });
  });

  app.post(href("/api/session/:id/turn"), async (c) => {
    const id = (c.req.param("id") ?? "");
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const parsed = turnBody.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: `invalid turn: ${parsed.error.issues.map((i) => i.message).join("; ")}` }, 400);
    }
    const body = parsed.data;
    const stateJson = body.state === undefined ? undefined : JSON.stringify(body.state);
    if (stateJson !== undefined && stateJson.length > LIMITS.maxStateChars) {
      return c.json({ error: `state must serialise to <= ${LIMITS.maxStateChars} characters` }, 400);
    }

    const session = deps.store.get(id);
    if (!session) return c.json({ error: "unknown session" }, 404);
    if (session.status === "active" && now() - session.lastSeenAt > LIMITS.idleExpiryMs) {
      deps.store.setStatus(id, "expired");
      session.status = "expired";
    }
    if (session.status === "expired") return c.json({ error: "This demo session has expired.", code: "expired" }, 410);
    if (session.status === "ended") {
      return c.json({ error: "This demo session has reached its limit.", code: "cap" }, 429);
    }
    const loaded = deps.registry.get(session.app);
    if (!loaded) return c.json({ error: `The "${session.app}" demo is no longer available.` }, 410);

    const pending = pendingToolUse(session.messages);
    if (body.moveResult && !pending) return c.json({ error: "no move is pending for this session" }, 400);
    if (pending && !body.moveResult) return c.json({ error: "a move is pending; send its moveResult" }, 400);
    if (body.moveResult && pending && body.moveResult.id !== pending.id) {
      return c.json({ error: `pending move id is ${pending.id}` }, 400);
    }

    // Assemble this turn's user message: tool_result first, then state, then text.
    const blocks: Exclude<MessageParam["content"], string> = [];
    if (body.moveResult && pending) {
      blocks.push({
        type: "tool_result",
        tool_use_id: pending.id,
        content: body.moveResult.ok
          ? body.moveResult.result || "Done."
          : `Error: ${body.moveResult.error || "the move failed"}`,
        ...(body.moveResult.ok ? {} : { is_error: true }),
      });
    }
    if (stateJson !== undefined) blocks.push({ type: "text", text: `[state] ${stateJson}` });
    const userText = body.userText?.trim();
    if (userText) {
      blocks.push({ type: "text", text: userText });
    } else if (body.start) {
      if (session.messages.length > 0) return c.json({ error: "session already started" }, 400);
      blocks.push({ type: "text", text: START_LINE });
    }
    if (blocks.length === 0) return c.json({ error: "nothing to send: give userText, moveResult or start" }, 400);
    if (busy.has(id)) return c.json({ error: "a turn is already in progress" }, 409);

    busy.add(id);
    deps.store.touch(id, now());
    let messages: MessageParam[] = trimHistory([...session.messages, { role: "user", content: blocks }]);
    deps.store.saveMessages(id, messages, { countTurn: true });

    c.header("X-Accel-Buffering", "no");
    return streamSSE(
      c,
      async (stream) => {
        const abort = new AbortController();
        stream.onAbort(() => abort.abort());
        const send = async (event: string, data: unknown): Promise<void> => {
          if (abort.signal.aborted) return;
          try {
            await stream.writeSSE({ event, data: JSON.stringify(data) });
          } catch (err) {
            log(`sse write failed session=${id}: ${(err as Error).message}`);
          }
        };

        let partial = "";
        try {
          if (!deps.guide) {
            await send("error", { message: NOT_CONFIGURED_MESSAGE });
            await send("done", { reason: "error" });
            return;
          }
          deps.store.reserveModelCall(id);
          const outcome = await deps.guide.runTurn({
            app: loaded,
            messages,
            signal: abort.signal,
            onText: (delta) => {
              partial += delta;
              void send("text", { delta });
            },
          });
          deps.store.addUsage(id, outcome.usage);
          if (outcome.assistant) {
            messages = trimHistory([...messages, outcome.assistant]);
            deps.store.saveMessages(id, messages);
          }
          if (outcome.kind === "move") {
            await send("move", outcome.move);
            await send("done", { reason: "move" });
          } else {
            await send("done", { reason: outcome.kind });
          }
        } catch (err) {
          if (abort.signal.aborted) {
            // Visitor paused mid-stream: keep what was said so the history stays coherent.
            if (partial.trim()) {
              deps.store.saveMessages(id, trimHistory([...messages, { role: "assistant", content: partial }]));
            }
            return;
          }
          if (err instanceof CapError) {
            await send("error", { message: "This demo session has reached its limit. Press Restart to begin again.", code: "cap" });
            await send("done", { reason: "error" });
            return;
          }
          log(`turn failed session=${id} app=${loaded.id}: ${(err as Error).stack ?? String(err)}`);
          await send("error", { message: "The demo guide hit a problem talking to the AI. Please try again." });
          await send("done", { reason: "error" });
        } finally {
          busy.delete(id);
        }
      },
      async (err) => {
        busy.delete(id);
        log(`sse stream error session=${id}: ${err.message}`);
      },
    );
  });

  // ---- admin --------------------------------------------------------------

  app.get(href("/api/admin/stats"), (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;
    const apps = deps.store.stats();
    const totals = apps.reduce(
      (t, a) => ({
        sessions: t.sessions + a.sessions,
        turns: t.turns + a.turns,
        modelCalls: t.modelCalls + a.modelCalls,
        inputTokens: t.inputTokens + a.inputTokens,
        cacheReadTokens: t.cacheReadTokens + a.cacheReadTokens,
        outputTokens: t.outputTokens + a.outputTokens,
        estimatedUsd: Math.round((t.estimatedUsd + a.estimatedUsd) * 10_000) / 10_000,
      }),
      { sessions: 0, turns: 0, modelCalls: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, estimatedUsd: 0 },
    );
    const prompt = totals.inputTokens + totals.cacheReadTokens;
    return c.json({ apps, totals: { ...totals, cacheHitRatio: prompt === 0 ? 0 : totals.cacheReadTokens / prompt } });
  });

  app.post(href("/api/admin/reload"), async (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;
    const result = await deps.registry.reload();
    return c.json(result);
  });

  app.onError((err, c) => {
    log(`unhandled error ${c.req.method} ${c.req.path}: ${err.stack ?? err.message}`);
    return c.json({ error: "internal error" }, 500);
  });

  return app;
}
