#!/usr/bin/env bash
# Tier 0 / AP4M Demo 2 agent: gets a 402, signs a Voucher, merchant redeems it, then settle + close.
set -euo pipefail
cd "$(dirname "$0")/.."
export TEAM_NAME="${TEAM_NAME:-FranksDAO}"
export CHANNEL_CAP="${CHANNEL_CAP:-1}"
export MAXIMUM_PRICE="${MAXIMUM_PRICE:-0.01}"
export OPERATION="${OPERATION:-demo2-$(date +%s)}"
export STATE_DIRECTORY="${STATE_DIRECTORY:-./.state/demo2-agent}"
exec node --env-file=.env packages/ap4m/example-x402-agent.mjs
