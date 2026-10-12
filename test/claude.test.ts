import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadBundle } from "../src/apps.js";
import { REFUSAL_LINE, createGuide } from "../src/claude.js";
import { createFakeClient } from "./fake-client.js";

const stubDir = path.resolve("apps/_stub");
const quiet = (): void => undefined;

describe("claude guide", () => {
  it("puts cache_control on the last system block only", async () => {
    const app = await loadBundle(stubDir, "_stub");
    const guide = createGuide({ client: createFakeClient([]).client, log: quiet });
    const system = guide.buildSystem(app);
    expect(system).toHaveLength(4);
    expect(system.slice(0, 3).every((b) => b.cache_control === undefined)).toBe(true);
    expect(system[3]?.cache_control).toEqual({ type: "ephemeral" });
    expect(system[0]?.text).toContain("1 to 3 short sentences");
    expect(system[1]?.text).toContain(app.knowledge.trim());
    expect(system[2]?.text).toContain(app.scenario.trim());
  });

  it("builds strict tools from moves.json in a deterministic order", async () => {
    const app = await loadBundle(stubDir, "_stub");
    const guide = createGuide({ client: createFakeClient([]).client, log: quiet });
    const tools = guide.buildTools(app.moves);
    expect(tools.map((t) => t.name)).toEqual(["go_to_screen", "point_at", "reset_demo", "set_markup"]);
    for (const tool of tools) {
      expect(tool.strict).toBe(true);
      expect(tool.input_schema.additionalProperties).toBe(false);
      expect("eager_input_streaming" in tool).toBe(false);
    }
    const reversed = guide.buildTools([...app.moves].reverse());
    expect(reversed.map((t) => t.name)).toEqual(tools.map((t) => t.name));
  });

  it("strips schema keywords strict tools reject, but keeps property names", async () => {
    const app = await loadBundle(stubDir, "_stub");
    const guide = createGuide({ client: createFakeClient([]).client, log: quiet });
    const move = {
      ...app.moves[0]!,
      name: "ranged",
      input_schema: {
        type: "object",
        properties: {
          percent: { type: "number", minimum: 0, maximum: 60, default: 18 },
          pattern: { type: "string", pattern: "^[a-z]+$", maxLength: 5 },
          tags: { type: "array", items: { type: "string", format: "uuid" }, minItems: 1 },
        },
        required: ["percent", "pattern", "tags"],
        additionalProperties: false,
      },
    };
    const [tool] = guide.buildTools([move]);
    const props = tool!.input_schema.properties as Record<string, Record<string, unknown>>;
    expect(props.percent).toEqual({ type: "number" });
    expect(props.pattern).toEqual({ type: "string" });
    expect(props.tags).toEqual({ type: "array", items: { type: "string" } });
    expect(tool!.input_schema.required).toEqual(["percent", "pattern", "tags"]);
  });

  it("sends the required request shape", async () => {
    const app = await loadBundle(stubDir, "_stub");
    const fake = createFakeClient([{ text: "Hi." }]);
    const guide = createGuide({ client: fake.client, log: quiet });
    await guide.runTurn({ app, messages: [{ role: "user", content: "hello" }], onText: quiet });
    const params = fake.calls[0]!;
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.max_tokens).toBe(1024);
    expect(params.output_config).toEqual({ effort: "low" });
    expect(params.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(params.fallbacks).toBe("default");
    expect(params.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect("thinking" in params).toBe(false);
  });

  it("turns a streamed tool_use into a move with a parsed input", async () => {
    const app = await loadBundle(stubDir, "_stub");
    const fake = createFakeClient([
      { text: "Let me show you the boards.", toolUse: { name: "go_to_screen", input: { screen: "boards" } } },
    ]);
    const guide = createGuide({ client: fake.client, log: quiet });
    let streamed = "";
    const outcome = await guide.runTurn({
      app,
      messages: [{ role: "user", content: "show me" }],
      onText: (d) => {
        streamed += d;
      },
    });
    expect(streamed).toBe("Let me show you the boards.");
    expect(outcome.kind).toBe("move");
    if (outcome.kind !== "move") throw new Error("expected move");
    expect(outcome.move.name).toBe("go_to_screen");
    expect(outcome.move.args).toEqual({ screen: "boards" });
    expect(outcome.move.id).toMatch(/^toolu_/);
    const content = outcome.assistant.content;
    expect(Array.isArray(content) && content.some((b) => b.type === "tool_use")).toBe(true);
  });

  it("replaces a refusal with the neutral line", async () => {
    const app = await loadBundle(stubDir, "_stub");
    const fake = createFakeClient([{ text: "", stopReason: "refusal" }]);
    const guide = createGuide({ client: fake.client, log: quiet });
    let streamed = "";
    const outcome = await guide.runTurn({
      app,
      messages: [{ role: "user", content: "something off-topic" }],
      onText: (d) => {
        streamed += d;
      },
    });
    expect(outcome.kind).toBe("refusal");
    expect(streamed).toBe(REFUSAL_LINE);
    expect(outcome.assistant.content).toEqual([{ type: "text", text: REFUSAL_LINE }]);
  });

  it("reports end_turn with the assistant text", async () => {
    const app = await loadBundle(stubDir, "_stub");
    const fake = createFakeClient([{ text: "That is the whole flow.", stopReason: "end_turn", cacheRead: 2000 }]);
    const guide = createGuide({ client: fake.client, log: quiet });
    const outcome = await guide.runTurn({ app, messages: [{ role: "user", content: "ok" }], onText: quiet });
    expect(outcome.kind).toBe("end_turn");
    expect(outcome.assistant?.content).toEqual([{ type: "text", text: "That is the whole flow.", citations: null }]);
    expect(outcome.usage.cacheReadTokens).toBe(2000);
  });

  it("never runs a tool_use that was cut off by max_tokens", async () => {
    const app = await loadBundle(stubDir, "_stub");
    const fake = createFakeClient([
      { text: "Going", toolUse: { name: "go_to_screen", input: { screen: "boards" } }, stopReason: "max_tokens" },
    ]);
    const guide = createGuide({ client: fake.client, log: quiet });
    const outcome = await guide.runTurn({ app, messages: [{ role: "user", content: "go" }], onText: quiet });
    expect(outcome.kind).toBe("end_turn");
    const content = outcome.kind === "end_turn" ? outcome.assistant?.content : undefined;
    expect(Array.isArray(content) && content.every((b) => b.type !== "tool_use")).toBe(true);
  });
});
