# demodude

A small Node service that hosts AI-guided product demos. It serves an app's
**demo bundle** (static files) inside an iframe, shows a chat panel beside it,
and uses Claude to narrate, answer questions from a knowledge pack, and drive the
app through a fixed set of **moves** (tools) over `postMessage`.

The contract between the service and an app is in `docs/protocol.md`. Read it
before building a bundle.

## Run locally

Requires Node 22+ and pnpm 10.

```sh
pnpm install
cp .env.example .env        # set ANTHROPIC_API_KEY
pnpm dev                    # http://127.0.0.1:8900
```

Open `http://127.0.0.1:8900/demo/_stub` for the built-in stub app. Without an
API key the service still runs; the panel shows "Demo AI is not configured".

```sh
pnpm test        # vitest (fake Claude client, in-memory SQLite)
pnpm typecheck
pnpm build       # tsc -> dist/
pnpm start       # node dist/server.js
```

## Add an app

Teams: the full brief is `docs/add-your-app.md`, with drop-in pieces (bridge, cursor,
bundle writer, Playwright check, CI workflow, Vite config) in `starter/`. In short:

1. Build the app's demo bundle as described in `docs/protocol.md`: `manifest.json`,
   `moves.json`, `knowledge.md`, `scenario.md`, the entry HTML and its assets.
   The bridge must honour `demo:move`, `demo:stop`, `demo:reset` and emit
   `demo:ready`, `demo:state`, `demo:moveResult`.
2. Copy the bundle folder into `APPS_DIR` under its id, e.g. `apps/aten/`.
   The folder name must equal `manifest.id`.
3. The service reloads bundles on file changes, or on
   `POST /api/admin/reload?token=<ADMIN_TOKEN>`. Check `GET /healthz`.
4. Visit `/demo/<id>` (or `/<base>/<id>` when `PUBLIC_BASE_PATH` is set).

`apps/_stub/` is a minimal reference bundle in plain JS; copy its `demo.js`
bridge as a starting point. A bundle is rejected, with the reason logged, when
`moves.json` is missing, a move schema lacks `additionalProperties: false`, or
the entry file does not exist.

Note on asset paths: the bundle is served at `/<base>/apps/<id>/`. With
`PUBLIC_BASE_PATH=/demo` that is `/demo/apps/<id>/`, so the app's build base
(and router basename) must match that path for the deployment it targets.

## How a turn works

1. The panel creates a session (`POST /api/session`) and sends `{ start: true }`
   to `POST /api/session/:id/turn`. The reply is an SSE stream: `text` deltas,
   then either `done {reason:"end_turn"}` or `move {id,name,args}` followed by
   `done {reason:"move"}`.
2. On `move` the panel posts `demo:move` to the iframe, waits for
   `demo:moveResult`, and sends it back as the next turn (`moveResult`), together
   with the app `state`. The model then continues the scenario.
3. Pause sends `demo:stop`; the stopped result is held and sent with the
   visitor's next message. Continue sends "Please continue." Restart opens a new
   session and posts `demo:reset`.

Caps: 60 model calls per session, 30 minutes idle expiry (410 on the next turn),
10 sessions per IP per hour, 40 messages of history (oldest turns dropped, tool
pairs never split). Session rows live in `DATA_DIR/sessions.db`.

Claude: model `claude-opus-5-5`, effort low, 1024 output tokens, strict tools built
from `moves.json`, one move per turn, server-side refusal fallback, prompt caching
on the static system prefix. Every call logs `cache_read` so caching can be
checked in the logs.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required for the guide; read by the SDK. |
| `PORT` / `HOST` | `8900` / `127.0.0.1` | Listener. |
| `APPS_DIR` | `./apps` | One sub-folder per bundle. |
| `DATA_DIR` | `./data` | SQLite file location. |
| `ADMIN_TOKEN` | unset | Enables `/api/admin/stats` and `/api/admin/reload`. |
| `PUBLIC_BASE_PATH` | empty | URL prefix behind a reverse proxy, e.g. `/demo`. |

`GET /api/admin/stats?token=…` returns per-app sessions, calls, tokens, cache hit
ratio and an estimated cost ($4/M input, $0.20/M cache read, $20/M output).

## Deploy (Ubuntu, systemd, nginx)

Files in `deploy/`:

- `demodude.service`: systemd unit running `node dist/server.js` as user `aten`
  from `/home/aten/demodude`, env from `/etc/demodude/env`.
- `nginx-location.conf`: `location /demo/` proxy block with SSE-friendly settings.
- `push.sh`: run LOCALLY; ships the working tree to the server over SSH as a
  tarball (the server has no GitHub access), installs and builds there, then prints
  the `sudo systemctl restart demodude` step for an admin.
- `push-app.sh <id> <bundle-dir>`: run LOCALLY; ships one app's built bundle into
  `apps/<id>/` on the server atomically. The service picks it up without a restart.
  For aten: build with `DEMO_BASE_PATH=/demo pnpm -F @aten/web build:demo` in the
  aten repo, then `./deploy/push-app.sh aten ../aten/packages/web/dist-demo`.

First-time setup:

```sh
sudo cp deploy/demodude.service /etc/systemd/system/
sudo mkdir -p /etc/demodude && sudo cp .env.example /etc/demodude/env   # then edit it
# set PUBLIC_BASE_PATH=/demo and ANTHROPIC_API_KEY in /etc/demodude/env
sudo systemctl daemon-reload && sudo systemctl enable --now demodude
# include deploy/nginx-location.conf in the site's server block, then reload nginx
```

Updates: `./deploy/push.sh`, then the printed restart command. App bundles: `./deploy/push-app.sh`.
Both scripts read the server (`user@host`) from `deploy/.host`, which is gitignored, or
from `DEMODUDE_HOST`; this repo is public and does not name the server.
