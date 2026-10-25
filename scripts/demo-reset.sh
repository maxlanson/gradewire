#!/usr/bin/env bash
# Reset the demo in a few seconds, without restarting anything but the cheater's node process:
#   - coordinator: new session (history wiped, counters restarted, dashboard reloads itself)
#   - Node C: next pre-provisioned cheater identity (see scripts/prep-cheaters.sh)
#   - agent: no leftover in-flight purchase markers
# Usage: scripts/demo-reset.sh            (prints the time it took)
set -euo pipefail
cd "$(dirname "$0")/.."
t0=$(date +%s)
next=$(cat .state/cheater-next 2>/dev/null || echo 1)
limactl shell node-c -- bash -c "test -f ~/gradewire/.state/cheater-ready-$next" 2>/dev/null || { echo "cheater identity $next is not prepared; run scripts/prep-cheaters.sh" >&2; exit 1; }
find .state/trainer -name 'inflight-*.json' -delete
curl -sf -X POST http://127.0.0.1:4500/admin/reset | python3 -c 'import json,sys; d=json.load(sys.stdin); print("coordinator: new session; dropped", d["dropped"] or "nothing", "| kept", d["kept"])'
limactl shell node-c -- bash -c "cd ~/gradewire && pkill -f 'server.mjs --port 4423' 2>/dev/null; sleep 0.3; (set -a; . .state/join-4423.env; set +a; NODE_STATE_DIR=.state/node-4423-$next setsid nohup node packages/node/server.mjs --port 4423 --label 'Node C (vm)' --cheat --no-display > .state/logs/join.log 2>&1 < /dev/null &)" 2>/dev/null
echo $((next + 1)) > .state/cheater-next
for i in $(seq 1 60); do
  n=$(curl -s 'http://127.0.0.1:4500/providers?status=active&min_score=0.8' | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["providers"]))' 2>/dev/null || echo 0)
  [[ "$n" == 3 ]] && break; sleep 0.5
done
curl -s 'http://127.0.0.1:4500/providers' | python3 -c 'import json,sys; print("nodes:", [(p["label"], p["status"]) for p in json.load(sys.stdin)["providers"]])'
echo "reset done in $(( $(date +%s) - t0 )) s (cheater identity $next; next is $((next + 1)))"
