import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BundleError, createAppRegistry, loadBundle } from "../src/apps.js";

const stubDir = path.resolve("apps/_stub");
const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempBundle(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "demodude-bundle-"));
  temps.push(dir);
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text);
  return dir;
}

describe("bundles", () => {
  it("loads the _stub bundle", async () => {
    const app = await loadBundle(stubDir, "_stub");
    expect(app.id).toBe("_stub");
    expect(app.manifest.name).toBe("Stub Quoting App");
    expect(app.moves.map((m) => m.name).sort()).toEqual(["go_to_screen", "point_at", "reset_demo", "set_markup"]);
    expect(app.knowledge).toContain("Al-Marsa");
    expect(app.scenario).toContain("Pricing");
  });

  it("rejects a bundle missing moves.json with a clear error", async () => {
    const dir = await tempBundle({
      "manifest.json": JSON.stringify({ id: "x", name: "X" }),
      "knowledge.md": "k",
      "scenario.md": "s",
      "index.html": "<p>x</p>",
    });
    await expect(loadBundle(dir, "x")).rejects.toThrow(BundleError);
    await expect(loadBundle(dir, "x")).rejects.toThrow(/missing required file moves\.json/);
  });

  it("rejects a move schema without additionalProperties:false", async () => {
    const dir = await tempBundle({
      "manifest.json": JSON.stringify({ id: "x", name: "X" }),
      "moves.json": JSON.stringify([
        { name: "go", description: "d", input_schema: { type: "object", properties: {}, required: [] } },
      ]),
      "knowledge.md": "k",
      "scenario.md": "s",
      "index.html": "<p>x</p>",
    });
    await expect(loadBundle(dir, "x")).rejects.toThrow(/moves\.json invalid.*additionalProperties/);
  });

  it("registry skips broken bundles but keeps the good ones", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "demodude-apps-"));
    temps.push(root);
    const good = path.join(root, "good");
    const bad = path.join(root, "bad");
    await Promise.all([
      (async () => {
        const { mkdir } = await import("node:fs/promises");
        await mkdir(good);
        await mkdir(bad);
      })(),
    ]);
    await writeFile(path.join(good, "manifest.json"), JSON.stringify({ id: "good", name: "Good" }));
    await writeFile(
      path.join(good, "moves.json"),
      JSON.stringify([{ name: "go", description: "d", input_schema: { type: "object", properties: {}, required: [], additionalProperties: false } }]),
    );
    await writeFile(path.join(good, "knowledge.md"), "k");
    await writeFile(path.join(good, "scenario.md"), "s");
    await writeFile(path.join(good, "index.html"), "<p>good</p>");
    await writeFile(path.join(bad, "manifest.json"), JSON.stringify({ id: "bad", name: "Bad" }));

    const registry = createAppRegistry({ appsDir: root, log: () => undefined });
    const result = await registry.reload();
    expect(result.loaded).toEqual(["good"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/bad.*moves\.json/);
    expect(registry.get("good")?.manifest.name).toBe("Good");
    expect(registry.get("bad")).toBeUndefined();
    registry.close();
  });
});
