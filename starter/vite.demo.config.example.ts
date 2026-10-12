// EXAMPLE for Vite apps — copy to vite.demo.config.ts and replace <id> and the alias targets.
// Not part of the starter kit's type-check (it needs vite and your framework plugin).
//
// The DEMO build (docs/protocol.md): the real screens compiled to static files that read from the
// bundled fixtures. Three things differ from the production vite.config.ts, and nothing else:
//   · base: the demo service serves the bundle at `${DEMO_BASE_PATH}/apps/<id>/` — empty in
//     development and in the check, `/demo` where the service is mounted under a reverse proxy.
//     Have the router read the same value back through Vite's import.meta.env.BASE_URL, so the
//     two can never disagree.
//   · aliases, so the production screens' auth and backend-client imports resolve to the demo
//     stubs — in THIS build only; the production entry and config are untouched.
//   · the entry is demo.html (bundle.ts renames the output to index.html).
//
// Next.js apps: there is no Vite config to copy. Instead add a `/demo` route that mounts the
// bridge and the fixtures, build with `output: "export"` and `basePath: `${DEMO_BASE_PATH}/apps/<id>``,
// and point bundle.ts --out at the exported folder with --entry demo/index.html (or copy that page
// to index.html). Server components, API routes and middleware are off the table in that build.
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react"; // TODO: your framework plugin, or drop it

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const APP_ID = "<id>"; // TODO: the bundle id, as in manifest.json
const BASE = `${(process.env["DEMO_BASE_PATH"] ?? "").replace(/\/+$/, "")}/apps/${APP_ID}/`;

/** Dev-server nicety: a path under the base without a file extension serves demo.html, like the bundle's host would. */
const demoHtmlFallback: Plugin = {
  name: "demo-html-fallback",
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const url = req.url ?? "";
      if (url.startsWith(BASE) && !url.slice(BASE.length).split("?")[0]!.includes(".")) {
        req.url = `${BASE}demo.html${url.includes("?") ? url.slice(url.indexOf("?")) : ""}`;
      }
      next();
    });
  },
};

export default defineConfig({
  base: BASE,
  plugins: [react(), demoHtmlFallback],
  resolve: {
    alias: [
      // TODO: one entry per import the screens make that would reach the network or an auth provider.
      { find: "<auth package>", replacement: here("./src/demo/authStub.ts") },
      { find: /^(\.\.\/|\.\/)backendClient$/, replacement: here("./src/demo/backendClientStub.ts") },
    ],
  },
  build: {
    outDir: "dist-demo",
    emptyOutDir: true,
    rollupOptions: { input: here("./demo.html") },
  },
  server: { port: 5174 },
});
