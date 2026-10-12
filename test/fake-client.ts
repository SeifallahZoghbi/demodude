// A scripted stand-in for the Anthropic client: each call pops the next script
// and replays it as stream events, so tests exercise the real prompt assembly
// and stop_reason handling without the network.

import type { BetaMessage, GuideClient, GuideStream, StreamEvent, StreamParams } from "../src/claude.js";

export interface Script {
  text?: string;
  toolUse?: { name: string; input: Record<string, unknown> };
  stopReason?: BetaMessage["stop_reason"];
  cacheRead?: number;
}

export interface FakeClient {
  client: GuideClient;
  calls: StreamParams[];
}

let toolCounter = 0;

function makeStream(script: Script, signal?: AbortSignal): GuideStream {
  const text = script.text ?? "";
  const stopReason = script.stopReason ?? (script.toolUse ? "tool_use" : "end_turn");
  const toolId = `toolu_${++toolCounter}`;
  const content: unknown[] = [];
  if (text) content.push({ type: "text", text, citations: null });
  if (script.toolUse) content.push({ type: "tool_use", id: toolId, name: script.toolUse.name, input: script.toolUse.input });

  const message = {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: script.cacheRead ?? 0,
      cache_creation_input_tokens: 0,
    },
  } as unknown as BetaMessage;

  async function* events(): AsyncGenerator<StreamEvent> {
    if (text) {
      yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: null } } as StreamEvent;
      for (const chunk of text.match(/.{1,6}/gs) ?? []) {
        if (signal?.aborted) throw new Error("aborted");
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } } as StreamEvent;
      }
      yield { type: "content_block_stop", index: 0 } as StreamEvent;
    }
    if (script.toolUse) {
      yield {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: toolId, name: script.toolUse.name, input: {} },
      } as StreamEvent;
      yield {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(script.toolUse.input) },
      } as StreamEvent;
      yield { type: "content_block_stop", index: 1 } as StreamEvent;
    }
    yield { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: message.usage } as StreamEvent;
    yield { type: "message_stop" } as StreamEvent;
  }

  return {
    [Symbol.asyncIterator]: () => events(),
    finalMessage: async () => message,
    abort: () => undefined,
  };
}

export function createFakeClient(scripts: Script[]): FakeClient {
  const queue = [...scripts];
  const calls: StreamParams[] = [];
  return {
    calls,
    client: {
      beta: {
        messages: {
          stream(params, options) {
            calls.push(params);
            const script = queue.shift() ?? { text: "(unscripted reply)", stopReason: "end_turn" };
            return makeStream(script, options?.signal);
          },
        },
      },
    },
  };
}
