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
scripts/vm-cheater-launcher.sh
find .state/trainer -name 'inflight-*.json' -delete
old=$(curl -s -m 3 http://127.0.0.1:4423/health | python3 -c 'import json,sys; print(json.load(sys.stdin)["provider"])' 2>/dev/null || true)
curl -sf -X POST http://127.0.0.1:4500/admin/reset -H 'content-type: application/json' -d "{\"drop\": [\"$old\"]}" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("coordinator: new session; dropped", d["dropped"] or "nothing", "| kept", d["kept"])'
limactl shell node-c -- bash -c '"$HOME/gradewire/.state/cheater.sh" start '"$next" 2>/dev/null
echo $((next + 1)) > .state/cheater-next
for i in $(seq 1 60); do
  new=$(curl -s -m 2 http://127.0.0.1:4423/health | python3 -c 'import json,sys; print(json.load(sys.stdin)["provider"].lower())' 2>/dev/null || true)
  [[ -n "$new" && "$new" != "$(echo "$old" | tr A-Z a-z)" ]] && curl -s 'http://127.0.0.1:4500/providers?status=active&min_score=0.8' | grep -qi "$new" && break
  sleep 0.5
done
curl -s 'http://127.0.0.1:4500/providers' | python3 -c 'import json,sys; print("nodes:", [(p["label"], p["status"]) for p in json.load(sys.stdin)["providers"]])'
echo "reset done in $(( $(date +%s) - t0 )) s (cheater identity $next; next is $((next + 1)))"
