// The fake cursor (docs/protocol.md, "The fake cursor"): a fixed-position arrow above everything,
// eased movement, a click ripple, a highlight ring on the target, and the target scrolled into
// view before the cursor travels. Pure DOM — it knows nothing about moves or messages, so it is
// the same for every app. Copy it as-is; the only thing worth changing is the accent colour,
// which it reads from the page's `--accent` custom property (fallback below).

const Z = 2147483647;
const MOVE_MS = 450;
const HIGHLIGHT_MS = 1200;
const STYLE_ID = "demo-cursor-style";
const ACCENT = "var(--accent, #006bdf)";

/** Thrown out of any await the moment `demo:stop` arrives; the bridge reports it as `error: "stopped"`. */
export class StopError extends Error {
  constructor() {
    super("stopped");
    this.name = "StopError";
  }
}

/** Sleep that rejects with StopError the moment the move is aborted. Every pause in a move goes through this. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new StopError());
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new StopError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class FakeCursor {
  private el: HTMLDivElement | null = null;
  private x = 0;
  private y = 0;

  private ensure(): HTMLDivElement {
    if (this.el !== null && this.el.isConnected) return this.el;
    if (document.getElementById(STYLE_ID) === null) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `
        @keyframes demo-ripple { from { transform: translate(-50%, -50%) scale(0.2); opacity: 0.55; } to { transform: translate(-50%, -50%) scale(1); opacity: 0; } }
        .demo-ripple { position: fixed; width: 44px; height: 44px; border-radius: 50%; background: ${ACCENT}; pointer-events: none; z-index: ${Z - 1}; animation: demo-ripple 520ms ease-out forwards; }
      `;
      document.head.appendChild(style);
    }
    const el = document.createElement("div");
    el.setAttribute("aria-hidden", "true");
    el.className = "demo-cursor";
    Object.assign(el.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "20px",
      height: "20px",
      zIndex: String(Z),
      pointerEvents: "none",
      opacity: "0",
      transition: `transform ${MOVE_MS}ms cubic-bezier(.2,.8,.2,1), opacity 200ms ease`,
      transform: "translate(-40px, -40px)",
      filter: "drop-shadow(0 2px 3px rgba(0,0,0,.35))",
    } satisfies Partial<CSSStyleDeclaration>);
    el.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M2 1.5 L2 15.5 L5.6 12.3 L8.1 18 L10.6 16.9 L8.1 11.4 L13 11.2 Z" fill="#0f1a23" stroke="#ffffff" stroke-width="1.4" stroke-linejoin="round"/>' +
      "</svg>";
    document.body.appendChild(el);
    this.el = el;
    return el;
  }

  /** Glide to a viewport point and wait for the easing to finish. */
  async moveTo(x: number, y: number, signal?: AbortSignal): Promise<void> {
    const el = this.ensure();
    this.x = x;
    this.y = y;
    el.style.opacity = "1";
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    await sleep(MOVE_MS + 40, signal);
  }

  /** Scroll the target into view, glide to it, ring it, and pause (the protocol's ~250 ms). */
  async pointAt(target: HTMLElement, signal?: AbortSignal): Promise<void> {
    target.scrollIntoView({ block: "center", inline: "nearest" });
    await sleep(120, signal);
    const r = target.getBoundingClientRect();
    // Aim just inside the element's top-left quadrant so the arrow tip sits on it, not beside it.
    const x = r.left + Math.min(r.width * 0.5, 160);
    const y = r.top + Math.min(r.height * 0.5, 22);
    await this.moveTo(x, y, signal);
    this.highlight(target);
    await sleep(250, signal);
  }

  /** The click ripple, at the cursor's current position. */
  ripple(): void {
    const dot = document.createElement("div");
    dot.className = "demo-ripple";
    dot.style.left = `${this.x}px`;
    dot.style.top = `${this.y}px`;
    document.body.appendChild(dot);
    setTimeout(() => dot.remove(), 600);
  }

  /** The highlight ring: outline on the target itself for ~1.2 s, then its inline style restored. */
  highlight(target: HTMLElement): void {
    const prev = { outline: target.style.outline, outlineOffset: target.style.outlineOffset, borderRadius: target.style.borderRadius };
    target.style.outline = `2px solid ${ACCENT}`;
    target.style.outlineOffset = "4px";
    target.style.borderRadius = "6px";
    setTimeout(() => {
      target.style.outline = prev.outline;
      target.style.outlineOffset = prev.outlineOffset;
      target.style.borderRadius = prev.borderRadius;
    }, HIGHLIGHT_MS);
  }

  /** Point, ripple, then perform the click (focus, for a text field). */
  async click(target: HTMLElement, signal?: AbortSignal): Promise<void> {
    await this.pointAt(target, signal);
    this.ripple();
    await sleep(90, signal);
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
      target.focus();
    } else {
      target.click();
    }
  }

  hide(): void {
    if (this.el !== null) this.el.style.opacity = "0";
  }
}
