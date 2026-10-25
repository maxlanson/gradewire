#!/usr/bin/env bash
# Join the Gradewire network as a node from any Mac (or Linux) laptop, in one command:
#
#   git clone https://github.com/maxlanson/gradewire && cd gradewire
#   scripts/join.sh --coordinator https://<the-team-laptop-tunnel>.trycloudflare.com --label "Node Sam"
#
# What it does: checks Node.js, Docker and cloudflared, installs npm packages, pulls the pinned
# sandbox image, opens an HTTPS tunnel to this node (the agent pays over HTTPS), starts the node,
# prints the node's address and waits until the team laptop funds it (3 XRP + 0.01 RLUSD bond).
# No secrets are needed on this laptop: the node makes its own key in .state/node-<port>/.
# Stop with Ctrl-C (stops the tunnel too). Re-running reuses the same key and funding.
set -euo pipefail
cd "$(dirname "$0")/.."

COORDINATOR=""; LABEL="Node $(scutil --get ComputerName 2>/dev/null || hostname -s)"; PORT=4411; PRICE="0.01"; CHEAT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --coordinator) COORDINATOR="${2%/}"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --price) PRICE="$2"; shift 2 ;;
    --cheat) CHEAT="--cheat"; shift ;;
    -h|--help) sed -n 2,12p "$0"; exit 0 ;;
    *) echo "unknown option $1 (try --help)" >&2; exit 1 ;;
  esac
done
[[ -n "$COORDINATOR" ]] || { echo "usage: scripts/join.sh --coordinator https://<tunnel-url> [--label \"Node Sam\"] [--port 4411]" >&2; exit 1; }

say() { printf '\033[1m[join]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[join]\033[0m %s\n' "$*" >&2; exit 1; }

# 1. prerequisites
if [[ "$(uname -m)" != "arm64" && "$(uname -m)" != "aarch64" ]]; then
  say "warning: this is an $(uname -m) machine; the team's verifiers run on Apple Silicon. Results of the sandbox are expected to match across architectures but this was not tested at the hackathon."
fi
command -v node >/dev/null || fail "Node.js is missing. Install it with: brew install node   (needs 22.13 or newer)"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[[ "$NODE_MAJOR" -ge 22 ]] || fail "Node.js $(node --version) is too old; needs 22.13 or newer: brew install node"
command -v docker >/dev/null || fail "Docker is missing. Install Docker Desktop (https://www.docker.com/products/docker-desktop/) and start it."
docker info >/dev/null 2>&1 || fail "Docker is installed but not running. Start Docker Desktop and run this again."
command -v cloudflared >/dev/null || fail "cloudflared is missing (it gives this node a public HTTPS address). Install: brew install cloudflared"
curl -sf -m 10 "$COORDINATOR/state" >/dev/null || fail "cannot reach the coordinator at $COORDINATOR (ask for the current tunnel URL; it changes when the team laptop restarts it)"
say "prerequisites ok: node $(node --version), docker $(docker version --format '{{.Server.Version}}'), cloudflared, coordinator reachable"

# 2. packages and the pinned sandbox image
if [[ ! -d node_modules ]]; then say "installing npm packages…"; npm ci --silent; fi
IMAGE=$(node -e "import('./packages/shared/index.mjs').then((m) => console.log(m.SANDBOX_IMAGE))")
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then say "pulling the pinned sandbox image (one time)…"; docker pull -q "$IMAGE" >/dev/null; fi
say "sandbox image ready: ${IMAGE:0:30}…"

# 3. public HTTPS address for this node (the paying agent requires HTTPS off-localhost)
mkdir -p .state/logs
URL_FILE=".state/tunnel-${PORT}.url"
scripts/tunnel.sh "$PORT" > ".state/logs/tunnel-${PORT}.log" 2>&1 &
TUNNEL_PID=$!
trap 'kill $TUNNEL_PID 2>/dev/null; exit 0' INT TERM
for i in $(seq 1 60); do [[ -s "$URL_FILE" ]] && break; sleep 1; done
PUBLIC_URL=$(cat "$URL_FILE" 2>/dev/null || true)
[[ -n "$PUBLIC_URL" ]] || { kill $TUNNEL_PID 2>/dev/null; fail "the tunnel did not come up in 60 s (see .state/logs/tunnel-${PORT}.log)"; }
say "this node's public address: $PUBLIC_URL"

# 4. run the node (team-public settings only; the node's own key is created on first start)
ENV_FILE=".state/join-${PORT}.env"
cat > "$ENV_FILE" <<ENV
AP4M_API_URL=https://hackathon.ap4m.build
PAYOUT_ADDRESS=0xfef51cf8a51f290b2f7bbb06890b12018631dbfc
MERCHANT_ID=0xb6aa1d849d8cce69e3acad00f3e938870f0ba3677404ba389e3d2b7b910fd80e
COORDINATOR_URL=$COORDINATOR
NODE_PUBLIC_URL=$PUBLIC_URL
PRICE_RLUSD=$PRICE
ENV
say "starting node \"$LABEL\" on port $PORT; when it prints 'waiting for funding', send that address to the team laptop"
say "the node shows up on the dashboard at $COORDINATOR/ once funded and benchmarked (about a minute)"
node --env-file="$ENV_FILE" packages/node/server.mjs --port "$PORT" --label "$LABEL" $CHEAT
