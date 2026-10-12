# Add your app to the Foundry demo

This is the brief for a product team (or the team's Claude) adding an AI-guided demo of
their app to the shared demo service. Read it top to bottom before writing code. The
aten app is the reference implementation; where this document says "see aten", open
the aten repo at `packages/web/src/demo/` and `packages/web/demo/`.

## What exists already, and what you build

The **demo service** (this repo, `demodude`) already runs on the Foundry VPS. It shows
your app inside an iframe beside a chat panel, talks to Claude, and drives your app
through a small fixed set of "moves". You do not touch the service.

You build a **demo bundle** for your app: one static folder containing

- a **demo build** of your real screens that reads from bundled fictional data, with no
  login and no backend calls;
- a **bridge** that lets the service drive those screens with a fake cursor;
- a **knowledge pack** and **scenario** the AI guide answers and narrates from;
- a **moves manifest** describing the moves your bridge can run.

The exact contract (bundle layout, message protocol, cursor rules, schema rules) is
`docs/protocol.md`. It is short and it is binding. Read it first.

## Deliverables checklist

- [ ] `pnpm build:demo` (or your equivalent) produces the bundle folder, built with
      `DEMO_BASE_PATH=/demo` for production (see "Base path" below).
- [ ] `manifest.json`, `moves.json`, `knowledge.md`, `scenario.md`, `index.html` + assets.
- [ ] `demo:check` runs every move in a real browser and passes.
- [ ] A GitHub workflow runs `demo:check` on every push that could change a screen.
- [ ] Production screens changed by `data-demo` attributes only.
- [ ] The two Markdown files reviewed by a human from your team for product accuracy.

## Step 1 — The demo build (real screens, fictional data, no backend)

Principle: compile your production screens with the data layer swapped for an in-memory
store of fictional data, so the demo *is* your UI and changes with it.

- **Vite + React (like aten):** add a second entry (`demo.html` → `src/demo/main.tsx`)
  and a second Vite config (`starter/vite.demo.config.example.ts`). Alias your auth and
  backend client modules to stubs *in this build only*. Wrap `<App/>` in a provider that
  answers every query/mutation from the fixture store. Production `main.tsx` and
  `vite.config.ts` stay untouched.
- **Next.js:** add a `/demo` route tree that renders the same page components with mock
  providers, and produce a static export of it (`output: "export"` for that build, or a
  separate app that imports your components). Rule of thumb: no server components that
  fetch, no API routes, no middleware in the demo build.
- **Other stacks:** same idea. The output must be static files that run with zero
  network calls other than their own assets.

Type the fixtures against your real API types (aten declares every handler with the
backend's own `FunctionArgs`/`FunctionReturnType`). That is the "git link": a backend
shape change fails the demo type check instead of breaking a customer demo.

Fictional data rules: invent a client, project and people (never real customer data or
names from your repo's samples), make the numbers add up (totals equal the sum of lines),
and make the app's actual rules true in the data (if a run costs one credit, the fixture
shows one credit). Write the final numbers into `src/demo/facts.md`; the knowledge pack
is reconciled against that file.

Anything slow or AI-driven in the real product (an analysis, a render) becomes a short
**staged animation** in the demo, driven by the wall clock (not chained timers: hidden
browser tabs throttle timers; see aten's `fixtures/store.ts` `scheduleRun`).

Things that would leave the iframe (card checkout, external links, downloads that open
new tabs) are turned off with a plain message or replaced with canned files.

## Step 2 — Targets and moves

Add `data-demo="<target>"` attributes to the elements the demo will point at or click:
navigation items, the main table rows, the key input, the headline figure, the one
flag/mark that tells the product's story. Keep names stable and meaningful
(`nav_pricing`, `row_<ID>`, `markup_input`, `export_button`). Attributes only; no behaviour
changes to production screens.

Define 6–12 moves (`starter/moveDefs.example.ts`). The proven set:

| Move | What it does |
|---|---|
| `go_to_screen {screen}` | navigate; opens the demo project when a screen needs one |
| `point_at {target}` | scroll to, hover and highlight, no click |
| `click {target}` | cursor click |
| `select_<thing> {id}` | open one record in the main workbench |
| `set_<key figure> {value}` | change the one number that visibly recomputes |
| `simulate_<slow step> {}` | the staged animation (≤ 30 s, honours stop) |
| `run_export {document}` | "generate" the deliverable, canned |
| `reset_demo {}` | fixtures back to initial state |

Every move returns a one-line result string for the model ("Now on Pricing. Markup 18 %,
selling EGP 5,451,600."). Schema rule: `additionalProperties: false`, a `required` list,
and **no** `minimum`/`maximum`/`minLength`/`maxLength`/`pattern`/`format`/`default`
(strict tools reject them; put ranges in the description and validate in the runner).

Wire the bridge with `starter/bridge.ts` + `starter/cursor.ts` (copy them into your
demo folder). You supply the moves, a `getState()` returning a small JSON object (which
screen, which record, the key figure), and `reset()`. Outside an iframe the bridge
exposes `window.__demo.run(name, args)` so you can hand-test moves in the dev server.

## Step 3 — Knowledge pack and scenario

These two Markdown files are the AI's **only** source of truth. Write them for selling,
not for testers, and make every number match `facts.md`.

`knowledge.md` (2,500–4,500 words):
1. `# FACTS` — the fictional project's numbers in tables (records, money, the review
   items as the screens show them, file names).
2. `# What <app> is` — the problem and what the app does end to end; who it is for.
3. `# The journey, screen by screen` — one subsection per screen in the order the
   product uses: what the visitor sees, what the user does there, what the marks mean,
   and which move shows it (`go_to_screen {"screen":"…"}`, targets for `point_at`).
4. `# How the engine decides` — buyer-level explanations of the clever parts.
5. `# Likely questions and agreed answers` — 15–25 Q&As; answer only what the product
   supports, otherwise "ask the team".
6. `# What <app> does not do yet` and `# Roadmap (planned, not available)`.
7. `# Demo guide rules` — one move per turn; say what you will show before showing it;
   keep to the fictional project; "that isn't in this demo" when asked for something not
   here; never claim the product did something the screens do not show.

`scenario.md` (600–1,300 words): 8–10 steps, each with the screen, the exact move call
and args, one or two sentences to say, and the one thing to point out. Include a
"if the visitor asks to skip ahead" note and a closing line.

Never mention real clients, model or provider names, internal phase numbers, API costs
or servers. Grep for them before you finish.

## Step 4 — Bundle, base path, check, CI

**Base path.** In production the service is mounted under `/demo`, so your bundle is
served at `/demo/apps/<id>/`. Build with `DEMO_BASE_PATH=/demo` and use
`${DEMO_BASE_PATH}/apps/<id>/` as the asset base and the router basename (aten derives
the basename from Vite's `import.meta.env.BASE_URL` so the two cannot drift). The
default (empty) is what the local check uses. Use **absolute** asset URLs; the entry page
is served both with and without a trailing slash.

**Bundle.** `starter/bundle.ts` writes `manifest.json` and copies the three files into
the built folder. `manifest.json`: `{ id, name, entry: "index.html", startPath: "/", version }`.

**Check.** `starter/check.ts` + a `check-plan.json` (see `starter/check-plan.example.json`)
listing every move with representative args (every screen, every record, every target).
Run it in `demo:check`. It must pass with no page errors, no console errors, and no
network request that leaves the local server. Add `playwright` to your app's
devDependencies and delete `starter/playwright-minimal.d.ts` from your copy; it exists
only so the kit type-checks here without the dependency.

**CI.** `starter/demo-check.yml` → `.github/workflows/demo-check.yml`, with your paths.
It is what keeps the demo honest after launch.

## Step 5 — Hand-off and publishing

Send the owner of the demo service:

1. the repo and the command that produces the bundle (`DEMO_BASE_PATH=/demo pnpm build:demo`),
2. the bundle id and display name,
3. a note of anything turned off in the demo.

The owner publishes with `./deploy/push-app.sh <id> <bundle-dir>`; the service picks the
bundle up without a restart. The demo is then live at
`https://aten.thefoundry.run/demo/<id>` (the service's own address) and, once your
website proxies `/demo/*` to the service, at `https://<your-site>/demo/<id>`.

To serve it under your own domain on Vercel, add to the site's `vercel.json` (before the
SPA catch-all) and set `trailingSlash: false`:

```json
{ "source": "/demo", "destination": "https://aten.thefoundry.run/demo/" },
{ "source": "/demo/:path*", "destination": "https://aten.thefoundry.run/demo/:path*" }
```

Then link "Start a demo" in the header and the closing section to `/demo/<id>` with a
plain `<a href>` (not a router link).

## Gates before you say "done"

- Type check green (fixtures against real API types).
- Lint green. Unit tests green (add tests for the fixture store's recompute and the fake
  client's subscription at minimum).
- `demo:check` green locally; the workflow green on GitHub.
- Production build still green and unchanged in behaviour.
- A human from the team has read `knowledge.md` and `scenario.md` and corrected them.
- One full run watched in a visible browser tab, start to finish, including one
  interruption ("wait, go back to X") and one off-script question.

## Lessons from the first app (do not relearn these)

- Strict tool schemas reject range keywords; one `maximum` took the whole demo down.
- Hidden browser tabs throttle timers; drive animations by elapsed time and never fail a
  move just because the tab is hidden.
- A reverse proxy may not forward slash-terminated paths; never depend on the trailing slash.
- The in-app help/feedback widgets still render in the demo; hide them in the demo build
  or accept that they show.
- Keep the knowledge pack factual and reconciled to the fixtures; a confident wrong
  number is worse than "that isn't in this demo".
