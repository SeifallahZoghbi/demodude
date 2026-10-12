// The app side of docs/protocol.md, with nothing app-specific inside: it accepts postMessage from
// exactly the origin named in `?demoOrigin=`, runs moves one at a time with the fake cursor, and
// reports `demo:ready`, `demo:state`, `demo:moveResult` and the optional `demo:userAction`. The
// app hands it the four things only the app knows — its id, its moves, how to read the state the
// AI sees, and how to reset — as a BridgeConfig. Loaded outside an iframe, or without a
// demoOrigin, it mounts nothing beyond a `window.__demo` hook for hand-testing in the dev server:
//   __demo.run("go_to_screen", { screen: "pricing" })
import { FakeCursor, StopError, sleep } from "./cursor.ts";

/** What a move gets to work with. Every await inside a move must take `signal` so demo:stop interrupts it. */
export interface MoveContext {
  cursor: FakeCursor;
  signal: AbortSignal;
  /** The element carrying `data-demo="<target>"`, or null when it is not on the current screen. */
  find: (target: string) => HTMLElement | null;
  /** Like `find`, but waits for the element to appear (a screen still rendering). Rejects after `timeoutMs` (default 4000) or on stop. */
  waitFor: (target: string, timeoutMs?: number) => Promise<HTMLElement>;
}

export type Move = (args: Record<string, unknown>, ctx: MoveContext) => Promise<string>;

export interface BridgeConfig<State> {
  /** The bundle id: the `id` in manifest.json and the folder under `/apps/`. */
  app: string;
  /** One runner per entry of moves.json, keyed by the move's name. */
  moves: Record<string, Move>;
  /** The small JSON object the AI sees every turn (keep it under ~300 characters). Cheap and side-effect free: it is called often. */
  getState: () => State;
  /** Fixtures back to their initial values and the app back to its start screen. */
  reset: () => Promise<void> | void;
  /** Optional: call `onChange` whenever the fixtures or the route change, so `demo:state` goes out promptly. The DOM observer covers the rest. */
  subscribe?: (onChange: () => void) => () => void;
  /** Optional, default true: watch the document for changes and re-read the state (debounced). Turn off if `subscribe` already covers every change. */
  observeDom?: boolean;
  /** Optional, default true: report the visitor's own clicks on `[data-demo]` elements as `demo:userAction`. */
  userActions?: boolean;
}

export interface BridgeHandle {
  /** Stop listening and remove the hand-testing hook. */
  destroy(): void;
  /** Run a move directly (no message round-trip): the hand-testing path, and handy in the app's own tests. */
  run(name: string, args?: Record<string, unknown>): Promise<string>;
  /** Abort the move in progress, if any. */
  stop(): void;
  /** Ask for a `demo:state` if the state changed — for apps that would rather call this from a router hook than pass `subscribe`. */
  notifyState(): void;
}

type Inbound =
  | { type: "demo:move"; id: string; name: string; args?: Record<string, unknown> }
  | { type: "demo:stop" }
  | { type: "demo:reset" };

const STATE_DEBOUNCE_MS = 100;
const WAIT_FOR_DEFAULT_MS = 4000;
const BUSY_ERROR = "A move is already running — wait for its result or send demo:stop";

/** The service origin this page may talk to, or null when it was not loaded by the service. */
function serviceOrigin(): string | null {
  if (window.parent === window) return null;
  const param = new URLSearchParams(window.location.search).get("demoOrigin");
  if (param === null || param === "") return null;
  try {
    return new URL(param).origin;
  } catch {
    return null;
  }
}

function selectorFor(target: string): string {
  return `[data-demo="${CSS.escape(target)}"]`;
}

export function findTarget(target: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(selectorFor(target));
}

export function waitForTarget(target: string, signal: AbortSignal, timeoutMs = WAIT_FOR_DEFAULT_MS): Promise<HTMLElement> {
  const now = findTarget(target);
  if (now !== null) return Promise.resolve(now);
  return new Promise((resolve, reject) => {
    const done = (): void => {
      observer.disconnect();
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const observer = new MutationObserver(() => {
      const el = findTarget(target);
      if (el === null) return;
      done();
      resolve(el);
    });
    const timer = setTimeout(() => {
      done();
      reject(new Error(`No element for target '${target}' on this screen`));
    }, timeoutMs);
    const onAbort = (): void => {
      done();
      reject(new StopError());
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
  });
}

export function mountBridge<State>(config: BridgeConfig<State>): BridgeHandle {
  const origin = serviceOrigin();
  const cursor = new FakeCursor();
  const moveNames = Object.keys(config.moves);
  let current: { controller: AbortController } | null = null;
  let readySent = false;
  let lastState = "";
  let stateTimer: ReturnType<typeof setTimeout> | null = null;
  let observer: MutationObserver | null = null;
  let unsubscribe: (() => void) | null = null;
  let destroyed = false;

  const post = (msg: Record<string, unknown>): void => {
    if (origin === null || destroyed) return;
    window.parent.postMessage(msg, origin);
  };

  const stateNow = (): State => config.getState();

  const notifyState = (): void => {
    if (origin === null || !readySent) return;
    if (stateTimer !== null) clearTimeout(stateTimer);
    stateTimer = setTimeout(() => {
      stateTimer = null;
      let next: string;
      try {
        next = JSON.stringify(stateNow());
      } catch (e) {
        console.error("demo bridge: getState threw", e);
        return;
      }
      if (next === lastState) return;
      lastState = next;
      post({ type: "demo:state", state: stateNow() });
    }, STATE_DEBOUNCE_MS);
  };

  const stop = (): void => {
    current?.controller.abort();
  };

  // The one place a move runs. Serialised: a second call while one is in flight is refused.
  const execute = async (name: string, args: Record<string, unknown>): Promise<string> => {
    if (current !== null) throw new Error(BUSY_ERROR);
    const move = Object.hasOwn(config.moves, name) ? config.moves[name] : undefined;
    if (move === undefined) throw new Error(`Unknown move '${name}'. Known moves: ${moveNames.join(", ")}`);
    const controller = new AbortController();
    current = { controller };
    const ctx: MoveContext = {
      cursor,
      signal: controller.signal,
      find: findTarget,
      waitFor: (target, timeoutMs) => waitForTarget(target, controller.signal, timeoutMs),
    };
    try {
      const result = await move(args, ctx);
      if (controller.signal.aborted) throw new StopError();
      return String(result);
    } finally {
      current = null;
      notifyState();
    }
  };

  const handleMove = async (id: string, name: string, args: Record<string, unknown>): Promise<void> => {
    try {
      const result = await execute(name, args);
      post({ type: "demo:moveResult", id, ok: true, result });
    } catch (e) {
      const error = e instanceof StopError ? "stopped" : e instanceof Error ? e.message : String(e);
      post({ type: "demo:moveResult", id, ok: false, error });
    }
  };

  const handleReset = async (): Promise<void> => {
    stop();
    try {
      await config.reset();
    } catch (e) {
      console.error("demo bridge: reset threw", e);
    }
    // After the app has re-rendered its start screen, so the state carries it.
    await sleep(120);
    lastState = JSON.stringify(stateNow());
    post({ type: "demo:state", state: stateNow() });
  };

  const onMessage = (event: MessageEvent): void => {
    if (event.origin !== origin || event.source !== window.parent) return;
    const msg = event.data as Partial<Inbound> | null;
    if (msg === null || typeof msg !== "object" || typeof msg.type !== "string") return;
    if (msg.type === "demo:move") {
      const m = msg as Extract<Inbound, { type: "demo:move" }>;
      const args = m.args !== null && typeof m.args === "object" ? m.args : {};
      void handleMove(String(m.id), String(m.name), args);
    } else if (msg.type === "demo:stop") {
      stop();
    } else if (msg.type === "demo:reset") {
      void handleReset();
    }
  };

  const onUserClick = (event: MouseEvent): void => {
    if (current !== null) return; // a move is clicking, not the visitor
    const el = (event.target as Element | null)?.closest<HTMLElement>("[data-demo]");
    const name = el?.dataset["demo"];
    if (name === undefined || name === "") return;
    post({ type: "demo:userAction", description: `The visitor clicked ${name.replace(/_/g, " ")}` });
  };

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    stop();
    window.removeEventListener("message", onMessage);
    document.removeEventListener("click", onUserClick, true);
    window.removeEventListener("popstate", notifyState);
    window.removeEventListener("hashchange", notifyState);
    observer?.disconnect();
    observer = null;
    unsubscribe?.();
    unsubscribe = null;
    if (stateTimer !== null) clearTimeout(stateTimer);
    delete (window as unknown as { __demo?: unknown }).__demo;
  };

  // The hand-testing hook, in and out of the service alike.
  (window as unknown as { __demo: unknown }).__demo = {
    run: (name: string, args: Record<string, unknown> = {}) => execute(name, args),
    stop,
    state: stateNow,
    moves: moveNames,
  };

  if (origin !== null) {
    window.addEventListener("message", onMessage);
    window.addEventListener("popstate", notifyState);
    window.addEventListener("hashchange", notifyState);
    if (config.userActions !== false) document.addEventListener("click", onUserClick, true);
    if (config.subscribe !== undefined) unsubscribe = config.subscribe(notifyState);
    if (config.observeDom !== false) {
      observer = new MutationObserver(notifyState);
      observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "aria-current", "aria-selected", "data-state"] });
    }
    // After the first paint, so the state it carries is the rendered screen's.
    requestAnimationFrame(() => {
      if (readySent || destroyed) return;
      readySent = true;
      lastState = JSON.stringify(stateNow());
      post({ type: "demo:ready", app: config.app, moves: moveNames, state: stateNow() });
    });
  }

  return { destroy, run: execute, stop, notifyState };
}
