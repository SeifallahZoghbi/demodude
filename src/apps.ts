// Loads app bundles from APPS_DIR and keeps them fresh. A bundle is a folder with
// manifest.json, moves.json, knowledge.md and scenario.md (docs/protocol.md). The
// four files are validated up front so a broken bundle fails loudly at load time
// instead of producing a confused model mid-demo.

import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const manifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/i, "id must be [a-z0-9_-]"),
  name: z.string().min(1),
  entry: z.string().min(1).default("index.html"),
  startPath: z.string().startsWith("/").default("/"),
  version: z.string().optional(),
});

const inputSchemaSchema = z
  .object({
    type: z.literal("object"),
    properties: z.record(z.string(), z.unknown()).default({}),
    required: z.array(z.string()),
    additionalProperties: z.literal(false),
  })
  .passthrough();

const moveSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, "move names must be snake_case"),
  description: z.string().min(1),
  input_schema: inputSchemaSchema,
});

const movesSchema = z.array(moveSchema).min(1).max(15);

export type Manifest = z.infer<typeof manifestSchema>;
export type Move = z.infer<typeof moveSchema>;

export interface LoadedApp {
  id: string;
  dir: string;
  manifest: Manifest;
  moves: Move[];
  knowledge: string;
  scenario: string;
}

export class BundleError extends Error {
  constructor(
    public readonly bundleDir: string,
    message: string,
  ) {
    super(`Bundle ${bundleDir}: ${message}`);
    this.name = "BundleError";
  }
}

async function readBundleFile(dir: string, file: string): Promise<string> {
  try {
    return await readFile(path.join(dir, file), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new BundleError(dir, `missing required file ${file}`);
    throw new BundleError(dir, `cannot read ${file}: ${(err as Error).message}`);
  }
}

function parseJson(dir: string, file: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new BundleError(dir, `${file} is not valid JSON: ${(err as Error).message}`);
  }
}

function describeIssues(issues: z.ZodIssue[]): string {
  return issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** Reads and validates one bundle folder. Throws BundleError with a clear reason. */
export async function loadBundle(dir: string, expectedId?: string): Promise<LoadedApp> {
  const manifestText = await readBundleFile(dir, "manifest.json");
  const manifestParsed = manifestSchema.safeParse(parseJson(dir, "manifest.json", manifestText));
  if (!manifestParsed.success) {
    throw new BundleError(dir, `manifest.json invalid: ${describeIssues(manifestParsed.error.issues)}`);
  }
  const manifest = manifestParsed.data;
  if (expectedId && manifest.id !== expectedId) {
    throw new BundleError(dir, `manifest id "${manifest.id}" does not match folder name "${expectedId}"`);
  }

  const movesText = await readBundleFile(dir, "moves.json");
  const movesParsed = movesSchema.safeParse(parseJson(dir, "moves.json", movesText));
  if (!movesParsed.success) {
    throw new BundleError(dir, `moves.json invalid: ${describeIssues(movesParsed.error.issues)}`);
  }
  const names = new Set<string>();
  for (const move of movesParsed.data) {
    if (names.has(move.name)) throw new BundleError(dir, `moves.json has duplicate move "${move.name}"`);
    names.add(move.name);
  }

  const knowledge = await readBundleFile(dir, "knowledge.md");
  const scenario = await readBundleFile(dir, "scenario.md");

  try {
    await stat(path.join(dir, manifest.entry));
  } catch {
    throw new BundleError(dir, `entry file ${manifest.entry} not found`);
  }

  return { id: manifest.id, dir, manifest, moves: movesParsed.data, knowledge, scenario };
}

export interface AppRegistry {
  get(id: string): LoadedApp | undefined;
  list(): LoadedApp[];
  /** Re-reads every bundle; returns the ids loaded and the errors for the rest. */
  reload(): Promise<{ loaded: string[]; errors: string[] }>;
  /** Starts watching APPS_DIR; changes trigger a debounced reload. */
  watch(): void;
  close(): void;
}

export function createAppRegistry(opts: {
  appsDir: string;
  log?: (msg: string) => void;
}): AppRegistry {
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const appsDir = path.resolve(opts.appsDir);
  let apps = new Map<string, LoadedApp>();
  let watcher: FSWatcher | undefined;
  let reloadTimer: NodeJS.Timeout | undefined;
  let reloading: Promise<{ loaded: string[]; errors: string[] }> | undefined;

  async function doReload(): Promise<{ loaded: string[]; errors: string[] }> {
    const next = new Map<string, LoadedApp>();
    const errors: string[] = [];
    let entries: string[];
    try {
      entries = (await readdir(appsDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort();
    } catch (err) {
      errors.push(`cannot read apps dir ${appsDir}: ${(err as Error).message}`);
      apps = next;
      return { loaded: [], errors };
    }
    for (const name of entries) {
      try {
        const app = await loadBundle(path.join(appsDir, name), name);
        next.set(app.id, app);
      } catch (err) {
        errors.push((err as Error).message);
      }
    }
    apps = next;
    return { loaded: [...next.keys()], errors };
  }

  function reload(): Promise<{ loaded: string[]; errors: string[] }> {
    // Coalesce overlapping reloads so a burst of file events runs the scan once.
    if (!reloading) {
      reloading = doReload().finally(() => {
        reloading = undefined;
      });
    }
    return reloading;
  }

  return {
    get: (id) => apps.get(id),
    list: () => [...apps.values()],
    reload,
    watch() {
      if (watcher) return;
      try {
        watcher = watch(appsDir, { recursive: true }, (_event, file) => {
          if (reloadTimer) clearTimeout(reloadTimer);
          reloadTimer = setTimeout(() => {
            reload()
              .then((r) => {
                log(`apps reloaded after change (${file ?? "?"}): ${r.loaded.join(", ") || "none"}`);
                for (const e of r.errors) log(`apps: ${e}`);
              })
              .catch((err: unknown) => log(`apps reload failed: ${(err as Error).message}`));
          }, 500);
        });
        watcher.on("error", (err) => log(`apps watcher error: ${err.message}`));
      } catch (err) {
        log(`apps: cannot watch ${appsDir} (${(err as Error).message}); use POST /api/admin/reload`);
      }
    },
    close() {
      if (reloadTimer) clearTimeout(reloadTimer);
      watcher?.close();
      watcher = undefined;
    },
  };
}
