#!/usr/bin/env bash
# Push one app's demo bundle to the server. Run LOCALLY after building the bundle:
#   ./deploy/push-app.sh <app-id> <bundle-dir> [user@host] [remote-dir]
# e.g.  ./deploy/push-app.sh aten ../aten/packages/web/dist-demo
# The bundle lands in <remote-dir>/apps/<app-id>/ atomically (extract beside, then
# swap), and the service picks it up on its own (it watches the apps folder).
set -euo pipefail

APP="${1:?app id}"
BUNDLE="${2:?bundle dir}"
# The server is not written into this public repo: put `user@host` in deploy/.host
# (gitignored) or pass it as the third argument / DEMODUDE_HOST.
HERE="$(cd "$(dirname "$0")" && pwd)"
HOST="${3:-${DEMODUDE_HOST:-$(cat "$HERE/.host" 2>/dev/null || true)}}"
[ -n "$HOST" ] || { echo "no server: pass user@host, set DEMODUDE_HOST, or write deploy/.host" >&2; exit 1; }
REMOTE_DIR="${4:-/home/${HOST%%@*}/demodude}"

for f in manifest.json moves.json knowledge.md scenario.md index.html; do
  [ -f "$BUNDLE/$f" ] || { echo "bundle is missing $f" >&2; exit 1; }
done

echo "==> pushing $BUNDLE -> $HOST:$REMOTE_DIR/apps/$APP"
tar czf - -C "$BUNDLE" . | ssh "$HOST" "
  set -e
  mkdir -p '$REMOTE_DIR/apps'
  rm -rf '$REMOTE_DIR/apps/.$APP.new'
  mkdir -p '$REMOTE_DIR/apps/.$APP.new'
  tar xzf - -C '$REMOTE_DIR/apps/.$APP.new'
  rm -rf '$REMOTE_DIR/apps/.$APP.old'
  [ -d '$REMOTE_DIR/apps/$APP' ] && mv '$REMOTE_DIR/apps/$APP' '$REMOTE_DIR/apps/.$APP.old' || true
  mv '$REMOTE_DIR/apps/.$APP.new' '$REMOTE_DIR/apps/$APP'
  rm -rf '$REMOTE_DIR/apps/.$APP.old'
"
echo "Done. Verify the service's /demo/healthz lists the app."
