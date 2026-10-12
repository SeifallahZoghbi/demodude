#!/usr/bin/env bash
# Push this checkout to the server and build it there. Run LOCALLY from the repo root:
#   ./deploy/push.sh [user@host] [remote-dir]
# The server pulls nothing from GitHub (no deploy key there); this ships the working
# tree as a tarball instead, excluding what the server builds or owns itself. After it
# finishes, an admin restarts the unit:  sudo systemctl restart demodude
set -euo pipefail

# The server is not written into this public repo: put `user@host` in deploy/.host
# (gitignored) or pass it as the first argument / DEMODUDE_HOST.
HERE="$(cd "$(dirname "$0")" && pwd)"
HOST="${1:-${DEMODUDE_HOST:-$(cat "$HERE/.host" 2>/dev/null || true)}}"
[ -n "$HOST" ] || { echo "no server: pass user@host, set DEMODUDE_HOST, or write deploy/.host" >&2; exit 1; }
REMOTE_DIR="${2:-/home/${HOST%%@*}/demodude}"

cd "$(dirname "$0")/.."

echo "==> packing working tree -> $HOST:$REMOTE_DIR"
tar czf - \
  --exclude=./node_modules --exclude=./dist --exclude=./data --exclude=./.git \
  --exclude='./apps/*' --exclude=./.env \
  . | ssh "$HOST" "mkdir -p '$REMOTE_DIR' && tar xzf - -C '$REMOTE_DIR'"

echo "==> install + build on the server"
ssh "$HOST" "cd '$REMOTE_DIR' && export PATH=\$HOME/bin:\$PATH && pnpm install --frozen-lockfile --prod=false && pnpm build"

echo
echo "Deployed. Restart as an admin:  sudo systemctl restart demodude"
echo "Then check:  curl -s http://127.0.0.1:8900/demo/healthz"
