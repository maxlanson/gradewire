#!/usr/bin/env bash
# Start a provider node. Usage: scripts/node.sh [--port 4401] [--cheat] [--label "Node A"]
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
export MERCHANT_ID="${MERCHANT_ID:-0xb6aa1d849d8cce69e3acad00f3e938870f0ba3677404ba389e3d2b7b910fd80e}"
export PRICE_RLUSD="${PRICE_RLUSD:-0.01}"
exec node packages/node/server.mjs "$@"
