#!/usr/bin/env bash
# Tier 0 / AP4M Demo 1: open a Channel, redeem one Voucher on-chain, settle, close.
# Note: the kit's ap4m-agent.js pays a fixed 1 RLUSD (to our own payout wallet).
set -euo pipefail
cd "$(dirname "$0")/.."
export TEAM_NAME="${TEAM_NAME:-FranksDAO}"
exec node --env-file=.env packages/ap4m/ap4m-agent.cjs
