import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createApp } from "../src/app.js";
import { createAppRegistry } from "../src/apps.js";
import { createGuide, NOT_CONFIGURED_MESSAGE } from "../src/claude.js";
import { createRateLimiter } from "../src/limits.js";
import { openSessionStore } from "../src/sessions.js";
import { createFakeClient, type Script } from "./fake-client.js";

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

function parseSse(text: string): SseEvent[] {
  return text
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      }
      return { event, data: JSON.parse(data.join("\n")) as Record<string, unknown> };
    });
}

async function build(opts: { scripts: Script[]; basePath?: string; configured?: boolean; adminToken?: string }) {
  const registry = createAppRegistry({ appsDir: path.resolve("apps"), log: () => undefined });
  await registry.reload();
  const fake = createFakeClient(opts.scripts);
  const app = createApp({
    registry,
    store: openSessionStore(":memory:"),
    guide: opts.configured === false ? undefined : createGuide({ client: fake.client, log: () => undefined }),
    sessionLimiter: createRateLimiter({ max: 10, windowMs: 60_000 }),
    ipSalt: "test",
    publicDir: path.resolve("public"),
    basePath: opts.basePath ?? "",
    adminToken: opts.adminToken,
    log: () => undefined,
  });
  return { app, fake };
}

async function postJson(app: Hono, url: string, body: unknown): Promise<Response> {
  return app.request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("http", () => {
  let app: Hono;
  let fake: ReturnType<typeof createFakeClient>;

  beforeAll(async () => {
    ({ app, fake } = await build({
      scripts: [
        { text: "Welcome! Let me open the boards.", toolUse: { name: "go_to_screen", input: { screen: "boards" } } },
        { text: "Here are the boards.", stopReason: "end_turn" },
      ],
      adminToken: "secret",
    }));
  });

  it("serves the index, panel and health check", async () => {
    const index = await app.request("/");
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('href="/demo/_stub"');

    const panel = await app.request("/demo/_stub");
    expect(panel.status).toBe(200);
    const html = await panel.text();
    expect(html).toContain("Stub Quoting App");
    expect(html).toContain('"iframePath":"/apps/_stub/"');
    expect(html).toContain("/static/panel.js");

    const health = await app.request("/healthz");
    expect(await health.json()).toEqual({ ok: true, apps: ["_stub"], aiConfigured: true });

    expect((await app.request("/demo/nope")).status).toBe(404);
  });

  it("serves bundle files with a SPA fallback and blocks traversal", async () => {
    const index = await app.request("/apps/_stub/");
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(index.headers.get("cache-control")).toBe("no-cache");
    expect(await index.text()).toContain("Stub Quoting App");

    const js = await app.request("/apps/_stub/demo.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");

    const spa = await app.request("/apps/_stub/boards/42");
    expect(spa.status).toBe(200);
    expect(spa.headers.get("content-type")).toContain("text/html");

    expect((await app.request("/apps/_stub/missing.png")).status).toBe(404);
    expect((await app.request("/apps/_stub/..%2F..%2Fpackage.json")).status).toBe(404);
    expect((await app.request("/apps/_stub")).status).toBe(302);
  });

  it("runs start -> move -> moveResult -> end_turn over SSE", async () => {
    const created = await postJson(app, "/api/session", { app: "_stub" });
    expect(created.status).toBe(200);
    const { sessionId } = (await created.json()) as { sessionId: string };
    expect(sessionId).toMatch(/[0-9a-f-]{36}/);

    // Nothing pending yet: a moveResult is rejected.
    const early = await postJson(app, `/api/session/${sessionId}/turn`, { moveResult: { id: "x", ok: true } });
    expect(early.status).toBe(400);

    const first = await postJson(app, `/api/session/${sessionId}/turn`, { start: true, state: { screen: "projects" } });
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSse(await first.text());
    const text = events.filter((e) => e.event === "text").map((e) => e.data.delta).join("");
    expect(text).toBe("Welcome! Let me open the boards.");
    const move = events.find((e) => e.event === "move");
    expect(move?.data.name).toBe("go_to_screen");
    expect(move?.data.args).toEqual({ screen: "boards" });
    expect(events.at(-1)).toEqual({ event: "done", data: { reason: "move" } });

    // The user message carried the fixed start line and the state.
    const sent = fake.calls[0]!.messages;
    expect(sent).toHaveLength(1);
    const content = sent[0]!.content;
    expect(Array.isArray(content) && content.map((b) => (b.type === "text" ? b.text : b.type))).toEqual([
      '[state] {"screen":"projects"}',
      "A visitor has just opened the demo. Greet them in one sentence and begin.",
    ]);

    // A move is pending: a turn without its result is rejected.
    const missing = await postJson(app, `/api/session/${sessionId}/turn`, { userText: "hello" });
    expect(missing.status).toBe(400);

    const second = await postJson(app, `/api/session/${sessionId}/turn`, {
      moveResult: { id: move!.data.id, ok: true, result: "Now on boards." },
      state: { screen: "boards" },
    });
    expect(second.status).toBe(200);
    const events2 = parseSse(await second.text());
    expect(events2.filter((e) => e.event === "text").map((e) => e.data.delta).join("")).toBe("Here are the boards.");
    expect(events2.at(-1)).toEqual({ event: "done", data: { reason: "end_turn" } });

    // Second call carried the tool_result for the pending tool_use.
    const history = fake.calls[1]!.messages;
    expect(history).toHaveLength(3);
    const lastUser = history[2]!.content;
    expect(Array.isArray(lastUser) && lastUser[0]?.type === "tool_result" && lastUser[0].tool_use_id).toBe(move!.data.id);

    // Admin stats reflect the two calls.
    expect((await app.request("/api/admin/stats")).status).toBe(403);
    const stats = (await (await app.request("/api/admin/stats?token=secret")).json()) as {
      apps: Array<{ app: string; modelCalls: number }>;
    };
    expect(stats.apps[0]).toMatchObject({ app: "_stub", modelCalls: 2 });
  });

  it("validates turn bodies", async () => {
    const { sessionId } = (await (await postJson(app, "/api/session", { app: "_stub" })).json()) as { sessionId: string };
    expect((await postJson(app, `/api/session/${sessionId}/turn`, { userText: "x".repeat(1001) })).status).toBe(400);
    expect((await postJson(app, `/api/session/${sessionId}/turn`, { state: { big: "y".repeat(700) } })).status).toBe(400);
    expect((await postJson(app, `/api/session/${sessionId}/turn`, {})).status).toBe(400);
    expect((await postJson(app, "/api/session/nope/turn", { userText: "hi" })).status).toBe(404);
    expect((await postJson(app, "/api/session", { app: "nope" })).status).toBe(404);
  });

  it("reports a missing API key on the first turn instead of crashing", async () => {
    const { app: bare } = await build({ scripts: [], configured: false });
    const { sessionId } = (await (await postJson(bare, "/api/session", { app: "_stub" })).json()) as { sessionId: string };
    const res = await postJson(bare, `/api/session/${sessionId}/turn`, { start: true });
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    expect(events[0]).toEqual({ event: "error", data: { message: NOT_CONFIGURED_MESSAGE } });
    expect(events.at(-1)).toEqual({ event: "done", data: { reason: "error" } });
  });

  it("mounts everything under PUBLIC_BASE_PATH", async () => {
    const { app: based } = await build({ scripts: [{ text: "hi" }], basePath: "/demo" });
    expect((await based.request("/demo/healthz")).status).toBe(200);
    const panel = await based.request("/demo/_stub");
    expect(panel.status).toBe(200);
    const html = await panel.text();
    expect(html).toContain('"iframePath":"/demo/apps/_stub/"');
    expect(html).toContain('"basePath":"/demo"');
    expect(html).toMatch(/href="\/demo\/static\/panel\.css\?v=[a-z0-9]+"/);
    expect((await based.request("/demo/static/panel.js")).status).toBe(200);
    expect((await based.request("/demo/apps/_stub/")).status).toBe(200);
    expect((await based.request("/demo/")).status).toBe(200);
    const created = await postJson(based, "/demo/api/session", { app: "_stub" });
    expect(created.status).toBe(200);
    expect((await based.request("/healthz")).status).toBe(404);
  });
});
