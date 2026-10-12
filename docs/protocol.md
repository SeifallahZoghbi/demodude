# Demo protocol — how the demo service and an app's demo build talk

This is the contract every app must implement to be demoable. The demo service
(this repo) hosts the chat panel and talks to Claude. Each app ships a **demo build**:
its real screens, compiled to static files, reading from a bundled dummy dataset
instead of its live backend. The service shows the demo build in an `<iframe>` and
drives it with `postMessage`. Nothing crosses the boundary except these messages.

## App bundle layout

The app's build step must output one folder (the "bundle") that the service serves
as-is. For aten: `packages/web/dist-demo/`.

```
<bundle>/
  manifest.json     { "id": "aten", "name": "Aten", "entry": "index.html",
                      "startPath": "/", "version": "<git sha or date>" }
  moves.json        the move manifest (below)
  knowledge.md      the knowledge pack the AI answers from
  scenario.md       the default storyline the AI follows when not interrupted
  index.html        the demo build's entry page
  assets/...        everything else the build emits
```

The service serves the bundle at `<base>/apps/<id>/` and the demo page at
`<base>/<id>` (or `/demo/<id>` when the service runs with no base), where `<base>` is
the service's `PUBLIC_BASE_PATH` (empty locally; `/demo` in production, because the
reverse proxy mounts the service under `https://aten.thefoundry.run/demo/`). The app's
build must therefore read the same value from the `DEMO_BASE_PATH` environment variable
(default empty) and use `${DEMO_BASE_PATH}/apps/<id>/` both as Vite `base` and as the
router basename. Build for production with `DEMO_BASE_PATH=/demo`.

## moves.json

A JSON array. Each entry becomes one Claude tool, verbatim, so write descriptions
for the model, not for humans.

```json
[
  {
    "name": "go_to_screen",
    "description": "Navigate to a screen. Use this before pointing at or clicking anything on that screen.",
    "input_schema": {
      "type": "object",
      "properties": { "screen": { "type": "string", "enum": ["projects", "boards", "..."] } },
      "required": ["screen"],
      "additionalProperties": false
    }
  }
]
```

Rules:
- `input_schema` must be valid JSON Schema with `additionalProperties: false` and a
  `required` list (the service sets `strict: true` on every tool).
- Strict tools accept only a schema subset: no `minimum`/`maximum`, `minLength`/
  `maxLength`, `pattern`, `format`, `default` or similar. State ranges in the
  description ("0 to 60") and validate inside the move. The service strips these
  keywords defensively, but do not rely on it.
- Names are `snake_case`, unique, and stable; renaming a move breaks saved sessions.
- Keep the set small (under 15). The AI picks from this list every turn.

## Messages: app → service (`window.parent.postMessage(msg, "*")`)

| `type` | fields | when |
|---|---|---|
| `demo:ready` | `app`, `moves` (names), `state` | once, after the bridge has mounted and fixtures are loaded |
| `demo:state` | `state` | whenever the state object changes (route change, selection change) |
| `demo:moveResult` | `id`, `ok`, `result?` (string, for the model), `error?` (string) | when a move finishes or fails |
| `demo:userAction` | `description` (string) | optional: the visitor clicked something themselves (so the AI can react) |

`state` is a small JSON object the AI sees every turn. For aten:
`{ "screen": "pricing", "projectName": "…", "selectedBoard": "MDB-01" | null, "markupPercent": 18 }`.
Keep it under ~300 characters; it is sent on every model turn.

## Messages: service → app (`iframe.contentWindow.postMessage(msg, origin)`)

| `type` | fields | meaning |
|---|---|---|
| `demo:move` | `id`, `name`, `args` | run this move; reply with exactly one `demo:moveResult` carrying the same `id` |
| `demo:stop` | — | abort any move in progress (the visitor typed or pressed pause); reply `demo:moveResult` with `ok:false, error:"stopped"` for the aborted move |
| `demo:reset` | — | reload fixtures to their initial state and go to `startPath`; reply with `demo:state` |

## Move execution rules (inside the app)

- A move is an async function. It must **animate**: move the fake cursor to the
  target, pause ~250 ms, show a click ripple, then perform the action. Target
  elements are found by `[data-demo="<target>"]`. Never use CSS selectors tied to
  layout or text.
- Total duration per move: 1–4 s. Longer "simulated processing" moves (e.g. a
  staged analysis) may run up to 12 s but must honour `demo:stop`.
- A move must never throw into the page. Catch, reply `ok:false` with a short
  human-readable `error` (e.g. `"No element for target 'export_button' on this screen"`).
- `result` is a one-line string the model reads, e.g. `"Now on Pricing. Markup is 18%, selling total EGP 5,452,300."`
- Moves must be idempotent where sensible (going to a screen you are already on is a no-op success).

## The fake cursor

Drawn by the app's bridge as a fixed-position element above everything
(`z-index` max), 20 px arrow with a soft shadow, eased movement (`transition: transform 450ms cubic-bezier(.2,.8,.2,1)`),
a click ripple on click, and a highlight ring (`outline: 2px solid <accent>; outline-offset: 4px; border-radius: 6px`)
on the target for ~1.2 s. Scroll the target into view (`block: "center"`) before moving the cursor to it.

## Security

- The app bridge must accept messages only from the service origin passed in as
  `?demoOrigin=<origin>` on the iframe URL; ignore everything else.
- The bundle has no secrets, no backend URLs, no auth. It must work from `file://`-like
  static hosting with zero network calls other than its own assets.
