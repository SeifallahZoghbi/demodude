// The demo check: serve a bundle the way the demo service would (under /apps/<id>/, with the SPA
// fallback), embed it in a harness page with a demoOrigin, wait for demo:ready, then run the
// moves listed in a plan file, one after the other. Fails — exit code 1, with every reason — on
// any ok:false, any `expect` substring missing from a result, any page error, any console error,
// or any request that leaves the local server (the bundle must be self-contained).
//
//   node --experimental-strip-types check.ts --id <app> --dir <bundle dir> --plan check-plan.json
//                                            [--port 0] [--screenshot <path>]
//
// The plan is a JSON array of steps: { "name", "args"?, "expect"?, "timeoutMs"?, "screenshot"? }.
// `expect` is a substring the result must contain; `timeoutMs` overrides the 20 s per-move wait
// (long simulated moves); `screenshot: true` marks the step after which --screenshot is taken
// (default: after the last step). See check-plan.example.json.
//
// Run it natively on Node 22+ type stripping (not through jiti or tsx: they rewrite Playwright's
// own bundle and break it). `playwright` comes from the app's devDependencies; playwright-minimal.d.ts
// next to this file only exists so the starter kit type-checks without it — delete it in the app.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, normalize, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

interface PlanStep {
  name: string;
  args?: Record<string, unknown>;
  expect?: string;
  timeoutMs?: number;
  screenshot?: boolean;
}

interface MoveResult {
  id: string;
  ok: boolean;
  result?: string;
  error?: string;
}

const { values } = parseArgs({
  options: {
    id: { type: "string" },
    dir: { type: "string" },
    plan: { type: "string" },
    port: { type: "string", default: "0" },
    screenshot: { type: "string" },
  },
  strict: true,
});

function required(name: "id" | "dir" | "plan"): string {
  const v = values[name];
  if (v === undefined || v === "") throw new Error(`check.ts: --${name} is required`);
  return v;
}

const id = required("id");
const dist = resolve(required("dir"));
const planPath = resolve(required("plan"));
const port = Number(values.port ?? "0");
const screenshotPath = values.screenshot;
const BASE = `/apps/${id}/`;
const DEFAULT_MOVE_TIMEOUT_MS = 20000;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

function harness(origin: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${id} demo harness</title></head>
<body style="margin:0">
<iframe id="app" src="${BASE}?demoOrigin=${encodeURIComponent(origin)}" style="width:100vw;height:100vh;border:0"></iframe>
<script>
  window.__msgs = [];
  window.addEventListener("message", (e) => { window.__msgs.push({ origin: e.origin, data: e.data }); });
  window.__send = (msg) => document.getElementById("app").contentWindow.postMessage(msg, "${origin}");
</script></body></html>`;
}

function serve(req: IncomingMessage, res: ServerResponse, origin: string): void {
  const url = new URL(req.url ?? "/", origin);
  if (url.pathname === "/harness") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(harness(origin));
    return;
  }
  if (!url.pathname.startsWith(BASE)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const rel = normalize(decodeURIComponent(url.pathname.slice(BASE.length)));
  let file = resolve(dist, rel);
  // Never serve outside the bundle, whatever the path says.
  if (file !== dist && !file.startsWith(dist + sep)) file = resolve(dist, "index.html");
  // The SPA fallback a bundle host must provide: any path without a file serves index.html.
  if (rel === "" || rel === "." || !existsSync(file) || statSync(file).isDirectory()) file = resolve(dist, "index.html");
  res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}

function loadPlan(): PlanStep[] {
  if (!existsSync(planPath)) throw new Error(`check.ts: plan ${planPath} does not exist`);
  const parsed = JSON.parse(readFileSync(planPath, "utf8")) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error(`check.ts: ${planPath} must be a non-empty JSON array of steps`);
  return parsed.map((step, i) => {
    const s = step as Partial<PlanStep> | null;
    if (s === null || typeof s !== "object" || typeof s.name !== "string") throw new Error(`check.ts: step ${i} has no name`);
    if (s.args !== undefined && (s.args === null || typeof s.args !== "object")) throw new Error(`check.ts: step ${i} (${s.name}): args must be an object`);
    if (s.expect !== undefined && typeof s.expect !== "string") throw new Error(`check.ts: step ${i} (${s.name}): expect must be a string`);
    if (s.timeoutMs !== undefined && typeof s.timeoutMs !== "number") throw new Error(`check.ts: step ${i} (${s.name}): timeoutMs must be a number`);
    return s as PlanStep;
  });
}

async function main(): Promise<void> {
  if (!existsSync(resolve(dist, "index.html"))) throw new Error(`${dist}/index.html is missing — build the bundle first`);
  for (const f of ["manifest.json", "moves.json", "knowledge.md", "scenario.md"]) {
    if (!existsSync(resolve(dist, f))) throw new Error(`${dist}/${f} is missing from the bundle`);
  }
  const plan = loadPlan();
  const shotAfter = plan.findIndex((s) => s.screenshot === true);
  const shotIndex = shotAfter >= 0 ? shotAfter : plan.length - 1;

  let origin = "";
  const server = createServer((req, res) => serve(req, res, origin));
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("could not bind a port");
  origin = `http://127.0.0.1:${address.port}`;

  const failures: string[] = [];
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  page.on("pageerror", (e) => failures.push(`page error: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") failures.push(`console error: ${m.text()}`);
  });
  page.on("request", (r) => {
    const u = r.url();
    if (u.startsWith(origin) || u.startsWith("blob:") || u.startsWith("data:") || u.startsWith("about:")) return;
    failures.push(`network request left the local server: ${u}`);
  });
  page.on("popup", (p) => void p.close().catch(() => undefined));
  page.on("download", (d) => void d.cancel().catch(() => undefined));

  await page.goto(`${origin}/harness`);
  await page.waitForFunction(() => (window as unknown as { __msgs: Array<{ data: { type: string } }> }).__msgs.some((m) => m.data?.type === "demo:ready"), null, { timeout: 20000 });
  const ready = await page.evaluate(() => (window as unknown as { __msgs: Array<{ data: unknown }> }).__msgs.find((m) => (m.data as { type: string }).type === "demo:ready")!.data);
  console.log("demo:ready", JSON.stringify(ready));
  const readyMsg = ready as { app?: string; moves?: string[] };
  if (readyMsg.app !== id) failures.push(`demo:ready names app '${readyMsg.app}', expected '${id}'`);
  const announced = new Set(readyMsg.moves ?? []);

  let seq = 0;
  const run = async (step: PlanStep): Promise<MoveResult> => {
    const moveArgs = step.args ?? {};
    const id = `m${++seq}`;
    await page.evaluate(({ id, name, moveArgs }) => (window as unknown as { __send: (m: unknown) => void }).__send({ type: "demo:move", id, name, args: moveArgs }), { id, name: step.name, moveArgs });
    const handle = await page.waitForFunction(
      (id) => (window as unknown as { __msgs: Array<{ data: MoveResult & { type: string } }> }).__msgs.find((m) => m.data?.type === "demo:moveResult" && m.data.id === id)?.data ?? null,
      id,
      { timeout: step.timeoutMs ?? DEFAULT_MOVE_TIMEOUT_MS },
    );
    const result = (await handle.jsonValue()) as MoveResult;
    const label = `${step.name} ${JSON.stringify(moveArgs)}`;
    if (!result.ok) failures.push(`${label} → ${result.error}`);
    else if (step.expect !== undefined && !(result.result ?? "").includes(step.expect)) failures.push(`${label} → result does not contain "${step.expect}": ${result.result}`);
    console.log(`${result.ok ? "ok  " : "FAIL"} ${label} → ${result.ok ? result.result : result.error}`);
    return result;
  };

  for (const [i, step] of plan.entries()) {
    if (!announced.has(step.name)) failures.push(`plan step '${step.name}' is not among the moves demo:ready announced`);
    try {
      await run(step);
    } catch (e) {
      failures.push(`${step.name} ${JSON.stringify(step.args ?? {})} → ${e instanceof Error ? e.message : String(e)}`);
    }
    if (screenshotPath !== undefined && i === shotIndex) {
      await page.screenshot({ path: screenshotPath, fullPage: false });
      console.log(`screenshot written to ${screenshotPath}`);
    }
  }

  const state = await page.evaluate(() => {
    const msgs = (window as unknown as { __msgs: Array<{ data: { type: string; state?: unknown } }> }).__msgs;
    return [...msgs].reverse().find((m) => m.data?.type === "demo:state")?.data.state ?? null;
  });
  console.log("final demo:state", JSON.stringify(state));

  await browser.close();
  server.close();

  if (failures.length > 0) {
    console.error(`\ndemo check FAILED (${failures.length}):\n - ${failures.join("\n - ")}`);
    process.exit(1);
  }
  console.log("\ndemo check passed");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
