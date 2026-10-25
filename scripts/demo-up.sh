#!/usr/bin/env bash
# Start the whole demo stack in the background: coordinator, 3 verifiers, 2 honest nodes and
# 1 cheating node. Logs in .state/logs/. Stop with scripts/demo-down.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .state/logs
start() { local name=$1; shift; "$@" > ".state/logs/$name.log" 2>&1 & echo "$!" > ".state/logs/$name.pid"; echo "started $name (pid $!)"; }
start coordinator scripts/coordinator.sh
for i in $(seq 1 30); do curl -sf http://127.0.0.1:4500/state >/dev/null && break; sleep 0.5; done
start verifier-1 scripts/verifier.sh 1
start verifier-2 scripts/verifier.sh 2
start verifier-3 scripts/verifier.sh 3
# NODES="A C" starts only some of the local nodes; NODES="" starts none (coordinator + verifiers only,
# for a demo that runs entirely on laptops joined with scripts/join.sh). The agent can fund at most
# 3 Channels per run, so count local + joined nodes together.
NODES="${NODES-A B C}"
[[ " $NODES " == *" A "* ]] && start node-4401 scripts/node.sh --port 4401 --label "Node A"
[[ " $NODES " == *" B "* ]] && start node-4402 scripts/node.sh --port 4402 --label "Node B"
[[ " $NODES " == *" C "* ]] && start node-4403 scripts/node.sh --port 4403 --label "Node C" --cheat
echo "dashboard: http://127.0.0.1:4500/   logs: tail -f .state/logs/*.log"
