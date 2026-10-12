// Turn a static build into the bundle docs/protocol.md describes: index.html as the entry,
// manifest.json, and moves.json, knowledge.md and scenario.md copied in from the folder where
// they are authored. App-agnostic: everything that differs per app comes in as an argument.
//
//   node --experimental-strip-types bundle.ts --id <app> --name "<Name>" --src <dir> --out <dir>
//                                             [--entry index.html] [--start /]
//
//   --id     the bundle id: the folder under /apps/ and the `id` in manifest.json
//   --name   the display name
//   --src    the folder holding knowledge.md, scenario.md and moves.json
//   --out    the built static site (Vite's outDir, Next's `out/`); the bundle is written in place
//   --entry  the entry page inside --out (default index.html); a Vite `demo.html` is renamed to it
//   --start  the startPath the service navigates to on reset (default /)
//
// Node 22+ (24 strips types natively; 22 needs the flag), node builtins only. The version is the
// git short sha of --src's repo, or today's date when there is no git.
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    id: { type: "string" },
    name: { type: "string" },
    src: { type: "string" },
    out: { type: "string" },
    entry: { type: "string", default: "index.html" },
    start: { type: "string", default: "/" },
  },
  strict: true,
});

function required(name: "id" | "name" | "src" | "out"): string {
  const v = values[name];
  if (v === undefined || v === "") throw new Error(`bundle.ts: --${name} is required`);
  return v;
}

const id = required("id");
const name = required("name");
const src = resolve(required("src"));
const out = resolve(required("out"));
const entry = values.entry ?? "index.html";
const startPath = values.start ?? "/";

if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) throw new Error(`bundle.ts: --id '${id}' must be a plain folder name (letters, digits, - and _)`);
if (!existsSync(out) || !statSync(out).isDirectory()) throw new Error(`bundle.ts: --out ${out} is not a directory — run the static build first`);
if (!existsSync(src) || !statSync(src).isDirectory()) throw new Error(`bundle.ts: --src ${src} is not a directory`);

// A Vite build whose input was demo.html emits demo.html; the service expects the entry name.
const viteDemoPage = resolve(out, "demo.html");
const entryPage = resolve(out, entry);
if (entry !== "demo.html" && existsSync(viteDemoPage) && !existsSync(entryPage)) renameSync(viteDemoPage, entryPage);
if (!existsSync(entryPage)) throw new Error(`bundle.ts: ${entryPage} is missing — the static build did not produce the entry page`);

function version(): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: src, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// moves.json must be there and must be a move list; the service refuses a bundle without it.
const movesSrc = resolve(src, "moves.json");
if (!existsSync(movesSrc)) throw new Error(`bundle.ts: ${movesSrc} is missing — write it from moveDefs (toMovesJson) first`);
const moves = JSON.parse(readFileSync(movesSrc, "utf8")) as unknown;
if (!Array.isArray(moves) || moves.length === 0) throw new Error(`bundle.ts: ${movesSrc} must be a non-empty JSON array`);
for (const m of moves as Array<Record<string, unknown>>) {
  if (typeof m["name"] !== "string" || typeof m["description"] !== "string" || typeof m["input_schema"] !== "object") {
    throw new Error(`bundle.ts: every entry of moves.json needs name, description and input_schema (offending: ${JSON.stringify(m).slice(0, 80)})`);
  }
}
copyFileSync(movesSrc, resolve(out, "moves.json"));

// knowledge.md and scenario.md are authored separately (the knowledge pack); a missing one gets a
// one-line placeholder so the bundle is complete, and the build says so.
const placeholders: string[] = [];
for (const file of ["knowledge.md", "scenario.md"]) {
  const from = resolve(src, file);
  if (existsSync(from)) copyFileSync(from, resolve(out, file));
  else {
    writeFileSync(resolve(out, file), "# placeholder\n");
    placeholders.push(file);
  }
}

const v = version();
writeFileSync(resolve(out, "manifest.json"), JSON.stringify({ id, name, entry, startPath, version: v }, null, 2) + "\n");

console.log(`demo bundle written to ${out} (id ${id}, version ${v}, ${moves.length} moves)`);
if (placeholders.length > 0) console.warn(`bundle.ts: ${placeholders.join(", ")} not found under ${src} — placeholder(s) written`);
