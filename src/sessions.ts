// Session persistence on node:sqlite (available on Node 22 and 24 without a native
// build). One row per visitor session holds the whole Claude message history as
// JSON: the service is single-process and the history is small (<= 40 messages),
// so a document column is simpler and safer than normalising turns.

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { LIMITS } from "./limits.js";

export type MessageParam = Anthropic.Beta.BetaMessageParam;
export type SessionStatus = "active" | "expired" | "ended";

export interface Session {
  id: string;
  app: string;
  createdAt: number;
  lastSeenAt: number;
  ipHash: string;
  turns: number;
  modelCalls: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  messages: MessageParam[];
  status: SessionStatus;
}

export interface UsageDelta {
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

export interface AppStats {
  app: string;
  sessions: number;
  turns: number;
  modelCalls: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  cacheHitRatio: number;
  estimatedUsd: number;
}

export interface SessionStore {
  create(input: { app: string; ipHash: string }): Session;
  get(id: string): Session | undefined;
  /** Marks the session seen now; returns false if it is not active. */
  touch(id: string, now?: number): boolean;
  setStatus(id: string, status: SessionStatus): void;
  /** Replaces the history (already trimmed by the caller) and bumps the turn counter. */
  saveMessages(id: string, messages: MessageParam[], opts?: { countTurn?: boolean }): void;
  /** Reserves one model call; throws CapError when the session is at its cap. */
  reserveModelCall(id: string): void;
  addUsage(id: string, usage: UsageDelta): void;
  /** Flags idle sessions as expired; returns how many changed. */
  expireIdle(now?: number): number;
  stats(): AppStats[];
  close(): void;
}

export class CapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapError";
  }
}

// Prices per million tokens (USD) used for the admin estimate only.
const PRICE = { input: 4, cacheRead: 0.2, output: 20 } as const;

interface Row {
  id: string;
  app: string;
  created_at: number;
  last_seen_at: number;
  ip_hash: string;
  turns: number;
  model_calls: number;
  input_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  messages_json: string;
  status: string;
}

function rowToSession(row: Row): Session {
  let messages: MessageParam[] = [];
  try {
    messages = JSON.parse(row.messages_json) as MessageParam[];
  } catch (err) {
    throw new Error(`session ${row.id}: corrupt messages_json (${(err as Error).message})`);
  }
  return {
    id: row.id,
    app: row.app,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    ipHash: row.ip_hash,
    turns: row.turns,
    modelCalls: row.model_calls,
    inputTokens: row.input_tokens,
    cacheReadTokens: row.cache_read_tokens,
    outputTokens: row.output_tokens,
    messages,
    status: row.status as SessionStatus,
  };
}

export function openSessionStore(dbPath: string): SessionStore {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      app TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      ip_hash TEXT NOT NULL,
      turns INTEGER NOT NULL DEFAULT 0,
      model_calls INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      messages_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE INDEX IF NOT EXISTS sessions_app_idx ON sessions(app);
    CREATE INDEX IF NOT EXISTS sessions_status_seen_idx ON sessions(status, last_seen_at);
  `);

  const insert = db.prepare(
    `INSERT INTO sessions (id, app, created_at, last_seen_at, ip_hash) VALUES (?, ?, ?, ?, ?)`,
  );
  const select = db.prepare(`SELECT * FROM sessions WHERE id = ?`);
  const touchStmt = db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ? AND status = 'active'`);
  const statusStmt = db.prepare(`UPDATE sessions SET status = ? WHERE id = ?`);
  const saveStmt = db.prepare(`UPDATE sessions SET messages_json = ?, turns = turns + ? WHERE id = ?`);
  const reserveStmt = db.prepare(
    `UPDATE sessions SET model_calls = model_calls + 1 WHERE id = ? AND status = 'active' AND model_calls < ?`,
  );
  const usageStmt = db.prepare(
    `UPDATE sessions SET input_tokens = input_tokens + ?, cache_read_tokens = cache_read_tokens + ?, output_tokens = output_tokens + ? WHERE id = ?`,
  );
  const expireStmt = db.prepare(
    `UPDATE sessions SET status = 'expired' WHERE status = 'active' AND last_seen_at < ?`,
  );
  const statsStmt = db.prepare(`
    SELECT app, COUNT(*) AS sessions, SUM(turns) AS turns, SUM(model_calls) AS model_calls,
           SUM(input_tokens) AS input_tokens, SUM(cache_read_tokens) AS cache_read_tokens,
           SUM(output_tokens) AS output_tokens
    FROM sessions GROUP BY app ORDER BY app
  `);

  return {
    create({ app, ipHash }) {
      const id = randomUUID();
      const now = Date.now();
      insert.run(id, app, now, now, ipHash);
      const session = this.get(id);
      if (!session) throw new Error(`session ${id} vanished right after insert`);
      return session;
    },
    get(id) {
      const row = select.get(id) as Row | undefined;
      return row ? rowToSession(row) : undefined;
    },
    touch(id, now = Date.now()) {
      return touchStmt.run(now, id).changes > 0;
    },
    setStatus(id, status) {
      statusStmt.run(status, id);
    },
    saveMessages(id, messages, opts) {
      saveStmt.run(JSON.stringify(messages), opts?.countTurn ? 1 : 0, id);
    },
    reserveModelCall(id) {
      const changes = reserveStmt.run(id, LIMITS.maxModelCallsPerSession).changes;
      if (changes === 0) {
        statusStmt.run("ended", id);
        throw new CapError(
          `session has used its ${LIMITS.maxModelCallsPerSession} model calls; start a new one`,
        );
      }
    },
    addUsage(id, usage) {
      usageStmt.run(usage.inputTokens, usage.cacheReadTokens, usage.outputTokens, id);
    },
    expireIdle(now = Date.now()) {
      return Number(expireStmt.run(now - LIMITS.idleExpiryMs).changes);
    },
    stats() {
      const rows = statsStmt.all() as Array<{
        app: string;
        sessions: number;
        turns: number;
        model_calls: number;
        input_tokens: number;
        cache_read_tokens: number;
        output_tokens: number;
      }>;
      return rows.map((r) => {
        const promptTokens = r.input_tokens + r.cache_read_tokens;
        const usd =
          (r.input_tokens * PRICE.input + r.cache_read_tokens * PRICE.cacheRead + r.output_tokens * PRICE.output) /
          1_000_000;
        return {
          app: r.app,
          sessions: r.sessions,
          turns: r.turns,
          modelCalls: r.model_calls,
          inputTokens: r.input_tokens,
          cacheReadTokens: r.cache_read_tokens,
          outputTokens: r.output_tokens,
          cacheHitRatio: promptTokens === 0 ? 0 : r.cache_read_tokens / promptTokens,
          estimatedUsd: Math.round(usd * 10_000) / 10_000,
        };
      });
    },
    close() {
      db.close();
    },
  };
}

/** True when the message carries at least one block of the given type. */
function hasBlock(message: MessageParam, type: "tool_use" | "tool_result"): boolean {
  if (typeof message.content === "string") return false;
  return message.content.some((block) => block.type === type);
}

/** The tool_use the assistant last asked for, if no tool_result has answered it yet. */
export function pendingToolUse(
  messages: MessageParam[],
): { id: string; name: string; input: unknown } | undefined {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant" || typeof last.content === "string") return undefined;
  for (const block of last.content) {
    if (block.type === "tool_use") return { id: block.id, name: block.name, input: block.input };
  }
  return undefined;
}

/**
 * Drops the oldest turns beyond `max`. The opening exchange (the fixed start line
 * and the first greeting, extended while that greeting is still mid-move) is kept
 * so the model always sees how the demo began. A tool_use and its tool_result are
 * never separated: after cutting, the tail never opens with an orphan tool_result.
 */
export function trimHistory(messages: MessageParam[], max = LIMITS.maxHistoryMessages): MessageParam[] {
  if (messages.length <= max) return messages;

  let headLen = Math.min(2, messages.length);
  // The greeting may itself have called a move; keep its tool_result (and the
  // reply to it) with it, up to a sane bound.
  while (headLen < 10 && headLen < messages.length) {
    const lastHead = messages[headLen - 1];
    if (lastHead && lastHead.role === "assistant" && hasBlock(lastHead, "tool_use")) {
      headLen = Math.min(headLen + 2, messages.length);
    } else {
      break;
    }
  }
  const lastHead = messages[headLen - 1];
  if (lastHead && lastHead.role === "assistant" && hasBlock(lastHead, "tool_use")) {
    // Still mid-move after the bound: give up on preserving the head.
    headLen = 0;
  }

  const head = messages.slice(0, headLen);
  let tail = messages.slice(headLen);
  const room = Math.max(0, max - head.length);

  while (tail.length > room && tail.length > 0) {
    tail = tail.slice(1);
    // A tail may open with a plain user message or with an assistant message
    // (its tool_use is still answered by the next message); it must never open
    // with a tool_result whose tool_use has just been cut away.
    while (tail.length > 0) {
      const first = tail[0];
      if (!first || first.role !== "user" || !hasBlock(first, "tool_result")) break;
      tail = tail.slice(1);
    }
  }
  return [...head, ...tail];
}
