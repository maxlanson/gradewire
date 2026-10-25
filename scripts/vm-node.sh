#!/usr/bin/env bash
# Run a Gradewire node inside a Lima VM on this Mac: a separate Linux machine with its own
# Docker, key and node, reachable by the agent through Lima's localhost port forwarding.
# Usage: scripts/vm-node.sh <name> <port> --coordinator https://<tunnel> [--label "Node X"] [--cheat]
#   e.g. scripts/vm-node.sh node-a 4421 --coordinator https://...trycloudflare.com --label "Node A (vm)"
# Creates the VM if missing (Ubuntu + Docker, 2 CPUs, 2 GB), installs Node.js and git, clones
# the public repo, and starts the join in the background inside the VM. Prints the node's
# address to fund. Logs: limactl shell <name> -- tail -f ~/gradewire/.state/logs/join.log
# Stop the node (an "unreliable" laptop closing its lid): limactl stop <name>; limactl start <name>
set -euo pipefail
cd "$(dirname "$0")/.."
NAME=$1; PORT=$2; shift 2
COORDINATOR=""; LABEL="Node $NAME"; CHEAT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --coordinator) COORDINATOR="${2%/}"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --cheat) CHEAT="--cheat"; shift ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
done
[[ -n "$COORDINATOR" ]] || { echo "usage: scripts/vm-node.sh <name> <port> --coordinator https://<tunnel> [--label ..] [--cheat]" >&2; exit 1; }
command -v limactl >/dev/null || { echo "brew install lima" >&2; exit 1; }
say() { printf '\033[1m[vm %s]\033[0m %s\n' "$NAME" "$*"; }

STATUS=$(limactl list --format '{{.Name}} {{.Status}}' 2>/dev/null | awk -v n="$NAME" '$1 == n { print $2 }')
if [[ -z "$STATUS" ]]; then
  say "creating the VM (Ubuntu + Docker; first time downloads the image)…"
  limactl start --name "$NAME" --cpus 2 --memory 2 --disk 10 --tty=false template:docker >/dev/null
elif [[ "$STATUS" != "Running" ]]; then
  say "starting the VM…"; limactl start "$NAME" >/dev/null
fi

say "provisioning (node.js, git, repo, packages, sandbox image)…"
limactl shell "$NAME" -- bash -s <<'VM'
set -e
cd "$HOME"   # limactl shell starts in the host's cwd, mounted read-only inside the VM
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null 2>&1
  sudo apt-get install -y -q nodejs git >/dev/null 2>&1
fi
command -v git >/dev/null || sudo apt-get install -y -q git >/dev/null 2>&1
if [ ! -d gradewire ]; then git clone -q https://github.com/maxlanson/gradewire; else (cd gradewire && git pull -q); fi
cd gradewire && mkdir -p .state/logs
[ -d node_modules ] || npm ci --silent --ignore-scripts
IMAGE=$(node -e "import('./packages/shared/index.mjs').then((m) => console.log(m.SANDBOX_IMAGE))")
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull -q "$IMAGE" >/dev/null
echo "provisioned: node $(node --version), docker $(docker version --format '{{.Server.Version}}'), $(uname -m)"
VM

say "starting the node (port $PORT is forwarded to this Mac's 127.0.0.1:$PORT)…"
# A launcher file inside the VM (limactl shell mangles long quoted commands); setsid + no stdin
# so the node outlives the shell session that starts it.
limactl shell "$NAME" -- bash -s <<VM
cat > ~/gradewire/.state/start-node.sh <<'START'
#!/usr/bin/env bash
cd ~/gradewire
pkill -f 'server.mjs --port $PORT' 2>/dev/null
sleep 1
(setsid nohup scripts/join.sh --coordinator '$COORDINATOR' --label '$LABEL' --port $PORT --public-url http://127.0.0.1:$PORT $CHEAT > .state/logs/join.log 2>&1 < /dev/null &)
sleep 2
START
chmod +x ~/gradewire/.state/start-node.sh
VM
limactl shell "$NAME" -- bash -c '"$HOME/gradewire/.state/start-node.sh"'   # ~ must expand in the guest, not here
for i in $(seq 1 60); do
  addr=$(limactl shell "$NAME" -- bash -c "grep -o 'waiting for funding of 0x[0-9a-fA-F]*' ~/gradewire/.state/logs/join.log 2>/dev/null | head -1 | awk '{print \$NF}'" 2>/dev/null || true)
  [[ -n "$addr" ]] && break
  if limactl shell "$NAME" -- bash -c "grep -q 'on-chain status' ~/gradewire/.state/logs/join.log 2>/dev/null"; then addr="(already funded)"; break; fi
  sleep 2
done
say "node address: ${addr:-not printed yet; check: limactl shell $NAME -- tail ~/gradewire/.state/logs/join.log}"
[[ "$addr" == 0x* ]] && say "fund it: node --env-file=.env scripts/fund-nodes.mjs --address $addr"
