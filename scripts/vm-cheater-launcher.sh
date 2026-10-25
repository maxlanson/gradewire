#!/usr/bin/env bash
# Installs ~/gradewire/.state/cheater.sh inside the node-c VM (limactl shell mangles long inline
# commands, so the VM gets a file it can run by path). Used by prep-cheaters.sh and demo-reset.sh.
#   cheater.sh prep <k>    start identity k on port 4433 (first join: benchmark, attest, bond), log .state/logs/prep-<k>.log
#   cheater.sh start <k>   start identity k as the live Node C on port 4423, log .state/logs/join.log
#   cheater.sh stop <port> stop the node on that port
set -euo pipefail
limactl shell node-c -- bash -s <<'VM'
cat > ~/gradewire/.state/cheater.sh <<'LAUNCH'
#!/usr/bin/env bash
cd ~/gradewire
mode=$1; k=$2
set -a; . .state/join-4423.env; set +a
if [ "$mode" = stop ]; then pkill -f "server.mjs --port $k" 2>/dev/null; exit 0; fi   # k is a port here; this script's own command line never contains the pattern
if [ "$mode" = prep ]; then port=4433; log=.state/logs/prep-$k.log; else port=4423; log=.state/logs/join.log; fi
pkill -f "server.mjs --port $port" 2>/dev/null; sleep 0.3
NODE_STATE_DIR=.state/node-4423-$k NODE_PUBLIC_URL=http://127.0.0.1:$port setsid nohup node packages/node/server.mjs --port $port --label "Node C (vm)" --cheat --no-display > "$log" 2>&1 < /dev/null &
sleep 1
LAUNCH
chmod +x ~/gradewire/.state/cheater.sh
VM
