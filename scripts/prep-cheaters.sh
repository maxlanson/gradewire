#!/usr/bin/env bash
# Prepare N cheater identities ahead of a demo day, inside the node-c VM: each gets its own key,
# 3 XRP + 0.01 RLUSD, and a full first join (register, benchmark, attest, bond) so that at demo
# time scripts/demo-reset.sh can switch to the next one in a few seconds. ~1 min per identity.
# Usage: scripts/prep-cheaters.sh 10
set -euo pipefail
cd "$(dirname "$0")/.."
N=${1:-10}
mkdir -p .state
for k in $(seq 1 "$N"); do
  dir=".state/node-4423-$k"
  if limactl shell node-c -- bash -c "test -f ~/gradewire/.state/cheater-ready-$k" 2>/dev/null; then echo "cheater $k already prepared"; continue; fi
  limactl shell node-c -- bash -c "cd ~/gradewire && pkill -f 'server.mjs --port 4433' 2>/dev/null; sleep 0.5; (set -a; . .state/join-4423.env; set +a; NODE_STATE_DIR=$dir NODE_PUBLIC_URL=http://127.0.0.1:4433 setsid nohup node packages/node/server.mjs --port 4433 --label 'Node C (vm)' --cheat --no-display > .state/logs/prep-$k.log 2>&1 < /dev/null &); sleep 2" 2>/dev/null
  addr=""
  for i in $(seq 1 30); do
    addr=$(limactl shell node-c -- bash -c "grep -o 'waiting for funding of 0x[0-9a-fA-F]*' ~/gradewire/.state/logs/prep-$k.log 2>/dev/null | head -1 | awk '{print \$NF}'" 2>/dev/null || true)
    [[ -n "$addr" ]] && break; sleep 2
  done
  [[ -n "$addr" ]] || { echo "cheater $k: no address printed (see prep-$k.log in the VM)"; exit 1; }
  node --env-file=.env scripts/fund-nodes.mjs --address "$addr" 2>&1 | tail -n 1
  for i in $(seq 1 90); do
    limactl shell node-c -- bash -c "grep -q 'on-chain status: active' ~/gradewire/.state/logs/prep-$k.log" 2>/dev/null && break; sleep 2
  done
  limactl shell node-c -- bash -c "pkill -f 'server.mjs --port 4433'; grep -q 'on-chain status: active' ~/gradewire/.state/logs/prep-$k.log && touch ~/gradewire/.state/cheater-ready-$k" 2>/dev/null || { echo "cheater $k: did not reach active"; exit 1; }
  echo "cheater $k ready: $addr"
done
echo "$N cheater identities ready; scripts/demo-reset.sh uses them in order"
