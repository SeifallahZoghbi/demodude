import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/limits.js";
import { CapError, openSessionStore, pendingToolUse, trimHistory, type MessageParam } from "../src/sessions.js";

describe("session store", () => {
  it("rejects the 61st model call and ends the session", () => {
    const store = openSessionStore(":memory:");
    const s = store.create({ app: "_stub", ipHash: "abc" });
    for (let i = 0; i < LIMITS.maxModelCallsPerSession; i++) store.reserveModelCall(s.id);
    expect(store.get(s.id)?.modelCalls).toBe(60);
    expect(() => store.reserveModelCall(s.id)).toThrow(CapError);
    expect(store.get(s.id)?.status).toBe("ended");
    store.close();
  });

  it("expires idle sessions after 30 minutes", () => {
    const store = openSessionStore(":memory:");
    const s = store.create({ app: "_stub", ipHash: "abc" });
    const t0 = store.get(s.id)!.lastSeenAt;
    expect(store.expireIdle(t0 + LIMITS.idleExpiryMs - 1)).toBe(0);
    expect(store.get(s.id)?.status).toBe("active");
    expect(store.expireIdle(t0 + LIMITS.idleExpiryMs + 1)).toBe(1);
    expect(store.get(s.id)?.status).toBe("expired");
    expect(store.touch(s.id)).toBe(false);
    store.close();
  });

  it("accumulates usage and reports per-app stats", () => {
    const store = openSessionStore(":memory:");
    const s = store.create({ app: "_stub", ipHash: "abc" });
    store.reserveModelCall(s.id);
    store.addUsage(s.id, { inputTokens: 1000, cacheReadTokens: 3000, outputTokens: 100 });
    const [stats] = store.stats();
    expect(stats?.app).toBe("_stub");
    expect(stats?.modelCalls).toBe(1);
    expect(stats?.cacheHitRatio).toBeCloseTo(0.75);
    // 1000*4 + 3000*0.2 + 100*20 = 4000+600+2000 = 6600 per million
    expect(stats?.estimatedUsd).toBeCloseTo(0.0066);
    store.close();
  });
});

function toolUseTurn(i: number): MessageParam {
  return {
    role: "assistant",
    content: [
      { type: "text", text: `step ${i}` },
      { type: "tool_use", id: `toolu_${i}`, name: "go_to_screen", input: { screen: "boards" } },
    ],
  };
}

function toolResultTurn(i: number): MessageParam {
  return {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: `toolu_${i}`, content: "Now on boards." },
      { type: "text", text: '[state] {"screen":"boards"}' },
    ],
  };
}

function pairsAreIntact(messages: MessageParam[]): void {
  const seenToolUse = new Set<string>();
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const block of m.content) {
      if (block.type === "tool_use") seenToolUse.add(block.id);
      if (block.type === "tool_result") {
        expect(seenToolUse.has(block.tool_use_id), `orphan tool_result ${block.tool_use_id}`).toBe(true);
      }
    }
  }
}

describe("trimHistory", () => {
  it("keeps the greeting and never splits a tool_use/tool_result pair", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "A visitor has just opened the demo." },
      { role: "assistant", content: [{ type: "text", text: "Welcome!" }] },
    ];
    // 30 move turns = 60 messages of alternating tool_use / tool_result.
    for (let i = 0; i < 30; i++) {
      messages.push(toolUseTurn(i), toolResultTurn(i));
    }
    const trimmed = trimHistory(messages, 40);
    expect(trimmed.length).toBeLessThanOrEqual(40);
    expect(trimmed[0]).toEqual(messages[0]);
    expect(trimmed[1]).toEqual(messages[1]);
    pairsAreIntact(trimmed);
    // The tail still holds recent history and never opens with an orphan result.
    expect(trimmed.length).toBeGreaterThan(30);
    const opener = trimmed[2];
    expect(opener?.role).toBe("assistant");
    expect(trimmed.at(-1)).toEqual(messages.at(-1));
  });

  it("keeps a greeting that itself called a move together with its result", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "start" },
      toolUseTurn(100),
      toolResultTurn(100),
      { role: "assistant", content: [{ type: "text", text: "Here we are." }] },
    ];
    for (let i = 0; i < 30; i++) {
      messages.push({ role: "user", content: `q${i}` }, { role: "assistant", content: `a${i}` });
    }
    const trimmed = trimHistory(messages, 40);
    expect(trimmed.length).toBeLessThanOrEqual(40);
    expect(trimmed.slice(0, 4)).toEqual(messages.slice(0, 4));
    pairsAreIntact(trimmed);
  });

  it("leaves short histories untouched", () => {
    const messages: MessageParam[] = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }];
    expect(trimHistory(messages, 40)).toBe(messages);
  });
});

describe("pendingToolUse", () => {
  it("finds the unanswered tool_use at the end of the history", () => {
    expect(pendingToolUse([{ role: "user", content: "hi" }, toolUseTurn(1)])).toEqual({
      id: "toolu_1",
      name: "go_to_screen",
      input: { screen: "boards" },
    });
    expect(pendingToolUse([{ role: "user", content: "hi" }, toolUseTurn(1), toolResultTurn(1)])).toBeUndefined();
    expect(pendingToolUse([])).toBeUndefined();
  });
});
